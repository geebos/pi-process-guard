#!/usr/bin/env node
/**
 * pi-guard-janitor — mandatory independent cleanup process
 * (docs/pi-guard-startup-flow.md §11, §12, §38).
 *
 * Runs as a detached OS process, outside the Pi runtime domain, so it can
 * reclaim the runtime even when Pi is SIGKILLed or the launcher disappears.
 *
 * Usage:
 *   pi-guard-janitor --runtime-dir <dir> --guard-id <id> --launcher-pid <pid>
 *   pi-guard-janitor --runtime-dir <dir> --guard-id <id> --recovery
 *
 * Normal mode:
 *   1. validates the runtime dir + guard id, records its own PID identity
 *   2. binds janitor.sock and publishes READY (docs §12)
 *   3. supervises via REGISTER_RUNTIME / EXTENSION_READY / CLEANUP_REQUEST
 *      messages plus its own health ticks:
 *        - Pi main process dies         -> cleanup("pi-dead")
 *        - launcher dies + orphan grace -> cleanup("launcher-dead")
 *        - macOS descendant registry    -> sampling (docs §21)
 *   4. performs the TERM -> grace -> KILL -> verify cleanup (docs §28, §29)
 *   5. publishes CLEANUP_DONE, removes the runtime dir and exits.
 *
 * Cleanup is idempotent (docs §23.1): RUNNING -> CLEANING -> CLEAN; repeated
 * requests are answered from the already-recorded result.
 */

import { createServer, type Socket } from "node:net";
import { unlinkSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { loadConfig } from "../config.ts";
import { createBackend, type GuardBackend } from "../platform/index.ts";
import { termThenKill } from "../cleanup.ts";
import { deleteStateDir, readState, updateState, controlSocketPath, readyFilePath, registryFilePath } from "../guard-state.ts";
import { getStartIdentity, pidAlive, startIdentityMatches } from "../process-info.ts";
import { ProcessTracker } from "../process-registry.ts";
import { createLogger } from "../log.ts";
import { encodeMessage, decodeMessage, JANITOR_PROTOCOL_VERSION } from "../protocol.ts";
import type { CleanupDoneMessage, GuardConfig, GuardStateFile, JanitorMessage } from "../types.ts";

interface JanitorArgs {
	runtimeDir?: string;
	guardId?: string;
	launcherPid?: number;
	recovery: boolean;
}

function parseArgs(argv: string[]): JanitorArgs {
	const out: JanitorArgs = { recovery: false };
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--runtime-dir":
				out.runtimeDir = argv[++i];
				break;
			case "--guard-id":
				out.guardId = argv[++i];
				break;
			case "--launcher-pid":
				out.launcherPid = Number(argv[++i]);
				break;
			case "--recovery":
				out.recovery = true;
				break;
			default: {
				// Legacy positional: a state file path.
				const arg = argv[i];
				if (!out.runtimeDir && arg && !arg.startsWith("-")) {
					out.runtimeDir = arg.replace(/\/state\.json$/, "");
				}
			}
		}
	}
	return out;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	if (!args.runtimeDir) {
		process.stderr.write("[pi-guard-janitor] missing --runtime-dir\n");
		process.exit(2);
	}

	const config = loadConfig();
	const stateDir = args.runtimeDir;
	const state = readState(stateDir);
	if (!state) {
		// Nothing to supervise — the runtime was never created.
		process.exit(0);
	}
	if (args.guardId && state.guardId !== args.guardId) {
		process.stderr.write("[pi-guard-janitor] guard id mismatch; refusing to supervise\n");
		process.exit(2);
	}

	const log = createLogger(config, { guardId: state.guardId, action: "janitor" });

	if (args.recovery) {
		void recover(config, stateDir, state, log);
		return;
	}
	void supervise(config, stateDir, state, log, args.launcherPid);
}

/** True when the pid is gone, checking start identity when one is recorded. */
async function identityGone(pid: number, startIdentity: string | undefined): Promise<boolean> {
	if (!Number.isInteger(pid) || pid <= 0) return true;
	if (!pidAlive(pid)) return true;
	if (startIdentity) return !(await startIdentityMatches(pid, startIdentity));
	return false;
}

