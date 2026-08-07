/**
 * Launcher core: creates the guard identity + state, starts the mandatory
 * janitor, starts the Pi runtime inside the platform isolation domain,
 * forwards signals and hands final cleanup to the janitor (docs/tech.md §21,
 * §22, §25).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { createBackend } from "./platform/index.ts";
import { deleteStateDir, readState, stateDirFor, stateFilePath, updateState, writeState, findStaleStates } from "./guard-state.ts";
import { pidAlive } from "./process-info.ts";
import type { GuardBackendKind, GuardConfig, GuardStateFile } from "./types.ts";

const JANITOR_ENTRY = resolveJanitorEntry();

function resolveJanitorEntry(): string {
	const base = fileURLToPath(new URL("./janitor/index.", import.meta.url));
	for (const ext of ["ts", "js"]) {
		const candidate = `${base}${ext}`;
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("pi-process-guard: cannot resolve janitor entry");
}

export interface RunGuardOptions {
	targetBin: string;
	targetArgs: string[];
	config?: GuardConfig;
	env?: NodeJS.ProcessEnv;
	/** Called once the runtime is up and the state file is published. */
	onStarted?: (info: {
		guardId: string;
		stateDir: string;
		piPid: number;
		pgid?: number;
		unit?: string;
		janitorPid: number;
	}) => void;
}

/** Environment that carries the resolved config so children load the same values. */
function configEnv(config: GuardConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		PI_PROCESS_GUARD: config.enabled ? "1" : "0",
		PI_PROCESS_GUARD_TERM_GRACE_MS: String(config.termGraceMs),
		PI_PROCESS_GUARD_KILL_VERIFY_MS: String(config.killVerifyMs),
		PI_PROCESS_GUARD_JANITOR_HEARTBEAT_MS: String(config.janitor.heartbeatMs),
		PI_PROCESS_GUARD_JANITOR_ORPHAN_GRACE_MS: String(config.janitor.orphanGraceMs),
		PI_PROCESS_GUARD_STATE_ROOT: config.stateRoot,
		PI_PROCESS_GUARD_LOG_FILE: config.logging.file,
		PI_PROCESS_GUARD_LOG: config.logging.level,
		...(config.configPath ? { PI_PROCESS_GUARD_CONFIG: config.configPath } : {}),
	};
}

/** Guard identity variables consumed by the extension (docs/tech.md §20). */
function guardEnv(
	env: NodeJS.ProcessEnv,
	identity: {
		guardId: string;
		backend: GuardBackendKind;
		launcherPid: number;
		janitorPid: number;
		stateFile: string;
		pgid?: number;
		unit?: string;
	},
): NodeJS.ProcessEnv {
	return {
		...env,
		PI_PROCESS_GUARD_ID: identity.guardId,
		PI_PROCESS_GUARD_BACKEND: identity.backend,
		PI_PROCESS_GUARD_PARENT_PID: String(identity.launcherPid),
		PI_PROCESS_GUARD_JANITOR_PID: String(identity.janitorPid),
		PI_PROCESS_GUARD_STATE_FILE: identity.stateFile,
		PI_PROCESS_GUARD_INNER: "1",
		...(identity.pgid ? { PI_PROCESS_GUARD_RUNTIME_PGID: String(identity.pgid) } : {}),
		...(identity.unit ? { PI_PROCESS_GUARD_RUNTIME_UNIT: identity.unit } : {}),
	};
}

/** Minimal unguarded passthrough used when PI_PROCESS_GUARD=0. */
function runPassthrough(opts: RunGuardOptions, config: GuardConfig): Promise<number> {
	const log = createLogger(config, { action: "passthrough" });
	const child = spawn(opts.targetBin, opts.targetArgs, { stdio: "inherit", env: opts.env });
	const forward = (signal: NodeJS.Signals): void => {
		try {
			process.kill(child.pid!, signal);
		} catch {
			/* child already gone */
		}
	};
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
		const h = (): void => forward(sig);
		process.on(sig, h);
		return { sig, h };
	});
	return new Promise<number>((resolve) => {
		child.on("exit", (code) => {
			for (const { sig, h } of handlers) process.removeListener(sig, h);
			log.info("passthrough target exited", { result: code === null ? "signal" : String(code) });
			resolve(code ?? 1);
		});
		child.on("error", (err) => {
			for (const { sig, h } of handlers) process.removeListener(sig, h);
			log.error("passthrough spawn failed", { error: err.message });
			resolve(1);
		});
	});
}

/**
 * Run a guarded Pi runtime and return Pi's exit code once cleanup is complete.
 */
