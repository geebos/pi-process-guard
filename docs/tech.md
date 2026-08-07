# Pi Process Guard 技术设计文档

> 状态：Draft / Implementation Ready  
> 目标平台：Linux、macOS  
> 目标运行时：Pi Coding Agent 及其 TypeScript Extensions  
> 文档日期：2026-08-07

## 1. 背景

Pi Coding Agent 允许 extension 直接启动本地进程，例如 language server、文件 watcher、HTTP server、测试 runner、MCP helper 或任意 `child_process.spawn()` 子进程。

这些进程可能在以下场景中残留：

- extension 忘记在退出时执行 cleanup；
- shell 命令主动后台化，例如 `npm run dev &`；
- 子进程继续 fork；
- Pi 异常崩溃；
- Pi 被 `SIGKILL`，来不及执行 JavaScript cleanup；
- 第三方 extension 没有实现 Pi 的 lifecycle cleanup。

Pi 官方 extension API 已提供 `session_shutdown`，并明确建议 extension 在该事件中释放 session-scoped 的后台进程、socket、watcher 和 timer。当前生命周期中，`/new`、`/resume`、`/fork`、`/clone`、`/reload` 以及程序退出都可能触发 `session_shutdown`。

但是，仅依赖 `session_shutdown` 不能解决所有问题：

1. `SIGKILL` 时不会执行 JavaScript handler；
2. 一个 extension 无法可靠拦截另一个 extension 直接调用 Node.js `child_process.spawn()`；
3. `session_shutdown` 不等价于“Pi 进程退出”，例如 `/new` 和 `/resume` 同样会触发；
4. macOS 没有 Linux cgroup，无法直接获得同等强度的进程归属机制。

因此，本设计采用 **Launcher + Pi Extension + Janitor** 的三层架构，而不是只实现单个 extension。Janitor 是必选组件，并与插件作为同一个 npm package 分发；用户无需单独安装。

---

## 2. 目标

### 2.1 核心目标

Pi Process Guard 必须满足：

- 支持 Linux；
- 支持 macOS；
- Pi 正常退出后，不留下普通 Pi 子进程或 extension 子进程；
- Pi crash 或被 `SIGKILL` 后，由独立 Janitor 继续完成最终清理；
- Janitor 在 Linux 和 macOS 上均为必选组件；
- Janitor 与插件同包安装、自动启动，不要求用户单独安装；
- `/new`、`/resume`、`/fork`、`/clone`、`/reload` 时，仅清理 session-scoped 任务；
- 不要求第三方 extension 主动注册其 PID；
- 对 `bash` tool 以及用户 `!` / `!!` shell 命令提供 session 级管理；
- 对任意 extension 直接 `spawn()` 的进程提供 Pi-runtime 级兜底管理；
- 清理流程优先 `SIGTERM`，超时后升级为 `SIGKILL`；
- 清理操作必须幂等。

### 2.2 非目标

以下情况不承诺强制回收：

- extension 将任务提交给 Docker daemon、Kubernetes、远程服务器等外部 supervisor；
- extension 创建独立的 `systemd` service 或 macOS `launchd` job；
- 子进程主动脱离当前管理域，并由其它系统服务接管；
- 进程切换到其它用户；
- 恶意进程专门规避进程追踪。

Process Guard 的目标是管理 **Pi 所拥有的普通本地进程树**，不是替代容器或操作系统安全沙箱。

---

## 3. 生命周期语义

本设计明确区分两个生命周期。

### 3.1 Session 生命周期

一个 Pi 进程可以连续经历多个 session：

```text
Pi Runtime
    |
    +-- Session A
    |      +-- bash/dev server
    |      +-- test runner
    |
    +-- /new
    |
    +-- Session B
           +-- bash/dev server
```

以下事件会结束旧 session，但不会结束 Pi Runtime：

- `/new`
- `/resume`
- `/fork`
- `/clone`
- `/reload`

这些场景只应停止 **session-owned process**。

### 3.2 Pi Runtime 生命周期

Pi Runtime 指当前 `pi` OS process 的完整生命周期。

真正退出包括：

- 用户正常退出；
- `Ctrl+C` / `Ctrl+D` 导致 Pi 退出；
- `SIGHUP`；
- `SIGTERM`；
- crash；
- `SIGKILL`；
- launcher 发现 Pi main PID 已结束。

当 Pi Runtime 结束时，应清理：

```text
所有 session-owned processes
+
所有普通 extension-owned descendants
+
Pi 自己遗留的其它 descendants
```

---

## 4. 总体架构

```text
                     +---------------------------+
                     |         pi-guard          |
                     |          Launcher         |
                     +-------------+-------------+
                                   |
                     OS isolation / tracking domain
                                   |
                          +--------v--------+
                          |       Pi        |
                          |   main process  |
                          +--------+--------+
                                   |
              +--------------------+--------------------+
              |                    |                    |
       +------v------+      +------v------+      +------v------+
       | Extension A |      | Extension B |      | built-in /  |
       |  LSP/helper |      | spawn(...)  |      | shell tools |
       +------+------+      +------+------+      +------+------+
              |                    |                    |
              +--------------------+--------------------+
                                   |
                            descendant processes

      +--------------------------------------------------+
      | process-guard Pi extension                       |
      |                                                  |
      | session_start                                    |
      | tool_call / user_bash interception               |
      | session_shutdown -> session cleanup              |
      | /process-guard -> diagnostics                    |
      +--------------------------------------------------+

      +--------------------------------------------------+
      | pi-guard-janitor (mandatory, separate OS process)|
      |                                                  |
      | monitors launcher/Pi liveness                    |
      | reads runtime registry / guard identity          |
      | performs crash / SIGKILL final cleanup           |
      | exits after runtime cleanup completes             |
      +--------------------------------------------------+
```

