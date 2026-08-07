#!/usr/bin/env node
/**
 * pi-guard-janitor — mandatory independent cleanup process (docs/tech.md §13).
 *
 * Runs as a detached OS process, separate from Pi and the launcher, so it can
 * reclaim the runtime even when Pi is SIGKILLed or the launcher disappears.
 *
 * Usage:
 *   pi-guard-janitor <stateFile> [--recovery]
 *
 * Normal mode: supervises the runtime and performs final cleanup when
 *   - the launcher marks the phase "terminating" (graceful quit), or
 *   - the Pi main process exits, or
 *   - the launcher disappears and the orphan grace window elapses.
 * Recovery mode: reclaims a stale state directory where both the launcher and
 * the Pi process are already gone.
 */

import { dirname } from "node:path";
import { loadConfig } from "../config.ts";
import { createBackend } from "../platform/index.ts";
import type { GuardBackend } from "../platform/index.ts";
import { termThenKill } from "../cleanup.ts";
import { deleteStateDir, readState, updateState } from "../guard-state.ts";
import { pidAlive } from "../process-info.ts";
import { createLogger } from "../log.ts";
import type { GuardStateFile } from "../types.ts";

const [stateFilePath, flag] = process.argv.slice(2);

function main(): void {
	if (!stateFilePath) {
		process.stderr.write("[pi-guard-janitor] missing state file argument\n");
		process.exit(2);
	}

	const config = loadConfig();
	const stateDir = dirname(stateFilePath);
	let state = readState(stateDir);
	const log = createLogger(config, { guardId: state?.guardId, action: "janitor" });

	if (!state) {
		// Nothing to supervise — the runtime was never fully created.
		process.exit(0);
	}

	const backendFor = async (s: GuardStateFile): Promise<GuardBackend> =>
		createBackend(s.platform as NodeJS.Platform, config, {
			guardId: s.guardId,
			pgid: s.piPgid,
			runtimeUnit: s.runtimeUnit,
		});

	let cleaning = false;

	async function cleanupAndExit(s: GuardStateFile): Promise<never> {
		if (cleaning) process.exit(0); // already running; do not double-enter
		cleaning = true;
		log.info("final cleanup started", { phase: s.phase, backend: s.backend, pgid: s.piPgid, unit: s.runtimeUnit });
		try {
			const backend = await backendFor(s);
			const result = await termThenKill(backend, {
				termGraceMs: config.termGraceMs,
				killVerifyMs: config.killVerifyMs,
				log,
			});
			const clean = await backend.isClean();
			log.info("final cleanup finished", {
				result: result.outcome,
				clean: String(clean),
				durationMs: String(result.durationMs),
			});
		} catch (err) {
			log.error("final cleanup failed", { error: err instanceof Error ? err.message : String(err) });
		}
		deleteStateDir(stateDir);
		log.info("runtime state removed; janitor exiting");
		process.exit(0);
	}

	if (flag === "--recovery") {
		// Only reclaim when neither the launcher nor Pi is alive (docs/tech.md §13.8).
		if (pidAlive(state.launcherPid) || pidAlive(state.piPid)) {
			log.debug("recovery aborted: launcher or Pi still alive", {
				launcherPid: state.launcherPid,
				piPid: state.piPid,
			});
			process.exit(0);
		}
		log.warn("recovery janitor reclaiming stale runtime", {
			launcherPid: state.launcherPid,
			piPid: state.piPid,
			pgid: state.piPgid,
		});
		void cleanupAndExit(state);
		return;
	}

	// Normal supervision: announce readiness so the launcher can proceed
	// (the janitor must be up before Pi starts; docs/tech.md §21).
	state = updateState(stateDir, { janitorReadyAt: Date.now() }) ?? state;

	let orphanSince: number | undefined;

	const tick = async (): Promise<void> => {
		if (cleaning) return;
		const current = readState(stateDir);
		if (!current) {
			process.exit(0);
		}
		if (!current.piPid || current.piPid <= 0) {
			return; // Pi not started yet — nothing to supervise.
		}
		const piAlive = pidAlive(current.piPid);
		const launcherAlive = pidAlive(current.launcherPid);

		if (current.phase === "terminating" || !piAlive) {
			await cleanupAndExit(current);
		}
		if (!launcherAlive) {
			// Launcher lost while Pi lives: enter the orphan grace window
			// (docs/tech.md §12.4) — do not kill a possibly healthy Pi right away.
			orphanSince ??= Date.now();
			if (Date.now() - orphanSince >= config.janitor.orphanGraceMs) {
				log.warn("launcher lost; runtime orphaned after grace window", { action: "orphan-cleanup" });
				await cleanupAndExit(current);
			}
		} else {
			orphanSince = undefined;
		}
	};

	void tick();
	setInterval(tick, config.janitor.heartbeatMs);
}

main();
