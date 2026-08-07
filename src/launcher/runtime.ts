/**
 * pi-guard launcher core — startup state machine
 * (docs/pi-guard-startup-flow.md §5, §37).
 *
 *   INIT -> PREFLIGHT -> RUNTIME_DIR_CREATED -> JANITOR_STARTING ->
 *   JANITOR_READY -> (backend) -> PI_STARTING -> EXTENSION_READY -> RUNNING
 *     -> STOP_REQUESTED | FAILURE -> JANITOR_CLEANUP -> CLEAN -> EXIT
 *
 * The launcher never exec()s Pi: it stays alive for signal coordination and
 * hands final cleanup to the mandatory janitor over the control socket.
 * Fail-closed rules (docs §46):
 *   - no Pi without a READY janitor;
 *   - no RUNNING runtime without a healthy janitor (janitor death stops Pi);
 *   - no claims of protection without EXTENSION_READY.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { createLogger, type Logger } from "../log.ts";
import { createBackend, type GuardBackend, type BackendStarted } from "../platform/index.ts";
import { systemdUserAvailable } from "../platform/linux-systemd.ts";
import { deleteStateDir, stateDirFor, controlSocketPath, writeState, findStaleStates } from "../guard-state.ts";
import { getStartIdentity, pidAlive, killProcessGroup } from "../process-info.ts";
import { connectToJanitor, JANITOR_PROTOCOL_VERSION, type ProtocolClient } from "../protocol.ts";
import { EXIT_CODES } from "../exit-codes.ts";
import type { GuardBackendKind, GuardConfig, JanitorMessage } from "../types.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Guard-level startup failure with a stable exit code (docs §22.1). */
export class GuardStartupError extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.name = "GuardStartupError";
		this.code = code;
	}
}

export interface RunGuardOptions {
	targetBin: string;
	targetArgs: string[];
	config?: GuardConfig;
	env?: NodeJS.ProcessEnv;
	/**
	 * Inject the bundled guard extension via --extension (docs §13). Defaults
	 * to true; tests that substitute a fake `pi` without --extension support
	 * disable it.
	 */
	injectExtension?: boolean;
	/** Called once the runtime is up (after REGISTER_RUNTIME). */
	onStarted?: (info: {
		guardId: string;
		stateDir: string;
		piPid: number;
		pgid?: number;
		unit?: string;
		janitorPid: number;
	}) => void;
}

function packageRoot(): string {
	// import.meta.url points at a file (src/launcher/runtime.ts or
	// dist/src/launcher/runtime.js); ../.. from its directory reaches pkg/.
	return fileURLToPath(new URL("../..", import.meta.url));
}

/** Installed layout (node_modules) can only run compiled JS, not TS sources. */
function isInstalled(): boolean {
	return import.meta.url.includes("node_modules");
}

function resolveJanitorEntry(): string {
	const root = packageRoot();
	// Workspace runs prefer the TS source so edits apply without a rebuild;
	// installed packages prefer the compiled JS (Node refuses to strip TS in
	// node_modules).
	const candidates = isInstalled()
		? [
				join(root, "dist", "src", "janitor", "index.js"),
				join(root, "src", "janitor", "index.ts"),
			]
		: [
				join(root, "src", "janitor", "index.ts"),
				join(root, "dist", "src", "janitor", "index.js"),
			];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new GuardStartupError(EXIT_CODES.INTERNAL, "pi-process-guard: cannot resolve janitor entry");
}

/** Guard extension injected via --extension, ahead of user args (docs §13). */
export function resolveBundledExtension(): string {
	const root = packageRoot();
	const candidates = isInstalled()
		? [
				join(root, "dist", "extension.js"), // documented dist/extension.js layout
				join(root, "dist", "extensions", "index.js"), // compiled layout
				join(root, "extensions", "index.js"),
				join(root, "extensions", "index.ts"),
			]
		: [
				join(root, "extensions", "index.ts"), // plain workspace run
				join(root, "dist", "extensions", "index.js"),
				join(root, "dist", "extension.js"),
			];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new GuardStartupError(EXIT_CODES.INTERNAL, "pi-process-guard: cannot resolve bundled guard extension");
}

