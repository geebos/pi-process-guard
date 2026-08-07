/**
 * Unit tests: session-exec entry resolution (Node 24 / node_modules TS bug).
 *
 * Node >= 24 refuses to type-strip .ts files under node_modules
 * (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). The entry Node actually
 * spawns must therefore be compiled JS (dist/src/) whenever the package is
 * installed, and only fall back to src/session-exec.ts in the workspace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExecutorEntryFrom } from "../../src/session-manager.ts";

/** Create a fake package layout and return its root. */
function makeLayout(files: string[]): string {
	const root = mkdtempSync(join(tmpdir(), "pi-guard-layout-"));
	for (const file of files) {
		const path = join(root, file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "");
	}
	return root;
}

test("plain workspace without dist build resolves src/session-exec.ts", () => {
	const root = makeLayout(["src/session-exec.ts"]);
	assert.equal(resolveExecutorEntryFrom(join(root, "src")), join(root, "src", "session-exec.ts"));
});

test("installed layout prefers compiled JS over the .ts source", () => {
	// node_modules install: pi loads src/ sources, but the spawned entry must
	// be the compiled dist/src/session-exec.js (the .ts one would crash Node 24).
	const root = makeLayout(["src/session-exec.ts", "dist/src/session-exec.js"]);
	assert.equal(resolveExecutorEntryFrom(join(root, "src")), join(root, "dist", "src", "session-exec.js"));
});

test("compiled module resolves the sibling session-exec.js", () => {
	const root = makeLayout(["dist/src/session-exec.js"]);
	assert.equal(resolveExecutorEntryFrom(join(root, "dist", "src")), join(root, "dist", "src", "session-exec.js"));
});
