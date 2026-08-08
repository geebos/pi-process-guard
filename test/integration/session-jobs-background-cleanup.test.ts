/**
 * Session jobs: a backgrounded command is tracked and terminated by
 * cleanupSession on session switch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listPgidMembers, pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";
import { setupSession, runWrapped } from "./session-jobs-helpers.ts";

test("backgrounded command is tracked and terminated by cleanupSession", { timeout: 30000 }, async () => {
	const { sm, root } = setupSession();
	const wrapped = sm.wrapCommand("sleep 600 &");
	const child = runWrapped(wrapped);

	// bash tool would return immediately for a backgrounded command.
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);

	// The job record is published and the background sleep is in its PGID.
	let sleepPid: number | undefined;
	await waitFor(async () => {
		if (sm.readJobRecords().length === 0) return false;
		const members = await listPgidMembers(sm.readJobRecords()[0]!.pgid);
		sleepPid = members.find((m) => m.comm === "sleep")?.pid;
		return sleepPid !== undefined;
	}, 5000);
	assert.ok(sleepPid, "background sleep lives in the job process group");

	// Session switch: everything owned by the session must die.
	const { stopped } = await sm.cleanupSession();
	assert.equal(stopped, 1);
	assert.equal(pidAlive(sleepPid), false, "background sleep terminated by session cleanup");
	assert.equal(existsSync(join(root, "sessions", "it-session")), false, "session dir removed");
});