/** Resolved config values propagated so the detached janitor loads the same config. */
function configEnv(config: GuardConfig, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return {
		...env,
		PI_PROCESS_GUARD: config.enabled ? "1" : "0",
		PI_PROCESS_GUARD_TERM_GRACE_MS: String(config.termGraceMs),
		PI_PROCESS_GUARD_KILL_VERIFY_MS: String(config.killVerifyMs),
		PI_PROCESS_GUARD_JANITOR_HEARTBEAT_MS: String(config.janitor.heartbeatMs),
		PI_PROCESS_GUARD_JANITOR_ORPHAN_GRACE_MS: String(config.janitor.orphanGraceMs),
		PI_PROCESS_GUARD_JANITOR_READY_TIMEOUT_MS: String(config.janitor.readyTimeoutMs),
		PI_PROCESS_GUARD_EXTENSION_READY_TIMEOUT_MS: String(config.extension.readyTimeoutMs),
		PI_PROCESS_GUARD_STATE_ROOT: config.stateRoot,
		PI_PROCESS_GUARD_LOG_FILE: config.logging.file,
		PI_PROCESS_GUARD_LOG: config.logging.level,
		PI_PROCESS_GUARD_REQUIRE_CGROUP: config.linux.requireCgroup ? "1" : "0",
		...(config.configPath ? { PI_PROCESS_GUARD_CONFIG: config.configPath } : {}),
	};
}

/**
 * Minimal environment for the detached janitor (docs §11.3): no provider
 * secrets, no API keys. Only PATH/HOME/identity/locale plus the resolved
 * PI_PROCESS_GUARD_* config values the janitor needs to load its config.
 */
function filterJanitorEnv(full: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	const whitelist = new Set([
		"PATH",
		"HOME",
		"USER",
		"LOGNAME",
		"TMPDIR",
		"XDG_CACHE_HOME",
		"XDG_RUNTIME_DIR",
		"DBUS_SESSION_BUS_ADDRESS",
		"SHELL",
		"TERM",
		"LANG",
	]);
	for (const [key, value] of Object.entries(full)) {
		if (value === undefined) continue;
		if (
			whitelist.has(key) ||
			key.startsWith("LC_") ||
			key.startsWith("PI_PROCESS_GUARD_") ||
			key.startsWith("PI_GUARD_")
		) {
			out[key] = value;
		}
	}
	out.PI_GUARD_INTERNAL = "janitor";
	return out;
}

/** Guard identity variables consumed by the extension (docs §14). */
function guardEnv(
	base: NodeJS.ProcessEnv,
	identity: {
		guardId: string;
		backend: GuardBackendKind;
		runtimeDir: string;
		launcherPid: number;
		socketPath: string;
	},
): NodeJS.ProcessEnv {
	return {
		...base,
		PI_PROCESS_GUARD: "1",
		PI_GUARD_ID: identity.guardId,
		PI_GUARD_BACKEND: identity.backend,
		PI_GUARD_RUNTIME_DIR: identity.runtimeDir,
		PI_GUARD_LAUNCHER_PID: String(identity.launcherPid),
		PI_GUARD_SOCKET_PATH: identity.socketPath,
		PI_GUARD_LAUNCH_DEPTH: "1",
	};
}

/** Minimal unguarded passthrough (administrative invocations, disabled guard). */
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

/** Preflight: reclaim stale runtimes from earlier invocations (docs §31). */
async function recoverStaleRuntimes(config: GuardConfig, env: NodeJS.ProcessEnv, log: Logger): Promise<void> {
	if (!config.janitor.staleRecovery) return;
	let janitorEntry: string;
	try {
		janitorEntry = resolveJanitorEntry();
	} catch {
		return;
	}
	for (const stale of findStaleStates(config)) {
		log.warn("found stale guard runtime; spawning recovery janitor", {
			action: "stale-recovery",
			guardId: stale.state.guardId,
		});
		spawn(process.execPath, [janitorEntry, "--runtime-dir", stale.dir, "--guard-id", stale.state.guardId, "--recovery"], {
			detached: true,
			stdio: "ignore",
			env: filterJanitorEnv(configEnv(config, env)),
		}).unref();
	}
}

