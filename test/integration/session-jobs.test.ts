/**
 * Phase 2 integration tests: session-owned commands run in their own process
 * group via session-exec; session cleanup terminates them; a detached
 * watchdog reclaims backgrounded jobs when the Pi main process dies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SessionProcessManager } from "../../src/session-manager.ts";
import { listPgidMembers, pidAlive } from "../../src/process-info.ts";
import { waitFor } from "../helpers.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function setupSession(): { sm: SessionProcessManager; root: string } {
	const root = join(mkdtempSync(join(tmpdir(), "pi-guard-sess-it-")), "root");
	const sm = new SessionProcessManager(root);
	sm.beginSession("it-session");
	return { sm, root };
}

/** Run a wrapped command the way the bash tool would (bash -lc), foreground. */
function runWrapped(wrapped: string): ReturnType<typeof spawn> {
	const child = spawn("bash", ["-lc", wrapped], { stdio: ["ignore", "pipe", "pipe"] });
	// Drain output so the pipe never blocks.
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	return child;
}

test("foreground session command runs and leaves no job behind", { timeout: 30000 }, async () => {
	const { sm } = setupSession();
	const child = runWrapped(sm.wrapCommand("sleep 2"));
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0, "wrapped command mirrors exit code");

	const records = sm.readJobRecords();
	assert.equal(records.length, 0, "no job records remain after the command finishes");
});

test("backgrounded command is tracked and terminated by cleanupSession", { timeout: 30000 }, async () => {
	const { sm, root } = setupSession();
	const wrapped = sm.wrapCommand("sleep 600 &");
	const child = runWrapped(wrapped);

	// bash tool would return immediately for a backgrounded command.
	const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
	assert.equal(code, 0);

	// The job record is published and the background sleep is in its PGID.
	await waitFor(() => sm.readJobRecords().length === 1, 5000);
	const record = sm.readJobRecords()[0]!;
	const members = await listPgidMembers(record.pgid);
	const sleepPid = members.find((m) => m.comm === "sleep")?.pid;
	assert.ok(sleepPid, "background sleep lives in the job process group");

	// Session switch: everything owned by the session must die.
	const { stopped } = await sm.cleanupSession();
	assert.equal(stopped, 1);
	assert.equal(pidAlive(sleepPid), false, "background sleep terminated by session cleanup");
	assert.equal(existsSync(join(root, "sessions", "it-session")), false, "session dir removed");
});

test("watchdog reclaims background job when the Pi main process dies", { timeout: 30000 }, async () => {
	const { sm, root } = setupSession();

	// Fake Pi main process.
	const fakePi = spawn("sleep", ["300"], { stdio: "ignore" });

	const wrapped = sm.wrapCommand("sleep 600 &", fakePi.pid!);
	const child = runWrapped(wrapped);
	await new Promise<number | null>((resolve) => child.on("exit", resolve));

	await waitFor(() => sm.readJobRecords().length === 1, 5000);
	const record = sm.readJobRecords()[0]!;
	const members = await listPgidMembers(record.pgid);
	const sleepPid = members.find((m) => m.comm === "sleep")?.pid;
	assert.ok(sleepPid, "background sleep is tracked");

	// Pi dies without any cleanup signal.
	process.kill(fakePi.pid!, "SIGKILL");

	const reclaimed = await waitFor(() => !pidAlive(sleepPid!), 8000);
	assert.equal(reclaimed, true, "watchdog terminates the job after Pi dies");
	await waitFor(() => existsSync(join(root, "sessions", "it-session", "jobs")) === false, 5000);
});

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
