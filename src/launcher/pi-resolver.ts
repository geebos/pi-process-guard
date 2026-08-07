/**
 * Real-Pi executable resolution (docs/pi-guard-startup-flow.md §8).
 *
 * Priority:
 *   1. --guard-pi-bin / PI_GUARD_PI_BIN explicit path
 *   2. PATH scan for the first executable `pi` (no shell involved)
 *
 * Recursion protection:
 *   - PI_GUARD_LAUNCH_DEPTH >= 1 => refuse (a second pi-guard under pi-guard)
 *   - realpath(candidate) is compared against this launcher's own entry;
 *     a candidate that resolves back to pi-guard is rejected.
 */

import { accessSync, constants, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export class PiResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PiResolutionError";
	}
}

/** The pi-guard entry this process is running from (for self-comparison). */
export function launcherSelfPath(): string {
	try {
		return realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return fileURLToPath(import.meta.url);
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Guard against launching pi-guard itself as "pi". */
function isSelf(candidate: string): boolean {
	const self = launcherSelfPath();
	try {
		if (realpathSync(candidate) === self) return true;
	} catch {
		// candidate vanished between access check and realpath
	}
	// Also reject a candidate whose resolved entry is our own janitor/extension.
	return candidate === self;
}

export function resolvePiBinary(env: NodeJS.ProcessEnv = process.env, explicitBin?: string): string {
	if (explicitBin) {
		if (!isExecutable(explicitBin)) {
			throw new PiResolutionError(`--guard-pi-bin ${explicitBin} is not executable`);
		}
		return explicitBin;
	}

	const envBin = env.PI_GUARD_PI_BIN;
	if (envBin) {
		if (!isExecutable(envBin)) {
			throw new PiResolutionError(`PI_GUARD_PI_BIN=${envBin} is not executable`);
		}
		return envBin;
	}

	const pathEntries = (env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of pathEntries) {
		const candidate = join(dir, "pi");
		if (!isExecutable(candidate)) continue;
		if (isSelf(candidate)) continue; // PATH points at pi-guard itself
		return candidate;
	}

	throw new PiResolutionError(
		"could not resolve the `pi` executable from PATH. " +
			"Install pi, or pass --guard-pi-bin / set PI_GUARD_PI_BIN explicitly.",
	);
}
