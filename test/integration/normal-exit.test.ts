/**
 * Normal exit: Pi terminates gracefully (SIGTERM), the janitor reclaims the
 * runtime domain, the state directory is removed, and the launcher mirrors
 * Pi's exit code (docs/tech.md §22.1, §23.1).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFilePath } from "../../src/guard-state.ts";
import { pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor, pgidEmpty, readPids } from "../helpers.ts";

test("graceful SIGTERM exit leaves no processes and preserves exit code", { timeout: 30000 }, async () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "pi-guard-pids-")), "pids.txt");
	const guard = await startGuard({ mode: "keepalive", pidFile });

	// Wait until the fixture installed its signal handlers (it records its own
	// pid synchronously before registering them).
	await waitFor(() => readPids(pidFile).self?.length === 1, 5000);

	// Pi is alive inside its own process group.
	assert.equal(pidAlive(guard.piPid), true, "pi should be alive");

	process.kill(guard.piPid, "SIGTERM");

	const exitCode = await guard.exitPromise;
	assert.equal(exitCode, 0, "launcher should mirror Pi exit code");

	const clean = await waitFor(() => pgidEmpty(guard.pgid), 5000);
	assert.equal(clean, true, "process group should be empty after cleanup");

	assert.equal(existsSync(stateFilePath(guard.stateDir)), false, "state dir should be removed");
	assert.equal(pidAlive(guard.janitorPid), false, "janitor should have exited");
});
