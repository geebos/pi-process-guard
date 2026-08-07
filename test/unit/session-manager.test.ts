/**
 * Unit tests: session manager lifecycle (docs/tech.md §6).
 *
 * Counting is disk-backed: cleanup totals reflect on-disk job records (each
 * carries the pgid that actually gets signalled), not the in-memory cache of
 * every command ever wrapped. Foreground commands remove their record on
 * finish, so they never inflate the count.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionProcessManager, sessionDirFor } from "../../src/session-manager.ts";

function setup(): { sm: SessionProcessManager; root: string } {
	const root = join(mkdtempSync(join(tmpdir(), "pi-guard-sm-")), "root");
	const sm = new SessionProcessManager(root);
	sm.beginSession("s1");
	return { sm, root };
}

/** Publish an on-disk job record (as session-exec would). */
function writeJob(root: string, sessionId: string, jobId: string, pgid: number): void {
	const dir = join(sessionDirFor(root, sessionId), "jobs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `${jobId}.json`),
		JSON.stringify({ jobId, pid: pgid, pgid, startedAt: Date.now() }),
	);
}

test("beginSession replaces the session; counting is disk-backed", () => {
	const { sm, root } = setup();
	writeJob(root, "s1", "a", 9001);
	writeJob(root, "s1", "b", 9002);
	assert.equal(sm.jobCount, 2);

	sm.beginSession("s2");
	assert.equal(sm.currentSessionId, "s2");
	assert.equal(sm.jobCount, 0, "new session has no disk records yet");
});

test("cleanupSession counts only on-disk records (real signalled jobs)", async () => {
	const { sm, root } = setup();
	// A memory-cache entry whose disk record is already gone (a foreground
	// command that finished) must NOT inflate the count.
	sm.trackJob({ id: "ghost", command: "ls", startedAt: Date.now() });
	writeJob(root, "s1", "real", 9001);

	const first = await sm.cleanupSession();
	assert.deepEqual(first, { stopped: 1 }, "only the on-disk record counts");
	assert.equal(sm.jobCount, 0);

	const second = await sm.cleanupSession();
	assert.deepEqual(second, { stopped: 0 }, "repeated cleanup is a no-op");
});

test("pendingJobCount reflects only records cleanup can signal", async () => {
	const { sm, root } = setup();
	assert.equal(sm.pendingJobCount(), 0);

	// Memory-only entries (write-window cache, no pgid) do not count.
	sm.trackJob({ id: "pending", command: "echo hi", startedAt: Date.now() });
	assert.equal(sm.pendingJobCount(), 0, "no pgid → cannot be signalled → not counted");

	writeJob(root, "s1", "real", 9001);
	assert.equal(sm.pendingJobCount(), 1, "on-disk record with pgid counts");
});

test("listJobs is backed by on-disk records", () => {
	const { sm, root } = setup();
	sm.trackJob({ id: "ghost", command: "ls", startedAt: Date.now() });
	writeJob(root, "s1", "real", 9001);

	const snapshot = sm.listJobs();
	assert.equal(snapshot.length, 1, "only on-disk jobs listed");
	assert.equal(snapshot[0]!.id, "real");
});
