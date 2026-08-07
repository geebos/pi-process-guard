/**
 * Unit tests: config resolution (defaults, file config, env overrides).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, loadConfig, saveFileConfig } from "../../src/config.ts";

test("defaults are applied", () => {
	const cfg = loadConfig({});
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.termGraceMs, 2000);
	assert.equal(cfg.killVerifyMs, 1000);
	assert.equal(cfg.janitor.staleRecovery, true);
	assert.equal(cfg.linux.backend, "auto");
});

test("PI_PROCESS_GUARD=0 disables the guard", () => {
	const cfg = loadConfig({ PI_PROCESS_GUARD: "0" });
	assert.equal(cfg.enabled, false);
});

test("env overrides merge onto defaults", () => {
	const cfg = loadConfig({
		PI_PROCESS_GUARD_TERM_GRACE_MS: "550",
		PI_PROCESS_GUARD_LOG: "debug",
		PI_PROCESS_GUARD_STATE_ROOT: "~/tmp/guard-state",
	});
	assert.equal(cfg.termGraceMs, 550);
	assert.equal(cfg.logging.level, "debug");
	assert.equal(cfg.stateRoot, join(process.env.HOME ?? "", "tmp/guard-state"));
});

test("malformed env numbers fall back to defaults", () => {
	const cfg = loadConfig({ PI_PROCESS_GUARD_TERM_GRACE_MS: "abc" });
	assert.equal(cfg.termGraceMs, DEFAULT_CONFIG.termGraceMs);
});

test("file config overrides defaults and is overridden by env", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-cfg-"));
	const file = join(dir, "process-guard.json");
	writeFileSync(file, JSON.stringify({ termGraceMs: 777, logging: { level: "info" } }));
	const cfg = loadConfig({ PI_PROCESS_GUARD_CONFIG: file, PI_PROCESS_GUARD_TERM_GRACE_MS: "888" });
	assert.equal(cfg.termGraceMs, 888, "env wins over file");
	assert.equal(cfg.logging.level, "info", "file value applies");
});

test("malformed config file falls back to defaults", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-cfg-"));
	const file = join(dir, "bad.json");
	writeFileSync(file, "{not json");
	const cfg = loadConfig({ PI_PROCESS_GUARD_CONFIG: file });
	assert.equal(cfg.enabled, true);
	assert.equal(cfg.termGraceMs, DEFAULT_CONFIG.termGraceMs);
});

test("saveFileConfig persists enabled and preserves other keys", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-cfg-"));
	const file = join(dir, "process-guard.json");
	writeFileSync(file, JSON.stringify({ termGraceMs: 777, logging: { level: "info" } }));

	assert.equal(saveFileConfig(file, { enabled: false }), true, "write succeeds");
	const cfg = loadConfig({ PI_PROCESS_GUARD_CONFIG: file });
	assert.equal(cfg.enabled, false, "enabled persisted");
	assert.equal(cfg.termGraceMs, 777, "existing keys preserved");
	assert.equal(cfg.logging.level, "info", "nested logging preserved");

	// Flip back.
	assert.equal(saveFileConfig(file, { enabled: true }), true);
	assert.equal(loadConfig({ PI_PROCESS_GUARD_CONFIG: file }).enabled, true);
});

test("saveFileConfig creates the file when absent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-guard-cfg-"));
	const file = join(dir, "process-guard.json");
	assert.equal(saveFileConfig(file, { enabled: false }), true);
	assert.equal(loadConfig({ PI_PROCESS_GUARD_CONFIG: file }).enabled, false);
});
