# pi-process-guard

[English](./README.md) | [中文](./README.zh-CN.md)

**Pi Process Guard —— 由 launcher + 强制 janitor + pi 扩展组成，确保 Pi 退出
（包括 crash 与 `SIGKILL`）后，普通 descendant 进程不会残留。**

实现遵循 [`docs/tech.md`](./docs/tech.md)。

## 为什么需要

Pi coding agent 可能启动 language server、watcher、dev server、测试 runner，
以及任意 extension 通过 `child_process.spawn()` 创建的进程。当 Pi 退出——
无论是正常退出、crash 还是 `SIGKILL`——这些进程都可能残留。

仅依赖扩展的 `session_shutdown` 生命周期事件是不够的：

- `SIGKILL` 不会执行任何 JavaScript cleanup；
- 一个 extension 无法可靠拦截另一个 extension 的 `spawn()`；
- `session_shutdown` 在 `/new`、`/resume`、`/fork`、`/reload` 时同样会触发，
  而这些场景只应停止 *session 所属* 的任务，而不是整个 runtime。

Pi Process Guard 用同一个 npm 包内的三个组件解决这个问题：

| 组件 | 职责 |
| --- | --- |
| `pi-guard` launcher | 创建 guard identity 与隔离域，启动 janitor，启动 Pi，转发信号 |
| janitor（`pi-guard-janitor`） | **必选**独立 OS 进程；即使 Pi 被 `SIGKILL` 或 launcher 消失，仍执行最终 TERM → KILL 清理 |
| Pi 扩展 | session 生命周期（`session_start` / `session_shutdown`）、诊断、session 任务管理 |

**隔离域：**

- **Linux：** 专用 `systemd --user` transient service（cgroup）——
  `KillMode=control-group`；systemd 不可用时回退到 process group。
- **macOS：** 专用 POSIX process group（PGID = Pi PID）；普通 descendant 都会继承它。

## 安装

一次安装即包含扩展、launcher 与 janitor：

```bash
pi install npm:pi-process-guard
```

Janitor 自动启动，无需额外安装步骤，也没有面向用户的关闭开关。

**建议通过 launcher 启动 Pi**（可选 shell alias）：

```bash
alias pi='pi-guard'
pi
```

> launcher 从 `PATH` 解析真实 `pi` 二进制，并拒绝重复包装自身，因此 alias 不会递归。

## Session 语义

- `session_start` → 新 session id + session 任务注册表
- `session_shutdown(reason)` → 只停止 **session 所属任务**，与 reason 无关
  （`quit`、`new`、`resume`、`fork`、`reload`）
- Pi 退出 → janitor 对整个 runtime 域执行最终清理

## Session 所属命令

每个 bash tool 命令与用户 `!` / `!!` 命令都会包装进 **session 所属的
process group**：一个小的 `session-exec` 进程 detached 运行命令、发布 job
记录并监督它。效果：

- `/new`、`/resume`、`/fork`、`/reload` 会终止旧 session 的 dev server /
  watcher / 后台任务（TERM → grace → KILL），而 runtime 级扩展 helper 不受影响；
- 后台命令（`npm run dev &`）继续运行且保持被跟踪——session 结束或 Pi 死亡时
  由独立 watchdog 回收；
- 即使 Pi 被 `SIGKILL`，session 任务仍会被 watchdog 回收（SIGKILL 时
  pi 自己的 detached-child 清理不会执行）。

Job 记录保存在磁盘
`<stateRoot>/pi-process-guard/sessions/<sessionId>/` 下，`/reload` 后仍然有效。

## 逃逸进程清理（macOS）

descendant 可能调用 `setsid()` 脱离 Pi 的 process group。launcher 维护一个
**descendant registry**：每 ~1s 采样进程表、从 Pi 的 PID 遍历 PPID 树，并记录
所有曾被确认属于 runtime 的进程及其启动时间身份（PID 复用防护）。registry
持久化在 state 文件旁。最终清理时 janitor 先终止 process group，再逐个清理
identity 仍然匹配的 registry 条目——TERM、宽限、KILL。PID 被复用但启动时间
不同的进程绝不会被误杀。

Best-effort 边界：在两次采样之间逃逸并退出的进程无法被回收（`docs/tech.md`
§8.6）。

## 命令

```text
/process-guard           诊断：平台、guard id、backend、janitor 状态
/process-guard ps        列出受跟踪的 runtime 进程（PGID 成员）
/process-guard doctor    健康检查：launcher、state 文件、janitor、PGID
/process-guard cleanup-session  停止 session 所属任务（幂等）
/guard                   显示生效配置
```

## 配置

可选配置文件：`~/.pi/agent/process-guard.json`

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

日志（绝不记录完整命令行）：`~/.pi/agent/logs/process-guard.log`

## 开发

```bash
npm install
npm run check    # typecheck + 测试
```

需要 Node.js ≥ 22.18（TypeScript type stripping）。Linux backend 按
`docs/tech.md` §7 开发，需 Linux CI 验证；macOS 与 process-group 路径由集成测试覆盖。

## License

[MIT](./LICENSE)
