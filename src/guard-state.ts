/**
 * Guard runtime state protocol.
 *
 * Each guarded runtime owns a directory `<stateRoot>/runtime/<guardId>/`
 * (docs/pi-guard-startup-flow.md §10):
 *
 *   state.json     runtime-management metadata only (never argv/env/prompts)
 *   janitor.sock   unix control socket (newline-delimited JSON, §20)
 *   ready          empty marker file published once the janitor is READY
 *   registry.json  macOS descendant registry (janitor-driven, §21)
 *   janitor.log    debug log (only created with --guard-debug)
 *
 * state.json is written atomically (tmp + rename) with 0600; the runtime dir
 * is created 0700. The launcher creates it, the janitor removes it as its
 * final act.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GuardConfig, GuardStateFile } from "./types.ts";
import { pidAlive } from "./process-info.ts";

export const STATE_FILE_NAME = "state.json";
export const SOCKET_FILE_NAME = "janitor.sock";
export const READY_FILE_NAME = "ready";
export const REGISTRY_FILE_NAME = "registry.json";

export function stateDirFor(config: GuardConfig, guardId: string): string {
	return join(config.stateRoot, "runtime", guardId);
}

export function stateFilePath(dir: string): string {
	return join(dir, STATE_FILE_NAME);
}

/**
 * Control-socket path for a runtime (docs §10 lists janitor.sock inside the
 * runtime dir). macOS unix sockets are limited to ~104 bytes and Linux ~108;
 * when the runtime-dir path would exceed that (long tmpdirs in tests), the
 * socket falls back to `<stateRoot>/<shortId>.sock` — same isolation, shorter
 * path. Both janitor and launcher must agree on the chosen path.
 */
export function controlSocketPath(stateRoot: string, guardId: string, dir: string): string {
	const preferred = join(dir, SOCKET_FILE_NAME);
	const limit = process.platform === "darwin" ? 100 : 104;
	if (preferred.length <= limit) return preferred;
	return join(stateRoot, `${guardId.slice(0, 8)}.sock`);
}

export function socketFilePath(dir: string): string {
	return join(dir, SOCKET_FILE_NAME);
}

export function readyFilePath(dir: string): string {
	return join(dir, READY_FILE_NAME);
}

export function registryFilePath(dir: string): string {
	return join(dir, REGISTRY_FILE_NAME);
}

/** Create the per-guard runtime directory with 0700 permissions. */
export function ensureRuntimeDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function writeState(dir: string, state: GuardStateFile): void {
	ensureRuntimeDir(dir);
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
		// Accept the legacy `version` field (pre-schema-rename state files).
		const version = parsed.schemaVersion ?? (parsed as GuardStateFile & { version?: number }).version;
		if (version !== 1 || typeof parsed.guardId !== "string") return undefined;
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

/** List all known runtime directories (including stale ones). */
export function listStateDirs(config: GuardConfig): string[] {
	const root = join(config.stateRoot, "runtime");
	if (!existsSync(root)) return [];
	try {
		return readdirSync(root).map((name) => join(root, name));
	} catch {
		return [];
	}
}

/**
 * Find runtime directories whose ownership is gone: both the launcher and
 * the Pi main process are dead, so a recovery janitor may reclaim them
 * (docs §31). The recovery janitor re-verifies PID identities before acting.
 */
export function findStaleStates(config: GuardConfig): { dir: string; state: GuardStateFile }[] {
	const stale: { dir: string; state: GuardStateFile }[] = [];
	for (const dir of listStateDirs(config)) {
		const state = readState(dir);
		if (!state) continue;
		if (state.state === "clean") continue;
		const launcherAlive = pidAlive(state.launcherPid);
		const piAlive = pidAlive(state.piPid);
		if (launcherAlive || piAlive) continue;
		stale.push({ dir, state });
	}
	return stale;
}
