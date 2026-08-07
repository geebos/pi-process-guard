/**
 * Unit tests: guard state file protocol and stale-state detection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testConfig } from "../helpers.ts";
import { stateDirFor, writeState, readState, updateState, deleteStateDir, findStaleStates } from "../../src/guard-state.ts";
import type { GuardStateFile } from "../../src/types.ts";

function makeState(overrides: Partial<GuardStateFile> = {}): GuardStateFile {
	const now = Date.now();
	return {
		schemaVersion: 1,
		guardId: "g1",
		platform: process.platform as NodeJS.Platform,
		backend: "process-group",
		launcherPid: process.pid,
		janitorPid: 0,
		piPid: 0,
		piPgid: 42,
		state: "running",
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

test("write/read/update/delete roundtrip", () => {
	const config = testConfig(mkdtempSync(join(tmpdir(), "pi-guard-state-")));
	const dir = stateDirFor(config, "g1");

	writeState(dir, makeState());
	const first = readState(dir);
	assert.ok(first, "state readable");
	assert.equal(first.guardId, "g1");
	assert.equal(first.state, "running");

	const updated = updateState(dir, { state: "cleaning", piPid: 123 });
	assert.ok(updated);
	assert.equal(updated.state, "cleaning");
	assert.equal(updated.piPid, 123);
	assert.ok(updated.updatedAt >= first.updatedAt);

	const reread = readState(dir);
	assert.equal(reread?.state, "cleaning");

	deleteStateDir(dir);
	assert.equal(readState(dir), undefined, "state gone after delete");
});

test("corrupt state file yields undefined", () => {
	const config = testConfig(mkdtempSync(join(tmpdir(), "pi-guard-state-")));
	const dir = stateDirFor(config, "g2");
	writeState(dir, makeState());
	// Truncate the file.
	writeFileSync(join(dir, "state.json"), "{corrupt");
	assert.equal(readState(dir), undefined);
});

test("findStaleStates only reports runtimes with dead launcher and pi", () => {
	const config = testConfig(mkdtempSync(join(tmpdir(), "pi-guard-state-")));

	// Live runtime (our own pid is alive).
	const liveDir = stateDirFor(config, "live");
	writeState(liveDir, makeState({ launcherPid: process.pid, piPid: 1_000_000 }));
	// Stale runtime (both dead).
	const staleDir = stateDirFor(config, "stale");
	writeState(staleDir, makeState({ guardId: "stale", launcherPid: 999_981, piPid: 999_982 }));

	const stale = findStaleStates(config);
	assert.equal(stale.length, 1);
	assert.equal(stale[0]?.state.guardId, "stale");});
