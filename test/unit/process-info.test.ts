/**
 * Unit tests: process inspection helpers (liveness, PGID enumeration,
 * start identity).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { pidAlive, listPgidMembers, getStartIdentity, startIdentityMatches, getPgid } from "../../src/process-info.ts";

test("pidAlive distinguishes live and dead pids", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(999_971), false);
	assert.equal(pidAlive(0), false);
	assert.equal(pidAlive(-1), false);
});

test("listPgidMembers enumerates a detached child's process group", async () => {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	const pgid = child.pid!;
	try {
		const members = await listPgidMembers(pgid);
		assert.ok(members.some((m) => m.pid === pgid), "group leader present");
	} finally {
		process.kill(pgid, "SIGKILL");
	}
});

test("start identity is stable and matches only the same process", async () => {
	const identity = await getStartIdentity(process.pid);
	assert.ok(identity, "start identity readable");
	assert.equal(await startIdentityMatches(process.pid, identity), true);
	assert.equal(await startIdentityMatches(process.pid, "some-other-identity"), false);
	assert.equal(await startIdentityMatches(999_972, undefined), false);
});

test("getPgid resolves the process group id", async () => {
	const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
	try {
		const pgid = await getPgid(child.pid!);
		assert.equal(pgid, child.pid, "detached child leads its own group");
	} finally {
		process.kill(child.pid!, "SIGKILL");
	}
});