/** Select the platform backend kind; linux requires systemd when demanded. */
async function selectBackend(config: GuardConfig, log: Logger): Promise<GuardBackendKind> {
	if (process.platform === "darwin") return "process-group";
	const systemd = await systemdUserAvailable();
	if (config.linux.backend === "cgroup" || config.linux.requireCgroup) {
		if (!systemd) {
			throw new GuardStartupError(
				EXIT_CODES.BACKEND_UNAVAILABLE,
				"systemd user manager unavailable and --guard-require-cgroup is set",
			);
		}
		return "systemd-cgroup";
	}
	if (config.linux.backend === "auto" && systemd) return "systemd-cgroup";
	if (config.linux.backend === "auto" && !systemd) {
		log.warn("Linux systemd user manager unavailable; falling back to POSIX process tracking (degraded)");
	}
	return "process-group";
}

async function connectJanitorWithRetry(socketPath: string, timeoutMs: number): Promise<ProtocolClient | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		try {
			return await connectToJanitor(socketPath, Math.min(1000, remaining));
		} catch {
			await sleep(50);
		}
	}
}

/** TERM -> grace -> KILL emergency stop used when the janitor is gone. */
async function emergencyStop(backend: GuardBackend, config: GuardConfig): Promise<void> {
	try {
		await backend.signalTerm();
		await sleep(config.termGraceMs);
		if (!(await backend.isClean())) await backend.signalKill();
	} catch {
		// best effort
	}
}

const TERMINAL_SIGNALS = new Set<NodeJS.Signals>(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);
const FORWARD_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGWINCH", "SIGQUIT", "SIGCONT"];

/**
 * Run a guarded Pi runtime and return Pi's exit code once cleanup is complete.
 * Throws GuardStartupError with a stable exit code when the guard itself fails.
 */