职责划分：

| 组件 | 职责 |
|---|---|
| `pi-guard` launcher | 创建 Pi-runtime 级隔离域；启动 Pi 与 Janitor；转发信号；等待 Pi |
| Process Guard extension | 管理 Pi session 生命周期；包装 shell/tool 任务；提供诊断 |
| `pi-guard-janitor` | 独立于 Pi/launcher 的必选 helper；监控运行时存活状态；异常退出后执行最终回收 |
| Linux backend | 使用 systemd/cgroup 管理整个 Pi runtime；Janitor 调用 systemd 完成最终回收 |
| macOS backend | 使用 POSIX session/process group + descendant registry；Janitor 执行 PGID/PID 最终回收 |

关键原则：

> **Extension 负责“session 优雅生命周期”，Launcher 负责“启动与信号协调”，Janitor 负责“最终清理保证”。**

### 4.1 Janitor 的实现与分发

Janitor 使用 TypeScript 开发并编译为 JavaScript，运行时直接复用 Pi 当前使用的 Node.js：

```ts
spawn(process.execPath, [janitorEntry, ...args], {
  detached: true,
  stdio: "ignore",
}).unref();
```

要求：

- Janitor 必须是独立 OS process，不能与 Pi extension 共用同一个 Node process；
- Janitor 必须与 `pi-process-guard` 发布在同一个 npm package 中；
- `pi install npm:pi-process-guard` 即完成 extension、launcher、janitor 的安装；
- Janitor 由 launcher 自动启动，用户不需要单独执行或配置；
- Janitor 不属于 Pi 的可清理 process group/cgroup 子域，避免在清理 Pi 时把自己提前杀掉；
- Janitor 完成清理后自行退出，不作为常驻 daemon 长期运行。

## 5. 为什么不能只做 Pi Extension

第三方 extension 可以直接执行：

```ts
import { spawn } from "node:child_process";

spawn("typescript-language-server", ["--stdio"]);
```

Process Guard extension 与该 extension 处于同一个 Node.js runtime，但 Pi extension API 并没有要求所有进程必须通过某个全局 `pi.spawn()` API 创建。

因此 Process Guard extension 无法可靠、透明地 monkey-patch 所有 extension 的进程创建行为。

这也是采用 launcher + janitor 的原因：

```text
launcher
   |
   +-- pi
       |
       +-- extension A child
       +-- extension B child
       +-- shell child
```

只要进程仍属于 Pi 的 OS 管理域，launcher 就无需知道它由哪个 extension 创建。

---

## 6. Pi Extension 生命周期集成

Pi 官方文档当前定义：

```ts
pi.on("session_shutdown", async (event, ctx) => {
  // event.reason:
  // "quit" | "reload" | "new" | "resume" | "fork"
});
```

Process Guard 使用如下策略：

```text
session_start
    -> 创建新的 sessionId
    -> 初始化 session process registry

bash tool / user bash
    -> 在 session-owned execution domain 中启动

session_shutdown(reason)
    -> SIGTERM session processes
    -> grace period
    -> SIGKILL survivors
    -> 清空 session registry

reason == quit
    -> extension cleanup 完成
    -> Pi main process 退出
    -> launcher 执行 runtime final cleanup
```

注意：

`session_shutdown` 必须设计成幂等，因为 shutdown、reload、错误恢复过程中可能出现重复清理路径。

---

## 7. Linux 设计

### 7.1 目标

Linux 上要求尽可能提供强保证：

> Pi 及其普通 descendants 全部位于同一个专属 cgroup；Pi main process 结束后，整个 cgroup 被停止和清理。

### 7.2 推荐实现：systemd transient user service

Launcher 不直接 `spawn("pi")`，而是使用 `systemd-run --user` 创建 transient service。

概念命令：

```bash
systemd-run --user \
  --wait \
  --collect \
  --service-type=exec \
  --unit="pi-guard-${TOKEN}" \
  --property=KillMode=control-group \
  --property=KillSignal=SIGTERM \
  --property=SendSIGKILL=yes \
  --property=TimeoutStopSec=3s \
  -- \
  pi "$@"
```

所有普通 descendants 会继承 service 的 cgroup：

```text
user.slice
└── pi-guard-abc.service
    ├── pi
    ├── node language server
    ├── npm
    ├── vite
    ├── python
    └── extension helper
```

`KillMode=control-group` 的语义适合本项目：停止 unit 时处理整个 cgroup，而不是只处理 main PID。

### 7.3 最终清理

Linux 上 Janitor 是最终清理责任方。Launcher 正常存活时可以主动请求 cleanup，但即使 Pi 或 launcher 异常退出，Janitor 仍应独立执行最终回收。

Janitor / supervisor 最终应保证：

```bash
systemctl --user stop "pi-guard-${TOKEN}.service"
```

必要时可显式执行：

