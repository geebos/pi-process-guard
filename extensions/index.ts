/**
 * pi-process-guard extension entry.
 *
 * Phase 1: session lifecycle, /process-guard diagnostics, launcher warning.
 * Phase 2: session-owned bash management — `tool_call` rewrites bash tool
 * commands and `user_bash` provides custom operations so every shell command
 * runs inside a session-owned process group that /new, /resume, /fork and
 * /reload terminate (docs/tech.md §9).
 *
 * Runtime-level ownership stays with the launcher + janitor; extension state
 * is never the source of truth across reloads (docs/tech.md §22.3).
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, UserBashEvent, ToolCallEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createSessionManager } from "../src/session-manager.ts";
import { getSessionManager, setSessionManager, hasLauncher } from "../src/store.ts";
import { registerGuardCommand } from "../src/command.ts";
import { registerGuardTools } from "../src/tools.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger, PLUGIN_NAME } from "../src/log.ts";

const log = createLogger(loadConfig(), { action: "session" });

/** Result of the most recent session cleanup, shown when the next session starts. */
let lastCleanup: { stopped: number; at: number } | undefined;

export default function (pi: ExtensionAPI) {
	const sessionManager = createSessionManager();
	setSessionManager(sessionManager);

	let launcherWarningShown = false;

	pi.on("session_start", (event, ctx) => {
		sessionManager.beginSession(randomUUID());
		// The TUI is fully up here, unlike during session_shutdown, so a
		// notification is reliably visible (status-bar notices sent during the
		// shutdown of the old runtime get swallowed by the session switch).
		if (lastCleanup) {
			ctx.ui.notify(
				`[${PLUGIN_NAME}] previous session cleanup: stopped ${lastCleanup.stopped} job(s)`,
				"info",
			);
			lastCleanup = undefined;
		}
		if (!hasLauncher() && !launcherWarningShown) {
			launcherWarningShown = true;
			ctx.ui.notify(
				"Process Guard extension loaded without pi-guard launcher. " +
					"Session cleanup is enabled, but arbitrary extension processes " +
					"cannot be guaranteed to be reclaimed on Pi exit.",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sm = getSessionManager();
		if (!sm) return;
		// Session-scoped cleanup only: /new, /resume, /fork, /reload must never
		// touch runtime-level processes (docs/tech.md §10.2). On "quit" the
		// janitor performs the runtime-level final sweep.
		const { stopped } = await sm.cleanupSession();
		lastCleanup = { stopped, at: Date.now() };
		log.info("session cleanup", {
			cleaned: String(stopped),
			sessionId: sm.currentSessionId,
		});
		// Best-effort TUI notice + terminal fallback (visible on the console
		// after pi exits, since the TUI runs in an alternate screen).
		ctx.ui.notify(`[${PLUGIN_NAME}] session cleanup: stopped ${stopped} job(s)`, "info");
		process.stderr.write(`[${PLUGIN_NAME}] session cleanup: stopped ${stopped} job(s)\n`);
	});

	// Phase 2: wrap bash tool commands into session-owned process groups.
	pi.on("tool_call", (event: ToolCallEvent) => {
		if (event.toolName !== "bash") return;
		const sm = getSessionManager();
		if (!sm) return;
		const input = event.input as { command: string };
		const wrapped = sm.wrapCommand(input.command);
		if (wrapped !== input.command) {
			input.command = wrapped;
		}
	});

	// Phase 2: user `!` / `!!` commands go through the same session executor.
	pi.on("user_bash", (event: UserBashEvent, _ctx: ExtensionContext) => {
		const sm = getSessionManager();
		if (!sm) return undefined;
		const localExec = createLocalBashOperations();
		return {
			operations: {
				exec: async (command, cwd, options) => {
					const wrapped = sm.wrapCommand(command);
					return localExec.exec(wrapped, cwd, options);
				},
			},
		};
	});

	registerGuardTools(pi);
	registerGuardCommand(pi);
}
