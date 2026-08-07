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

/**
 * Locate the session-exec entry Node can actually execute.
 *
 * Published packages ship compiled JS under dist/src/ — Node refuses to
 * type-strip .ts files inside node_modules — while the workspace runs the
 * same file as .ts (project files are not subject to the node_modules
 * restriction). `here` is the directory of the module doing the resolution:
 *   - dist/src/ when a compiled module is loaded (candidate 1)
 *   - src/ when pi loads the extension sources (candidate 2, matching the
 *     installed layout where dist/src/session-exec.js sits next to src/)
 */
export function resolveExecutorEntryFrom(here: string): string {
	const candidates = [
		join(here, "session-exec.js"), // compiled layout: dist/src/
		join(here, "..", "dist", "src", "session-exec.js"), // src/ → dist/src/ (workspace / node_modules install)
		join(here, "session-exec.ts"), // plain workspace run: src/
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[2]!;
}

const EXECUTOR_ENTRY = resolveExecutorEntryFrom(fileURLToPath(new URL(".", import.meta.url)));

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
		return this.readJobRecords().length;
	}

	/**
	 * Session jobs, disk-backed: job records carry the pgid that cleanup
	 * actually signals. The command string is looked up in the memory cache
	 * (foreground commands remove their record on finish, so it may be absent).
	 */
	listJobs(): SessionJob[] {
		return this.readJobRecords().map((r) => ({
			id: r.jobId,
			command: this.jobs.get(r.jobId)?.command ?? "",
			startedAt: r.startedAt,
			pid: r.pid,
		}));
	}

	/**
	 * Remember a wrapped command until its executor publishes the on-disk job
	 * record. The memory entry has no pgid, so it is only a write-window cache
	 * and diagnostic aid — it never counts towards cleanup totals.
	 */
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
	 * Drop memory entries whose on-disk job record is gone (the executor
	 * removes the record when a foreground command finishes). Keeps the cache
	 * bounded and consistent with what cleanup can actually signal.
	 */
	private pruneMemoryJobs(): void {
		const diskIds = new Set(this.readJobRecords().map((r) => r.jobId));
		for (const id of [...this.jobs.keys()]) {
			if (!diskIds.has(id)) this.jobs.delete(id);
		}
	}

	/**
	 * Number of jobs that the next cleanup will actually signal — on-disk job
	 * records with a pgid. Used to announce an upcoming cleanup.
	 */
	pendingJobCount(): number {
		this.pruneMemoryJobs();
		return this.readJobRecords().length;
	}

	/**
	 * Stop all session-owned jobs (TERM → grace → KILL) and clear the session.
	 * Idempotent: repeated calls are safe; ESRCH is treated as already gone.
	 *
	 * `stopped` counts the on-disk job records (each has a pgid that is sent
	 * SIGTERM → SIGKILL). Foreground commands that already finished removed
	 * their records, so they never inflate the total.
	 */
	async cleanupSession(): Promise<{ stopped: number }> {
		// Give a just-wrapped command's executor a moment to publish its job
		// record, so a /new right after `npm run dev &` still catches it.
		await sleep(200);
		this.pruneMemoryJobs();
		const records = this.readJobRecords();
		const stopped = records.length;
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