```bash
systemctl --user kill \
  --kill-whom=all \
  --signal=SIGTERM \
  "pi-guard-${TOKEN}.service"

sleep "$GRACE_PERIOD"

systemctl --user kill \
  --kill-whom=all \
  --signal=SIGKILL \
  "pi-guard-${TOKEN}.service"
```

通常应优先让 systemd 自己按照 `KillMode`、`KillSignal`、`TimeoutStopSec`、`SendSIGKILL` 执行 stop 流程，避免重复实现 systemd 已提供的机制。Janitor 的职责是确认对应 guard unit 最终进入 inactive/failed 且 cgroup 内无残留进程。

### 7.4 Linux 优点

cgroup 的关键优势是：

- 不依赖 PPID；
- 普通 fork 不会逃逸；
- double-fork 仍然保留 cgroup 成员关系；
- parent 退出后 child 不会因为 reparent 就失去归属；
- 可以用 `systemd-cgls --user-unit UNIT` 诊断；
- 对第三方 extension 无侵入。

### 7.5 Linux fallback

若系统没有可用的 `systemd --user`：

1. 退化为 POSIX process group 模式；
2. 启动时打印 warning；
3. `/process-guard` 显示 `isolation=process-group`；
4. 不宣称与 cgroup 模式具有相同保证。

可选配置：

```json
{
  "linux": {
    "backend": "auto"
  }
}
```

其中：

```text
auto
  -> systemd-user 可用：cgroup
  -> 否则：process-group fallback
```

---

## 8. macOS 设计

### 8.1 macOS 限制

macOS 没有 Linux cgroup，因此无法直接获得“不可因 reparent 而丢失归属”的统一进程容器。

macOS 提供 POSIX process group/session：

- `setsid()`：创建新 session 和新 process group；
- `setpgid()`：修改 process group；
- `killpg()`：向整个 process group 发信号。

Node.js 在 POSIX 平台使用 `spawn(..., { detached: true })` 时，可用于让 child 成为新的 process group/session leader，因此可由 launcher 创建独立的 Pi execution group。

### 8.2 Launcher 模式

概念实现：

```ts
const child = spawn(piBinary, args, {
  detached: true,
  stdio: "inherit",
  env: {
    ...process.env,
    PI_PROCESS_GUARD_ID: token,
  },
});

const piPid = child.pid!;
const piPgid = piPid;
```

默认情况下：

```text
PGID = Pi PID

Pi process group
├── pi
├── extension helper
├── npm
├── node
└── python
```

Pi 退出后，正常路径可由 launcher 请求清理；最终责任由 Janitor 对负 PID 发信号：

```ts
process.kill(-piPgid, "SIGTERM");
```

经过 grace period 后：

```ts
process.kill(-piPgid, "SIGKILL");
```

这对应 POSIX `killpg()` 行为。

### 8.3 为什么仅 killpg 不够

某个 descendant 可以主动调用：

```c
setsid();
```

之后它将进入新的 session/process group，不再属于 Pi 的原 PGID。

因此 macOS backend 采用：

```text
process group
+
periodic descendant registry
+
final descendant sweep
```

### 8.4 Descendant Registry

Launcher 在 Pi 存活期间周期性采样进程表。

建议默认周期：

```text
1000 ms
```

采样字段：

```text
PID
PPID
PGID
SID
START_TIME
COMMAND
```

可通过：

```bash
ps -axo pid=,ppid=,pgid=,sess=,lstart=,command=
```

或使用更稳定的 native/libproc helper 实现。

每轮构建：

```text
pid -> ppid
```

然后从 Pi PID 做 descendant traversal：

```text
Pi PID
  -> children
      -> grandchildren
          -> ...
```

曾确认属于 Pi 的 PID 写入 registry：

```ts
interface TrackedProcess {
  pid: number;
  firstSeenAt: number;
  startIdentity?: string;
  lastSeenPpid: number;
  lastSeenPgid: number;
}
```

在 cleanup 时：

1. 先 kill process group；
2. 重新扫描 descendants；
3. 对 registry 中仍存在且 identity 匹配的进程发送 SIGTERM；
4. grace period 后再次确认 identity；
5. SIGKILL survivors。

### 8.5 PID reuse 防护

不能仅保存 PID：

```text
PID 1234 原来属于 Pi
PID 1234 退出
OS 很快将 1234 分配给其它应用
```

若直接 kill PID 1234，可能误杀无关进程。

因此 registry 至少保存：

```text
PID + process start identity
```

cleanup 前必须重新读取 start identity，并匹配后才允许发送 signal。

生产实现优先使用 native/libproc 获取稳定的 process start time；纯 `ps` 实现作为 portability fallback。

### 8.6 macOS 保证等级

macOS backend 定义为：

```text
普通 child/fork/background process        Strong
process group 内后台服务                  Strong
已采样后再调用 setsid() 的 descendant     Best effort / High
极短时间创建并逃逸且未被采样              Not guaranteed
交给 launchd/其它 supervisor              Out of scope
```

因此文档和 CLI 不应把 macOS 模式宣传成与 Linux cgroup 等价的硬保证。

---

## 9. Session-owned shell 管理

Launcher 管理“整个 Pi Runtime”；extension 额外管理“当前 session 的 shell jobs”。

### 9.1 Bash tool

Process Guard 监听 `tool_call`，当：

```ts
event.toolName === "bash"
```

时，将命令包装进 session execution domain。

概念形式：

```text
original:
  npm run dev

wrapped:
  process-guard-session-exec <sessionId> -- npm run dev
```

