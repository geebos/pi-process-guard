/**
 * Extension commands: /process-guard (diagnostics) and /guard (config).
 * See docs/tech.md §17.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { readState } from "./guard-state.ts";
import { listPgidMembers, pidAlive } from "./process-info.ts";
import { getRuntimeContext, getSessionManager, hasLauncher } from "./store.ts";

function reportToUser(ctx: ExtensionCommandContext, report: string): void {
	ctx.ui.notify(report, "info");
}

function baseReport(): string[] {
	const ctx = getRuntimeContext();
	const session = getSessionManager();
	const lines: string[] = ["Pi Process Guard"];
	lines.push(`Platform:        ${process.platform} ${process.arch}`);
	lines.push(`Launcher:        ${hasLauncher() ? "active" : "not loaded"}`);
	if (ctx.guardId) {
		lines.push(`Guard ID:        ${ctx.guardId.slice(0, 8)}…`);
		lines.push(`Backend:         ${ctx.backend ?? "unknown"}`);
		if (ctx.pgid) lines.push(`Runtime PGID:    ${ctx.pgid}`);
		if (ctx.unit) lines.push(`Unit:            ${ctx.unit}`);
		if (ctx.janitorPid) lines.push(`Janitor:         ${pidAlive(ctx.janitorPid) ? "active" : "missing"}`);
	}
	if (session) {
		lines.push(`Session ID:      ${session.currentSessionId ? session.currentSessionId.slice(0, 8) + "…" : "none"}`);
		lines.push(`Tracked session: ${session.jobCount} jobs`);
	}
	return lines;
}

async function runtimeProcessLines(): Promise<string[]> {
	const ctx = getRuntimeContext();
	if (!ctx.pgid) return ["Tracked runtime: no process group (no launcher)"];
	try {
		const members = await listPgidMembers(ctx.pgid);
		const lines = [`Tracked runtime: ${members.length} processes in PGID ${ctx.pgid}`];
		for (const m of members) {
			lines.push(`  ${m.pid}  ppid=${m.ppid}  ${m.comm}`);
		}
		return lines;
	} catch (err) {
		return [`Tracked runtime: unable to scan process group (${err instanceof Error ? err.message : String(err)})`];
	}
}

async function doctorReport(): Promise<string[]> {
	const ctx = getRuntimeContext();
	const lines: string[] = ["Pi Process Guard — doctor"];
	const check = (ok: boolean, label: string, detail?: string): void => {
		lines.push(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	};

	check(hasLauncher(), "launcher handshake", ctx.guardId ? ctx.guardId.slice(0, 8) + "…" : undefined);
	if (ctx.stateFile) {
		const state = existsSync(ctx.stateFile) ? readState(ctx.stateFile) : undefined;
		check(Boolean(state), "state file", ctx.stateFile);
		if (state) {
			check(state.phase === "running" || state.phase === "terminating", `state phase (${state.phase})`);
			check(pidAlive(state.launcherPid), "launcher pid alive");
			check(pidAlive(state.piPid), "pi pid alive");
		}
	} else {
		check(false, "state file", "not set (no launcher)");
	}
	if (ctx.janitorPid) check(pidAlive(ctx.janitorPid), "janitor pid alive");
	else check(false, "janitor pid", "not set (no launcher)");
	if (ctx.pgid) {
		try {
			const members = await listPgidMembers(ctx.pgid);
			check(true, "process group scan", `${members.length} owned processes`);
		} catch (err) {
			check(false, "process group scan", err instanceof Error ? err.message : String(err));
		}
	}
	const config = loadConfig();
	check(config.enabled, "config loaded", `log level ${config.logging.level}`);
	return lines;
}

export function registerGuardCommand(pi: ExtensionAPI): void {
	pi.registerCommand("process-guard", {
		description: "Pi Process Guard diagnostics (status | ps | doctor | cleanup-session)",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			switch (sub) {
				case "ps": {
					const lines = [...baseReport(), ...(await runtimeProcessLines())];
					reportToUser(ctx, lines.join("\n"));
					break;
				}
				case "doctor": {
					reportToUser(ctx, (await doctorReport()).join("\n"));
					break;
				}
				case "cleanup-session": {
					const session = getSessionManager();
					if (!session) {
						reportToUser(ctx, "Pi Process Guard — no session manager");
						break;
					}
					const { stopped } = await session.cleanupSession();
					reportToUser(ctx, `Pi Process Guard — session cleanup: ${stopped} job(s) stopped`);
					break;
				}
				default: {
					reportToUser(ctx, baseReport().join("\n"));
					break;
				}
			}
		},
	});

	pi.registerCommand("guard", {
		description: "Pi Process Guard configuration",
		handler: async (_args, ctx) => {
			const config = loadConfig();
			const lines = [
				"Pi Process Guard — configuration",
				`Config file:     ${config.configPath}${existsSync(config.configPath) ? "" : " (not present)"}`,
				`Enabled:         ${config.enabled}`,
				`TERM grace:      ${config.termGraceMs} ms`,
				`KILL verify:     ${config.killVerifyMs} ms`,
				`Janitor:         heartbeat ${config.janitor.heartbeatMs} ms, stale recovery ${config.janitor.staleRecovery ? "on" : "off"}`,
				`Linux backend:   ${config.linux.backend}`,
				`Log level:       ${config.logging.level}`,
			];
			reportToUser(ctx, lines.join("\n"));
		},
	});
}
