/**
 * Configuration for pi-process-guard.
 *
 * Resolution order (lowest to highest precedence):
 *   defaults -> file config (~/.pi/agent/process-guard.json) -> environment
 * See docs/tech.md §16.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import type { GuardConfig, LogLevel } from "./types.ts";

export const CONFIG_FILE_NAME = "process-guard.json";

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) {
		return join(homedir(), path.slice(2));
	}
	return path;
}

/**
 * Default state root: $XDG_CACHE_HOME/pi-process-guard or ~/.cache/pi-process-guard.
 * Runtime dirs live under `<root>/runtime/<guardId>/` (docs §10).
 */
export function defaultStateRoot(env: NodeJS.ProcessEnv = process.env): string {
	const xdg = env.XDG_CACHE_HOME;
	if (xdg && xdg.trim()) return join(expandHome(xdg), "pi-process-guard");
	return join(homedir(), ".cache", "pi-process-guard");
}

/** Default log file location: ~/.pi/agent/logs/process-guard.log */
export function defaultLogFile(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.PI_CODING_AGENT_DIR;
	const agentDir = configured ? expandHome(configured) : join(homedir(), ".pi", "agent");
	return join(agentDir, "logs", "process-guard.log");
}

export const DEFAULT_CONFIG: GuardConfig = {
	enabled: true,
	termGraceMs: 2000,
	killVerifyMs: 1000,
	signalExitGraceMs: 5000,
	janitor: {
		heartbeatMs: 1000,
		staleRecovery: true,
		orphanGraceMs: 10000,
		readyTimeoutMs: 2000,
	},
	extension: {
		readyTimeoutMs: 5000,
	},
	macos: {
		registryIntervalMs: 1000,
	},
	linux: {
		backend: "auto",
		systemdUnitPrefix: "pi-guard",
		requireCgroup: false,
	},
	logging: {
		level: "info",
		file: defaultLogFile(),
	},
	stateRoot: defaultStateRoot(),
	configPath: join(homedir(), ".pi", "agent", CONFIG_FILE_NAME),
};

const isLogLevel = (v: unknown): v is LogLevel =>
	v === "debug" || v === "info" || v === "warn" || v === "error";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
	return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
	if (typeof v === "boolean") return v;
	if (typeof v === "string") {
		if (v === "1" || v.toLowerCase() === "true") return true;
		if (v === "0" || v.toLowerCase() === "false") return false;
	}
	return fallback;
}

function pick(obj: unknown, key: string): unknown {
	return typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * Load a partial config from a JSON file. Unknown / malformed entries are
 * ignored rather than aborting the guard.
 */
export function loadFileConfig(path: string): Partial<GuardConfig> {
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof raw !== "object" || raw === null) return {};
		const out: Partial<GuardConfig> = {};
		const r = raw as Record<string, unknown>;
		if (r.enabled !== undefined) out.enabled = bool(r.enabled, true);
		if (r.termGraceMs !== undefined) out.termGraceMs = num(r.termGraceMs, DEFAULT_CONFIG.termGraceMs);
		if (r.killVerifyMs !== undefined) out.killVerifyMs = num(r.killVerifyMs, DEFAULT_CONFIG.killVerifyMs);
		if (r.signalExitGraceMs !== undefined)
			out.signalExitGraceMs = num(r.signalExitGraceMs, DEFAULT_CONFIG.signalExitGraceMs);
		if (r.logging !== undefined) {
			const logging = pick(r, "logging") as Record<string, unknown>;
			const level = pick(logging, "level");
			if (isLogLevel(level)) out.logging = { ...DEFAULT_CONFIG.logging, level };
		}
		if (r.janitor !== undefined) {
			const janitor = pick(r, "janitor") as Record<string, unknown>;
			out.janitor = {
				...DEFAULT_CONFIG.janitor,
				...(pick(janitor, "heartbeatMs") !== undefined
					? { heartbeatMs: num(janitor.heartbeatMs, DEFAULT_CONFIG.janitor.heartbeatMs) }
					: {}),
				...(pick(janitor, "staleRecovery") !== undefined
					? { staleRecovery: bool(janitor.staleRecovery, true) }
					: {}),
				...(pick(janitor, "orphanGraceMs") !== undefined
					? { orphanGraceMs: num(janitor.orphanGraceMs, DEFAULT_CONFIG.janitor.orphanGraceMs) }
					: {}),
				...(pick(janitor, "readyTimeoutMs") !== undefined
					? { readyTimeoutMs: num(janitor.readyTimeoutMs, DEFAULT_CONFIG.janitor.readyTimeoutMs) }
					: {}),
			};
		}
		if (r.extension !== undefined) {
			const extension = pick(r, "extension") as Record<string, unknown>;
			if (pick(extension, "readyTimeoutMs") !== undefined) {
				out.extension = {
					...DEFAULT_CONFIG.extension,
					readyTimeoutMs: num(extension.readyTimeoutMs, DEFAULT_CONFIG.extension.readyTimeoutMs),
				};
			}
		}
		if (r.macos !== undefined) {
			const macos = pick(r, "macos") as Record<string, unknown>;
			if (pick(macos, "registryIntervalMs") !== undefined) {
				out.macos = {
					...DEFAULT_CONFIG.macos,
					registryIntervalMs: num(macos.registryIntervalMs, DEFAULT_CONFIG.macos.registryIntervalMs),
				};
			}
		}
		if (r.linux !== undefined) {
			const linux = pick(r, "linux") as Record<string, unknown>;
			out.linux = {
				...DEFAULT_CONFIG.linux,
				...(pick(linux, "backend") === "cgroup" || pick(linux, "backend") === "process-group"
					? { backend: pick(linux, "backend") as "cgroup" | "process-group" }
					: {}),
				...(typeof pick(linux, "systemdUnitPrefix") === "string"
					? { systemdUnitPrefix: pick(linux, "systemdUnitPrefix") as string }
					: {}),
				...(pick(linux, "requireCgroup") !== undefined
					? { requireCgroup: bool(linux.requireCgroup, false) }
					: {}),
			};
		}
		return out;
	} catch {
		return {};
	}
}

