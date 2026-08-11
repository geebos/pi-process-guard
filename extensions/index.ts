/**
 * pi-process-guard extension entry
 * (docs/pi-guard-startup-flow.md §18, §32, §39).
 *
 * Responsibilities (docs §32 — never the source of truth for runtime
 * cleanup; that stays with launcher + janitor):
 *   1. EXTENSION_READY handshake with the janitor (only when launched via
 *      pi-guard; docs §18)
 *   2. session lifecycle + session-owned process management
 *   3. /process-guard diagnostics
 *   4. passive warning when loaded without the pi-guard launcher (docs §14)
 *
 * Pi re-runs the extension factory for every runtime (/new, /reload, …), so
 * the factory must re-register handlers/commands on the fresh ExtensionAPI.
 * Within one runtime generation, auto-discovery and the launcher's explicit
 * --extension may load the same extension twice (source .ts + compiled .js),
 * which must not double-initialize (docs §13.2). The registration is therefore
 * scoped per runtime generation, not per process: a session_shutdown (which pi
 * fires before re-running the factory) bumps the generation, distinguishing a
 * genuine re-registration from a same-pass duplicate.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, UserBashEvent, ToolCallEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { createSessionManager } from "../src/session-manager.ts";
import { getSessionManager, setSessionManager, hasLauncher, getRuntimeContext } from "../src/store.ts";
import { registerGuardCommand } from "../src/command.ts";
import { registerGuardTools } from "../src/tools.ts";
import { loadConfig } from "../src/config.ts";
import { createLogger, PLUGIN_NAME } from "../src/log.ts";
import { connectToJanitor } from "../src/protocol.ts";

const log = createLogger(loadConfig(), { action: "session" });

/** Result of the most recent session cleanup, shown when the next session starts. */
let lastCleanup: { stopped: number; at: number } | undefined;

/** Runtime-generation counters shared across the .ts/.js module instances (docs §13.2). */
const GENERATION_KEY = Symbol.for("pi-process-guard.extension.generation");
const REGISTRATION_KEY = Symbol.for("pi-process-guard.extension.registration-generation");

/** EXTENSION_READY handshake: confirms the bundled extension really loaded (docs §18.1). */
async function notifyExtensionReady(runtime: ReturnType<typeof getRuntimeContext>): Promise<void> {
	const socketPath = runtime.socketPath;
	if (!socketPath) return;
	try {
		const client = await connectToJanitor(socketPath, 1000);
		client.send({
			type: "EXTENSION_READY",
			guardId: runtime.guardId!,
			piPid: process.pid,
		});
		setTimeout(() => client.close(), 50);
	} catch {
		// The janitor may be gone; the launcher's fail-closed monitor handles
		// it. Never crash the extension over the handshake.
	}
}

export default function (pi: ExtensionAPI) {
	// Register at most once per runtime generation (docs §13.2). A duplicate
	// factory call within the same generation is the same-pass auto-discovery +
	// --extension double-load and must be ignored; a call after session_shutdown
	// (pi fires it before re-running the factory on /new, /reload, /resume,
	// /fork) is a new runtime and must re-register on the fresh api.
	const g = globalThis as Record<symbol, unknown>;
	const generation = (g[GENERATION_KEY] as number) ?? 0;
	if (g[REGISTRATION_KEY] === generation) return;
	g[REGISTRATION_KEY] = generation;

	const sessionManager = createSessionManager();
	setSessionManager(sessionManager);

	let launcherWarningShown = false;

	// EXTENSION_READY handshake (docs §18.1).
	const runtime = getRuntimeContext();
	if (runtime.active) {
		void notifyExtensionReady(runtime);
	}

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
					"Runtime process cleanup guarantee is inactive. Start with: pi-guard",
				"warning",
			);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		// Advance the runtime generation so the factory call pi makes when
		// re-initializing after /new, /resume, /fork, /reload registers again
		// on the new ExtensionAPI instead of being skipped as a duplicate.
		const g = globalThis as Record<symbol, unknown>;
		g[GENERATION_KEY] = ((g[GENERATION_KEY] as number) ?? 0) + 1;
		const sm = getSessionManager();
		if (!sm) return;
		// Session-scoped cleanup only: /new, /resume, /fork, /reload must never
		// touch runtime-level processes (docs §33.2). On "quit" the janitor
		// performs the runtime-level final sweep.
		const pending = sm.pendingJobCount();
		// Announce the cleanup BEFORE waiting on it, so the /new pause is
		// understood as "stopping processes", not a hang. warning renders as a
		// line in the chat area (showWarning), not just a status flash.
		if (pending > 0) {
			const starting = `[${PLUGIN_NAME}] stopping ${pending} session process(es)...`;
			log.info("session cleanup start", { cleaning: String(pending) });
			process.stderr.write(`${starting}\n`);
			ctx.ui.notify(starting, "warning");
		}
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
