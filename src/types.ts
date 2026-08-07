/**
 * Shared types for pi-process-guard (launcher / janitor / extension).
 *
 * Mirrors the runtime state and protocol contracts from
 * docs/pi-guard-startup-flow.md (§5, §10, §20).
 */

/** OS-level ownership domain used for a guarded Pi runtime. */
export type GuardBackendKind = "systemd-cgroup" | "process-group";

/** Lifecycle state of a guarded runtime (docs §5 state machine). */
export type GuardRuntimeState = "starting" | "running" | "cleaning" | "clean";

/** Logging level. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Protection strength reported for diagnostics. systemd cgroup is strong;
 * POSIX process-group tracking is degraded/best-effort.
 */
export type GuardProtection = "strong" | "degraded" | "best-effort-high";

/** Resolved configuration. See docs §36 (timeouts) and §7 (backends). */
export interface GuardConfig {
	enabled: boolean;
	/** SIGTERM grace period before escalating to SIGKILL (ms). */
	termGraceMs: number;
	/** Window after SIGKILL to verify the domain is empty (ms). */
	killVerifyMs: number;
	/** Window the launcher waits for Pi to exit after forwarding a signal (ms). */
	signalExitGraceMs: number;
	janitor: {
		heartbeatMs: number;
		staleRecovery: boolean;
		/** Window a janitor waits for a dead launcher to recover before declaring the runtime orphaned (ms). */
		orphanGraceMs: number;
		/** How long the launcher waits for the janitor READY handshake (ms). */
		readyTimeoutMs: number;
	};
	extension: {
		/** How long the launcher waits for EXTENSION_READY after Pi starts (ms). 0 disables the wait. */
		readyTimeoutMs: number;
	};
	macos: {
		/** Descendant registry sample interval (ms); janitor-driven. */
		registryIntervalMs: number;
	};
	linux: {
		backend: "auto" | "cgroup" | "process-group";
		/** Transient unit prefix, e.g. pi-guard-<shortId>.scope */
		systemdUnitPrefix: string;
		/** Fail startup when the systemd user manager is unavailable. */
		requireCgroup: boolean;
	};
	logging: {
		level: LogLevel;
		file: string;
	};
	/**
	 * Root directory holding all guard data: `<root>/runtime/<guardId>/`
	 * (runtime state) and `<root>/sessions/` (session jobs).
	 */
	stateRoot: string;
	/** Path of the JSON config file this configuration was loaded from. */
	configPath: string;
}

/**
 * Persistent per-guard runtime state file. Written atomically by the
 * launcher, kept up to date by the janitor. It holds only runtime-management
 * metadata — never argv, environment or prompts (docs §10.2).
 */
export interface GuardStateFile {
	schemaVersion: 1;
	guardId: string;
	platform: NodeJS.Platform;
	backend: GuardBackendKind;
	state: GuardRuntimeState;
	launcherPid: number;
	/** Process start identity of the launcher (PID reuse protection). */
	launcherStartIdentity?: string;
	janitorPid: number;
	janitorStartIdentity?: string;
	piPid: number;
	piStartIdentity?: string;
	/** POSIX process group id of the Pi runtime (process-group backend). */
	piPgid?: number;
	/** systemd transient unit name (systemd-cgroup backend). */
	runtimeUnit?: string;
	createdAt: number;
	updatedAt: number;
	/** Set by the janitor once it is ready to supervise. */
	janitorReadyAt?: number;
	/** Set once the guard extension confirmed it loaded (EXTENSION_READY). */
	extensionReadyAt?: number;
	/** Incremented per cleanup; lets janitor answer repeated requests idempotently. */
	cleanupGeneration?: number;
	/** Last cleanup reason recorded by the janitor. */
	cleanupReason?: string;
}

/** Result of a TERM → KILL cleanup run. */
export interface CleanupResult {
	outcome: "clean" | "kill-required" | "not-clean";
	durationMs: number;
}

/** Snapshot of the guarded runtime for diagnostics. */
export interface RuntimeSnapshot {
	backend: GuardBackendKind;
	piPid: number;
	piPgid?: number;
	runtimeUnit?: string;
	/** Processes currently present in the runtime domain. */
	trackedProcesses: number;
}

/* ------------------------------------------------------------------ */
/* Janitor control protocol (newline-delimited JSON over a unix socket) */
/* ------------------------------------------------------------------ */

export const JANITOR_PROTOCOL_VERSION = 1;

export interface ReadyMessage {
	type: "READY";
	guardId: string;
	janitorPid: number;
	protocolVersion: number;
}

export interface RegisterRuntimeMessage {
	type: "REGISTER_RUNTIME";
	guardId: string;
	platform: NodeJS.Platform;
	backend: GuardBackendKind;
	piPid: number;
	piPgid?: number;
	unit?: string;
	piStartIdentity?: string;
}

export interface ExtensionReadyMessage {
	type: "EXTENSION_READY";
	guardId: string;
	piPid: number;
}

export interface HeartbeatMessage {
	type: "HEARTBEAT";
	launcherPid: number;
}

export interface CleanupRequestMessage {
	type: "CLEANUP_REQUEST";
	reason: string;
	generation: number;
}

export interface CleanupDoneMessage {
	type: "CLEANUP_DONE";
	result: "clean" | "incomplete";
	reason: string;
	generation: number;
}

export type JanitorMessage =
	| ReadyMessage
	| RegisterRuntimeMessage
	| ExtensionReadyMessage
	| HeartbeatMessage
	| CleanupRequestMessage
	| CleanupDoneMessage;
