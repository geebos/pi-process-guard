/**
 * Multi-instance isolation: two guarded runtimes running in parallel must not
 * affect each other. Ending instance A reclaims A's descendants only;
 * instance B's processes stay alive until B ends. Release-blocking test
 * (docs/tech.md §23.5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor, readPids } from "../helpers.ts";

async function instanceWithChild(marker: string, sleepSecs: string): Promise<{ guard: Awaited<ReturnType<typeof startGuard>>; childPid: number }> {
	const pidFile = join(mkdtempSync(join(tmpdir(), `pi-guard-${marker}-`)), "pids.txt");
	const guard = await startGuard({ mode: "normal", sleepSecs, pidFile });
	await waitFor(() => readPids(pidFile).child?.length === 1, 5000);
	return { guard, childPid: readPids(pidFile).child[0]! };
}

test("two guarded runtimes are isolated", { timeout: 60000 }, async () => {
	const a = await instanceWithChild("a", "137");
	const b = await instanceWithChild("b", "139");

	assert.equal(pidAlive(a.childPid), true, "A child alive");
	assert.equal(pidAlive(b.childPid), true, "B child alive");

	// End instance A hard.
	process.kill(a.guard.piPid, "SIGKILL");
	await a.guard.exitPromise;
	assert.equal(pidAlive(a.childPid), false, "A child must be reclaimed");
	assert.equal(pidAlive(b.childPid), true, "B child must survive A's teardown");
	assert.equal(pidAlive(b.guard.piPid), true, "B Pi must survive A's teardown");

	// End instance B.
	process.kill(b.guard.piPid, "SIGKILL");
	await b.guard.exitPromise;
	assert.equal(pidAlive(b.childPid), false, "B child must be reclaimed");
});
