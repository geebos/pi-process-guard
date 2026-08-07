/**
 * Unit tests: session manager lifecycle (docs/tech.md §6).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionManager, type SessionJob } from "../../src/session-manager.ts";

function job(id: string): SessionJob {
	return { id, command: "npm run dev", startedAt: Date.now() };
}

test("beginSession replaces the session and clears jobs", () => {
	const sm = createSessionManager();
	sm.beginSession("s1");
	sm.trackJob(job("a"));
	sm.trackJob(job("b"));
	assert.equal(sm.jobCount, 2);
	assert.equal(sm.currentSessionId, "s1");

	sm.beginSession("s2");
	assert.equal(sm.currentSessionId, "s2");
	assert.equal(sm.jobCount, 0, "new session starts empty");
});

test("cleanupSession is idempotent and reports stopped jobs", async () => {
	const sm = createSessionManager();
	sm.beginSession("s1");
	sm.trackJob(job("a"));

	const first = await sm.cleanupSession();
	assert.deepEqual(first, { stopped: 1 });
	assert.equal(sm.jobCount, 0);

	const second = await sm.cleanupSession();
	assert.deepEqual(second, { stopped: 0 }, "repeated cleanup is a no-op");
});

test("listJobs returns a snapshot of tracked jobs", () => {
	const sm = createSessionManager();
	sm.beginSession("s1");
	sm.trackJob(job("a"));
	const snapshot = sm.listJobs();
	assert.equal(snapshot.length, 1);
	snapshot.pop();
	assert.equal(sm.jobCount, 1, "mutating the snapshot does not affect the manager");
});
