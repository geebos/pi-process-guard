/**
 * Stable exit codes for pi-guard (docs/pi-guard-startup-flow.md §22.1).
 *
 * Pi's own exit code is mirrored whenever Pi ran; the codes below are used
 * only for guard-level failures so scripts can distinguish "Pi failed" from
 * "the guard itself failed".
 */

export const EXIT_CODES = {
	/** Guard internal failure (e.g. janitor died while Pi was running). */
	INTERNAL: 70,
	/** Mandatory janitor could not be started / did not become ready. */
	JANITOR_UNAVAILABLE: 71,
	/** Platform backend unavailable (e.g. --guard-require-cgroup without systemd). */
	BACKEND_UNAVAILABLE: 72,
	/** Guard extension did not initialize within the readiness window. */
	EXTENSION_FAILURE: 73,
	/** Final runtime cleanup did not complete. */
	CLEANUP_INCOMPLETE: 74,
	/** Usage / recursive launch. */
	USAGE: 2,
} as const;