export async function runGuard(opts: RunGuardOptions): Promise<number> {
	const env = opts.env ?? process.env;
	const config = opts.config ?? loadConfig(env);
	const log = createLogger(config);

	if (!config.enabled) return runPassthrough(opts, config);

	const platform = process.platform;
	if (platform !== "linux" && platform !== "darwin") {
		throw new GuardStartupError(EXIT_CODES.INTERNAL, `Unsupported platform for pi-process-guard: ${platform} (supported: linux, darwin)`);
	}

	// Phase 1: preflight — platform checked above; stale runtime recovery.
	await recoverStaleRuntimes(config, env, log);

	// Backend selection (linux systemd probe) — before any runtime artifacts.
	const backendKind = await selectBackend(config, log);

	// Phase 3+4: guard identity + runtime dir (docs §9, §10).
	const guardId = randomUUID();
	const stateDir = stateDirFor(config, guardId);
	const launcherStartIdentity = await getStartIdentity(process.pid);
	writeState(stateDir, {
		schemaVersion: 1,
		guardId,
		platform,
		backend: backendKind,
		state: "starting",
		launcherPid: process.pid,
		launcherStartIdentity,
		janitorPid: 0,
		piPid: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});

	// Phase 5+6: mandatory janitor + READY handshake (docs §11, §12).
	const janitorEntry = resolveJanitorEntry();
	const janitorEnv = filterJanitorEnv(configEnv(config, env));
	const janitor = spawn(
		process.execPath,
		[janitorEntry, "--runtime-dir", stateDir, "--guard-id", guardId, "--launcher-pid", String(process.pid)],
		{ detached: true, stdio: "ignore", env: janitorEnv },
	);
	janitor.unref();
	const janitorPid = janitor.pid!;

	const client = await connectJanitorWithRetry(controlSocketPath(config.stateRoot, guardId, stateDir), config.janitor.readyTimeoutMs);
	if (!client) {
		log.error("janitor did not become ready; aborting guarded startup", { action: "startup-abort", janitorPid });
		try {
			process.kill(janitorPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		deleteStateDir(stateDir);
		throw new GuardStartupError(EXIT_CODES.JANITOR_UNAVAILABLE, "pi-process-guard: janitor failed to start — Pi was not launched");
	}
	const ready = await client.waitFor("READY", Math.min(config.janitor.readyTimeoutMs, 2000));
	if (!ready || ready.protocolVersion !== JANITOR_PROTOCOL_VERSION) {
		log.error("janitor READY handshake failed", { action: "startup-abort", protocolVersion: ready?.protocolVersion });
		try {
			process.kill(janitorPid, "SIGKILL");
		} catch {
			/* already gone */
		}
		deleteStateDir(stateDir);
		throw new GuardStartupError(EXIT_CODES.JANITOR_UNAVAILABLE, "pi-process-guard: janitor protocol handshake failed — Pi was not launched");
	}
	log.info("janitor ready", { action: "janitor-ready", janitorPid, guardId: guardId.slice(0, 8) });

	// Phase 7: inject the bundled guard extension ahead of user args (docs §13).
	const piArgs =
		opts.injectExtension !== false
			? ["--extension", resolveBundledExtension(), ...opts.targetArgs]
			: [...opts.targetArgs];

	// Phase 8: runtime environment for Pi (docs §14).
	const piEnv = guardEnv(configEnv(config, env), {
		guardId,
		backend: backendKind,
		runtimeDir: stateDir,
		launcherPid: process.pid,
		socketPath: controlSocketPath(config.stateRoot, guardId, stateDir),
	});

	// Phase 9: create the isolation domain and start Pi inside it.
	const backend = await createBackend(platform, config, { guardId });
	let started: BackendStarted;
	try {
		started = await backend.start({ bin: opts.targetBin, args: piArgs, env: piEnv });
	} catch (err) {
		log.error("failed to start Pi runtime", { error: err instanceof Error ? err.message : String(err) });
		client.send({ type: "CLEANUP_REQUEST", reason: "backend-start-failed", generation: 1 });
		await client.waitFor("CLEANUP_DONE", 5000);
		deleteStateDir(stateDir);
		throw err instanceof GuardStartupError ? err : new GuardStartupError(EXIT_CODES.INTERNAL, err instanceof Error ? err.message : String(err));
	}

	// Phase 9.x: register the runtime with the janitor (docs §15.4, §17.4).
	client.send({
		type: "REGISTER_RUNTIME",
		guardId,
		platform,
		backend: backend.kind,
		piPid: started.piPid,
		...(started.pgid ? { piPgid: started.pgid } : {}),
		...(started.unit ? { unit: started.unit } : {}),
		piStartIdentity: await getStartIdentity(started.piPid),
	});
	log.info("guarded runtime started", {
		action: "runtime-start",
		guardId: guardId.slice(0, 8),
		backend: backend.kind,
		pid: started.piPid,
		pgid: started.pgid,
		unit: started.unit,
		janitorPid,
	});

	// Fail-closed janitor supervision is armed as soon as Pi is up (docs §27):
	// janitor death while Pi runs stops the runtime. Once Pi exits normally the
	// monitor is stopped, so the janitor's own exit after final cleanup is not
	// mistaken for a failure.
	const failClosed = installJanitorMonitor(janitorPid, started.piPid, config, log);
	void started.exited.then(() => failClosed.stop());

	opts.onStarted?.({
		guardId,
		stateDir,
		piPid: started.piPid,
		pgid: started.pgid,
		unit: started.unit,
		janitorPid,
	});

	// Phase 10: EXTENSION_READY handshake (docs §18). A live Pi without a
	// ready extension is a guard failure, not a quiet unguarded run. A janitor
	// death during this window is also fail-closed.
	let piExitCode: number | null | undefined;
	const readiness = await Promise.race([
		waitForExtensionOrPi(client, started, config.extension.readyTimeoutMs),
		failClosed.promise,
	]);
	if (readiness === FAIL_CLOSED) {
		return failClosedExit(config, guardId, stateDir, backend, log, client);
	}
	if (readiness.kind === "pi-exit") {
		piExitCode = readiness.exitCode;
		log.info("Pi exited before extension readiness; cleaning up", { action: "pi-exit-before-ready", code: String(piExitCode) });
		await requestCleanup(client, "pi-exit-before-ready");
		return normalizePiExit(piExitCode);
	}
	if (readiness.kind === "timeout") {
		log.error("guard extension did not initialize; terminating guarded Pi runtime", { action: "extension-timeout" });
		await requestCleanup(client, "extension-not-ready");
		return EXIT_CODES.EXTENSION_FAILURE;
	}

	// Phase 11: RUNNING — signal forwarding + janitor health monitoring.
	const stopRequested = { value: false };
	const escalation = installSignalForwarding(backend, started, stopRequested, config, () => {
		void requestCleanup(client, "signal-escalation");
	});

	// Wait for Pi to exit, or fail-closed if the janitor dies first.
	const exitResult = await Promise.race([started.exited, failClosed.promise]);
	stopRequested.value = true;
	cleanupSignalForwarding(escalation);

	if (exitResult === FAIL_CLOSED) {
		return failClosedExit(config, guardId, stateDir, backend, log, client);
	}

	piExitCode = exitResult as number | null;
	log.info("Pi exited", { action: "pi-exit", pid: started.piPid, result: piExitCode === null ? "signal" : String(piExitCode) });

	// Final cleanup handover: CLEANUP_REQUEST -> CLEANUP_DONE (docs §22). The
	// janitor removes the runtime dir before it exits; wait for its exit so the
	// launcher never returns while artifacts are still on disk.
	const finalTimeout = config.termGraceMs + config.killVerifyMs + 5000;
	const done = await requestCleanup(client, "pi-exit", finalTimeout);
	client.close();
	await waitForJanitorExit(janitorPid, 3000);
	if (done !== "clean") {
		log.error("janitor cleanup did not complete", { action: "cleanup-incomplete", result: done });
		return EXIT_CODES.CLEANUP_INCOMPLETE;
	}
	return normalizePiExit(piExitCode);
}

/** Wait until the janitor process is gone (it removes artifacts before exiting). */
async function waitForJanitorExit(janitorPid: number, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline && pidAlive(janitorPid)) {
		await sleep(50);
	}
}

const FAIL_CLOSED: { kind: "fail-closed" } = { kind: "fail-closed" };

async function failClosedExit(
	config: GuardConfig,
	guardId: string,
	stateDir: string,
	backend: GuardBackend,
	log: Logger,
	client: ProtocolClient,
): Promise<number> {
	log.error("janitor died while Pi was running; fail-closed: stopping runtime", { action: "janitor-death" });
	await emergencyStop(backend, config);
	// Remove the control socket (may live outside the runtime dir on long paths).
	try {
		const { unlinkSync, existsSync } = await import("node:fs");
		const socket = controlSocketPath(config.stateRoot, guardId, stateDir);
		if (existsSync(socket)) unlinkSync(socket);
	} catch {
		// best effort
	}
	deleteStateDir(stateDir);
	client.close();
	return EXIT_CODES.INTERNAL;
}

/** Pi exit code normalization: keep it, or 1 when killed by a signal. */
function normalizePiExit(code: number | null | undefined): number {
	return code ?? 1;
}

async function waitForExtensionOrPi(
	client: ProtocolClient,
	started: BackendStarted,
	timeoutMs: number,
): Promise<{ kind: "ready" } | { kind: "pi-exit"; exitCode: number | null } | { kind: "timeout" }> {
	if (timeoutMs <= 0) return { kind: "ready" };
	return new Promise((resolve) => {
		let done = false;
		const finish = (r: { kind: "ready" } | { kind: "pi-exit"; exitCode: number | null } | { kind: "timeout" }): void => {
			if (!done) {
				done = true;
				resolve(r);
			}
		};
		client.on("EXTENSION_READY", () => finish({ kind: "ready" }));
		void started.exited.then((code) => finish({ kind: "pi-exit", exitCode: code }));
		setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
	});
}

/** CLEANUP_REQUEST -> wait CLEANUP_DONE. Returns "clean" | "incomplete" | "timeout". */
async function requestCleanup(
	client: ProtocolClient,
	reason: string,
	timeoutMs = 10_000,
): Promise<"clean" | "incomplete" | "timeout"> {
	client.send({ type: "CLEANUP_REQUEST", reason, generation: 1 });
	const done = await client.waitFor("CLEANUP_DONE", timeoutMs);
	if (!done) return "timeout";
	return done.result;
}

interface EscalationHandles {
	timer: NodeJS.Timeout | undefined;
	handlers: { sig: NodeJS.Signals; h: () => void }[];
}

/**
 * Forward terminal signals to the Pi runtime (docs §17.3, §23). Termination
 * signals are handled once: mark STOP_REQUESTED, forward, then give Pi a
 * short window before escalating to janitor cleanup.
 */
function installSignalForwarding(
	backend: GuardBackend,
	started: BackendStarted,
	stopRequested: { value: boolean },
	config: GuardConfig,
	escalate: () => void,
): EscalationHandles {
	let timer: NodeJS.Timeout | undefined;
	const forward = (signal: NodeJS.Signals): void => {
		if (TERMINAL_SIGNALS.has(signal)) {
			if (stopRequested.value) return;
			stopRequested.value = true;
		}
		if (started.pgid) {
			try {
				killProcessGroup(started.pgid, signal);
			} catch {
				/* Pi already gone */
			}
		} else {
			try {
				process.kill(started.piPid, signal);
			} catch {
				/* Pi already gone */
			}
		}
		if (TERMINAL_SIGNALS.has(signal)) {
			timer ??= setTimeout(() => {
				if (pidAlive(started.piPid)) escalate();
			}, config.signalExitGraceMs);
		}
	};
	const handlers = FORWARD_SIGNALS.map((sig) => {
		const h = (): void => forward(sig);
		process.on(sig, h);
		return { sig, h };
	});
	return { timer, handlers };
}

function cleanupSignalForwarding(handles: EscalationHandles): void {
	for (const { sig, h } of handles.handlers) process.removeListener(sig, h);
	if (handles.timer) clearTimeout(handles.timer);
}

/**
 * Fail-closed janitor supervision (docs §27, invariant 6): if the mandatory
 * janitor dies **while Pi still runs**, the launcher must stop the runtime
 * instead of letting Pi continue unguarded. stop() is called once Pi exits
 * so the janitor's own exit after final cleanup is not treated as a failure.
 */
function installJanitorMonitor(
	janitorPid: number,
	piPid: number,
	config: GuardConfig,
	log: Logger,
): { promise: Promise<{ kind: "fail-closed" }>; stop(): void } {
	let stopped = false;
	let resolve!: (v: { kind: "fail-closed" }) => void;
	const promise = new Promise<{ kind: "fail-closed" }>((res) => {
		resolve = res;
	});
	const interval = setInterval(() => {
		if (stopped) return;
		if (!pidAlive(janitorPid) && pidAlive(piPid)) {
			stopped = true;
			clearInterval(interval);
			log.error("janitor died while Pi was running; fail-closed: stopping Pi runtime", { action: "janitor-death", janitorPid });
			resolve(FAIL_CLOSED);
		}
	}, config.janitor.heartbeatMs);
	interval.unref?.();
	return {
		promise,
		stop() {
			stopped = true;
			clearInterval(interval);
		},
	};
}