/**
 * Persist a partial config to the JSON config file, merging with any existing
 * content (unknown keys are preserved). Atomic tmp+rename, 0600. Returns false
 * when the write fails.
 */
export function saveFileConfig(path: string, patch: Partial<GuardConfig>): boolean {
	const existing: Record<string, unknown> = existsSync(path)
		? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
		: {};
	const next: Record<string, unknown> = { ...existing };
	if (patch.enabled !== undefined) next.enabled = patch.enabled;
	if (patch.termGraceMs !== undefined) next.termGraceMs = patch.termGraceMs;
	if (patch.killVerifyMs !== undefined) next.killVerifyMs = patch.killVerifyMs;
	if (patch.logging !== undefined) next.logging = { ...(next.logging as object | undefined), ...patch.logging };
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
		return true;
	} catch {
		return false;
	}
}

/** Merge env overrides (PI_PROCESS_GUARD_*) on top of a base config. */
export function applyEnvOverrides(base: GuardConfig, env: NodeJS.ProcessEnv = process.env): GuardConfig {
	const cfg: GuardConfig = { ...base };
	if (env.PI_PROCESS_GUARD !== undefined) cfg.enabled = bool(env.PI_PROCESS_GUARD, true);
	if (env.PI_PROCESS_GUARD_TERM_GRACE_MS !== undefined)
		cfg.termGraceMs = num(env.PI_PROCESS_GUARD_TERM_GRACE_MS, cfg.termGraceMs);
	if (env.PI_PROCESS_GUARD_KILL_VERIFY_MS !== undefined)
		cfg.killVerifyMs = num(env.PI_PROCESS_GUARD_KILL_VERIFY_MS, cfg.killVerifyMs);
	if (env.PI_PROCESS_GUARD_LOG !== undefined && isLogLevel(env.PI_PROCESS_GUARD_LOG))
		cfg.logging = { ...cfg.logging, level: env.PI_PROCESS_GUARD_LOG };
	if (env.PI_PROCESS_GUARD_STATE_ROOT !== undefined)
		cfg.stateRoot = expandHome(env.PI_PROCESS_GUARD_STATE_ROOT);
	if (env.PI_PROCESS_GUARD_LOG_FILE !== undefined)
		cfg.logging = { ...cfg.logging, file: expandHome(env.PI_PROCESS_GUARD_LOG_FILE) };
	if (env.PI_PROCESS_GUARD_JANITOR_HEARTBEAT_MS !== undefined)
		cfg.janitor = { ...cfg.janitor, heartbeatMs: num(env.PI_PROCESS_GUARD_JANITOR_HEARTBEAT_MS, cfg.janitor.heartbeatMs) };
	if (env.PI_PROCESS_GUARD_JANITOR_ORPHAN_GRACE_MS !== undefined)
		cfg.janitor = { ...cfg.janitor, orphanGraceMs: num(env.PI_PROCESS_GUARD_JANITOR_ORPHAN_GRACE_MS, cfg.janitor.orphanGraceMs) };
	if (env.PI_PROCESS_GUARD_JANITOR_READY_TIMEOUT_MS !== undefined)
		cfg.janitor = { ...cfg.janitor, readyTimeoutMs: num(env.PI_PROCESS_GUARD_JANITOR_READY_TIMEOUT_MS, cfg.janitor.readyTimeoutMs) };
	if (env.PI_PROCESS_GUARD_EXTENSION_READY_TIMEOUT_MS !== undefined)
		cfg.extension = { ...cfg.extension, readyTimeoutMs: num(env.PI_PROCESS_GUARD_EXTENSION_READY_TIMEOUT_MS, cfg.extension.readyTimeoutMs) };
	if (env.PI_PROCESS_GUARD_REQUIRE_CGROUP !== undefined)
		cfg.linux = { ...cfg.linux, requireCgroup: bool(env.PI_PROCESS_GUARD_REQUIRE_CGROUP, false) };
	return cfg;
}

/**
 * Resolve the effective configuration: defaults, overlaid with the JSON file,
 * overlaid with environment variables.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GuardConfig {
	const filePath = expandHome(env.PI_PROCESS_GUARD_CONFIG ?? DEFAULT_CONFIG.configPath);
	const base: GuardConfig = { ...DEFAULT_CONFIG, ...loadFileConfig(filePath), configPath: filePath };
	return applyEnvOverrides(base, env);
}