/** Reclaim a stale runtime whose launcher and Pi are both gone (docs §31). */
async function recover(config: GuardConfig, stateDir: string, state: GuardStateFile, log: ReturnType<typeof createLogger>): Promise<void> {
	const launcherGone = await identityGone(state.launcherPid, state.launcherStartIdentity);
	const piGone = await identityGone(state.piPid, state.piStartIdentity);
	if (!launcherGone || !piGone) {
		log.debug("recovery aborted: launcher or Pi still alive", {
			launcherPid: state.launcherPid,
			piPid: state.piPid,
		});
		process.exit(0);
	}
	log.warn("recovery janitor reclaiming stale runtime", {
		launcherPid: state.launcherPid,
		piPid: state.piPid,
		pgid: state.piPgid,
		unit: state.runtimeUnit,
	});
	await runCleanup(config, stateDir, state, "stale-recovery", log);
	deleteStateDir(stateDir);
	log.info("recovery janitor exiting");
	process.exit(0);
}

async function supervise(
	config: GuardConfig,
	stateDir: string,
	initial: GuardStateFile,
	log: ReturnType<typeof createLogger>,
	launcherPidArg?: number,
): Promise<void> {
	const janitorPid = process.pid;
	const janitorStartIdentity = await getStartIdentity(janitorPid);
	updateState(stateDir, { janitorPid, janitorStartIdentity, janitorReadyAt: Date.now() });

	// Bind the control socket before announcing READY (docs §12.1).
	const socketPath = controlSocketPath(config.stateRoot, initial.guardId, stateDir);
	try {
		if (existsSync(socketPath)) unlinkSync(socketPath);
	} catch {
		// stale socket; best effort
	}
	const sockets = new Set<Socket>();
	const broadcast = (message: JanitorMessage): void => {
		const line = encodeMessage(message);
		for (const socket of sockets) {
			if (!socket.destroyed) socket.write(line);
		}
	};

	const server = createServer((socket) => {
		socket.setEncoding("utf8");
		let buffer = "";
		socket.on("data", (chunk: string) => {
			buffer += chunk;
			let idx: number;
			while ((idx = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (!line.trim()) continue;
				const message = decodeMessage(line);
				if (message) handleMessage(message);
			}
		});
		socket.on("error", () => { /* client vanished */ });
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		// Publish READY to every new client (docs §12.2).
		sendTo(socket, {
			type: "READY",
			guardId: initial.guardId,
			janitorPid,
			protocolVersion: JANITOR_PROTOCOL_VERSION,
		});
	});
	server.on("error", (err) => {
		log.error("janitor socket error", { error: err.message });
	});
	server.listen(socketPath, () => {
		try {
			writeFileSync(readyFilePath(stateDir), "", { mode: 0o600 });
		} catch {
			// non-fatal diagnostics marker
		}
		log.info("janitor ready", { action: "ready", pid: janitorPid, socket: socketPath });
	});

	let cleaning = false;
	let cleanupDone: CleanupDoneMessage | undefined;
	let registered = false;
	let orphanSince: number | undefined;

	const currentState = (): GuardStateFile | undefined => readState(stateDir);

	async function cleanup(reason: string, generation = 0): Promise<void> {
		if (cleaning) {
			// Idempotent: repeat requests answer from the recorded result (docs §23.1).
			if (cleanupDone) broadcast(cleanupDone);
			return;
		}
		cleaning = true;
		const s = currentState() ?? initial;
		log.info("final cleanup started", { reason, backend: s.backend, pgid: s.piPgid, unit: s.runtimeUnit });
		updateState(stateDir, { state: "cleaning", cleanupReason: reason, cleanupGeneration: generation });

		const result = await runCleanup(config, stateDir, s, reason, log);
		cleanupDone = { type: "CLEANUP_DONE", result, reason, generation };
		broadcast(cleanupDone);

		// Final lifecycle: remove transient artifacts, then exit (docs §30).
		server.close();
		try {
			if (existsSync(socketPath)) unlinkSync(socketPath);
		} catch {
			// best effort
		}
		deleteStateDir(stateDir);
		log.info("janitor exiting after cleanup", { result });
		process.exit(0);
	}

	function handleMessage(message: JanitorMessage): void {
		switch (message.type) {
			case "REGISTER_RUNTIME": {
				if (message.guardId !== initial.guardId) return;
				updateState(stateDir, {
					state: "running",
					backend: message.backend,
					platform: message.platform,
					piPid: message.piPid,
					piStartIdentity: message.piStartIdentity,
					...(message.piPgid ? { piPgid: message.piPgid } : {}),
					...(message.unit ? { runtimeUnit: message.unit } : {}),
				});
				registered = true;
				orphanSince = undefined;
				log.info("runtime registered", {
					action: "runtime-register",
					backend: message.backend,
					piPid: message.piPid,
					pgid: message.piPgid,
					unit: message.unit,
				});
				break;
			}
			case "EXTENSION_READY": {
				const current = currentState();
				if (!current || message.guardId !== current.guardId) return;
				updateState(stateDir, { extensionReadyAt: Date.now() });
				log.info("extension ready", { action: "extension-ready", piPid: message.piPid });
				// Relay to the launcher so it can stop waiting (docs §18).
				broadcast(message);
				break;
			}
			case "HEARTBEAT": {
				// Confirms the launcher event loop is alive; the health tick
				// additionally re-verifies PID + start identity.
				break;
			}
			case "CLEANUP_REQUEST": {
				void cleanup(message.reason, message.generation);
				break;
			}
			default:
				break;
		}
	}

	// Health tick: owner loss, Pi death, macOS descendant registry.
	const tick = async (): Promise<void> => {
		if (cleaning) return;
		const current = currentState();
		if (!current) process.exit(0);

		// Pi death -> runtime cleanup (docs §24, §25).
		if (registered && current.piPid > 0 && (await identityGone(current.piPid, current.piStartIdentity))) {
			log.info("Pi process gone; starting cleanup", { action: "pi-dead", piPid: current.piPid });
			await cleanup("pi-dead");
			return;
		}

		// Launcher loss -> orphan grace window -> cleanup (docs §26).
		const launcherPid = launcherPidArg ?? current.launcherPid;
		const launcherAlive = !(await identityGone(launcherPid, current.launcherStartIdentity));
		if (!launcherAlive) {
			orphanSince ??= Date.now();
			if (Date.now() - orphanSince >= config.janitor.orphanGraceMs) {
				log.warn("launcher lost; runtime orphaned after grace window", { action: "orphan-cleanup" });
				await cleanup("launcher-dead");
				return;
			}
		} else {
			orphanSince = undefined;
		}

		// macOS descendant registry sampling (docs §21).
		if (current.piPid > 0 && process.platform === "darwin") {
			await sampleRegistry(stateDir, current, log);
		}
	};

	void tick();
	setInterval(() => void tick(), config.janitor.heartbeatMs);
}

/** macOS descendant sampling: PPID-tree walk from Pi, persisted to disk. */
async function sampleRegistry(
	stateDir: string,
	state: GuardStateFile,
	log: ReturnType<typeof createLogger>,
): Promise<void> {
	try {
		const tracker = new ProcessTracker(state.piPid, userInfo().username);
		await tracker.sample();
		tracker.writeTo(registryFilePath(stateDir));
		log.debug("descendant registry sampled", {
			action: "registry-sample",
			piPid: state.piPid,
			tracked: String(tracker.snapshot().length),
		});
	} catch (err) {
		log.error("descendant registry sampling failed", {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

function sendTo(socket: Socket, message: JanitorMessage): void {
	if (!socket.destroyed) socket.write(encodeMessage(message));
}

/** TERM -> grace -> KILL -> verify; records CLEAN and returns the outcome. */
async function runCleanup(
	config: GuardConfig,
	stateDir: string,
	state: GuardStateFile,
	reason: string,
	log: ReturnType<typeof createLogger>,
): Promise<"clean" | "incomplete"> {
	const backend: GuardBackend = await createBackend(state.platform, config, {
		guardId: state.guardId,
		pgid: state.piPgid,
		runtimeUnit: state.runtimeUnit,
		registryPath: join(stateDir, "registry.json"),
	});
	const result = await termThenKill(backend, {
		termGraceMs: config.termGraceMs,
		killVerifyMs: config.killVerifyMs,
		log,
	});
	const clean = await backend.isClean();
	const outcome: "clean" | "incomplete" = clean ? "clean" : "incomplete";
	updateState(stateDir, { state: "clean", cleanupReason: reason });
	log.info("final cleanup finished", {
		reason,
		result: result.outcome,
		clean: String(clean),
		durationMs: String(result.durationMs),
	});
	return outcome;
}

main();
