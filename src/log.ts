/**
 * Structured logger for pi-process-guard.
 *
 * Writes JSON lines to a log file (default ~/.pi/agent/logs/process-guard.log)
 * and echoes warn/error to stderr when enabled. Never logs full command lines:
 * they may contain tokens or sensitive arguments (docs/tech.md §18).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { GuardConfig, LogLevel } from "./types.ts";

/** npm package / plugin name, included in every log record and printed by cleanup. */
export const PLUGIN_NAME = "pi-process-guard";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

export interface LogContext {
	guardId?: string;
	sessionId?: string;
	backend?: string;
	action?: string;
	pid?: number;
	pgid?: number;
	unit?: string;
	signal?: string;
	result?: string;
	error?: string;
	/** Additional structured fields recorded as-is. */
	[key: string]: unknown;
}

export interface Logger {
	debug(msg: string, ctx?: LogContext): void;
	info(msg: string, ctx?: LogContext): void;
	warn(msg: string, ctx?: LogContext): void;
	error(msg: string, ctx?: LogContext): void;
}

export function createLogger(config: Pick<GuardConfig, "logging">, ctx?: LogContext): Logger {
	const { level, file } = config.logging;
	const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.warn;
	let fileOpened = false;

	const ensureFile = (): void => {
		if (fileOpened) return;
		try {
			mkdirSync(dirname(file), { recursive: true });
			fileOpened = true;
		} catch {
			// Logging must never crash the guarded runtime.
		}
	};

	const write = (entryLevel: LogLevel, message: string, extra: LogContext | undefined): void => {
		if (LEVEL_ORDER[entryLevel] < threshold) return;
		const record = {
			ts: new Date().toISOString(),
			level: entryLevel,
			msg: message,
			plugin: PLUGIN_NAME,
			...ctx,
			...extra,
		};
		const line = `${JSON.stringify(record)}\n`;
		ensureFile();
		try {
			appendFileSync(file, line);
		} catch {
			// Best effort only.
		}
		if (entryLevel === "warn" || entryLevel === "error") {
			process.stderr.write(`[${PLUGIN_NAME}] ${entryLevel}: ${message}\n`);
		}
	};

	return {
		debug: (msg, extra) => write("debug", msg, extra),
		info: (msg, extra) => write("info", msg, extra),
		warn: (msg, extra) => write("warn", msg, extra),
		error: (msg, extra) => write("error", msg, extra),
	};
}
