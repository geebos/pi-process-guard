/**
 * TERM → KILL cleanup state machine (docs/tech.md §11).
 *
 *   RUNNING
 *     -> TERMINATING (SIGTERM)
 *     -> all exited                -> CLEAN
 *     -> grace timeout -> KILLING  -> CLEAN
 *
 * Idempotent: repeated calls simply re-verify; a domain that is already empty
 * is reported clean immediately. `ESRCH` is treated as "target already gone".
 */

import type { CleanupResult } from "./types.ts";
import type { Logger } from "./log.ts";

export interface TermKillTarget {
	/** Send SIGTERM to the whole runtime domain. */
	signalTerm(): Promise<void>;
	/** Send SIGKILL to surviving members of the runtime domain. */
	signalKill(): Promise<void>;
	/** True when the runtime domain holds no more (owned) processes. */
	isClean(): Promise<boolean>;
}

export interface TermKillOptions {
	termGraceMs: number;
	killVerifyMs: number;
	/** How often to poll isClean() while waiting. */
	pollMs?: number;
	log?: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntilClean(target: TermKillTarget, deadline: number, pollMs: number): Promise<boolean> {
	for (;;) {
		if (await target.isClean()) return true;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await sleep(Math.min(pollMs, remaining));
	}
}

export async function termThenKill(target: TermKillTarget, opts: TermKillOptions): Promise<CleanupResult> {
	const pollMs = opts.pollMs ?? 100;
	const log = opts.log;
	const startedAt = Date.now();

	await target.signalTerm();
	log?.debug("cleanup: SIGTERM sent", { action: "term" });

	if (await waitUntilClean(target, startedAt + opts.termGraceMs, pollMs)) {
		return { outcome: "clean", durationMs: Date.now() - startedAt };
	}

	log?.warn("cleanup: grace period elapsed, escalating to SIGKILL", { action: "kill" });
	await target.signalKill();

	if (await waitUntilClean(target, startedAt + opts.termGraceMs + opts.killVerifyMs, pollMs)) {
		return { outcome: "kill-required", durationMs: Date.now() - startedAt };
	}

	log?.error("cleanup: domain not clean after SIGKILL", { action: "verify" });
	return { outcome: "not-clean", durationMs: Date.now() - startedAt };
}
