/**
 * Smoke test: the extension loads through pi's real loader (jiti) and wires
 * session lifecycle handlers + commands against the real ExtensionAPI shape.
 *
 * This validates the wiring without booting a full agent loop.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { discoverAndLoadExtensions, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const EXT_ENTRY = fileURLToPath(new URL("../../extensions/index.ts", import.meta.url));
const CWD = fileURLToPath(new URL("../..", import.meta.url));

function mockCtx(notices: { message: string; type: string }[]): ExtensionContext {
	return {
		ui: {
			notify: (message: string, type = "info") => notices.push({ message, type }),
		} as unknown as ExtensionContext["ui"],
	} as ExtensionContext;
}

test("extension loads and registers commands + lifecycle handlers", { timeout: 30000 }, async () => {
	const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
	assert.deepEqual(result.errors, [], "extension must load without errors");

	const ext = result.extensions[0];
	assert.ok(ext, "extension loaded");
	assert.ok(ext.commands.has("process-guard"), "registers /process-guard");
	assert.ok(ext.commands.has("guard"), "registers /guard");
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
	const result = await discoverAndLoadExtensions([EXT_ENTRY], CWD);
	assert.deepEqual(result.errors, []);
	const ext = result.extensions[0]!;
	const notices: { message: string; type: string }[] = [];
	const ctx = mockCtx(notices);

	const startHandlers = ext.handlers.get("session_start")!;
	await startHandlers[0]({ type: "session_start", reason: "startup" }, ctx);

	const shutdownHandlers = ext.handlers.get("session_shutdown")!;
	await shutdownHandlers[0]({ type: "session_shutdown", reason: "new" }, ctx);

	const cleanupNotice = notices.find((n) => n.message.includes("pi-process-guard") && n.message.includes("session cleanup"));
	assert.ok(cleanupNotice, "session cleanup prints the plugin name and job count");
	assert.match(cleanupNotice!.message, /stopped \d+ job\(s\)/, "includes the cleaned job count");
});
