/**
 * Session jobs: cleanupSession stops multiple background jobs at once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { listPgidMembers } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";
import { setupSession, runWrapped } from "./session-jobs-helpers.ts";

test("cleanupSession with multiple background jobs stops all of them", { timeout: 30000 }, async () => {
	const { sm } = setupSession();
	const w1 = sm.wrapCommand("sleep 601 &");
	const w2 = sm.wrapCommand("sleep 602 &");
	const c1 = runWrapped(w1);
	const c2 = runWrapped(w2);
	await Promise.all([
		new Promise<number | null>((resolve) => c1.on("exit", resolve)),
		new Promise<number | null>((resolve) => c2.on("exit", resolve)),
	]);
	await waitFor(() => sm.readJobRecords().length === 2, 5000);

	const { stopped } = await sm.cleanupSession();
	assert.equal(stopped, 2);
	const leftovers = (await listPgidMembers(0)).length; // sanity: PGID 0 never matches
	assert.equal(leftovers, 0);
});
