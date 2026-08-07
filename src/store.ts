/**
 * In-memory runtime context shared by the extension modules.
 *
 * The launcher publishes guard identity through PI_GUARD_* env vars
 * (docs/pi-guard-startup-flow.md §14); the extension reads them here and
 * keeps the session manager reference for commands.
 */

import type { SessionProcessManager } from "./session-manager.ts";

export interface GuardRuntimeContext {
	active: boolean;
	guardId?: string;
	backend?: string;
	launcherPid?: number;
	runtimeDir?: string;
	/** Control socket path (may differ from runtimeDir/janitor.sock on long paths). */
	socketPath?: string;
}

/** Read the guard handshake variables from the process environment. */
export function readGuardEnv(env: NodeJS.ProcessEnv = process.env): GuardRuntimeContext {
	const num = (v: string | undefined): number | undefined => {
		const n = v === undefined ? Number.NaN : Number(v);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	const active = env.PI_PROCESS_GUARD === "1" && Boolean(env.PI_GUARD_ID);
	return {
		active,
		guardId: env.PI_GUARD_ID,
		backend: env.PI_GUARD_BACKEND,
		launcherPid: num(env.PI_GUARD_LAUNCHER_PID),
		runtimeDir: env.PI_GUARD_RUNTIME_DIR,
		socketPath: env.PI_GUARD_SOCKET_PATH,
	};
}

let runtimeContext: GuardRuntimeContext = readGuardEnv();

/** True when the extension runs under the pi-guard launcher. */
export function hasLauncher(): boolean {
	return runtimeContext.active;
}

export function getRuntimeContext(): GuardRuntimeContext {
	return runtimeContext;
}

export function setRuntimeContext(ctx: GuardRuntimeContext): void {
	runtimeContext = ctx;
}

let sessionManager: SessionProcessManager | undefined;

export function setSessionManager(sm: SessionProcessManager): void {
	sessionManager = sm;
}

export function getSessionManager(): SessionProcessManager | undefined {
	return sessionManager;
}
