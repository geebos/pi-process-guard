# pi-process-guard

[English](./README.md) | [中文](./README.zh-CN.md)

**Pi Process Guard — a launcher, a cleanup daemon, and a pi extension that
make sure no background processes started by Pi survive Pi's exit, no matter
how Pi exits — including crashes and force-kills.**

## Features

Pi Process Guard is one npm package containing a launcher, a cleanup daemon,
and a pi extension:

- Cleans up background processes Pi started when Pi exits — whether it quits
  normally, crashes, or is force-killed.
- Stops the previous session's jobs when you switch or reload sessions
  (`/new`, `/resume`, `/fork`, `/reload`), while Pi's own helpers stay
  untouched.
- Keeps backgrounded commands (`npm run dev &`) tracked and cleans them up
  when the session ends or Pi dies.
- On macOS, also sweeps up processes that try to escape tracking (best
  effort).
- Works on Linux and macOS.

## Install

One package installs the extension, the launcher, and the janitor:

```bash
pi install npm:pi-process-guard
```

The janitor starts automatically; there is no extra installation step and no
user-facing toggle.

### Add `pi-guard` to your `PATH`

`pi install` places the package under `~/.pi/agent/npm/`; the `pi-guard` and
`pi-guard-janitor` binaries are symlinked into `~/.pi/agent/bin/`. If that
directory is not already on your `PATH`, add it to your shell rc file
(`~/.zshrc` for zsh, `~/.bashrc` for bash):

```bash
echo 'export PATH="$HOME/.pi/agent/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Verify:

```bash
which pi-guard    # → ~/.pi/agent/bin/pi-guard
```

**Prefer launching Pi through the launcher** (optionally via a shell alias):

```bash
alias pi='pi-guard'
pi
```

> The launcher resolves the real `pi` binary from `PATH` and refuses to
> re-wrap itself, so the alias is safe from recursion.

## Session behavior

- Starting a session registers it and its jobs.
- Ending a session — `quit`, `new`, `resume`, `fork`, `reload` — stops only
  that session's jobs, whatever the reason.
- When Pi exits, the janitor sweeps up whatever remains.

## Session jobs

Commands you run with the bash tool, or with `!` / `!!`, are tracked as jobs
of the current session. This means:

- switching or reloading sessions stops the previous session's dev servers,
  watchers, and background jobs, while Pi's own helpers are left untouched;
- backgrounded commands (`npm run dev &`) keep running and stay tracked — a
  detached watchdog cleans them up when the session ends or Pi dies;
- even if Pi is force-killed, session jobs are still cleaned up by the
  watchdog, because Pi's own cleanup never runs on a force-kill.

Job records are kept on disk and survive `/reload`.

## Escaped processes (macOS)

A process can deliberately leave the group it is tracked in. To handle this,
the launcher keeps a registry of every process it has ever confirmed as part
of Pi's runtime, identified by PID **and** start time, so a reused PID is
never mistaken for a new process. During final cleanup it first stops the
group, then sweeps the registry — terminate, grace period, kill.

This is best effort: a process that escapes and exits between two checks
cannot be reclaimed.

## Commands

```text
/plugin:pg enable|disable|status   Turn the guard on/off (persisted to config)
/process-guard                     Diagnostics: platform, guard id, backend, janitor state
/process-guard ps                  List tracked runtime processes (PGID membership)
/process-guard doctor              Health checks: launcher, state file, janitor, PGID
/process-guard cleanup-session     Stop session-owned jobs (idempotent)
/guard                             Show effective configuration
```

> `/plugin:pg` writes `enabled` to the config file. The change applies on the
> next launch **via `pi-guard`** (the launcher reads `enabled` at startup);
> the currently running guard keeps its behavior until then.

## Configuration

Optional config file: `~/.pi/agent/extensions/pi-process-guard/process-guard.json`

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

Logs (never full command lines): `~/.pi/agent/extensions/pi-process-guard/logs/process-guard.log`

## License

[MIT](./LICENSE)
