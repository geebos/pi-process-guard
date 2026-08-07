/**
 * Shared types for pi-process-guard (launcher / janitor / extension).
 *
 * Mirrors the runtime state and config contracts from docs/tech.md.
 */

/** OS-level ownership domain used for a guarded Pi runtime. */
export type GuardBackendKind = "systemd-cgroup" | "process-group";

/** Lifecycle phase of a guarded runtime. */
export type GuardPhase = "running" | "terminating" | "clean";

/** Logging level. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Resolved configuration. See docs/tech.md §16. */
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
	};
	macos: {
		/** Descendant registry sample interval (ms). Used from Phase 3 on. */
		registryIntervalMs: number;
	};
	linux: {
		backend: "auto" | "cgroup" | "process-group";
		systemdUnitPrefix: string;
	};
	logging: {
		level: LogLevel;
		file: string;
	};
	/** Root directory holding per-guard state directories. */
	stateRoot: string;
	/** Path of the JSON config file this configuration was loaded from. */
	configPath: string;
}

/**
 * Persistent per-guard runtime state file.
 * Written atomically by the launcher, read by the janitor. See docs/tech.md §13.3.
 */
export interface GuardStateFile {
	version: 1;
	guardId: string;
	platform: NodeJS.Platform;
	backend: GuardBackendKind;
	launcherPid: number;
	janitorPid: number;
	piPid: number;
	/** POSIX process group id of the Pi runtime (process-group backend). */
	piPgid?: number;
	/** systemd transient unit name (systemd-cgroup backend). */
	runtimeUnit?: string;
	phase: GuardPhase;
	createdAt: number;
	updatedAt: number;
	/** Set by the janitor once it is ready to supervise. */
	janitorReadyAt?: number;
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
