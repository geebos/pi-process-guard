/**
 * Unit tests: descendant registry (docs/tech.md §8.4–§8.5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ProcessTracker, type TrackedProcess } from "../../src/process-registry.ts";
import { getStartIdentity } from "../../src/process-info.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A node process that spawns a detached child and stays alive. */
async function spawnTree(): Promise<{ parent: ReturnType<typeof spawn>; childPid: number }> {
	const parent = spawn(process.execPath, ["-e", `
		const { spawn } = require("node:child_process");
		const child = spawn("sleep", ["300"], { stdio: "ignore", detached: true });
		console.log("CHILD=" + child.pid);
		setInterval(() => {}, 1000);
	`], { stdio: ["ignore", "pipe", "ignore"] });
	const pidLine = await new Promise<string>((resolve, reject) => {
		let buf = "";
		parent.stdout?.on("data", (d) => {
			buf += d.toString();
			const m = buf.match(/CHILD=(\d+)/);
			if (m) resolve(m[1]!);
		});
		parent.on("exit", () => reject(new Error("parent exited early")));
		setTimeout(() => reject(new Error("timeout")), 5000);
	});
	return { parent, childPid: Number(pidLine) };
}

test("sample() discovers descendants incl. detached (escaped) children", { timeout: 30000 }, async () => {
	const { parent, childPid } = await spawnTree();
	try {
		const tracker = new ProcessTracker(parent.pid!);
		// Let the registry settle (identity capture is async).
		for (let i = 0; i < 5 && tracker.snapshot().length < 2; i++) {
			await tracker.sample();
			await sleep(300);
		}
		const snapshot = tracker.snapshot();
		const pids = snapshot.map((t) => t.pid);
		assert.ok(!pids.includes(parent.pid!), "root itself is not a descendant");
		assert.ok(pids.includes(childPid), "detached child tracked via PPID tree");

		// Every tracked process carries a start identity.
		for (const t of snapshot) {
			assert.ok(t.startIdentity, `pid ${t.pid} has a start identity`);
		}
	} finally {
		process.kill(childPid, "SIGKILL");
		process.kill(parent.pid!, "SIGKILL");
	}
});

test("verify() distinguishes the same process from a reused PID", { timeout: 30000 }, async () => {
	const child = spawn("sleep", ["300"], { stdio: "ignore" });
	const identity = await getStartIdentity(child.pid!);
	assert.ok(identity, "identity readable");

	const tracked: TrackedProcess = {
		pid: child.pid!,
		ppid: process.pid,
		pgid: child.pid!,
		firstSeenAt: Date.now(),
		startIdentity: identity,
		lastSeenPpid: process.pid,
		lastSeenPgid: child.pid!,
	};

	const tracker = new ProcessTracker(process.pid);
	assert.equal(await tracker.verify(tracked), true, "identity matches while alive");

	// Wrong identity must fail.
	const wrong: TrackedProcess = { ...tracked, startIdentity: "different-start-time" };
	assert.equal(await tracker.verify(wrong), false, "mismatched identity is rejected");

	// Dead process must fail.
	process.kill(child.pid!, "SIGKILL");
	await sleep(100);
	assert.equal(await tracker.verify(tracked), false, "dead process fails verification");
});

test("writeTo/readFrom roundtrip survives the process", { timeout: 30000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-reg-"));
	const file = join(dir, "registry.json");
	const tracked: TrackedProcess = {
		pid: 4242,
		ppid: 1,
		pgid: 4242,
		firstSeenAt: 1,
		startIdentity: "identity-x",
		lastSeenPpid: 1,
		lastSeenPgid: 4242,
	};
	const tracker = new ProcessTracker(4242);
	tracker["registered"].set(4242, tracked);
	tracker.writeTo(file);
	const loaded = ProcessTracker.readFrom(file);
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0]!.pid, 4242);
	assert.equal(loaded[0]!.startIdentity, "identity-x");
});