Linux 可为每个 session 或每个 job 创建 child cgroup/scope；macOS 可为 session job 创建独立 process group。

### 9.2 User bash

用户直接使用 `!` / `!!` 的本地命令，也应通过同一 session executor。

目标：

```text
/new
  -> 旧 session 的 npm/vite/test watcher 被清理
  -> Pi Runtime 本身不结束
  -> runtime-level extension helper 不被无条件误杀
```

---

## 10. Extension-owned process 的处理策略

### 10.1 第三方 extension 无需注册

例如：

```ts
spawn("some-language-server");
```

Process Guard 不要求改成：

```ts
guard.spawn(...);
```

只要它是普通 descendant：

- Linux：自动继承 Pi cgroup；
- macOS：通常自动继承 Pi process group，同时由 registry 追踪。

### 10.2 不在 session switch 时全杀

不能在每个 `session_shutdown` 上直接 kill 所有 Pi descendants。

原因：

```text
Pi Runtime
├── Extension language server    <- runtime helper
└── Session A dev server         <- session job
```

如果执行 `/new`：

正确行为：

```text
dev server -> stop
language server -> 保留或由 extension 自己按 lifecycle 重建
```

因此，全 runtime descendant cleanup 只能在 Pi main process 真正结束后由 launcher 执行。

---

## 11. Cleanup 状态机

统一状态：

```text
RUNNING
   |
   v
TERMINATING
   | SIGTERM
   |
   +---- all exited ----> CLEAN
   |
   +---- grace timeout
             |
             v
          KILLING
             | SIGKILL
             v
           CLEAN
```

要求：

- 重复调用 cleanup 不报错；
- `ESRCH` 视为目标已退出；
- 先停止创建新任务，再清理现有任务；
- cleanup 有全局 deadline；
- launcher 最终退出码应尽量保持 Pi 的退出码。

建议默认：

```text
SIGTERM grace period: 2000 ms
SIGKILL verification: 1000 ms
registry sample interval on macOS: 1000 ms
```

这些参数应可配置。

---

## 12. Crash / SIGKILL 处理

### 12.1 正常退出

```text
Pi
  -> session_shutdown(reason=quit)
  -> extension graceful cleanup
  -> Pi exits
  -> launcher observes exit
  -> launcher marks runtime terminating
  -> Janitor performs/verifies runtime final cleanup
  -> launcher/Janitor exit
```

### 12.2 Pi crash

```text
Pi crashes
  -> session_shutdown may not complete
  -> launcher may observe child exit
  -> Janitor independently observes Pi death
  -> runtime final sweep
```

### 12.3 Pi 被 SIGKILL

```text
kill -9 <pi-pid>
  -> no JavaScript cleanup inside Pi
  -> Janitor remains alive
  -> Janitor observes Pi death
  -> TERM runtime domain
  -> grace period
  -> KILL survivors
  -> verify clean
```

这正是 Janitor 必须独立于 Pi 进程存在的主要原因。

### 12.4 Launcher 被 SIGKILL

```text
kill -9 <launcher-pid>
  -> Pi 可能仍然存活
  -> Janitor observes launcher death
  -> 根据 state 判断 Pi/runtime 是否仍有效
  -> 必要时进入 orphan-runtime cleanup
```

Janitor 必须避免因为“launcher 消失”就立即误杀仍由用户正常使用的 Pi。推荐规则：

1. launcher 消失但 Pi 仍存活：进入短暂 orphan grace window；
2. 尝试确认 Pi 是否仍属于当前 guard identity；
3. 若 launcher 无法恢复且 runtime 已成为 orphan，则终止整个 guarded runtime；
4. 如果 Pi 也已消失，则立即执行最终 cleanup。

### 12.5 Janitor 自身被 SIGKILL

Janitor 是必选组件，但不能声称自己不可被杀死。

- Linux：即使 Janitor 被杀，systemd/cgroup 仍提供额外 OS-level containment；后续可通过 stale-unit recovery 清理；
- macOS：若 Pi、launcher、Janitor 同时被强制终止，无法提供与 Linux cgroup 等价的硬保证；启动新实例时必须扫描 stale registry 并尝试恢复清理。

因此 Janitor 提供的是 **独立故障域 + 自动恢复能力**，不是安全边界。

---

## 13. Janitor（必选组件）

### 13.1 角色

Janitor 是 `pi-process-guard` 的必选 runtime helper。它与 extension 使用同一套 TypeScript 代码库，但必须运行在独立 Node.js OS process 中。

```text
npm package: pi-process-guard
├── extension.js
├── pi-guard.js
└── janitor.js      <- mandatory
```

用户只安装一次：

```bash
pi install npm:pi-process-guard
```

不需要额外安装 `janitor` package、Python、Go、Rust runtime 或额外 Node.js。

### 13.2 启动

Launcher 生成 `guardId` 和 runtime state 后，先启动 Janitor，再启动或托管 Pi：

```text
pi-guard
  |
  +-- create guard state
  +-- spawn janitor.js as detached independent process
  +-- create runtime isolation domain
  +-- start Pi
  +-- publish Pi PID / PGID / systemd unit into state
```

概念代码：

```ts
const janitor = spawn(process.execPath, [janitorEntry, stateFile], {
  detached: true,
  stdio: "ignore",
  env: sanitizedEnv,
});

janitor.unref();
```

