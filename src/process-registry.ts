/**
 * Descendant registry for the process-group backend (docs/tech.md §8.4).
 *
 * killpg covers the Pi process group, but a descendant can escape with
 * setsid(). The registry periodically samples the process table, walks the
 * PPID tree from Pi's PID, and remembers every process ever confirmed to be
 * part of the runtime — with a start-time identity to guard against PID
 * reuse (docs/tech.md §8.5). The launcher persists the registry so the
 * janitor can perform the final sweep after Pi dies.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { getStartIdentity, pidAlive } from "./process-info.ts";

export interface TrackedProcess {
	pid: number;
	ppid: number;
	pgid: number;
	firstSeenAt: number;
	/** Process start-time identity; verified before signalling (PID reuse guard). */
	startIdentity?: string;
	lastSeenPpid: number;
	lastSeenPgid: number;
}

interface PsSampleRow {
	pid: number;
	ppid: number;
	pgid: number;
	user: string;
	comm: string;
}

const PS_COLUMNS = "pid=,ppid=,pgid=,sess=,user=,comm=";

function runPs(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("/bin/ps", ["-e", "-o", PS_COLUMNS], { timeout: 5000 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(stdout);
		});
	});
}

async function sampleTable(owner: string): Promise<PsSampleRow[]> {
	const out = await runPs();
	const rows: PsSampleRow[] = [];
	for (const line of out.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
		if (!m) continue;
		const [, pid, ppid, pgid, , user, comm] = m;
		if (user !== owner) continue;
		rows.push({
			pid: Number(pid),
			ppid: Number(ppid),
			pgid: Number(pgid),
			user,
			comm: comm ?? "",
		});
	}
	return rows;
}

export class ProcessTracker {
	private readonly registered = new Map<number, TrackedProcess>();
	private readonly owner: string;
	/** Last full sample: pid -> row. */
	private lastSample = new Map<number, PsSampleRow>();
	private readonly rootPid: number;

	constructor(rootPid: number, owner = userInfo().username) {
		this.rootPid = rootPid;
		this.owner = owner;
	}

	/** Processes confirmed as runtime descendants so far. */
	snapshot(): TrackedProcess[] {
		return [...this.registered.values()];
	}

	/** True when `pid` is still the same process as `identity` recorded earlier. */
	async verify(process: TrackedProcess): Promise<boolean> {
		if (!pidAlive(process.pid)) return false;
		if (!process.startIdentity) return false;
		const current = await getStartIdentity(process.pid);
		return current === process.startIdentity;
	}

	/**
	 * Sample the process table, walk descendants from the root PID, and update
	 * the registry. Newly seen processes get their start identity recorded.
	 */
	async sample(): Promise<void> {
		const rows = await sampleTable(this.owner);
		this.lastSample = new Map(rows.map((r) => [r.pid, r]));

		// BFS the PPID tree from the root pid.
		const byParent = new Map<number, number[]>();
		for (const row of rows) {
			const list = byParent.get(row.ppid) ?? [];
			list.push(row.pid);
			byParent.set(row.ppid, list);
		}
		const descendants = new Set<number>();
		const queue = [this.rootPid];
		while (queue.length > 0) {
			const pid = queue.shift()!;
			for (const child of byParent.get(pid) ?? []) {
				if (!descendants.has(child)) {
					descendants.add(child);
					queue.push(child);
				}
			}
		}

		const now = Date.now();
		for (const pid of descendants) {
			const row = this.lastSample.get(pid);
			if (!row) continue;
			const existing = this.registered.get(pid);
			if (existing) {
				existing.lastSeenPpid = row.ppid;
				existing.lastSeenPgid = row.pgid;
				continue;
			}
			// New process: record it with its start identity. Sync fetch is fine
			// here (rare, one ps call) but keep it non-blocking for the loop.
			void this.captureIdentity(pid, row).then((tracked) => {
				if (tracked) this.registered.set(pid, tracked);
			});
		}

		// Drop processes that no longer exist.
		for (const [pid, tracked] of this.registered) {
			if (!this.lastSample.has(pid) && !pidAlive(pid)) {
				this.registered.delete(pid);
			}
			void tracked;
		}
	}

	private async captureIdentity(pid: number, row: PsSampleRow): Promise<TrackedProcess | undefined> {
		const startIdentity = await getStartIdentity(pid);
		if (!startIdentity) return undefined; // vanished between sample and capture
		const now = Date.now();
		return {
			pid,
			ppid: row.ppid,
			pgid: row.pgid,
			firstSeenAt: now,
			startIdentity,
			lastSeenPpid: row.ppid,
			lastSeenPgid: row.pgid,
		};
	}

	/** Persist the registry so a janitor can perform the final sweep. */
	writeTo(path: string): void {
		try {
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, JSON.stringify(this.snapshot()));
		} catch {
			// best effort — registry is an enhancement, never a blocker
		}
	}

	static readFrom(path: string): TrackedProcess[] {
		if (!existsSync(path)) return [];
		try {
			const parsed = JSON.parse(readFileSync(path, "utf8")) as TrackedProcess[];
			return Array.isArray(parsed) ? parsed.filter((p) => Number.isInteger(p?.pid) && p.pid > 0) : [];
		} catch {
			return [];
		}
	}
}
