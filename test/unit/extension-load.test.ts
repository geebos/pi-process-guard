/**
 * Smoke test: the extension loads through pi's real loader (jiti) and wires
 * session lifecycle handlers + commands against the real ExtensionAPI shape.
 *
 * This validates the wiring without booting a full agent loop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { waitFor } from "../helpers.ts";

const EXT_ENTRY = fileURLToPath(new URL("../../extensions/index.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The extension is a process-wide singleton (docs §13.2). pi's loader runs
 * the factory on every discover call, so tests that reload the extension in
 * the same process must reset the singleton first.
 */
const SINGLETON_KEY = Symbol.for("pi-process-guard.extension.loaded");
function resetSingleton(): void {
	delete (globalThis as Record<symbol, unknown>)[SINGLETON_KEY];
}

function mockCtx(notices: { message: string; type: string }[]): ExtensionContext {
	return {
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
		} as unknown as ExtensionContext["ui"],
	} as ExtensionContext;
}

test("extension loads and registers commands + lifecycle handlers", { timeout: 30000 }, async () => {
	resetSingleton();
	const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
	assert.deepEqual(result.errors, [], "extension must load without errors");

	const ext = result.extensions[0];
	assert.ok(ext, "extension loaded");
	assert.ok(ext.commands.has("process-guard"), "registers /process-guard");
	assert.ok(ext.commands.has("guard"), "registers /guard");
	assert.ok(ext.commands.has("plugin:pg"), "registers /plugin:pg");
	assert.ok(ext.handlers.has("session_start"), "subscribes to session_start");
	assert.ok(ext.handlers.has("session_shutdown"), "subscribes to session_shutdown");
	assert.ok(ext.handlers.has("tool_call"), "subscribes to tool_call (Phase 2)");
	assert.ok(ext.handlers.has("user_bash"), "subscribes to user_bash (Phase 2)");

	const notices: { message: string; type: string }[] = [];
	const ctx = mockCtx(notices);

	const startHandlers = ext.handlers.get("session_start")!;
	await startHandlers[0]({ type: "session_start", reason: "startup" }, ctx);
	assert.equal(notices.length, 1, "first session_start without launcher shows the warning");
	assert.equal(notices[0]!.type, "warning");

	// Second start: warning must not repeat.
	await startHandlers[0]({ type: "session_start", reason: "new" }, ctx);
	assert.equal(notices.length, 1, "warning shown only once");

	const shutdownHandlers = ext.handlers.get("session_shutdown")!;
	await shutdownHandlers[0]({ type: "session_shutdown", reason: "new" }, ctx);
	await shutdownHandlers[0]({ type: "session_shutdown", reason: "quit" }, ctx);
});

test("tool_call wraps bash commands into session-owned executors", { timeout: 30000 }, async () => {
	resetSingleton();
	const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
	assert.deepEqual(result.errors, []);
	const ext = result.extensions[0]!;
	const ctx = mockCtx([]);

	// session_start so a session id exists.
	const startHandlers = ext.handlers.get("session_start")!;
	await startHandlers[0]({ type: "session_start", reason: "startup" }, ctx);

	const toolCallHandlers = ext.handlers.get("tool_call")!;
	const event = {
		type: "tool_call",
		toolCallId: "c1",
		toolName: "bash",
		input: { command: "npm run dev" },
	} as const;
	await toolCallHandlers[0](event as never, ctx);

	assert.ok(
		event.input.command.includes("--") && event.input.command.includes("session-exec"),
		"bash command is wrapped into a session executor",
	);

	// Non-bash tools are untouched.
	const readEvent = {
		type: "tool_call",
		toolCallId: "c2",
		toolName: "read",
		input: { path: "x" },
	} as const;
	await toolCallHandlers[0](readEvent as never, ctx);
	assert.equal(readEvent.input.path, "x", "non-bash tool args are not touched");
});

test("user_bash returns custom operations that wrap the command", { timeout: 30000 }, async () => {
	resetSingleton();
	const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
	assert.deepEqual(result.errors, []);
	const ext = result.extensions[0]!;
	const ctx = mockCtx([]);

	const startHandlers = ext.handlers.get("session_start")!;
	await startHandlers[0]({ type: "session_start", reason: "startup" }, ctx);

	const userBashHandlers = ext.handlers.get("user_bash")!;
	const outcome = await userBashHandlers[0](
		{ type: "user_bash", command: "echo hi", excludeFromContext: false, cwd: CWD },
		ctx,
	);
	assert.ok(outcome && typeof outcome === "object" && "operations" in outcome, "user_bash returns custom operations");
	const operations = (outcome as { operations: { exec: (cmd: string) => Promise<unknown> } }).operations;
	assert.equal(typeof operations.exec, "function");

	// The operations exec must wrap the command before running it.
	const wrappedResult = await operations.exec("true", CWD, {
		onData: () => {},
	});
	assert.deepEqual(wrappedResult, { exitCode: 0 }, "wrapped command executes successfully");
});