### 13.3 Runtime State

建议状态目录：

```text
~/.cache/pi-process-guard/<guardId>/state.json
```

或遵循 `$XDG_RUNTIME_DIR` / macOS cache directory。

状态示例：

```json
{
  "version": 1,
  "guardId": "uuid",
  "platform": "darwin",
  "launcherPid": 100,
  "piPid": 101,
  "piPgid": 101,
  "backend": "process-group-registry",
  "phase": "running",
  "createdAt": 1786096800000
}
```

Linux 可附加：

```json
{
  "runtimeUnit": "pi-guard-<guardId>.service"
}
```

Janitor 不应只信任 PID。macOS 对 tracked PID 必须验证 start identity；Linux 只操作包含随机 guard token 的专属 systemd unit。

### 13.4 心跳与存活检测

Janitor 周期性检查：

```text
launcher PID
Pi PID
runtime state phase
Linux systemd unit / macOS PGID + registry
```

推荐 interval：

```text
500-1000 ms
```

不要依赖 IPC socket 作为唯一存活依据，因为 crash 时 socket cleanup 可能不可靠。

### 13.5 Cleanup 协议

正常退出：

```text
extension session cleanup
  -> Pi exits
  -> launcher writes phase=terminating
  -> Janitor TERM runtime domain
  -> grace period
  -> Janitor KILL survivors
  -> verify clean
  -> delete state directory
  -> Janitor exits
```

异常退出：

```text
Pi/launcher disappears
  -> Janitor detects orphaned guard
  -> validates guard identity
  -> TERM
  -> wait
  -> KILL
  -> verify
  -> remove state
  -> exit
```

### 13.6 Linux Janitor Backend

Linux Janitor 不枚举 PPID tree 作为主要所有权依据，而是调用 systemd：

```text
janitor.js
   -> systemctl --user stop pi-guard-<id>.service
   -> verify unit/cgroup empty
   -> explicit systemctl kill --kill-whom=all when needed
```

这样即使 child double-fork 或被 reparent，只要没有迁移到其它 cgroup，仍属于同一 runtime。

### 13.7 macOS Janitor Backend

macOS Janitor 使用：

```text
runtime PGID
+
descendant registry
+
PID start identity
```

顺序：

1. 对 runtime PGID 发送 `SIGTERM`；
2. 对 registry 中已验证 identity 的逃逸 descendant 发送 `SIGTERM`；
3. 等待 grace period；
4. 重新验证；
5. 对 survivors 发送 `SIGKILL`；
6. 最终扫描并删除 runtime state。

Janitor 本身必须位于不同 process group，禁止加入 Pi runtime PGID。

### 13.8 Stale State Recovery

每次 `pi-guard` 启动时都扫描 stale guard state：

```text
state exists
+
launcher/Pi no longer valid
+
Janitor missing or stale
    -> spawn recovery janitor
    -> cleanup old runtime
```

这用于覆盖机器休眠、Janitor 意外退出、终端强制结束等边界情况。

## 14. 建议目录结构

```text
pi-process-guard/
├── package.json
├── README.md
├── bin/
│   └── pi-guard.ts
├── src/
│   ├── extension.ts
│   ├── config.ts
│   ├── cleanup.ts
│   ├── process-registry.ts
│   ├── session-manager.ts
│   ├── platform/
│   │   ├── index.ts
│   │   ├── linux-systemd.ts
│   │   ├── posix-process-group.ts
│   │   └── macos.ts
│   └── janitor/
│       ├── index.ts
│       ├── linux-janitor.ts
│       └── macos-janitor.ts
└── test/
    ├── integration/
    │   ├── normal-exit.test.ts
    │   ├── sigterm.test.ts
    │   ├── sigkill.test.ts
    │   ├── background-child.test.ts
    │   ├── double-fork.test.ts
    │   └── session-switch.test.ts
    └── unit/
```

---

## 15. Package 设计

建议发布为标准 Pi package，同时暴露 launcher CLI。

`package.json` 概念结构：

```json
{
  "name": "pi-process-guard",
  "type": "module",
  "bin": {
    "pi-guard": "./dist/bin/pi-guard.js",
    "pi-guard-janitor": "./dist/src/janitor/index.js"
  },
  "pi": {
    "extensions": [
      "./dist/src/extension.js"
    ]
  }
}
```

用户安装：

```bash
pi install npm:pi-process-guard
```

Janitor 不要求用户直接调用；`pi-guard-janitor` binary 仅作为包内 runtime entry 和调试入口。

推荐启动：

```bash
pi-guard
```

而不是直接：

```bash
pi
```

可选 shell alias：

```bash
alias pi='pi-guard'
```

注意应防止 launcher 内部再次解析 alias 造成递归；内部必须解析真实 Pi executable。

---

## 16. 配置

建议配置文件：

```text
~/.pi/agent/process-guard.json
```

示例：

```json
{
  "enabled": true,
  "termGraceMs": 2000,
  "killVerifyMs": 1000,
  "janitor": {
    "heartbeatMs": 1000,
    "staleRecovery": true
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

Janitor 没有 `enabled` / `enableJanitor` 开关。只要 Process Guard 启用，Janitor 就必须成功启动；若 Janitor 启动失败，launcher 应终止启动并返回明确错误。

环境变量应可覆盖：

```text
PI_PROCESS_GUARD=0
PI_PROCESS_GUARD_TERM_GRACE_MS=2000
PI_PROCESS_GUARD_LOG=debug
```

---

## 17. `/process-guard` 诊断命令

Extension 注册：

```text
/process-guard
```

输出示例：

```text
Pi Process Guard

