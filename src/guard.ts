/**
 * Launcher entry — re-exports the startup state machine.
 *
 * The full startup flow lives in src/launcher/runtime.ts
 * (docs/pi-guard-startup-flow.md §37). This module keeps the historical
 * `runGuard` import path stable for tests and tooling.
 */

export { runGuard, GuardStartupError } from "./launcher/runtime.ts";
export type { RunGuardOptions } from "./launcher/runtime.ts";
