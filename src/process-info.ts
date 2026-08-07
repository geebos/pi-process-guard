/**
 * POSIX process inspection helpers backed by `ps`.
 *
 * Used by the process-group backend and the janitor to enumerate a process
 * group, verify process ownership and protect against PID reuse via start
 * identity. Pure `ps` is the documented portability fallback; a native
 * libproc-based sampler may replace it later (docs/tech.md §8.4).
 */

import { execFile } from "node:child_process";
import { userInfo } from "node:os";

export interface PsRow {
	pid: number;
	ppid: number;
	pgid: number;
	user: string;
	comm: string;
}

const PS_COLUMNS = "pid=,ppid=,pgid=,user=,comm=";

function runPs(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("/bin/ps", args, { timeout: 5000 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}

/** True if a PID exists right now. ESRCH means gone; EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code !== "ESRCH";
	}
}

/**
 * List all processes in a process group.
 * Returns rows for the current user only (docs/tech.md §19.1: never signal
 * processes owned by other users).
 */
export async function listPgidMembers(pgid: number, owner = userInfo().username): Promise<PsRow[]> {
	if (!Number.isInteger(pgid) || pgid <= 0) return [];
	const out = await runPs(["-e", "-o", PS_COLUMNS]);
	const rows: PsRow[] = [];
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!m) continue;
		const [, pid, ppid, gid, user, comm] = m;
		if (Number(gid) !== pgid) continue;
		if (user !== owner) continue;
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			pgid: Number(gid),
			user,
			comm: comm ?? "",
		});
	}
	return rows;
}

/**
 * Read a process start-time identity string, used to guard against PID reuse.
 * `undefined` means the process does not exist (or is not readable).
 */
export async function getStartIdentity(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const out = await runPs(["-o", "lstart=", "-p", String(pid)]);
		const identity = out.trim();
		return identity.length > 0 ? identity : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Verify that `pid` still refers to the same process as `expectedStartIdentity`.
 * The janitor must re-check this before signaling tracked PIDs (docs/tech.md §8.5).
 */
export async function startIdentityMatches(pid: number, expectedStartIdentity: string | undefined): Promise<boolean> {
	if (!expectedStartIdentity) return false;
	const current = await getStartIdentity(pid);
	return current === expectedStartIdentity;
}

/** Resolve the process group id of a PID via ps. */
export async function getPgid(pid: number): Promise<number | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const out = await runPs(["-o", "pgid=", "-p", String(pid)]);
		const value = Number(out.trim());
		return Number.isInteger(value) && value > 0 ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Send a signal to a whole process group (POSIX killpg).
 * A group with no members yields ESRCH, which is treated as success (idempotent).
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	if (!Number.isInteger(pgid) || pgid <= 0) return;
	try {
		process.kill(-pgid, signal);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") throw err;
	}
}