Platform:        macOS arm64
Guard ID:        e8f4...
Pi PID:          48122
Runtime PGID:    48122
Session ID:      7a19...
Backend:         process-group + registry
Tracked runtime: 6 processes
Tracked session: 2 processes
Janitor:         active
```

Linux：

```text
Pi Process Guard

Platform:        Linux x64
Guard ID:        e8f4...
Pi PID:          22013
Backend:         systemd-cgroup
Unit:            pi-guard-e8f4.service
Tracked session: 2 jobs
Janitor:         active
```

可增加：

```text
/process-guard ps
/process-guard cleanup-session
/process-guard doctor
```

`cleanup-runtime` 不建议作为普通命令暴露，因为会直接终止当前 Pi。

---

## 18. 日志

默认避免污染 Pi TUI。

日志文件：

```text
~/.pi/agent/logs/process-guard.log
```

记录：

```text
 timestamp
 guardId
 sessionId
 backend
 action
 pid/pgid/unit
 signal
 result
```

不要默认记录完整 command line，因为可能包含 token、路径或敏感参数。

Debug 模式可显式开启 command logging，并在文档中提示风险。

---

## 19. 安全要求

### 19.1 不误杀其它进程

Linux：

- 只操作当前 guard 创建的 systemd unit；
- unit name 必须包含随机 token；
- 禁止使用宽泛 `pkill node` / `killall`。

macOS：

- 首选 PGID；
- registry PID 必须验证 start identity；
- 只处理当前用户拥有的进程；
- 禁止仅根据 command name 判断所有权。

### 19.2 Guard ID

每次 launcher 创建 cryptographically random guard ID：

```text
PI_PROCESS_GUARD_ID=<uuid/random-token>
```

用于：

- 日志关联；
- systemd unit 命名；
- janitor state；
- extension 与 launcher 握手。

### 19.3 Signal forwarding

Launcher 收到：

```text
SIGINT
SIGTERM
SIGHUP
```

应优先转发给 Pi main process，让 Pi 有机会执行 `session_shutdown`。

如果 Pi 在 deadline 内不退出，再启动 runtime cleanup。

---

## 20. 启动握手

Launcher 设置：

```text
PI_PROCESS_GUARD_ID
PI_PROCESS_GUARD_BACKEND
PI_PROCESS_GUARD_PARENT_PID
PI_PROCESS_GUARD_JANITOR_PID
PI_PROCESS_GUARD_STATE_FILE
PI_PROCESS_GUARD_RUNTIME_UNIT   # Linux only
PI_PROCESS_GUARD_RUNTIME_PGID   # macOS/POSIX
```

Extension 在 `session_start` 检查这些变量。

如果用户直接运行：

```bash
pi
```

而没有通过 launcher，extension 应显示一次非阻塞 warning：

```text
Process Guard extension loaded without pi-guard launcher.
Session cleanup is enabled, but arbitrary extension processes
cannot be guaranteed to be reclaimed on Pi exit.
```

不要阻止 Pi 正常使用。

---

## 21. 启动流程

### Linux

```text
pi-guard
   |
   +-- detect platform
   +-- detect systemd --user
   +-- generate guardId
   +-- create runtime state
   +-- start mandatory Janitor
   +-- systemd-run transient service
          |
          +-- PI_PROCESS_GUARD_* env
          +-- pi
                |
                +-- extension loads
                +-- session_start
```

Janitor 在 Pi 启动前进入 ready 状态，避免 Pi 在极短启动窗口内 crash 而无人接管。

### macOS

```text
pi-guard
   |
   +-- generate guardId
   +-- create runtime state
   +-- start mandatory Janitor in independent PGID/session
   +-- spawn Pi as new process group/session
   +-- publish Pi PID/PGID
   +-- start descendant registry
   |
   +-- wait Pi PID
          |
          +-- extension loads
          +-- session_start
```

## 22. 退出流程

### 22.1 Graceful quit

```text
user quits Pi
   |
   +-- Pi: session_shutdown(reason=quit)
   |      +-- stop session jobs
   |
   +-- Pi exits
   |
   +-- launcher marks runtime terminating
   |
   +-- Janitor final cleanup
   |      +-- TERM remaining runtime descendants
   |      +-- wait
   |      +-- KILL survivors
   |      +-- verify clean + delete state
   |
   +-- launcher exits with Pi exit status
   +-- Janitor exits
```

### 22.2 `/new`

```text
/new
 |
 +-- session_shutdown(reason=new)
 |      +-- cleanup old session jobs only
 |
 +-- new extension runtime/session_start
 |
 +-- Pi process remains alive
