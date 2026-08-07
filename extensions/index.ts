/**
 * pi-process-guard extension entry.
 *
 * Phase 1 responsibilities (docs/tech.md §6, §21):
 *   - session lifecycle: session_start -> new session id + registry
 *   - session_shutdown -> session-owned job cleanup (idempotent)
 *   - non-blocking warning when loaded without the pi-guard launcher
 *   - /process-guard and /guard commands
 *
 * Runtime-level ownership is held by the launcher + janitor, NOT by this
 * extension: extension state must not be the source of truth across
 * /reload and session switches (docs/tech.md §22.3).
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSessionManager } from "../src/session-manager.ts";
import { getSessionManager, setSessionManager, hasLauncher } from "../src/store.ts";
import { registerGuardCommand } from "../src/command.ts";
import { registerGuardTools } from "../src/tools.ts";

export default function (pi: ExtensionAPI) {
	const sessionManager = createSessionManager();
	setSessionManager(sessionManager);

	let launcherWarningShown = false;

	pi.on("session_start", (event, ctx) => {
		sessionManager.beginSession(randomUUID());
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

	pi.on("session_shutdown", async (_event) => {
		const sm = getSessionManager();
		if (!sm) return;
		// Session-scoped cleanup only: /new, /resume, /fork, /reload must never
		// touch runtime-level processes (docs/tech.md §10.2). On "quit" the
		// janitor performs the runtime-level final sweep.
		await sm.cleanupSession();
	});

	registerGuardTools(pi);
	registerGuardCommand(pi);
}
