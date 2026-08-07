import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Register guard tools.
 *
 * Phase 1 ships no agent tools. Phase 2 adds bash tool / user-bash wrapping
 * (tool_call interception with session-owned execution domains, docs/tech.md §9).
 */
export function registerGuardTools(_pi: ExtensionAPI): void {
	// no tools in Phase 1
}
