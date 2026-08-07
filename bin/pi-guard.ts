#!/usr/bin/env node
/**
 * pi-guard — launcher CLI for pi-process-guard.
 *
 * Starts the Pi runtime inside a guard isolation domain with a mandatory
 * independent janitor. Prefer launching Pi through this binary:
 *
 *   pi-guard [pi args...]
 *   pi-guard -- [pi args...]
 *
 * Internal env overrides (debug/testing):
 *   PI_PROCESS_GUARD_TARGET_BIN  — binary to launch instead of `pi` from PATH
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { runGuard } from "../src/guard.ts";

function fail(message: string, code = 1): never {
	process.stderr.write(`[pi-guard] ${message}\n`);
	process.exit(code);
}

// Guard against alias recursion: the launcher must never re-wrap itself.
if (process.env.PI_PROCESS_GUARD_INNER) {
	fail("refusing to launch: PI_PROCESS_GUARD_INNER is set (launcher recursion?)", 2);
}

// Published binaries are compiled to JS (dist/); in the workspace the
// launcher runs as TypeScript and relies on Node's type stripping.
const tsSupport = (process.features as { typescript?: boolean }).typescript;
if (!tsSupport) {
	fail("requires Node.js >= 22.18 with TypeScript type stripping", 2);
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
	process.stdout.write(
		[
			"Usage: pi-guard [pi args...]",
			"       pi-guard -- [pi args...]",
			"",
			"Runs pi inside a guard isolation domain with a mandatory janitor.",
			"Resolves the real `pi` executable from PATH unless",
			"PI_PROCESS_GUARD_TARGET_BIN overrides it.",
			"",
			"Exit code mirrors the guarded pi process.",
		].join("\n") + "\n",
	);
	process.exit(0);
}

const dd = args.indexOf("--");
const targetArgs = dd >= 0 ? args.slice(dd + 1) : args;

function resolvePiBinary(): string {
	const override = process.env.PI_PROCESS_GUARD_TARGET_BIN;
	if (override) return override;
	const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean);
	for (const dir of pathEntries) {
		const candidate = join(dir, "pi");
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// keep scanning
		}
	}
	fail(
		"could not resolve the `pi` executable from PATH. " +
			"Install pi or set PI_PROCESS_GUARD_TARGET_BIN explicitly.",
	);
}

const targetBin = resolvePiBinary();

runGuard({ targetBin, targetArgs })
	.then((code) => {
		process.exit(code);
	})
	.catch((err: unknown) => {
		fail(err instanceof Error ? err.message : String(err));
	});
