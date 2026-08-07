/**
 * Unit tests: session command wrapping (Phase 2).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionProcessManager, shq } from "../../src/session-manager.ts";

function manager(): SessionProcessManager {
	const sm = new SessionProcessManager(join(mkdtempSync(join(tmpdir(), "pi-guard-sess-")), "root"));
	sm.beginSession("session-1");
	return sm;
}

test("shq single-quotes and escapes embedded quotes", () => {
	assert.equal(shq("npm run dev"), "'npm run dev'");
	assert.equal(shq("it's"), `'it'\\''s'`);
});

test("wrapCommand wraps into session-exec with quoted command", () => {
	const sm = manager();
	const wrapped = sm.wrapCommand("cd dir && npm run dev");
	assert.ok(wrapped.includes("--"), "contains separator");
	assert.ok(wrapped.includes("'cd dir && npm run dev'"), "whole command stays inside one quote");
	assert.ok(wrapped.startsWith("PI_GUARD_SESSION_DIR="), "carries session dir");
	assert.ok(wrapped.includes("PI_GUARD_JOB_ID="), "carries job id");
	assert.ok(wrapped.includes("PI_GUARD_PI_PID="), "carries pi pid");
});

test("wrapCommand is idempotent", () => {
	const sm = manager();
	const wrapped = sm.wrapCommand("echo hi");
	assert.equal(sm.wrapCommand(wrapped), wrapped, "already-wrapped commands are not re-wrapped");
});

test("wrapCommand without an active session returns the command untouched", () => {
	const sm = new SessionProcessManager(join(mkdtempSync(join(tmpdir(), "pi-guard-sess-")), "root"));
	assert.equal(sm.wrapCommand("echo hi"), "echo hi");
});

test("wrapCommand preserves shell operators inside the quoted command", () => {
	const sm = manager();
	const wrapped = sm.wrapCommand("a && b; c | d > f");
	// The wrapped command must contain the whole original as one argument.
	const inner = wrapped.slice(wrapped.indexOf("-- ") + 3);
	assert.equal(inner, "'a && b; c | d > f'");
});

test("cleanupSession is idempotent and reports stopped jobs", async () => {
	const sm = manager();
	assert.deepEqual(await sm.cleanupSession(), { stopped: 0 });
	assert.deepEqual(await sm.cleanupSession(), { stopped: 0 });
});
