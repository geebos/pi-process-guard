/**
 * SIGKILL: Pi is force-killed with no chance for JavaScript cleanup. The
 * independent janitor must observe Pi's death and reclaim the runtime domain
 * including background children (docs/tech.md §12.3, §23.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFilePath } from "../../src/guard-state.ts";
import { pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor, pgidEmpty, readPids } from "../helpers.ts";

test("SIGKILL of Pi: janitor reclaims background child", { timeout: 30000 }, async () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "pi-guard-pids-")), "pids.txt");
	const guard = await startGuard({ mode: "normal", sleepSecs: "600", pidFile });

	// Wait until the fixture's background `sleep 600` child is registered.
	await waitFor(() => readPids(pidFile).child?.length === 1, 5000);
	const childPid = readPids(pidFile).child[0]!;
	assert.equal(pidAlive(childPid), true, "background child should be alive before kill");
	assert.equal(pidAlive(guard.piPid), true, "pi should be alive before kill");

	process.kill(guard.piPid, "SIGKILL");

	const exitCode = await guard.exitPromise;
	assert.equal(exitCode, 1, "launcher exits non-zero when Pi is killed by a signal");

	const clean = await waitFor(() => pgidEmpty(guard.pgid), 8000);
	assert.equal(clean, true, "process group should be empty after janitor cleanup");
	assert.equal(pidAlive(childPid), false, "background child must be reclaimed");
	assert.equal(existsSync(stateFilePath(guard.stateDir)), false, "state dir should be removed");
	assert.equal(pidAlive(guard.janitorPid), false, "janitor should have exited");
});
