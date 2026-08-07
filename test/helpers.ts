/**
 * Shared helpers for pi-process-guard integration tests.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG, type GuardConfig } from "../src/config.ts";
import { runGuard } from "../src/guard.ts";
import { listPgidMembers } from "../src/process-info.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const FIXTURE = fileURLToPath(new URL("./fixtures/pi-target.ts", import.meta.url));

/** Fast, isolated test config. */
export function testConfig(stateRoot: string): GuardConfig {
	return {
		...DEFAULT_CONFIG,
		enabled: true,
		termGraceMs: 400,
		killVerifyMs: 400,
		signalExitGraceMs: 2000,
		stateRoot,
		janitor: { ...DEFAULT_CONFIG.janitor, heartbeatMs: 100, orphanGraceMs: 1500 },
		macos: { ...DEFAULT_CONFIG.macos, registryIntervalMs: 100 },
		linux: { ...DEFAULT_CONFIG.linux, backend: "process-group" },
		logging: { level: "error", file: join(stateRoot, "guard-test.log") },
		configPath: join(stateRoot, "process-guard.json"),
	};
}

export interface GuardHarness {
	exitPromise: Promise<number>;
	guardId: string;
	stateDir: string;
	piPid: number;
	pgid: number;
	janitorPid: number;
}

export interface StartGuardOptions {
	mode?: string;
	sleepSecs?: string;
	exitCode?: string;
	pidFile?: string;
	stateRoot?: string;
	env?: NodeJS.ProcessEnv;
}

export async function startGuard(opts: StartGuardOptions = {}): Promise<GuardHarness> {
	const stateRoot = opts.stateRoot ?? mkdtempSync(join(tmpdir(), "pi-guard-test-"));
	const config = testConfig(stateRoot);
	let started: Omit<GuardHarness, "exitPromise"> | undefined;

	const exitPromise = runGuard({
		targetBin: process.execPath,
		targetArgs: [FIXTURE],
		config,
		env: {
			...process.env,
			...opts.env,
			FIXTURE_MODE: opts.mode ?? "normal",
			...(opts.sleepSecs ? { FIXTURE_CHILD_SLEEP_SECS: opts.sleepSecs } : {}),
			...(opts.exitCode ? { FIXTURE_EXIT_CODE: opts.exitCode } : {}),
			...(opts.pidFile ? { FIXTURE_PID_FILE: opts.pidFile } : {}),
		},
		onStarted: (info) => {
			started = { ...info, pgid: info.pgid ?? 0 };
		},
	});

	while (!started) await sleep(10);
	return { exitPromise, ...started };
}

/** Read `tag pid` lines written by the fixture. */
export function readPids(pidFile: string): Record<string, number[]> {
	const out: Record<string, number[]> = {};
	try {
		for (const line of readFileSync(pidFile, "utf8").split("\n")) {
			const m = line.trim().match(/^(\S+)\s+(\d+)$/);
			if (!m) continue;
			(out[m[1]] ??= []).push(Number(m[2]));
		}
	} catch {
		// file not written yet
	}
	return out;
}

export async function waitFor(
	check: () => Promise<boolean>,
	timeoutMs: number,
	intervalMs = 50,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return true;
		if (Date.now() >= deadline) return false;
		await sleep(Math.min(intervalMs, deadline - Date.now()));
	}
}

/** True when the process group holds no processes owned by the current user. */
export async function pgidEmpty(pgid: number): Promise<boolean> {
	return (await listPgidMembers(pgid)).length === 0;
}

