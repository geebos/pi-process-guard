/**
 * POSIX process-group backend (macOS, and Linux fallback when systemd is
 * unavailable). The Pi process is spawned `detached`, making it the leader of
 * its own session and process group with PGID = Pi PID. All ordinary
 * descendants inherit that group (docs/tech.md §8.2).
 *
 * Because a descendant can escape with setsid(), the backend also maintains a
 * descendant registry (sampled from the PPID tree) and sweeps escaped
 * processes by PID + start identity during cleanup (docs/tech.md §8.3–§8.5).
 *
 * Safety rules (docs/tech.md §19.1):
 * - only processes owned by the current user are ever signalled;
 * - the domain is signalled as a group when every member is owned, otherwise
 *   owned members are signalled individually and others are left alone;
 * - registry PIDs are verified against their recorded start identity before
 *   signalling (PID reuse protection).
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { BackendContext, BackendStarted, GuardBackend } from "./index.ts";
import type { GuardConfig, RuntimeSnapshot } from "../types.ts";
import { ProcessTracker, type TrackedProcess } from "../process-registry.ts";
import { getStartIdentity, listPgidMembers, pidAlive } from "../process-info.ts";

export function createProcessGroupBackend(config: GuardConfig, state: BackendContext): GuardBackend {
	const owner = userInfo().username;
	const pgid = state.pgid;
	// Registry entries loaded from disk (janitor path) or built by sampling.
	let escaped: TrackedProcess[] = [];
	if (state.registryPath) {
		escaped = ProcessTracker.readFrom(state.registryPath);
	}

	/** Registry processes that escaped the Pi process group (need individual sweep). */
	function escapedMembers(): TrackedProcess[] {
		return escaped.filter((p) => pgid === undefined || p.pgid !== pgid);
	}

	async function signalEscaped(signal: NodeJS.Signals): Promise<void> {
		for (const proc of escapedMembers()) {
			// PID reuse guard: only signal when the identity still matches.
			if (!(await procVerify(proc))) continue;
			try {
				process.kill(proc.pid, signal);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
			}
		}
	}

	async function signalDomain(signal: NodeJS.Signals): Promise<void> {
		if (pgid) {
			const members = await listPgidMembers(pgid, owner);
			if (members.length > 0) {
				const owned = members.filter((m) => m.user === owner);
				if (owned.length === members.length) {
					// Whole group belongs to us: use killpg semantics.
					try {
						process.kill(-pgid, signal);
					} catch (err) {
						if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
					}
				} else {
					for (const member of owned) {
						try {
							process.kill(member.pid, signal);
						} catch (err) {
							if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
						}
					}
				}
			}
		}
		await signalEscaped(signal);
	}

	async function isClean(): Promise<boolean> {
		if (pgid) {
			const members = await listPgidMembers(pgid, owner);
			if (members.length > 0) return false;
		}
		// Escaped processes count as dirty only while their identity matches
		// (a reused PID with a different process is not ours to clean).
		for (const proc of escapedMembers()) {
			if (await procVerify(proc)) return false;
		}
		return true;
	}

	return {
		kind: "process-group",

		async start(target): Promise<BackendStarted> {
			const child = spawn(target.bin, target.args, {
				detached: true,
				stdio: "inherit",
				env: target.env,
			});
			const piPid = child.pid!;
			const startedPgid = piPid; // detached child: session+group leader, PGID = PID
			state.pgid = startedPgid;

			// Start the descendant registry sampler once the runtime is up.
			if (state.registryPath) {
				const tracker = new ProcessTracker(piPid, owner);
				const tick = async (): Promise<void> => {
					try {
						await tracker.sample();
						escaped = tracker.snapshot();
						tracker.writeTo(state.registryPath!);
					} catch {
						// Sampling failure: degrade to PGID-only (docs/tech.md §25).
					}
				};
				void tick();
				const interval = setInterval(tick, Math.max(250, config.macos.registryIntervalMs));
				interval.unref?.();
			}

			const exited = new Promise<number | null>((resolve) => {
				child.on("exit", (code, signal) => resolve(signal ? null : code));
				child.on("error", (err) => {
					process.stderr.write(`[pi-guard] failed to start Pi: ${err.message}\n`);
					resolve(null);
				});
			});

			return { piPid, pgid: startedPgid, exited };
		},

		signalTerm: () => signalDomain("SIGTERM"),
		signalKill: () => signalDomain("SIGKILL"),
		isClean,

		async snapshot(): Promise<RuntimeSnapshot> {
			const members = pgid ? await listPgidMembers(pgid, owner) : [];
			return {
				backend: "process-group",
				piPid: pgid ?? 0,
				piPgid: pgid,
				trackedProcesses: members.filter((m) => pidAlive(m.pid)).length,
			};
		},
	};
}

/** Verify a tracked process still exists with its recorded identity. */
async function procVerify(proc: TrackedProcess): Promise<boolean> {
	if (!pidAlive(proc.pid)) return false;
	if (!proc.startIdentity) return false;
	const current = await getStartIdentity(proc.pid);
	return current === proc.startIdentity;
}
