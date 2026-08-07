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
