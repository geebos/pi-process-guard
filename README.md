# pi-process-guard

[English](./README.md) | [中文](./README.zh-CN.md)

**Pi Process Guard — a launcher + mandatory janitor + pi extension that makes
sure no ordinary descendant processes of Pi survive Pi's exit — including
crashes and `SIGKILL`.**

Implementation follows [`docs/tech.md`](./docs/tech.md).

## Why

A Pi coding agent can start language servers, watchers, dev servers, test
runners, and arbitrary `child_process.spawn()` processes from any extension.
When Pi exits — normally, through a crash, or via `SIGKILL` — those processes
can be left behind.

Relying only on the extension `session_shutdown` lifecycle event is not enough:

- `SIGKILL` runs no JavaScript cleanup;
- one extension cannot reliably intercept another extension's `spawn()`;
- `session_shutdown` also fires on `/new`, `/resume`, `/fork`, `/reload`, which
  must only stop *session-owned* jobs, not the whole runtime.

Pi Process Guard solves this with three components shipped in one npm package:

| Component | Responsibility |
| --- | --- |
| `pi-guard` launcher | creates the guard identity + isolation domain, starts the janitor, starts Pi, forwards signals |
| janitor (`pi-guard-janitor`) | **mandatory** independent OS process; performs the final TERM → KILL cleanup even when Pi is `SIGKILL`ed or the launcher disappears |
| Pi extension | session lifecycle (`session_start` / `session_shutdown`), diagnostics, session-owned job management |

**Isolation domains:**

- **Linux:** a dedicated `systemd --user` transient service (cgroup) —
  `KillMode=control-group`, with a process-group fallback when systemd is
  unavailable.
- **macOS:** a dedicated POSIX process group (PGID = Pi PID); every ordinary
  descendant inherits it.

## Install

One package installs the extension, the launcher, and the janitor:

```bash
pi install npm:pi-process-guard
```

The janitor starts automatically; there is no extra installation step and no
user-facing toggle.

**Prefer launching Pi through the launcher** (optionally via a shell alias):

```bash
alias pi='pi-guard'
pi
```

> The launcher resolves the real `pi` binary from `PATH` and refuses to
> re-wrap itself, so the alias is safe from recursion.

## Session semantics

- `session_start` → new session id + session job registry
- `session_shutdown(reason)` → stops **session-owned jobs only**, regardless of
  reason (`quit`, `new`, `resume`, `fork`, `reload`)
- Pi exit → janitor performs the runtime-level final sweep of the whole domain

## Session-owned commands

Every bash tool command and user `!` / `!!` command is wrapped into a
**session-owned process group**: a small `session-exec` process runs the
command detached, publishes a job record, and supervises it. Consequences:

- `/new`, `/resume`, `/fork`, `/reload` terminate the previous session's
  dev servers / watchers / background jobs (TERM → grace → KILL), while
  runtime-level extension helpers stay untouched;
- backgrounded commands (`npm run dev &`) keep running and stay tracked — a
  detached watchdog reclaims them when the session ends or Pi dies;
- if Pi is `SIGKILL`ed, the session jobs are still reclaimed by the watchdog,
  because pi's own detached-child cleanup never runs on SIGKILL.

Job records live on disk under
`<stateRoot>/pi-process-guard/sessions/<sessionId>/`, so they survive
`/reload`.

## Commands

```text
/process-guard           Diagnostics: platform, guard id, backend, janitor state
/process-guard ps        List tracked runtime processes (PGID membership)
/process-guard doctor    Health checks: launcher, state file, janitor, PGID
/process-guard cleanup-session   Stop session-owned jobs (idempotent)
/guard                   Show effective configuration
```

## Configuration

Optional config file: `~/.pi/agent/process-guard.json`

```json
{
  "enabled": true,
  "termGraceMs": 2000,
  "killVerifyMs": 1000,
  "janitor": {
    "heartbeatMs": 1000,
    "staleRecovery": true,
    "orphanGraceMs": 10000
  },
  "macos": {
    "registryIntervalMs": 1000
  },
  "linux": {
    "backend": "auto",
    "systemdUnitPrefix": "pi-guard"
  },
  "logging": {
    "level": "warn"
  }
}
```

Environment overrides:

```text
PI_PROCESS_GUARD=0                     disable the guard (passthrough mode)
PI_PROCESS_GUARD_TERM_GRACE_MS=2000    SIGTERM grace period
PI_PROCESS_GUARD_KILL_VERIFY_MS=1000   SIGKILL verification window
PI_PROCESS_GUARD_LOG=debug             log level
```

Logs (never full command lines): `~/.pi/agent/logs/process-guard.log`

## Development

```bash
npm install
npm run check    # typecheck + tests
```

Requires Node.js ≥ 22.18 (TypeScript type stripping). Linux backend behavior
is developed per `docs/tech.md` §7 and requires Linux CI; macOS and the
process-group path are exercised by the integration tests.

## License

[MIT](./LICENSE)