export async function runGuard(opts: RunGuardOptions): Promise<number> {
	const env = opts.env ?? process.env;
	const config = opts.config ?? loadConfig(env);
	const log = createLogger(config);

	if (!config.enabled) return runPassthrough(opts, config);

	const platform = process.platform;
	if (platform !== "linux" && platform !== "darwin") {
		throw new Error(`Unsupported platform for pi-process-guard: ${platform} (supported: linux, darwin)`);
	}

	// Stale state recovery: reclaim old runtimes whose launcher and Pi are both
	// gone (docs/tech.md §13.8). Best effort and non-blocking.
	if (config.janitor.staleRecovery) {
		for (const stale of findStaleStates(config)) {
			log.warn("found stale guard state; spawning recovery janitor", {
				action: "stale-recovery",
				guardId: stale.state.guardId,
			});
			spawn(process.execPath, [JANITOR_ENTRY, stateFilePath(stale.dir), "--recovery"], {
				detached: true,
				stdio: "ignore",
				env: configEnv(config, env),
			}).unref();
		}
	}

	// 1. Guard identity + initial state.
	const guardId = randomUUID();
	const stateDir = stateDirFor(config, guardId);
	const stateFile = stateFilePath(stateDir);
	const initialState: GuardStateFile = {
		version: 1,
		guardId,
		platform,
		backend: "process-group", // refined below by the backend
		launcherPid: process.pid,
		janitorPid: 0,
		piPid: 0,
		phase: "running",
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	writeState(stateDir, initialState);

	// 2. Start the mandatory janitor BEFORE Pi. If it fails to come up, abort
	// startup — never degrade to an unguarded runtime (docs/tech.md §25).
	const janitorEnv = configEnv(config, env);
	const janitor = spawn(process.execPath, [JANITOR_ENTRY, stateFile], {
		detached: true,
		stdio: "ignore",
		env: janitorEnv,
	});
	janitor.unref();
	const janitorPid = janitor.pid!;
	updateState(stateDir, { janitorPid });

	const ready = await waitForJanitorReady(stateDir, 5000, log);
	if (!ready) {
		log.error("janitor did not become ready; aborting guarded startup", {
			action: "startup-abort",
			janitorPid,
		});
		try {
			process.kill(janitorPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		deleteStateDir(stateDir);
		throw new Error("pi-process-guard: janitor failed to start — aborting (no unguarded fallback)");
	}

	// 3. Create the isolation domain and start Pi inside it.
	const backend = await createBackend(platform, config, {
		guardId,
		registryPath: join(stateDir, "registry.json"),
	});
	const guardVars = guardEnv(janitorEnv, {
		guardId,
		backend: backend.kind,
		launcherPid: process.pid,
		janitorPid,
		stateFile,
	});
	const started = await backend.start({ bin: opts.targetBin, args: opts.targetArgs, env: guardVars });

	// 4. Publish the runtime identity.
	updateState(stateDir, {
		backend: backend.kind,
		piPid: started.piPid,
		...(started.pgid ? { piPgid: started.pgid } : {}),
		...(started.unit ? { runtimeUnit: started.unit } : {}),
	});

	log.info("guarded runtime started", {
		action: "runtime-start",
		guardId,
		backend: backend.kind,
		pid: started.piPid,
		pgid: started.pgid,
		unit: started.unit,
		janitorPid,
	});

	opts.onStarted?.({
		guardId,
		stateDir,
		piPid: started.piPid,
		pgid: started.pgid,
		unit: started.unit,
		janitorPid,
	});

	// 5. Forward terminal signals to Pi; escalate to runtime cleanup if Pi
	// does not exit within the grace window (docs/tech.md §19.3).
	let escalationTimer: NodeJS.Timeout | undefined;
	const forwarded = new Set<NodeJS.Signals>();
	const forward = (signal: NodeJS.Signals): void => {
		if (forwarded.has(signal)) return;
		forwarded.add(signal);
		log.info("forwarding signal to Pi", { action: "signal-forward", signal, pid: started.piPid });
		try {
			process.kill(started.piPid, signal);
		} catch {
			/* Pi already gone */
		}
		escalationTimer ??= setTimeout(() => {
			if (pidAlive(started.piPid)) {
				log.warn("Pi did not exit after signal; marking runtime terminating", {
					action: "signal-escalation",
					signal,
				});
				updateState(stateDir, { phase: "terminating" });
			}
		}, config.signalExitGraceMs);
	};
	const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
		const h = (): void => forward(sig);
		process.on(sig, h);
		return { sig, h };
	});

	// Janitor supervision: if the janitor dies while Pi is running, restart it
	// so final cleanup still has an independent owner (docs/tech.md §25).
	let currentJanitorPid = janitorPid;
	let piExited = false;
	const janitorWatchdog = setInterval(() => {
		if (piExited || pidAlive(currentJanitorPid)) return;
		log.warn("janitor died; restarting", { action: "janitor-restart", janitorPid: currentJanitorPid });
		const replacement = spawn(process.execPath, [JANITOR_ENTRY, stateFile], {
			detached: true,
			stdio: "ignore",
			env: janitorEnv,
		});
		replacement.unref();
		currentJanitorPid = replacement.pid!;
		updateState(stateDir, { janitorPid: currentJanitorPid });
	}, config.janitor.heartbeatMs);
	janitorWatchdog.unref?.();

	let exitCode: number | null = null;
	try {
		exitCode = await started.exited;
	} finally {
		piExited = true;
		clearInterval(janitorWatchdog);
		for (const { sig, h } of handlers) process.removeListener(sig, h);
		if (escalationTimer) clearTimeout(escalationTimer);
	}

	log.info("Pi exited", { action: "pi-exit", pid: started.piPid, result: exitCode === null ? "signal" : String(exitCode) });

	// 6. Hand over final cleanup to the janitor and wait for it.
	updateState(stateDir, { phase: "terminating" });
	const deadline = Date.now() + config.termGraceMs + config.killVerifyMs + 5000;
	let janitorDone = false;
	while (Date.now() < deadline) {
		if (!pidAlive(currentJanitorPid) || !existsSync(stateFile)) {
			janitorDone = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 50));
	}

	if (!janitorDone) {
		log.error("janitor did not finish cleanup in time", { action: "janitor-timeout", janitorPid: currentJanitorPid });
		// Best-effort direct cleanup so the machine is never left with a live runtime.
		try {
			await backend.signalTerm();
			await new Promise((r) => setTimeout(r, config.termGraceMs));
			if (!(await backend.isClean())) await backend.signalKill();
		} catch {
			/* already handled */
		}
		deleteStateDir(stateDir);
	}

	return exitCode ?? 1;
}

async function waitForJanitorReady(stateDir: string, timeoutMs: number, log: ReturnType<typeof createLogger>): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const state = readState(stateDir);
		if (state?.janitorReadyAt) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	log.error("timed out waiting for janitor readiness");
	return false;
}
