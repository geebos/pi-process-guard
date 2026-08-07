#!/usr/bin/env node
/**
 * session-exec — runs a session-owned command inside its own process group.
 *
 * The extension wraps bash tool / user-bash commands as:
 *
 *   node session-exec.ts -- '<original command>'
 *   (session dir / job id / pi pid are passed via PI_GUARD_* env vars)
 *
 * Responsibilities (docs/tech.md §9):
 *   1. spawn `bash -lc <command>` detached → the command and all its
 *      descendants live in their own process group (PGID = that bash pid),
 *      so a session switch can terminate the whole job with killpg.
 *   2. publish a job file `jobs/<jobId>.json` with the pgid so the session
 *      manager can clean it up.
 *   3. wait for the command; when the job group still has members after the
 *      shell exits (e.g. `npm run dev &`), spawn a detached watchdog that
 *      takes over cleanup and exit so the caller (bash tool) returns promptly.
 *   4. watchdog: terminate the job group when the Pi main process
 *      (PI_GUARD_PI_PID) disappears — including SIGKILL, where pi's own
 *      detached-child cleanup never runs.
 *   5. on SIGTERM/SIGINT, clean up the job group before exiting.
 *
 * The executor itself stays inside the Pi runtime domain (it is an ordinary
 * child of the wrapping shell), so runtime-level cleanup still reaches it;
 * the watchdog is detached and self-terminates once the job group is empty.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { killProcessGroup, listPgidMembers, pidAlive } from "./process-info.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const WATCHDOG_INTERVAL_MS = 1000;

export interface JobRecord {
	jobId: string;
	pid: number;
	pgid: number;
	startedAt: number;
	piPid?: number;
}

interface RunArgs {
	mode: "run" | "watch";
	command?: string;
	jobFile?: string;
	sessionDir?: string;
	jobId?: string;
	piPid?: number;
}

function parseArgs(): RunArgs {
	const [modeArg] = process.argv.slice(2);
	if (modeArg === "--watch") {
		const jobFile = process.argv[3];
		if (!jobFile || !existsSync(jobFile)) {
			process.stderr.write("[session-exec] --watch requires an existing job file\n");
			process.exit(2);
		}
		return { mode: "watch", jobFile };
	}

	const dashdash = process.argv.indexOf("--");
	const command = process.argv.slice(dashdash + 1).join(" ").trim();
	const jobId = process.env.PI_GUARD_JOB_ID;
	const sessionDir = process.env.PI_GUARD_SESSION_DIR;
	const piPidRaw = process.env.PI_GUARD_PI_PID;
	const piPid = piPidRaw ? Number(piPidRaw) : undefined;

	if (!command) {
		process.stderr.write("[session-exec] empty command\n");
		process.exit(2);
	}
	if (!jobId || !sessionDir) {
		process.stderr.write("[session-exec] missing PI_GUARD_JOB_ID / PI_GUARD_SESSION_DIR\n");
		process.exit(2);
	}
	return {
		mode: "run",
		command,
		jobFile: join(sessionDir, "jobs", `${jobId}.json`),
		sessionDir,
		jobId,
		piPid: Number.isInteger(piPid) && (piPid ?? 0) > 0 ? piPid : undefined,
	};
}

async function jobGroupMembers(pgid: number): Promise<number> {
	try {
		return (await listPgidMembers(pgid)).length;
	} catch {
		return -1; // unknown — keep the record
	}
}

async function terminateJobGroup(pgid: number, jobFile: string, exitCode: number): Promise<never> {
	killProcessGroup(pgid, "SIGTERM");
	await sleep(300);
	killProcessGroup(pgid, "SIGKILL");
	try {
		rmSync(jobFile, { force: true });
	} catch {
		/* best effort */
	}
	process.exit(exitCode);
}

/** Detached watchdog: supervises a job group left behind by a backgrounded job. */
function runWatchdog(jobFile: string): void {
	let job: JobRecord | undefined;
	try {
		job = JSON.parse(readFileSync(jobFile, "utf8")) as JobRecord;
	} catch {
		process.exit(0);
	}
	const { pgid, piPid } = job;
	if (!pgid) process.exit(0);

	process.on("SIGTERM", () => void terminateJobGroup(pgid, jobFile, 0));
	process.on("SIGINT", () => void terminateJobGroup(pgid, jobFile, 0));

	const tick = async (): Promise<void> => {
		if (!existsSync(jobFile)) process.exit(0); // session cleanup already finished
		if (piPid !== undefined && !pidAlive(piPid)) {
			void terminateJobGroup(pgid, jobFile, 1);
			return;
		}
		const members = await jobGroupMembers(pgid);
		if (members === 0) {
			try {
				rmSync(jobFile, { force: true });
			} catch {
				/* best effort */
			}
			process.exit(0);
		}
	};
	void tick();
	setInterval(tick, WATCHDOG_INTERVAL_MS);
}

function main(): void {
	const args = parseArgs();
	if (args.mode === "watch") {
		runWatchdog(args.jobFile!);
		return;
	}

	const { command, jobFile, piPid } = args;
	const shell = process.env.SHELL ?? "/bin/bash";
	const child: import("node:child_process").ChildProcess = spawn(shell, ["-lc", command!], {
		detached: true,
		stdio: "inherit",
		env: process.env,
	});
	const pgid = child.pid!;

	const job: JobRecord = {
		jobId: args.jobId!,
		pid: process.pid,
		pgid,
		startedAt: Date.now(),
		piPid,
	};
	try {
		writeFileSync(jobFile!, JSON.stringify(job));
	} catch (err) {
		process.stderr.write(`[session-exec] cannot write job file: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(2);
	}

	// Watchdog for the Pi-main-process death (covers SIGKILL of Pi).
	const piWatchdog = setInterval(() => {
		if (piPid !== undefined && !pidAlive(piPid)) {
			void terminateJobGroup(pgid, jobFile!, 1);
		}
	}, WATCHDOG_INTERVAL_MS);
	piWatchdog.unref?.();

	process.on("SIGTERM", () => void terminateJobGroup(pgid, jobFile!, 0));
	process.on("SIGINT", () => void terminateJobGroup(pgid, jobFile!, 0));

	child.on("exit", (code) => {
		clearInterval(piWatchdog);
		void (async () => {
			const members = await jobGroupMembers(pgid);
			if (members === 0) {
				// Foreground job finished normally.
				try {
					rmSync(jobFile!, { force: true });
				} catch {
					/* best effort */
				}
				process.exit(code ?? 1);
			}
			// Backgrounded job: hand over to a detached watchdog so the caller
			// (bash tool) returns immediately while the job stays supervised.
			const watchdog = spawn(process.execPath, [process.argv[1]!, "--watch", jobFile!], {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			watchdog.unref();
			process.exit(code ?? 0);
		})();
	});
	child.on("error", (err) => {
		process.stderr.write(`[session-exec] failed to start command: ${err.message}\n`);
		clearInterval(piWatchdog);
		try {
			rmSync(jobFile!, { force: true });
		} catch {
			/* best effort */
		}
		process.exit(1);
	});
}

main();
