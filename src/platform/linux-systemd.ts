/**
 * Linux systemd backend: runs the Pi runtime inside a transient user scope
 * (cgroup) (docs/pi-guard-startup-flow.md §15).
 *
 * `systemd-run --user --scope` creates a transient scope; everything Pi forks
 * inherits the scope's cgroup, so ownership survives reparenting and
 * double-forking. Cleanup lets systemd do the work via `systemctl stop` with
 * KillMode=control-group / KillSignal=SIGTERM / SendSIGKILL=yes /
 * TimeoutStopSec=<termGrace>; `systemctl kill` escalates when processes
 * survive.
 *
 * Unit naming: pi-guard-<shortGuardId>.scope (docs §9 — never PID-based).
 *
 * NOTE: developed on macOS and not exercised locally — requires Linux CI.
 */

import { execFile, spawn } from "node:child_process";
import type { BackendContext, BackendStarted, GuardBackend } from "./index.ts";
import type { GuardConfig, RuntimeSnapshot } from "../types.ts";

const EXEC_TIMEOUT_MS = 10_000;

function runSystemctl(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		execFile(
			"systemctl",
			["--user", ...args],
			{ timeout: EXEC_TIMEOUT_MS },
			(err, stdout, stderr) => {
				resolve({ code: err ? (err as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0, stdout, stderr });
			},
		);
	});
}

/** Probe whether a usable `systemd --user` manager exists (docs §7.4). */
export async function systemdUserAvailable(): Promise<boolean> {
	if (!process.env.XDG_RUNTIME_DIR) return false;
	try {
		const { code } = await new Promise<{ code: number }>((resolve) => {
			execFile("systemd-run", ["--user", "--version"], { timeout: 5000 }, (err) => {
				resolve({ code: err ? 1 : 0 });
			});
		});
		return code === 0;
	} catch {
		return false;
	}
}

const PASS_THROUGH_ENV = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_ID",
	"DBUS_SESSION_BUS_ADDRESS",
];

export function createSystemdBackend(config: GuardConfig, state: BackendContext): GuardBackend {
	let unit: string | undefined = state.runtimeUnit;

	const unitPropertyArgs = () => [
		`--property=KillMode=control-group`,
		`--property=KillSignal=SIGTERM`,
		`--property=SendSIGKILL=yes`,
		`--property=TimeoutStopSec=${Math.max(1, Math.ceil(config.termGraceMs / 1000))}s`,
	];

	async function showValue(property: string): Promise<string> {
		const { stdout } = await runSystemctl(["show", unit!, `-p`, property, "--value"]);
		return stdout.trim();
	}

	async function isClean(): Promise<boolean> {
		if (!unit) return true;
		const active = await showValue("ActiveState");
		if (active === "inactive" || active === "failed") return true;
		// Unit vanished (collected) — nothing left to clean.
		if (active === "" || active === "Unknown" || active.includes("not-found")) return true;
		return false;
	}

	return {
		kind: "systemd-cgroup",

		async start(target): Promise<BackendStarted> {
			const prefix = config.linux.systemdUnitPrefix;
			const shortId = state.guardId.slice(0, 8);
			const unitName = `${prefix}-${shortId}.scope`;
			unit = unitName;

			const envArgs: string[] = [];
			const envKeys = new Set<string>([
				...PASS_THROUGH_ENV,
				...Object.keys(target.env).filter((k) => k.startsWith("PI_PROCESS_GUARD_") || k.startsWith("PI_GUARD_")),
			]);
			for (const key of envKeys) {
				const value = target.env[key];
				if (value !== undefined) envArgs.push("--setenv", `${key}=${value}`);
			}

			// systemd-run --scope runs the command in the foreground inside a
			// transient scope, mirrors its exit code, and --collect reclaims the
			// unit once empty.
			const runner = spawn(
				"systemd-run",
				[
					"--user",
					"--scope",
					"--quiet",
					"--collect",
					`--unit=${unitName}`,
					...unitPropertyArgs(),
					...envArgs,
					"--",
					target.bin,
					...target.args,
				],
				{ stdio: "inherit", env: target.env },
			);

			// Poll for the main PID: the scope becomes active shortly.
			const piPid = await (async () => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const raw = await showValue("MainPID");
					const pid = Number(raw);
					if (Number.isInteger(pid) && pid > 0) return pid;
					await new Promise((r) => setTimeout(r, 100));
				}
				throw new Error(`systemd unit ${unitName} did not report a MainPID within 10s`);
			})();

			const exited = new Promise<number | null>((resolve) => {
				runner.on("exit", (code) => resolve(code ?? null));
				runner.on("error", (err) => resolve(null));
			});

			return { piPid, unit: unitName, exited };
		},

		async signalTerm(): Promise<void> {
			if (!unit) return;
			// systemd itself performs TERM -> grace -> KILL inside the cgroup.
			const { code } = await runSystemctl(["stop", unit]);
			if (code !== 0 && !(await isClean())) {
				const { code: killCode } = await runSystemctl(["kill", "--kill-whom=all", "--signal=SIGTERM", unit]);
				if (killCode !== 0) process.stderr.write(`[pi-guard] systemctl kill TERM failed for ${unit}\n`);
			}
		},

		async signalKill(): Promise<void> {
			if (!unit) return;
			const { code } = await runSystemctl(["kill", "--kill-whom=all", "--signal=SIGKILL", unit]);
			if (code !== 0) process.stderr.write(`[pi-guard] systemctl kill KILL failed for ${unit}\n`);
		},

		isClean,

		async snapshot(): Promise<RuntimeSnapshot> {
			const [pidRaw, active] = await Promise.all([
				showValue("MainPID"),
				showValue("ActiveState"),
			]);
			const pid = Number(pidRaw);
			return {
				backend: "systemd-cgroup",
				piPid: Number.isInteger(pid) && pid > 0 ? pid : 0,
				runtimeUnit: unit,
				trackedProcesses: active === "active" ? -1 : 0,
			};
		},
	};
}
