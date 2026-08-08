/**
 * Session jobs: the detached watchdog reclaims a background job when the Pi
 * main process dies without any cleanup signal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { listPgidMembers, pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";
import { setupSession, runWrapped } from "./session-jobs-helpers.ts";

test("watchdog reclaims background job when the Pi main process dies", { timeout: 30000 }, async () => {
	const { sm, root } = setupSession();

	// Fake Pi main process.
	const fakePi = spawn("sleep", ["300"], { stdio: "ignore" });

	const wrapped = sm.wrapCommand("sleep 600 &", fakePi.pid!);
	const child = runWrapped(wrapped);
	await new Promise<number | null>((resolve) => child.on("exit", resolve));

	let sleepPid: number | undefined;
	await waitFor(async () => {
		if (sm.readJobRecords().length === 0) return false;
		const members = await listPgidMembers(sm.readJobRecords()[0]!.pgid);
		sleepPid = members.find((m) => m.comm === "sleep")?.pid;
		return sleepPid !== undefined;
	}, 5000);
	assert.ok(sleepPid, "background sleep is tracked");

	// Pi dies without any cleanup signal.
	process.kill(fakePi.pid!, "SIGKILL");

	const reclaimed = await waitFor(() => !pidAlive(sleepPid!), 8000);
	assert.equal(reclaimed, true, "watchdog terminates the job after Pi dies");
	await waitFor(() => existsSync(join(root, "sessions", "it-session", "jobs")) === false, 5000);
});