```

### 22.3 `/reload`

Pi 官方文档说明 reload 会 shutdown 旧 extension runtime 后重新加载资源。

因此 Process Guard 的 extension state 不可假设跨 reload 保持。

Runtime-level ownership数据必须保存在 launcher 或可恢复的外部 state 中，而不能只存在 extension closure 内。

---

## 23. 测试计划

### 23.1 基础矩阵

| Case | Linux | macOS |
|---|---:|---:|
| 正常退出 Pi | 必测 | 必测 |
| SIGTERM Pi | 必测 | 必测 |
| SIGKILL Pi | 必测 | 必测 |
| bash foreground child | 必测 | 必测 |
| `sleep 600 &` | 必测 | 必测 |
| npm dev server | 必测 | 必测 |
| extension `spawn()` child | 必测 | 必测 |
| child -> grandchild | 必测 | 必测 |
| `/new` | 必测 | 必测 |
| `/resume` | 必测 | 必测 |
| `/fork` | 必测 | 必测 |
| `/reload` | 必测 | 必测 |
| 多 Pi 实例并行 | 必测 | 必测 |
| PID reuse protection | N/A/cgroup | 必测 |
| process calls `setsid()` | cgroup 必须仍管理 | best-effort 测试 |
| Pi SIGKILL + launcher alive | 必测 | 必测 |
| launcher SIGKILL + Pi alive | 必测 | 必测 |
| Janitor 独立存活 | 必测 | 必测 |
| stale state recovery | 必测 | 必测 |

### 23.2 Extension fixture

测试 extension：

```ts
pi.on("session_start", () => {
  spawn(process.execPath, ["fixture-child.js"], {
    stdio: "ignore",
  });
});
```

退出 Pi 后断言 PID 不存在。

### 23.3 Background shell fixture

```bash
node fixture-server.js &
echo $!
```

执行 `/new` 后应消失。

### 23.4 Linux double-fork

fixture 主动 fork/daemonize。

预期：只要没有显式迁移到别的 cgroup，仍属于 Pi cgroup，并在 runtime cleanup 时被杀掉。

### 23.5 多实例隔离

同时运行：

```text
pi-guard instance A
pi-guard instance B
```

结束 A 后：

```text
A descendants -> all gone
B descendants -> all alive
```

这是 release blocking test。

---

## 24. 验收标准

### Linux

必须达到：

1. 正常退出后 cgroup 中无残留进程；
2. Pi 被 `SIGKILL` 后无普通 descendant 残留；
3. extension 直接 `spawn()` 的普通 child 被回收；
4. background shell child 被回收；
5. `/new` 只清 session jobs；
6. 两个 Pi 实例不会相互误杀；
7. 不使用 command-name based `pkill`；
8. Janitor 必须默认启动且不可通过普通配置关闭；
9. launcher 被异常终止后，Janitor 仍可识别并回收 orphan runtime。

### macOS

必须达到：

1. 普通 process group descendants 在退出后全部回收；
2. Pi 被 `SIGKILL` 后 launcher 能回收 PGID；
3. extension 直接 `spawn()` child 被回收；
4. registry 有 PID reuse protection；
5. `/new` 只清 session jobs；
6. 多实例隔离；
7. 对主动 `setsid()` 逃逸场景明确标记 best-effort，而不是错误宣称强保证；
8. Janitor 必须默认启动且不可通过普通配置关闭；
9. stale registry/state 可由恢复 Janitor 自动处理。

---

## 25. Failure Mode

| Failure | 处理 |
|---|---|
| `systemd-run` 不存在 | Linux fallback 到 process-group 并 warning |
| user systemd 不可用 | fallback |
| `systemctl stop` 失败 | 尝试 explicit kill；记录错误 |
| PID 已退出 | `ESRCH` 视为成功 |
| macOS registry 扫描失败 | 继续 PGID cleanup；记录 degraded mode |
| extension shutdown 抛异常 | 不阻止 Janitor runtime final cleanup |
| Pi 非零退出 | cleanup 后保留原 exit code |
| cleanup 超时 | SIGKILL 后结束；输出 warning |
| launcher 无权限 signal child | 输出明确错误，禁止扩大 kill 范围 |
| Janitor 未启动成功 | 启动 Pi 失败；不得降级为无 Janitor 模式 |
| Janitor 意外退出 | launcher 尝试重启；下次启动执行 stale-state recovery |

---

## 26. 可观测性

建议指标：

```text
processes_tracked_total
processes_terminated_term
processes_terminated_kill
cleanup_duration_ms
cleanup_failures_total
registry_scan_duration_ms
```

CLI debug：

```bash
PI_PROCESS_GUARD_LOG=debug pi-guard
```

Linux 可辅助：

```bash
systemd-cgls --user-unit pi-guard-<id>.service
```

macOS 可辅助：

```bash
ps -axo pid,ppid,pgid,sess,command
```

---

## 27. 推荐实现阶段

### Phase 1 — Runtime Guard + Mandatory Janitor

实现：

- launcher；
- cross-platform Janitor entry；
- runtime state protocol；
- Linux systemd transient service；
- Pi/launcher liveness monitoring；
- TERM/KILL final cleanup；
- stale state recovery；
- `/process-guard doctor`；
- extension lifecycle skeleton。

Janitor 是 Phase 1 release blocker，不能推迟到后续增强阶段。

### Phase 2 — Session Process Manager

实现：

- bash tool wrapping；
- user bash wrapping；
- `/new` / `/resume` / `/fork` session cleanup；
- job registry。

### Phase 3 — macOS Process Group + Registry

实现：

- detached Pi PGID；
- signal forwarding；
- descendant sampling；
- PID start identity；
- escaped-PGID best-effort cleanup；
- integration tests。

### Phase 4 — Hardening

实现：

- launcher crash recovery；
- Janitor restart/recovery；
- suspend/resume tests；
- concurrent Pi instances；
- fault injection。

### Phase 5 — Packaging

实现：

- single npm Pi package；
- extension + launcher + janitor 一次安装；
- install/update instructions；
- compatibility CI；
- Linux x64/arm64；
- macOS Intel/Apple Silicon。

## 28. 推荐 API 边界

内部接口：

```ts
interface RuntimeGuard {
  readonly id: string;
  readonly backend: string;

