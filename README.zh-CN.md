# pi-process-guard

[English](./README.md) | [中文](./README.zh-CN.md)

**Pi Process Guard —— 由启动器、清理守护进程与 pi 扩展组成，确保 Pi 无论以何种
方式退出（包括崩溃与被强制杀死），其启动的后台进程都不会残留。**

## 功能

Pi Process Guard 是一个 npm 包，包含启动器、清理守护进程与 pi 扩展：

- Pi 退出时清理它启动的后台进程——无论是正常退出、崩溃还是被强制杀死。
- 切换或重载 session（`/new`、`/resume`、`/fork`、`/reload`）时停止上一个
  session 的任务，不影响 Pi 自身的 helper。
- 后台命令（`npm run dev &`）保持跟踪，session 结束或 Pi 死亡时自动清理。
- macOS 上尽力回收试图脱离跟踪的进程。
- 支持 Linux 与 macOS。

## 安装

一次安装即包含扩展、launcher 与 janitor：

```bash
pi install npm:pi-process-guard
```

Janitor 自动启动，无需额外安装步骤，也没有面向用户的关闭开关。

### 将 `pi-guard` 加入 `PATH`

`pi install` 会把包安装到 `~/.pi/agent/npm/` 下，`pi-guard` 与
`pi-guard-janitor` 二进制会软链到 `~/.pi/agent/bin/`。如果该目录不在你的
`PATH` 中，请在你的 shell 配置里加上（zsh 为 `~/.zshrc`，bash 为 `~/.bashrc`）：

```bash
echo 'export PATH="$HOME/.pi/agent/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

验证：

```bash
which pi-guard    # → ~/.pi/agent/bin/pi-guard
```

**建议通过 launcher 启动 Pi**（可选 shell alias）：

```bash
alias pi='pi-guard'
pi
```

> launcher 从 `PATH` 解析真实 `pi` 二进制，并拒绝重复包装自身，因此 alias 不会递归。

## Session 行为

- 开启 session 会注册它及其任务。
- 结束 session——`quit`、`new`、`resume`、`fork`、`reload`——只会停止该
  session 的任务，与原因无关。
- Pi 退出后，janitor 会清理所有残留。

## Session 任务

通过 bash 工具或 `!` / `!!` 运行的命令都会被跟踪为当前 session 的任务。这意味着：

- 切换或重载 session 会终止上一个 session 的 dev server、watcher 和后台任务，
  而 Pi 自身的 helper 不受影响；
- 后台命令（`npm run dev &`）会继续运行且保持被跟踪——session 结束或 Pi 死亡时
  由独立 watchdog 清理；
- 即使 Pi 被强制杀死，session 任务仍会被 watchdog 清理（强制杀死时 Pi 自身的
  清理代码不会执行）。

任务记录保存在磁盘上，`/reload` 后仍然有效。

## 逃逸进程清理（macOS）

进程可能主动脱离被跟踪的进程组。为此，启动器维护一个注册表：记录所有曾被确认
属于 Pi runtime 的进程，用 PID **和**启动时间双重标识，避免误认被复用的 PID。
最终清理时先终止进程组，再逐个清理注册表中的进程——终止、宽限、杀死。

这是尽力而为的：两次检查之间逃逸并退出的进程无法被回收。

## 命令

```text
/plugin:pg enable|disable|status   开启/关闭 guard（持久化到配置文件）
/process-guard           诊断：平台、guard id、backend、janitor 状态
/process-guard ps        列出受跟踪的 runtime 进程（PGID 成员）
/process-guard doctor    健康检查：launcher、state 文件、janitor、PGID
/process-guard cleanup-session  停止 session 所属任务（幂等）
/guard                   显示生效配置
```

> `/plugin:pg` 会把 `enabled` 写入配置文件。下次**通过 `pi-guard` 启动**时生效
> （launcher 启动时读取 `enabled`）；当前运行中的 guard 保持现有行为。

## 配置

可选配置文件：`~/.pi/agent/extensions/pi-process-guard/process-guard.json`

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

环境变量覆盖：

```text
PI_PROCESS_GUARD=0                     禁用 guard（passthrough 模式）
PI_PROCESS_GUARD_TERM_GRACE_MS=2000    SIGTERM 宽限期
PI_PROCESS_GUARD_KILL_VERIFY_MS=1000   SIGKILL 验证窗口
PI_PROCESS_GUARD_LOG=debug             日志级别
```

日志（绝不记录完整命令行）：`~/.pi/agent/extensions/pi-process-guard/logs/process-guard.log`

## License

[MIT](./LICENSE)
