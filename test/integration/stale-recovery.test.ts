/**
 * Stale state recovery: a leftover state directory whose launcher and Pi are
 * both gone is reclaimed by a recovery janitor on the next guarded startup
 * (docs/tech.md §13.8, §23.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { stateDirFor, stateFilePath, writeState } from "../../src/guard-state.ts";
import { pidAlive } from "../../src/process-info.ts";
import { startGuard, testConfig, waitFor } from "../helpers.ts";
import type { GuardStateFile } from "../../src/types.ts";

test("stale state dir with dead launcher+pi is reclaimed on next startup", { timeout: 30000 }, async () => {
	const stateRoot = mkdtempSync(join(tmpdir(), "pi-guard-stale-"));
	const config = testConfig(stateRoot);

	// A real process that plays the role of a leftover runtime descendant.
	const staleChild = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const stalePgid = staleChild.pid!;
	assert.equal(pidAlive(staleChild.pid!), true, "stale child should start alive");

	const staleGuardId = "00000000-0000-4000-8000-00000000dead";
	const staleDir = stateDirFor(config, staleGuardId);
	const now = Date.now();
	writeState(staleDir, {
		version: 1,
		guardId: staleGuardId,
		platform: process.platform as NodeJS.Platform,
		backend: "process-group",
		launcherPid: 999_991, // definitely dead
		janitorPid: 0,
		piPid: 999_992, // definitely dead
		piPgid: stalePgid,
		phase: "running",
		createdAt: now,
		updatedAt: now,
	} satisfies GuardStateFile);

	// Starting any guarded runtime triggers the stale recovery scan.
	const guard = await startGuard({ mode: "keepalive", stateRoot });

	const recovered = await waitFor(() => !existsSync(stateFilePath(staleDir)), 8000);
	assert.equal(recovered, true, "stale state dir should be removed by the recovery janitor");
	await waitFor(() => !pidAlive(staleChild.pid!), 8000);
	assert.equal(pidAlive(staleChild.pid!), false, "stale runtime process should be reclaimed");

	// Teardown of the live guard.
	process.kill(guard.piPid, "SIGTERM");
	await guard.exitPromise;
});
