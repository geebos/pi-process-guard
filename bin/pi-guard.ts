#!/usr/bin/env node
/**
 * pi-guard — runtime launcher for pi coding agent
 * (docs/pi-guard-startup-flow.md §4, §6, §8).
 *
 *   pi-guard [guard options] [pi args...]
 *
 * Guard-owned options use the --guard-* prefix so Pi args pass through
 * untouched. Administrative Pi invocations (--help/--version/install/update/
 * list/config) are passed through directly without creating a janitor;
 * everything else runs the full Launcher + Janitor + OS domain + Guard
 * extension flow.
 */

import { spawn } from "node:child_process";
import { constants, accessSync, existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import type { GuardConfig } from "../src/types.ts";
import { runGuard, resolveBundledExtension, GuardStartupError } from "../src/launcher/runtime.ts";
import { resolvePiBinary, PiResolutionError } from "../src/launcher/pi-resolver.ts";
import { EXIT_CODES } from "../src/exit-codes.ts";
import { systemdUserAvailable } from "../src/platform/linux-systemd.ts";
import { stateDirFor, socketFilePath } from "../src/guard-state.ts";

const GUARD_HELP = [
	"Usage: pi-guard [--guard-* options] [pi args...]",
	"       pi-guard --guard-doctor",
	"",
	"Guard options:",
	"  --guard-debug                          verbose logging",
	"  --guard-doctor                         print a health report and exit",
	"  --guard-pi-bin <path>                  explicit real `pi` executable",
	"  --guard-runtime-dir <path>             guard state root (runtime/<id> inside)",
	"  --guard-grace-ms <ms>                  SIGTERM grace before SIGKILL",
	"  --guard-janitor-ready-timeout-ms <ms>  janitor READY handshake timeout",
	"  --guard-extension-ready-timeout-ms <ms> EXTENSION_READY wait (0 disables)",
	"  --guard-require-cgroup                 fail on Linux without systemd user manager",
	"  --guard-force-runtime                  force the full runtime even for admin commands",
	"  --guard-help                           show this help",
	"",
	"All other arguments are forwarded to the real `pi` unchanged.",
	"Exit code mirrors Pi's exit code.",
].join("\n");

interface GuardCli {
	debug: boolean;
	doctor: boolean;
	piBin?: string;
	runtimeDir?: string;
	graceMs?: number;
	janitorReadyTimeoutMs?: number;
	extensionReadyTimeoutMs?: number;
	requireCgroup: boolean;
	forceRuntime: boolean;
	help: boolean;
	/** Arguments forwarded to Pi (after --guard-* extraction). */
	piArgs: string[];
}

function fail(message: string, code = 1): never {
	process.stderr.write(`[pi-guard] ${message}\n`);
	process.exit(code);
}

// Recursion guard (docs §8.2): a pi-guard that starts under pi-guard is a bug.
const inner = process.env.PI_GUARD_LAUNCH_DEPTH ?? (process.env.PI_PROCESS_GUARD_INNER ? "1" : "0");
const depth = Number(inner);
if (depth >= 1) {
	fail("refusing recursive pi-guard launch (PI_GUARD_LAUNCH_DEPTH is set)", EXIT_CODES.USAGE);
}

// Workspace runs rely on Node's TypeScript type stripping.
const tsSupport = (process.features as { typescript?: boolean }).typescript;
if (!tsSupport) {
	fail("requires Node.js >= 22.18 with TypeScript type stripping", EXIT_CODES.USAGE);
}

function parseGuardArgs(argv: string[]): GuardCli {
	const cli: GuardCli = {
		debug: false,
		doctor: false,
		requireCgroup: false,
		forceRuntime: false,
		help: false,
		piArgs: [],
	};
	const rest: string[] = [];
	let afterSeparator = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (afterSeparator) {
			rest.push(arg);
			continue;
		}
		switch (arg) {
			case "--":
				afterSeparator = true;
				break;
			case "--guard-debug":
				cli.debug = true;
				break;
			case "--guard-doctor":
				cli.doctor = true;
				break;
			case "--guard-require-cgroup":
				cli.requireCgroup = true;
				break;
			case "--guard-force-runtime":
				cli.forceRuntime = true;
				break;
			case "--guard-help":
				cli.help = true;
				break;
			case "--guard-pi-bin":
				cli.piBin = argv[++i];
				break;
			case "--guard-runtime-dir":
				cli.runtimeDir = argv[++i];
				break;
			case "--guard-grace-ms":
				cli.graceMs = Number(argv[++i]);
				break;
			case "--guard-janitor-ready-timeout-ms":
				cli.janitorReadyTimeoutMs = Number(argv[++i]);
				break;
			case "--guard-extension-ready-timeout-ms":
				cli.extensionReadyTimeoutMs = Number(argv[++i]);
				break;
			default:
				rest.push(arg);
		}
	}
	cli.piArgs = rest;
	return cli;
}

const ADMIN_FLAGS = new Set(["--help", "-h", "--version", "-V"]);
const ADMIN_COMMANDS = new Set(["install", "remove", "uninstall", "update", "list", "config"]);

/**
 * Classify the invocation (docs §6): administrative commands pass through
 * without a runtime; everything else gets the full guard.
 */
function isAdministrativeInvocation(piArgs: string[], forceRuntime: boolean): boolean {
	if (forceRuntime) return false;
	if (piArgs.length === 0) return false; // `pi-guard` alone starts the agent
	const first = piArgs[0]!;
	if (ADMIN_FLAGS.has(first)) return true;
	if (ADMIN_COMMANDS.has(first)) return true;
	return false;
}

