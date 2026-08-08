/**
 * Shared helpers for the session-jobs integration tests. Split into per-case
 * files so `node --test` can run them in parallel at the file level.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SessionProcessManager } from "../../src/session-manager.ts";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function setupSession(): { sm: SessionProcessManager; root: string } {
	const root = join(mkdtempSync(join(tmpdir(), "pi-guard-sess-it-")), "root");
	const sm = new SessionProcessManager(root);
	sm.beginSession("it-session");
	return { sm, root };
}

/** Run a wrapped command the way the bash tool would (bash -lc), foreground. */
export function runWrapped(wrapped: string): ReturnType<typeof spawn> {
	const child = spawn("bash", ["-lc", wrapped], { stdio: ["ignore", "pipe", "pipe"] });
	// Drain output so the pipe never blocks.
	child.stdout?.on("data", () => {});
	child.stderr?.on("data", () => {});
	return child;
}
