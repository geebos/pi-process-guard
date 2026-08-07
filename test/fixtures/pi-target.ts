#!/usr/bin/env node
/**
 * Fake Pi main process used by integration tests.
 *
 * Modes (FIXTURE_MODE):
 *   keepalive  — stay alive until SIGTERM/SIGINT, exit 0 (no children)
 *   normal     — like keepalive, plus spawn `sleep <secs>` in the background
 *   exit       — exit with FIXTURE_EXIT_CODE after a short delay (no children)
 *   exit-bg    — spawn `sleep <secs>`, then exit with FIXTURE_EXIT_CODE
 *
 * Child PIDs are appended to FIXTURE_PID_FILE (one `tag pid` per line) so
 * tests can assert on them.
 */

import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const mode = process.env.FIXTURE_MODE ?? "normal";
const sleepSecs = process.env.FIXTURE_CHILD_SLEEP_SECS ?? "600";
const exitCode = Number(process.env.FIXTURE_EXIT_CODE ?? "0");
const pidFile = process.env.FIXTURE_PID_FILE;

function note(tag: string, pid: number): void {
	if (pidFile) {
		try {
			appendFileSync(pidFile, `${tag} ${pid}\n`);
		} catch {
			// diagnostics only
		}
	}
}

function spawnBackground(): void {
	const child = spawn("sleep", [sleepSecs], { stdio: "ignore" });
	note("child", child.pid ?? -1);
}

note("self", process.pid);

switch (mode) {
	case "exit":
		setTimeout(() => process.exit(exitCode), 200);
		break;
	case "exit-bg":
		spawnBackground();
		setTimeout(() => process.exit(exitCode), 200);
		break;
	case "normal":
		spawnBackground();
	// fallthrough: keep alive
	case "keepalive":
		process.on("SIGTERM", () => process.exit(0));
		process.on("SIGINT", () => process.exit(0));
		setInterval(() => {}, 1000);
		break;
	default:
		process.stderr.write(`[fixture] unknown FIXTURE_MODE: ${mode}\n`);
		process.exit(2);
}