function applyCliToConfig(base: GuardConfig, cli: GuardCli): GuardConfig {
	let cfg = base;
	if (cli.runtimeDir) cfg = { ...cfg, stateRoot: cli.runtimeDir };
	if (cli.graceMs !== undefined && Number.isFinite(cli.graceMs) && cli.graceMs > 0)
		cfg = { ...cfg, termGraceMs: Math.round(cli.graceMs) };
	if (cli.requireCgroup) cfg = { ...cfg, linux: { ...cfg.linux, requireCgroup: true } };
	if (cli.debug) cfg = { ...cfg, logging: { ...cfg.logging, level: "debug" } };
	if (cli.janitorReadyTimeoutMs !== undefined && Number.isFinite(cli.janitorReadyTimeoutMs) && cli.janitorReadyTimeoutMs > 0)
		cfg = { ...cfg, janitor: { ...cfg.janitor, readyTimeoutMs: Math.round(cli.janitorReadyTimeoutMs) } };
	if (cli.extensionReadyTimeoutMs !== undefined && Number.isFinite(cli.extensionReadyTimeoutMs) && cli.extensionReadyTimeoutMs >= 0)
		cfg = { ...cfg, extension: { ...cfg.extension, readyTimeoutMs: Math.round(cli.extensionReadyTimeoutMs) } };
	return cfg;
}

/** Administrative passthrough: no janitor, no extension (docs §6.2). */
function passthrough(targetBin: string, piArgs: string[]): Promise<number> {
	return new Promise<number>((resolve) => {
		const child = spawn(targetBin, piArgs, { stdio: "inherit" });
		const forward = (signal: NodeJS.Signals): void => {
			try {
				process.kill(child.pid!, signal);
			} catch {
				/* child gone */
			}
		};
		const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((sig) => {
			const h = (): void => forward(sig);
			process.on(sig, h);
			return { sig, h };
		});
		child.on("exit", (code) => {
			for (const { sig, h } of handlers) process.removeListener(sig, h);
			resolve(code ?? 1);
		});
		child.on("error", (err) => {
			for (const { sig, h } of handlers) process.removeListener(sig, h);
			process.stderr.write(`[pi-guard] failed to start ${targetBin}: ${err.message}\n`);
			resolve(1);
		});
	});
}

function checkExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** --guard-doctor: environment + file integrity report (docs §8.4). */
async function doctor(cli: GuardCli, config: GuardConfig): Promise<number> {
	const lines: string[] = ["Pi Process Guard — doctor"];
	const check = (ok: boolean, label: string, detail?: string): void => {
		lines.push(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
	};

	let piBin = "";
	try {
		piBin = resolvePiBinary(process.env, cli.piBin);
		check(true, "pi executable", piBin);
	} catch (err) {
		check(false, "pi executable", err instanceof Error ? err.message : String(err));
	}

	if (piBin) {
		const version = await new Promise<string>((resolve) => {
			const child = spawn(piBin, ["--version"], { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
			let out = "";
			child.stdout?.on("data", (d) => (out += d.toString()));
			child.on("error", () => resolve("(spawn failed)"));
			child.on("exit", () => resolve(out.trim() || "(no output)"));
		});
		check(!/spawn failed/.test(version) && !/no output/.test(version), "pi version", version);
	}

	try {
		const ext = resolveBundledExtension();
		check(existsSync(ext), "guard extension", ext);
	} catch (err) {
		check(false, "guard extension", err instanceof Error ? err.message : String(err));
	}

	const backend = process.platform === "darwin" ? "macos-posix" : await systemdUserAvailable() ? "linux-systemd" : "linux-posix";
	check(process.platform === "linux" || process.platform === "darwin", "platform", process.platform);
	check(backend !== "linux-posix", "backend", backend);

	// Runtime dir writability.
	try {
		const probe = stateDirFor(config, "doctor-probe");
		const { mkdirSync, rmSync } = await import("node:fs");
		mkdirSync(probe, { recursive: true, mode: 0o700 });
		rmSync(probe, { recursive: true, force: true });
		check(true, "runtime dir writable", config.stateRoot);
	} catch (err) {
		check(false, "runtime dir writable", err instanceof Error ? err.message : String(err));
	}

	process.stdout.write(lines.join("\n") + "\n");
	return 0;
}

async function main(): Promise<number> {
	const cli = parseGuardArgs(process.argv.slice(2));

	if (cli.help) {
		process.stdout.write(GUARD_HELP + "\n");
		return 0;
	}

	let config = loadConfig();
	config = applyCliToConfig(config, cli);

	if (cli.doctor) {
		return doctor(cli, config);
	}

	let targetBin: string;
	try {
		targetBin = resolvePiBinary(process.env, cli.piBin);
	} catch (err) {
		if (err instanceof PiResolutionError) fail(err.message, EXIT_CODES.USAGE);
		throw err;
	}

	if (isAdministrativeInvocation(cli.piArgs, cli.forceRuntime)) {
		return passthrough(targetBin, cli.piArgs);
	}

	try {
		return await runGuard({ targetBin, targetArgs: cli.piArgs, config, env: process.env });
	} catch (err) {
		if (err instanceof GuardStartupError) {
			fail(err.message, err.code);
		}
		fail(err instanceof Error ? err.message : String(err), EXIT_CODES.INTERNAL);
	}
}

main().then((code) => process.exit(code));
