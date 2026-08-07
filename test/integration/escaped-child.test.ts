/**
 * Phase 3: a descendant that escapes the Pi process group (setsid() /
 * detached, new PGID) is still reclaimed after Pi is SIGKILLed — via the
 * descendant registry with PID start-identity verification.
 * (docs/tech.md §8.3–§8.5, §23.1 "process calls setsid()" case)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateFilePath } from "../../src/guard-state.ts";
import { getPgid, pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor, readPids } from "../helpers.ts";

test("escaped (setsid) child is reclaimed after Pi SIGKILL via registry", { timeout: 60000 }, async () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "pi-guard-pids-")), "pids.txt");
	const guard = await startGuard({ mode: "escape", sleepSecs: "600", pidFile });

	// The fixture spawns an escaped (detached) child.
	await waitFor(() => readPids(pidFile).escaped?.length === 1, 5000);
	const escapedPid = readPids(pidFile).escaped[0]!;
	assert.equal(pidAlive(escapedPid), true, "escaped child alive before kill");

	// It truly escaped the Pi process group.
	const escapedPgid = await getPgid(escapedPid);
	assert.notEqual(escapedPgid, guard.pgid, "escaped child has its own PGID");

	// Give the launcher's registry sampler time to record it.
	await waitFor(async () => {
		const registryPath = join(guard.stateDir, "registry.json");
		if (!existsSync(registryPath)) return false;
		const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { pid: number }[];
		return parsed.some((p) => p.pid === escapedPid);
	}, 6000);

	// Kill Pi hard.
	process.kill(guard.piPid, "SIGKILL");
	await guard.exitPromise;

	const reclaimed = await waitFor(() => !pidAlive(escapedPid), 8000);
	assert.equal(reclaimed, true, "escaped child reclaimed via registry after Pi SIGKILL");
	assert.equal(existsSync(stateFilePath(guard.stateDir)), false, "state dir removed");
});

