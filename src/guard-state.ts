/**
 * Guard runtime state protocol.
 *
 * Each guarded runtime owns a directory `<stateRoot>/<guardId>/` containing a
 * single `state.json`, written atomically (tmp + rename). The launcher writes
 * it; the janitor reads it and removes it as its final act (docs/tech.md §13.3).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig, GuardStateFile } from "./types.ts";
import { pidAlive } from "./process-info.ts";

export const STATE_FILE_NAME = "state.json";

export function stateDirFor(config: GuardConfig, guardId: string): string {
	return join(config.stateRoot, "pi-process-guard", guardId);
}

export function stateFilePath(dir: string): string {
	return join(dir, STATE_FILE_NAME);
}

export function writeState(dir: string, state: GuardStateFile): void {
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `${STATE_FILE_NAME}.tmp`);
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, join(dir, STATE_FILE_NAME));
}

/** Read the state file; undefined when missing or unparseable. */
export function readState(dir: string): GuardStateFile | undefined {
	const path = stateFilePath(dir);
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as GuardStateFile;
		if (parsed.version !== 1 || typeof parsed.guardId !== "string") return undefined;
		return parsed;
	} catch {
		return undefined;
	}
}

/** Read-modify-write an updated state file. */
export function updateState(dir: string, patch: Partial<GuardStateFile>): GuardStateFile | undefined {
	const current = readState(dir);
	if (!current) return undefined;
	const next: GuardStateFile = { ...current, ...patch, updatedAt: Date.now() };
	writeState(dir, next);
	return next;
}

/** Remove a guard state directory (janitor's final act). */
export function deleteStateDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

/** List all known guard state directories (including stale ones). */
export function listStateDirs(config: GuardConfig): string[] {
	const root = join(config.stateRoot, "pi-process-guard");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root).map((name) => join(root, name));
	} catch {
		return [];
	}
}

/**
 * Find state directories whose runtime is no longer valid: both the launcher
 * and the Pi main process are gone, so a recovery janitor may reclaim them
 * (docs/tech.md §13.8).
 */
export function findStaleStates(config: GuardConfig): { dir: string; state: GuardStateFile }[] {
	const stale: { dir: string; state: GuardStateFile }[] = [];
	for (const dir of listStateDirs(config)) {
		const state = readState(dir);
		if (!state) continue;
		const launcherAlive = pidAlive(state.launcherPid);
		const piAlive = pidAlive(state.piPid);
		if (launcherAlive || piAlive) continue;
		stale.push({ dir, state });
	}
	return stale;
}


