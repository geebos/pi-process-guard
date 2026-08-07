#!/usr/bin/env node
/**
 * publish:local — bump the version (without a git commit) and publish to a
 * local npm registry (Verdaccio etc.), for local integration testing of the
 * pi-process-guard package.
 *
 * Usage:
 *   npm run publish:local             # patch bump
 *   npm run publish:local -- minor    # minor bump
 *   npm run publish:local -- major    # major bump
 *
 * The version bump writes package.json + package-lock.json only; no git
 * commit or tag is created (`npm version --no-git-tag-version`).
 *
 * Local registry address (in precedence order):
 *   $PI_GUARD_LOCAL_REGISTRY, $LOCAL_REGISTRY, default http://localhost:4873
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");
const registry =
	process.env.PI_GUARD_LOCAL_REGISTRY ?? process.env.LOCAL_REGISTRY ?? "http://localhost:4873";

const bump = process.argv[2] ?? "patch";
const BUMPS = ["patch", "minor", "major", "prepatch", "preminor", "premajor", "prerelease"];
if (!BUMPS.includes(bump)) {
	process.stderr.write(`[publish:local] invalid bump "${bump}" — use one of: ${BUMPS.join(", ")}\n`);
	process.exit(2);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const prev = pkg.version;

// Bump in package.json (+ package-lock.json). No git commit, no tag.
const newVersion = execFileSync("npm", ["version", bump, "--no-git-tag-version"], {
	cwd: repoRoot,
	stdio: "pipe",
	encoding: "utf8",
})
	.trim()
	.replace(/^v/, "");

console.log(`[publish:local] version ${prev} -> ${newVersion} (no git commit)`);

try {
	execFileSync("npm", ["publish", "--registry", registry], { cwd: repoRoot, stdio: "inherit" });
} catch {
	process.stderr.write(
		`[publish:local] publish to ${registry} failed. ` +
			`The version bump to ${newVersion} was kept (uncommitted); fix the registry and re-run.\n`,
	);
	process.exit(1);
}

console.log(`[publish:local] published ${pkg.name}@${newVersion} to ${registry}`);
