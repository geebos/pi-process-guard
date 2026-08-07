/**
 * Session process manager (docs/tech.md §9, §28).
 *
 * Tracks session-owned jobs and the current session id. Phase 1 registers the
 * session lifecycle and an idempotent cleanup; bash tool / user-bash wrapping
 * and real job termination arrive in Phase 2.
 */

export interface SessionJob {
	id: string;
	/** Command string kept minimal; full command lines are never logged. */
	command: string;
	startedAt: number;
	pid?: number;
}

export class SessionProcessManager {
	private sessionId: string | undefined;
	private readonly jobs = new Map<string, SessionJob>();

	/** Start (or replace) a session; previous session jobs must already be cleaned. */
	beginSession(sessionId: string): void {
		this.sessionId = sessionId;
		this.jobs.clear();
	}

	get currentSessionId(): string | undefined {
		return this.sessionId;
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

	/**
	 * Stop all session-owned jobs and clear the registry.
	 * Idempotent: repeated calls are safe (docs/tech.md §6).
	 *
	 * Phase 1: jobs are not yet spawned by this manager, so this only clears
	 * the registry. Phase 2 replaces this with real TERM/KILL semantics.
	 */
	async cleanupSession(): Promise<{ stopped: number }> {
		const stopped = this.jobs.size;
		this.jobs.clear();
		return { stopped };
	}
}

export function createSessionManager(): SessionProcessManager {
	return new SessionProcessManager();
}
