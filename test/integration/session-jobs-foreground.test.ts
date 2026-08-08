/**
 * Session jobs: a foreground wrapped command runs and leaves no job behind.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { setupSession, runWrapped } from "./session-jobs-helpers.ts";

test("foreground session command runs and leaves no job behind", { timeout: 30000 }, async () => {
	const { sm } = setupSession();
	const child = runWrapped(sm.wrapCommand("sleep 2"));
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, "wrapped command mirrors exit code");

	const records = sm.readJobRecords();
	assert.equal(records.length, 0, "no job records remain after the command finishes");
});
