/**
 * Background shell child (`sleep 600 &`): must be reclaimed when the runtime
 * ends — both on graceful exit and on crash (docs/tech.md §23.1, §23.3).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor, readPids } from "../helpers.ts";

async function startedBackgroundChild(): Promise<{ guard: Awaited<ReturnType<typeof startGuard>>; childPid: number }> {
	const pidFile = join(mkdtempSync(join(tmpdir(), "pi-guard-pids-")), "pids.txt");
	const guard = await startGuard({ mode: "normal", sleepSecs: "600", pidFile });
	await waitFor(() => readPids(pidFile).child?.length === 1, 5000);
	const childPid = readPids(pidFile).child[0]!;
	return { guard, childPid };
}

test("background child reclaimed on graceful runtime exit", { timeout: 30000 }, async () => {
	const { guard, childPid } = await startedBackgroundChild();
	assert.equal(pidAlive(childPid), true, "background child should be alive");

	process.kill(guard.piPid, "SIGTERM");
	await guard.exitPromise;

	assert.equal(pidAlive(childPid), false, "background child must be gone after runtime exit");
});

test("background child reclaimed on Pi crash", { timeout: 30000 }, async () => {
	const { guard, childPid } = await startedBackgroundChild();

	process.kill(guard.piPid, "SIGKILL");
	await guard.exitPromise;

	assert.equal(pidAlive(childPid), false, "background child must be gone after crash");
});