  start(): Promise<void>;
  terminate(signal?: NodeJS.Signals): Promise<void>;
  cleanup(): Promise<void>;
  inspect(): Promise<RuntimeSnapshot>;
}
```

Session manager：

```ts
interface SessionProcessManager {
  beginSession(id: string): Promise<void>;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  cleanupSession(id: string): Promise<void>;
}
```

macOS tracker：

```ts
interface ProcessTracker {
  sample(): Promise<void>;
  descendantsOf(rootPid: number): TrackedProcess[];
  verify(process: TrackedProcess): Promise<boolean>;
}
```

平台选择：

```ts
switch (process.platform) {
  case "linux":
    return createLinuxGuard();
  case "darwin":
    return createMacOSGuard();
  default:
    throw new UnsupportedPlatformError();
}
```

---

## 29. 设计决策摘要

### 决策 1：Launcher 是必需组件

**原因：** extension API 无法全局约束其它 extension 的 `spawn()`。

### 决策 2：Linux 使用 cgroup，而不是 PPID tree

**原因：** PPID 会因 reparent 变化；cgroup 是更可靠的所有权边界。

### 决策 3：macOS 使用 PGID + registry

**原因：** PGID 对普通 coding-agent 工作负载足够可靠，同时 registry 用于缓解 `setsid()` 逃逸。

### 决策 4：Session 与 Runtime 分离

**原因：** Pi 的 `session_shutdown` 也发生在 `/new`、`/resume`、`/fork`、`/reload`，不能把它当作“整个 Pi 已退出”。

### 决策 5：Janitor 是必选组件

**原因：** Pi 内部 JavaScript lifecycle 无法覆盖 `SIGKILL`，launcher 本身也可能异常退出；独立 Janitor 提供单独故障域和最终清理责任。Janitor 与插件同包安装，不提供普通用户关闭选项。

### 决策 6：TERM -> KILL

**原因：** 先允许 server/LSP 写回状态、关闭 socket，再对不响应进程强制回收。

---

## 30. 已知限制

### Linux

强保证依赖：

- systemd user manager 可用；
- descendant 没有被显式迁移到其它 cgroup；
- extension 没有把任务提交给外部 daemon/service manager。

### macOS

无 Linux cgroup 对等能力。

以下行为只能 best-effort：

```text
Pi child
  -> setsid()
  -> 快速退出 parent
  -> escaped child 在下一次 registry sample 前完成脱离
```

若产品需求升级为“macOS 上也必须具有不可逃逸的强隔离”，应评估：

- 容器/VM；
- OS sandbox；
- privileged/native supervisor；
- 更底层的进程事件监控机制。

不建议通过高频 `ps` 轮询伪装成硬保证。

---

## 31. 最终推荐

生产方案采用：

```text
                         Pi Process Guard

Both
  pi-guard launcher
       -> create guard identity/state
       -> start mandatory independent Janitor
       -> start Pi runtime

Linux
  dedicated systemd transient service/cgroup
       -> Pi + all ordinary extension descendants
       -> KillMode=control-group
       -> Janitor performs/verifies final cleanup

macOS
  dedicated POSIX process group/session
       -> Pi + ordinary descendants
       -> descendant registry + PID identity
       -> Janitor performs final PGID/PID cleanup

Both
  Process Guard Pi Extension
       -> session lifecycle
       -> bash/user-bash job ownership
       -> session_shutdown cleanup
       -> diagnostics
```

保证等级：

| 平台 | Pi runtime 普通 descendants | 后台 fork | reparent | 主动逃逸 |
|---|---|---|---|---|
| Linux + cgroup | 强 | 强 | 强 | 迁移 cgroup 后不保证 |
| macOS PGID | 强 | 强 | 强，只要 PGID 不变 | 不保证 |
| macOS PGID + registry | 强 | 强 | 强 | best-effort |

对于 Pi Coding Agent 的常规开发任务，推荐将 **Linux cgroup** 作为 reference backend，将 **macOS PGID + registry + mandatory janitor** 定义为兼容 backend。

---

## 32. 参考资料

1. Pi Extensions — Lifecycle、`session_shutdown`、extension auto-discovery：  
   https://pi.dev/docs/latest/extensions

2. Pi Documentation：  
   https://pi.dev/docs/latest

3. Apple `setsid(2)` manual：  
   https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html

4. Apple `setpgid(2)` manual：  
   https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setpgid.2.html

5. Apple `killpg(2)` manual：  
   https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/killpg.2.html

6. systemd control-group / unit process management：  
   https://www.freedesktop.org/software/systemd/

7. `systemd-cgls`：  
   https://www.freedesktop.org/software/systemd/man/systemd-cgls.html

8. Node.js `child_process.spawn()` / `options.detached`：  
   https://nodejs.org/api/child_process.html

---

## 33. 一句话实现原则

> **不要尝试让一个 Pi extension 猜出所有其它 extension 创建了哪些进程；让操作系统从 Pi 启动那一刻就知道这些进程属于谁，并让独立 Janitor 对这个所有权域负责到底。**
