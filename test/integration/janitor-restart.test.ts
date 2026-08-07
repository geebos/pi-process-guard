/**
 * Phase 4 hardening: the janitor dies while Pi runs; the launcher restarts it,
 * and the replacement janitor still performs the final cleanup (docs/tech.md §25).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateFilePath } from "../../src/guard-state.ts";
import { pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../bin/pi-guard.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/pi-target.ts", import.meta.url));

test("janitor death triggers launcher restart; replacement cleans up", { timeout: 60000 }, async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-guard-janitor-restart-"));
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

	const stateDir = join(stateRoot, "pi-process-guard");
	await waitFor(
		async () => {
			const dirs = existsSync(stateDir) ? readdirSync(stateDir) : [];
			if (dirs.length === 0) return false;
			const s = JSON.parse(readFileSync(join(stateDir, dirs[0]!, "state.json"), "utf8")) as {
				piPid: number;
				janitorPid: number;
			};
			return s.piPid > 0 && s.janitorPid > 0 && pidAlive(s.piPid) && pidAlive(s.janitorPid);
		},
		10000,
		100,
	);
	const dir = join(stateDir, readdirSync(stateDir)[0]!);
	const stateFile = join(dir, "state.json");
	const initial = JSON.parse(readFileSync(stateFile, "utf8")) as { janitorPid: number; piPid: number };

	// Kill the janitor.
	process.kill(initial.janitorPid, "SIGKILL");
	await waitFor(() => !pidAlive(initial.janitorPid), 5000);

	// The launcher must restart it and update the state.
	const restarted = await waitFor(
		async () => {
			const s = JSON.parse(readFileSync(stateFile, "utf8")) as { janitorPid: number };
			return s.janitorPid !== initial.janitorPid && pidAlive(s.janitorPid);
		},
		10000,
		100,
	);
	assert.equal(restarted, true, "launcher restarts the janitor");
	const restartedState = JSON.parse(readFileSync(stateFile, "utf8")) as { janitorPid: number };
	assert.equal(pidAlive(restartedState.janitorPid), true, "replacement janitor alive");

	// Graceful Pi exit must be cleaned up by the replacement janitor.
	process.kill(initial.piPid, "SIGTERM");
	await waitFor(() => !pidAlive(initial.piPid), 8000);
	const cleaned = await waitFor(() => !pidAlive(restartedState.janitorPid) && !existsSync(stateFile), 10000);
	assert.equal(cleaned, true, "replacement janitor finishes final cleanup");
	await launcher.kill?.();
});
