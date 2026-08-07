/**
 * Platform backends for the guarded Pi runtime (docs/tech.md §7, §8).
 *
 * - Linux:    systemd transient user service / cgroup (fallback: process group)
 * - macOS:    POSIX process group (+ descendant registry from Phase 3 on)
 *
 * The backend owns the OS isolation domain: everything spawned inside the
 * runtime inherits it, so the guard never needs to know which extension
 * created a process.
 */

import type { GuardBackendKind, GuardConfig, RuntimeSnapshot } from "../types.ts";
import { createProcessGroupBackend } from "./posix-process-group.ts";
import { createSystemdBackend, systemdUserAvailable } from "./linux-systemd.ts";

export interface BackendStarted {
	/** Pi main process pid. */
	piPid: number;
	/** POSIX process group id (process-group backend). */
	pgid?: number;
	/** systemd transient unit name (systemd-cgroup backend). */
	unit?: string;
	/** Resolves with the Pi exit code (null when killed by a signal). */
	exited: Promise<number | null>;
}

export interface GuardBackend {
	readonly kind: GuardBackendKind;
	/** Launch the Pi process inside the isolation domain. */
	start(target: { bin: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<BackendStarted>;
	/** SIGTERM the whole runtime domain. */
	signalTerm(): Promise<void>;
	/** SIGKILL surviving members of the runtime domain. */
	signalKill(): Promise<void>;
	/** True when the runtime domain holds no (owned) processes. */
	isClean(): Promise<boolean>;
	/** Diagnostic snapshot. */
	snapshot(): Promise<RuntimeSnapshot>;
}

export class UnsupportedPlatformError extends Error {
	constructor(platform: string) {
		super(`Unsupported platform for pi-process-guard: ${platform} (supported: linux, darwin)`);
		this.name = "UnsupportedPlatformError";
	}
}

export interface BackendContext {
	guardId: string;
	pgid?: number;
	runtimeUnit?: string;
}

/**
 * Resolve the backend for a platform. `state` provides the domain handles
 * (pgid / systemd unit) for existing runtimes (janitor path); the launcher
 * passes only the guard id.
 */
export async function createBackend(
	platform: NodeJS.Platform,
	config: GuardConfig,
	state: BackendContext,
): Promise<GuardBackend> {
	switch (platform) {
		case "darwin":
			return createProcessGroupBackend(config, state);
		case "linux": {
			const wantCgroup =
				config.linux.backend === "cgroup" ||
				(config.linux.backend === "auto" && (await systemdUserAvailable()));
			if (wantCgroup) return createSystemdBackend(config, state);
			return createProcessGroupBackend(config, state);
		}
		default:
			throw new UnsupportedPlatformError(platform);
	}
}
