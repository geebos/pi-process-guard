/**
 * Session process manager (docs/tech.md §9, §28).
 *
 * Session-owned commands (bash tool, user `!`/`!!`) are wrapped with
 * `session-exec`, which runs them in their own process group. A session
 * switch (/new, /resume, /fork, /reload) terminates those process groups
 * while leaving runtime-level extension helpers untouched.
 *
 * Job metadata lives on disk under
 *   <stateRoot>/pi-process-guard/sessions/<sessionId>/jobs/<jobId>.json
 * so it survives extension reloads (docs/tech.md §22.3).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { killProcessGroup, listPgidMembers } from "./process-info.ts";

const EXECUTOR_ENTRY = fileURLToPath(new URL("./session-exec.ts", import.meta.url));

export interface SessionJob {
	id: string;
	command: string;
	startedAt: number;
	pid?: number;
}

export interface JobRecord {
	jobId: string;
	pid: number;
	pgid: number;
	startedAt: number;
	piPid?: number;
}

/** Single-quote a string for safe embedding into a shell command line. */
export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultStateRoot(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	const root = xdg && xdg.trim() ? xdg : join(homedir(), ".cache");
	return process.env.PI_PROCESS_GUARD_STATE_ROOT ?? join(root, "pi-process-guard");
}

export function sessionDirFor(stateRoot: string, sessionId: string): string {
	return join(stateRoot, "sessions", sessionId);
}

export class SessionProcessManager {
	private stateRoot: string;
	private sessionId: string | undefined;
	private readonly jobs = new Map<string, SessionJob>();

	constructor(stateRoot: string = defaultStateRoot()) {
		this.stateRoot = stateRoot;
	}

	/** Start (or replace) a session; previous session jobs must already be cleaned. */
	beginSession(sessionId: string): void {
		this.sessionId = sessionId;
		this.jobs.clear();
	}

	get currentSessionId(): string | undefined {
		return this.sessionId;
	}

	get sessionDir(): string | undefined {
		return this.sessionId ? sessionDirFor(this.stateRoot, this.sessionId) : undefined;
	}

	get jobCount(): number {
		return this.jobs.size;
	}

	listJobs(): SessionJob[] {
		return [...this.jobs.values()];
	}

	trackJob(job: SessionJob): void {
		this.jobs.set(job.id, job);
	}

	/** True when the command is already wrapped (idempotent wrapping). */
	isWrapped(command: string): boolean {
		return command.includes(EXECUTOR_ENTRY);
	}

	/**
	 * Wrap a raw command so it runs inside a session-owned process group:
	 *   node session-exec.ts -- '<command>'
	 * The original command is passed as one single-quoted argument so shell
	 * operators (&&, |, ;, >) stay inside the wrapped shell, not the wrapper.
	 * `piPid` defaults to the current process; tests inject a stand-in.
	 */
	wrapCommand(command: string, piPid: number = process.pid): string {
		if (this.isWrapped(command)) return command;
		if (!this.sessionId) return command; // no active session — run unwrapped
		const jobId = randomId();
		const sessionDir = this.sessionDir!;
		try {
			mkdirSync(join(sessionDir, "jobs"), { recursive: true });
		} catch {
			return command; // cannot manage — run unwrapped
		}
		this.trackJob({ id: jobId, command, startedAt: Date.now() });
		return (
			`PI_GUARD_SESSION_DIR=${shq(sessionDir)} ` +
			`PI_GUARD_JOB_ID=${shq(jobId)} ` +
			`PI_GUARD_PI_PID=${shq(String(piPid))} ` +
			`${shq("node")} ${shq(EXECUTOR_ENTRY)} -- ${shq(command)}`
		);
	}



	private jobsDir(): string | undefined {
		const dir = this.sessionDir;
		return dir ? join(dir, "jobs") : undefined;
	}

	/** Read job records currently published on disk (survives reloads). */
	readJobRecords(): JobRecord[] {
		const dir = this.jobsDir();
		if (!dir || !existsSync(dir)) return [];
		try {
			return readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => {
					try {
						return JSON.parse(readFileSync(join(dir, name), "utf8")) as JobRecord;
					} catch {
						return undefined;
					}
				})
				.filter((r): r is JobRecord => Boolean(r?.pgid));
		} catch {
			return [];
		}
	}

	/**
	 * Number of jobs this session owns right now (on-disk records + in-memory
	 * pending, deduplicated). Used to announce an upcoming cleanup.
	 */
	pendingJobCount(): number {
		return this.sessionJobIds().size;
	}

	private sessionJobIds(): Set<string> {
		const records = this.readJobRecords();
		return new Set<string>([...records.map((r) => r.jobId), ...this.jobs.keys()]);
	}

	/**
	 * Stop all session-owned jobs (TERM → grace → KILL) and clear the session.
	 * Idempotent: repeated calls are safe; ESRCH is treated as already gone.
	 */
	async cleanupSession(): Promise<{ stopped: number }> {
		// Give a just-wrapped command's executor a moment to publish its job
		// record, so a /new right after `npm run dev &` still catches it.
		await sleep(200);
		const records = this.readJobRecords();
		const ids = this.sessionJobIds();
		const stopped = ids.size;
		this.jobs.clear();

		for (const record of records) {
			killProcessGroup(record.pgid, "SIGTERM");
		}
		if (records.length > 0) {
			await sleep(2000); // TERM grace period (docs/tech.md §11)
			for (const record of records) {
				const members = await listPgidMembers(record.pgid);
				if (members.length > 0) killProcessGroup(record.pgid, "SIGKILL");
			}
			await sleep(300); // allow survivors to die before removing records
		}

		const dir = this.sessionDir;
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best effort */
			}
		}
		return { stopped };
	}
}

function randomId(): string {
	return globalThis.crypto.randomUUID();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function createSessionManager(): SessionProcessManager {
	return new SessionProcessManager();
}
