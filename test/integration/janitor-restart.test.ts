/**
 * Fail-closed janitor supervision (docs/pi-guard-startup-flow.md §27,
 * invariant 6): the janitor dies while Pi runs => the launcher must stop the
 * runtime instead of letting Pi continue unguarded, and exit with the guard
 * internal-failure code (70).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EXIT_CODES } from "../../src/exit-codes.ts";
import { pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../bin/pi-guard.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/pi-target.ts", import.meta.url));

test("janitor death triggers fail-closed runtime stop (exit 70)", { timeout: 60000 }, async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-guard-janitor-death-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_PROCESS_GUARD_TARGET_BIN: process.execPath,
		PI_PROCESS_GUARD_STATE_ROOT: stateRoot,
		PI_PROCESS_GUARD_JANITOR_HEARTBEAT_MS: "200",
		PI_PROCESS_GUARD_TERM_GRACE_MS: "400",
		PI_PROCESS_GUARD_KILL_VERIFY_MS: "400",
		PI_PROCESS_GUARD_LOG_FILE: join(stateRoot, "guard.log"),
	};

	const launcher = spawn(process.execPath, [CLI, FIXTURE], { env, stdio: "ignore" });
	const exitPromise = new Promise<number | null>((resolve) => launcher.on("exit", (code) => resolve(code)));

	// Wait for Pi + janitor to come up.
	const runtimeRoot = join(stateRoot, "runtime");
	await waitFor(
		async () => {
			const dirs = existsSync(runtimeRoot) ? readdirSync(runtimeRoot) : [];
			if (dirs.length === 0) return false;
			const s = JSON.parse(readFileSync(join(runtimeRoot, dirs[0]!, "state.json"), "utf8")) as {
				piPid: number;
				janitorPid: number;
			};
			return s.piPid > 0 && s.janitorPid > 0 && pidAlive(s.piPid) && pidAlive(s.janitorPid);
		},
		10000,
		100,
	);
	const stateDir = join(runtimeRoot, readdirSync(runtimeRoot)[0]!);
	const stateFile = join(stateDir, "state.json");
	const initial = JSON.parse(readFileSync(stateFile, "utf8")) as { janitorPid: number; piPid: number };

	// Kill the mandatory janitor.
	process.kill(initial.janitorPid, "SIGKILL");
	await waitFor(() => !pidAlive(initial.janitorPid), 5000);

	// Fail-closed: the launcher must stop Pi and exit with the internal code.
	const exitCode = await exitPromise;
	assert.equal(exitCode, EXIT_CODES.INTERNAL, "launcher exits with guard internal failure (70)");
	assert.equal(pidAlive(initial.piPid), false, "Pi must not continue unguarded after janitor death");
	assert.equal(existsSync(stateFile), false, "runtime state dir is removed after fail-closed stop");
});
