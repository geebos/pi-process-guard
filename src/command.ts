/**
 * Extension commands: /process-guard (diagnostics) and /guard (config).
 * See docs/pi-guard-startup-flow.md §34.
 *
 * The report is built from the runtime state file + the guard environment —
 * never guessed (docs §34: "Extension 通过 runtime socket/state 获取信息,
 * 不自己猜").
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { loadConfig, saveFileConfig } from "./config.ts";
import { readState, stateFilePath } from "./guard-state.ts";
import { listPgidMembers, pidAlive } from "./process-info.ts";
import { getRuntimeContext, getSessionManager, hasLauncher } from "./store.ts";

function reportToUser(ctx: ExtensionCommandContext, report: string): void {
	ctx.ui.notify(report, "info");
}

function protectionLabel(backend: string | undefined): string {
	switch (backend) {
		case "systemd-cgroup":
			return "strong";
		case "process-group":
			return process.platform === "darwin" ? "best-effort-high" : "degraded";
		default:
			return "unknown";
	}
}

function formatAge(createdAt: number): string {
	const total = Math.max(0, Math.floor((Date.now() - createdAt) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number): string => String(n).padStart(2, "0");
	return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function baseReport(): string[] {
	const ctx = getRuntimeContext();
	const session = getSessionManager();
	const lines: string[] = ["Pi Process Guard"];
	lines.push(`Platform:        ${process.platform} ${process.arch}`);
	lines.push(`Launcher:        ${hasLauncher() ? "active" : "not loaded"}`);

	const state = ctx.runtimeDir ? readState(ctx.runtimeDir) : undefined;
	if (!ctx.active) {
		lines.push("Protection:      none (start with: pi-guard)");
		return lines;
	}

	const stateLabel = state?.state === "running" ? "RUNNING" : state?.state ?? "unknown";
	lines.push(`Guard ID:        ${(ctx.guardId ?? "").slice(0, 8)}…`);
	lines.push(`State:           ${stateLabel}`);
	lines.push(`Launcher PID:    ${state?.launcherPid ?? ctx.launcherPid ?? "?"}`);
	lines.push(`Janitor PID:     ${state?.janitorPid ?? "?"}`);
	lines.push(`Pi PID:          ${state?.piPid ?? process.pid}`);
	lines.push(`Backend:         ${ctx.backend ?? state?.backend ?? "unknown"}`);
	if (state?.runtimeUnit) lines.push(`Unit:            ${state.runtimeUnit}`);
	if (state?.piPgid) lines.push(`Runtime PGID:    ${state.piPgid}`);
	lines.push(`Protection:      ${protectionLabel(ctx.backend ?? state?.backend)}`);
	lines.push(`Janitor:         ${state?.janitorPid && pidAlive(state.janitorPid) ? "healthy" : "missing"}`);
	lines.push(`Extension:       ${state?.extensionReadyAt ? "ready" : "pending"}`);
	if (state) lines.push(`Runtime age:     ${formatAge(state.createdAt)}`);
	return lines;
}

async function runtimeProcessLines(): Promise<string[]> {
	const ctx = getRuntimeContext();
	const state = ctx.runtimeDir ? readState(ctx.runtimeDir) : undefined;
	const pgid = state?.piPgid;
	if (!pgid) return ["Tracked runtime: no process group (no launcher)"];
	try {
		const members = await listPgidMembers(pgid);
		const lines = [`Tracked runtime: ${members.length} processes in PGID ${pgid}`];
		for (const m of members) {
			lines.push(`  ${m.pid}  ppid=${m.ppid}  ${m.comm}`);
		}
		return lines;
	} catch (err) {
		return [`Tracked runtime: unable to scan process group (${err instanceof Error ? err.message : String(err)})`];
	}
}

function sessionJobLines(): string[] {
	const sm = getSessionManager();
	if (!sm) return ["Tracked session: no session manager"];
	const records = sm.readJobRecords();
	const lines = [`Tracked session: ${sm.jobCount} job(s) in ${sm.sessionDir ?? "(no session)"}`];
	for (const r of records) {
		lines.push(`  job ${r.jobId.slice(0, 8)}… pgid=${r.pgid} pid=${r.pid} started=${new Date(r.startedAt).toISOString()}`);
	}
	return lines;
}

async function doctorReport(): Promise<string[]> {
	const ctx = getRuntimeContext();
	const lines: string[] = ["Pi Process Guard — doctor"];
	const check = (ok: boolean, label: string, detail?: string): void => {
		lines.push(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	};

	check(hasLauncher(), "launcher handshake", ctx.guardId ? ctx.guardId.slice(0, 8) + "…" : undefined);
	const state = ctx.runtimeDir ? readState(ctx.runtimeDir) : undefined;
	if (ctx.runtimeDir && state) {
		check(true, "state file", stateFilePath(ctx.runtimeDir));
		check(state.state === "running" || state.state === "cleaning", `runtime state (${state.state})`);
		check(pidAlive(state.launcherPid), "launcher pid alive");
		check(pidAlive(state.piPid), "pi pid alive");
		if (state.janitorPid) check(pidAlive(state.janitorPid), "janitor pid alive");
	} else {
		check(false, "state file", ctx.runtimeDir ? "unreadable" : "not set (no launcher)");
	}
	if (state?.piPgid) {
		try {
			const members = await listPgidMembers(state.piPgid);
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
	pi.registerCommand("plugin:pg", {
		description: "Pi Process Guard on/off (enable | disable | status)",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "status";
			const config = loadConfig();

			if (sub === "enable" || sub === "disable") {
				const enabled = sub === "enable";
				const ok = saveFileConfig(config.configPath, { enabled });
				if (!ok) {
					reportToUser(ctx, `[pi-process-guard] failed to write config: ${config.configPath}`);
					return;
				}
				// The launcher reads `enabled` at startup, so the change applies to
				// the next launch; the running guard keeps its current behavior.
				reportToUser(
					ctx,
					`[pi-process-guard] ${enabled ? "enabled" : "disabled"} (takes effect on next launch via pi-guard; current run unchanged)`,
				);
				return;
			}

			// status (default): effective value + where it comes from.
			reportToUser(
				ctx,
				[
					`[pi-process-guard] ${config.enabled ? "enabled" : "disabled"}`,
					`Config file:     ${config.configPath}${existsSync(config.configPath) ? "" : " (not present)"}`,
					`Usage: /plugin:pg enable | disable | status`,
				].join("\n"),
			);
		},
	});

	pi.registerCommand("process-guard", {
		description: "Pi Process Guard diagnostics (status | ps | doctor | cleanup-session)",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] ?? "";
			switch (sub) {
			case "ps": {
					const lines = [...baseReport(), ...(await runtimeProcessLines()), ...sessionJobLines()];
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
						reportToUser(ctx, `[pi-process-guard] no session manager`);
						break;
					}
					const { stopped } = await session.cleanupSession();
					reportToUser(ctx, `[pi-process-guard] session cleanup: stopped ${stopped} job(s)`);
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
				`Linux backend:   ${config.linux.backend}${config.linux.requireCgroup ? " (require cgroup)" : ""}`,
				`Log level:       ${config.logging.level}`,
			];
			reportToUser(ctx, lines.join("\n"));
		},
	});
}
