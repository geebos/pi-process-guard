/**
 * In-memory runtime context shared by the extension modules.
 *
 * The launcher publishes guard identity through PI_PROCESS_GUARD_* env vars
 * (docs/tech.md §20); the extension reads them here and keeps the session
 * manager reference for commands.
 */

import type { SessionProcessManager } from "./session-manager.ts";

export interface GuardRuntimeContext {
	guardId?: string;
	backend?: string;
	launcherPid?: number;
	janitorPid?: number;
	stateFile?: string;
	pgid?: number;
	unit?: string;
}

/** Read the guard handshake variables from the process environment. */
export function readGuardEnv(env: NodeJS.ProcessEnv = process.env): GuardRuntimeContext {
	const num = (v: string | undefined): number | undefined => {
		const n = v === undefined ? Number.NaN : Number(v);
		return Number.isInteger(n) && n > 0 ? n : undefined;
	};
	return {
		guardId: env.PI_PROCESS_GUARD_ID,
		backend: env.PI_PROCESS_GUARD_BACKEND,
		launcherPid: num(env.PI_PROCESS_GUARD_PARENT_PID),
		janitorPid: num(env.PI_PROCESS_GUARD_JANITOR_PID),
		stateFile: env.PI_PROCESS_GUARD_STATE_FILE,
		pgid: num(env.PI_PROCESS_GUARD_RUNTIME_PGID),
		unit: env.PI_PROCESS_GUARD_RUNTIME_UNIT,
	};
}

let runtimeContext: GuardRuntimeContext = readGuardEnv();

/** True when the extension runs under the pi-guard launcher. */
export function hasLauncher(): boolean {
	return Boolean(runtimeContext.guardId);
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
