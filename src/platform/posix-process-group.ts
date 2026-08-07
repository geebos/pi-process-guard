/**
 * POSIX process-group backend (macOS, and Linux fallback when systemd is
 * unavailable). The Pi process is spawned `detached`, making it the leader of
 * its own session and process group with PGID = Pi PID. All ordinary
 * descendants inherit that group (docs/tech.md §8.2).
 *
 * Safety rules (docs/tech.md §19.1):
 * - only processes owned by the current user are ever signalled;
 * - the domain is signalled as a group when every member is owned, otherwise
 *   owned members are signalled individually and others are left alone.
 */

import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import type { BackendContext, BackendStarted, GuardBackend } from "./index.ts";
import type { GuardConfig, RuntimeSnapshot } from "../types.ts";
import { listPgidMembers, pidAlive } from "../process-info.ts";

export function createProcessGroupBackend(config: GuardConfig, state: BackendContext): GuardBackend {
	const owner = userInfo().username;
	const pgid = state.pgid;

	async function signalDomain(signal: NodeJS.Signals): Promise<void> {
		if (!pgid) return;
		const members = await listPgidMembers(pgid, owner);
		if (members.length === 0) return; // ESRCH equivalent: nothing to do
		const owned = members.filter((m) => m.user === owner);
		if (owned.length === members.length) {
			// Whole group belongs to us: use killpg semantics.
			try {
				process.kill(-pgid, signal);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
			}
			return;
		}
		// Mixed-ownership group (should not happen for a guard-created PGID):
		// signal only our own members, never touch others.
		for (const member of owned) {
			try {
				process.kill(member.pid, signal);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
			}
		}
	}

	async function isClean(): Promise<boolean> {
		if (!pgid) return true;
		const members = await listPgidMembers(pgid, owner);
		return members.length === 0;
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

			const exited = new Promise<number | null>((resolve) => {
				child.on("exit", (code, signal) => resolve(signal ? null : code));
				child.on("error", (err) => {
					// Spawn failure: treat as an exit so the launcher can fail fast.
					process.stderr.write(`[pi-guard] failed to start Pi: ${err.message}\n`);
					resolve(null);
				});
			});

			// `startedPgid` may differ from `state.pgid` — the launcher stores the
			// real one; the janitor reads it back from state.
			state.pgid = startedPgid;
			return { piPid, pgid: startedPgid, exited };
		},

		signalTerm: () => signalDomain("SIGTERM"),
		signalKill: () => signalDomain("SIGKILL"),
		isClean,

		async snapshot(): Promise<RuntimeSnapshot> {
			const members = pgid ? await listPgidMembers(pgid, owner) : [];
			return {
				backend: "process-group",
				piPid: state.pgid ?? 0,
				piPgid: pgid,
				trackedProcesses: members.filter((m) => pidAlive(m.pid)).length,
			};
		},
	};
}