test("session_shutdown prints the plugin name and cleaned job count", { timeout: 30000 }, async () => {
	// Isolate the state root so the test never touches the real user cache.
	resetSingleton();
	const stateRoot = join(mkdtempSync(join(tmpdir(), "pi-guard-ext-")), "root");
	const prevStateRoot = process.env.PI_PROCESS_GUARD_STATE_ROOT;
	process.env.PI_PROCESS_GUARD_STATE_ROOT = stateRoot;
	try {
		const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
		assert.deepEqual(result.errors, []);
		const ext = result.extensions[0]!;
		const notices: { message: string; type: string }[] = [];
		const ctx = mockCtx(notices);

		const startHandlers = ext.handlers.get("session_start")!;
		await startHandlers[0]({ type: "session_start", reason: "startup" }, ctx);

		// Wrap a backgrounded command and actually run it so the executor
		// publishes the on-disk job record.
		const toolCallHandlers = ext.handlers.get("tool_call")!;
		const bashEvent = {
			type: "tool_call",
			toolCallId: "c1",
			toolName: "bash",
			input: { command: "sleep 700 &" },
		} as const;
		await toolCallHandlers[0](bashEvent as never, ctx);
		assert.ok(bashEvent.input.command.includes("session-exec"), "command wrapped");

		const shell = spawn("bash", ["-lc", bashEvent.input.command], { stdio: "ignore" });
		void shell;
		// Wait until the executor publishes the on-disk job record. The test
		// inspects the filesystem (jiti loads its own store.ts instance, so the
		// module-level session manager is not shared with this test process).
		await waitFor(async () => {
			const sessionsRoot = join(stateRoot, "sessions");
			if (!existsSync(sessionsRoot)) return false;
			return readdirSync(sessionsRoot).some((s) => {
				const jobsDir = join(sessionsRoot, s, "jobs");
				return existsSync(jobsDir) && readdirSync(jobsDir).some((f) => f.endsWith(".json"));
			});
		}, 5000);

		const shutdownHandlers = ext.handlers.get("session_shutdown")!;
		await shutdownHandlers[0]({ type: "session_shutdown", reason: "new" }, ctx);
		void shell;

		// The cleanup is announced BEFORE it runs, so the /new pause is understood.
		const stoppingNotice = notices.find((n) => n.message.includes("stopping"));
		assert.ok(stoppingNotice, "cleanup start is announced");
		assert.match(stoppingNotice!.message, /stopping 1 session process\(es\)\.\.\./, "announces the real signallable count");
		assert.equal(stoppingNotice!.type, "warning", "start notice renders as a warning line");

		const cleanupNotice = notices.find((n) => n.message.includes("session cleanup"));
		assert.ok(cleanupNotice, "session cleanup prints the plugin name and job count");
		assert.match(cleanupNotice!.message, /stopped 1 job\(s\)/, "counts exactly the on-disk record");

		// The next session_start must surface the previous cleanup in the TUI
		// (session_shutdown-time notices are unreliable during the switch).
		await startHandlers[0]({ type: "session_start", reason: "new" }, ctx);
		const carryover = notices.find((n) => n.message.includes("previous session cleanup"));
		assert.ok(carryover, "next session shows the previous cleanup result");
		assert.match(carryover!.message, /stopped 1 job\(s\)/, "carryover counts the on-disk record");
	} finally {
		if (prevStateRoot === undefined) delete process.env.PI_PROCESS_GUARD_STATE_ROOT;
		else process.env.PI_PROCESS_GUARD_STATE_ROOT = prevStateRoot;
	}
});

test("/plugin:pg enable/disable persists to the config file", { timeout: 30000 }, async () => {
	// Isolated config path so the real ~/.pi/agent config is never touched.
	resetSingleton();
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-pg-"));
	const configPath = join(dir, "process-guard.json");
	const prev = process.env.PI_PROCESS_GUARD_CONFIG;
	process.env.PI_PROCESS_GUARD_CONFIG = configPath;
	try {
		const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
		assert.deepEqual(result.errors, []);
		const ext = result.extensions[0]!;
		const command = ext.commands.get("plugin:pg")!;
		const notices: { message: string; type: string }[] = [];
		const ctx = mockCtx(notices);

		// disable
		await command.handler("disable", ctx);
		const disabled = notices.at(-1)!.message;
		assert.match(disabled, /disabled/, "reports disabled");
		assert.match(disabled, /next launch/, "notes it takes effect on next launch");
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, false, "config file written");

		// status reflects the file
		await command.handler("status", ctx);
		assert.match(notices.at(-1)!.message, /disabled/, "status shows disabled");

		// enable
		await command.handler("enable", ctx);
		const enabled = notices.at(-1)!.message;
		assert.match(enabled, /enabled/, "reports enabled");
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).enabled, true, "config file flipped back");
	} finally {
		if (prev === undefined) delete process.env.PI_PROCESS_GUARD_CONFIG;
		else process.env.PI_PROCESS_GUARD_CONFIG = prev;
	}
});
