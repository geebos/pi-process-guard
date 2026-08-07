/**
 * Phase 4 hardening: launcher is SIGKILLed while Pi is alive. The janitor
 * must not kill Pi immediately — it enters an orphan grace window, then
 * reclaims the whole orphaned runtime (docs/tech.md §12.4, §23.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stateFilePath } from "../../src/guard-state.ts";
import { listPgidMembers, pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";

const CLI = fileURLToPath(new URL("../../bin/pi-guard.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../fixtures/pi-target.ts", import.meta.url));

test("launcher SIGKILL: janitor reclaims the orphaned runtime after grace", { timeout: 60000 }, async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-guard-crash-"));
	const env: NodeJS.ProcessEnv = {
		...process.env,
		PI_PROCESS_GUARD_TARGET_BIN: process.execPath,
		PI_PROCESS_GUARD_STATE_ROOT: stateRoot,
		PI_PROCESS_GUARD_JANITOR_ORPHAN_GRACE_MS: "1500",
		PI_PROCESS_GUARD_TERM_GRACE_MS: "400",
		PI_PROCESS_GUARD_KILL_VERIFY_MS: "400",
		PI_PROCESS_GUARD_LOG_FILE: join(stateRoot, "guard.log"),
		PI_PROCESS_GUARD_LOG: "debug",
	};

	const launcher = spawn(process.execPath, [CLI, FIXTURE], {
		env,
		stdio: "ignore",
	});

	// Wait for the state file to appear and Pi to come up.
	await waitFor(
		async () => {
			const file = join(stateRoot, "runtime");
			const dirs = existsSync(file) ? readdirSync(file) : [];
			if (dirs.length === 0) return false;
			const state = JSON.parse(readFileSync(join(file, dirs[0]!, "state.json"), "utf8")) as {
				piPid: number;
				janitorPid: number;
			};
			return state.piPid > 0 && pidAlive(state.piPid) && pidAlive(state.janitorPid);
		},
		10000,
		100,
	);

	const stateDir = join(stateRoot, "runtime", readdirSync(join(stateRoot, "runtime"))[0]!);
	const state = JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")) as {
		launcherPid: number;
		piPid: number;
		janitorPid: number;
		piPgid: number;
	};
	assert.equal(pidAlive(state.piPid), true, "Pi alive before launcher crash");

	// SIGKILL the launcher; Pi must survive past the orphan grace window.
	process.kill(launcher.pid!, "SIGKILL");
	await waitFor(() => !pidAlive(launcher.pid!), 5000);

	const survivedGrace = await new Promise<boolean>((resolve) => {
		setTimeout(() => resolve(pidAlive(state.piPid)), 1200);
	});
	assert.equal(survivedGrace, true, "Pi must survive launcher death during the grace window");

	// After the grace window, the janitor reclaims the orphaned runtime.
	const reclaimed = await waitFor(() => !pidAlive(state.piPid), 15000);
	assert.equal(reclaimed, true, "orphaned Pi reclaimed after grace window");
	await waitFor(() => !pidAlive(state.janitorPid), 5000);
	await waitFor(async () => (await listPgidMembers(state.piPgid)).length === 0, 5000);
	assert.equal(existsSync(stateFilePath(stateDir)), false, "state dir removed");
});
