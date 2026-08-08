/**
 * Phase 1 + Phase 2 composition: session-owned commands run inside a guarded
 * runtime, and when Pi is SIGKILLed the session job is still reclaimed —
 * by the executor/watchdog, since the janitor's Pi-domain sweep cannot reach
 * the session job's own process group.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SessionProcessManager } from "../../src/session-manager.ts";
import { listPgidMembers, pidAlive } from "../../src/process-info.ts";
import { startGuard, waitFor } from "../helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("session job inside a guarded runtime is reclaimed after Pi SIGKILL", { timeout: 60000 }, async () => {
	// A real guarded runtime whose Pi is the fixture (stays alive).
	const guard = await startGuard({ mode: "keepalive" });

	// Simulate the extension: wrap a backgrounded command for this session.
	const root = join(mkdtempSync(join(tmpdir(), "pi-guard-combo-")), "root");
	const sm = new SessionProcessManager(root);
	sm.beginSession("combo-session");
	const wrapped = sm.wrapCommand("sleep 600 &", guard.piPid);

	// Run it the way the bash tool does (detached shell, own process group).
	const shell = spawn("bash", ["-lc", wrapped], { detached: true, stdio: "ignore" });
	shell.unref();
	let jobPid: number | undefined;
	await waitFor(async () => {
		if (sm.readJobRecords().length === 0) return false;
		const members = await listPgidMembers(sm.readJobRecords()[0]!.pgid);
		jobPid = members.find((m) => m.comm === "sleep")?.pid;
		return jobPid !== undefined;
	}, 5000);
	assert.ok(jobPid, "background sleep lives in the session job group");
	assert.equal(pidAlive(guard.piPid), true);

	// Kill Pi hard — no extension cleanup runs.
	process.kill(guard.piPid, "SIGKILL");
	const exitCode = await guard.exitPromise;
	assert.equal(exitCode, 1);

	// The janitor cleans the Pi domain…
	await waitFor(async () => (await listPgidMembers(guard.pgid)).length === 0, 8000);
	// …and the session job is reclaimed by the executor watchdog.
	const reclaimed = await waitFor(() => !pidAlive(jobPid!), 8000);
	assert.equal(reclaimed, true, "session background job reclaimed after Pi SIGKILL");
});
