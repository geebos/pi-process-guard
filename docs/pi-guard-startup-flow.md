# Pi Guard 启动流程与运行时设计

> 状态：Implementation Design  
> 平台：Linux、macOS  
> 组件：`pi-guard` Launcher + Process Guard Extension + Mandatory Janitor  
> 文档日期：2026-08-07  
> 设计目标：通过 `pi-guard` 代理真实 `pi` 的启动，使 Pi、Pi Extension 以及普通子进程进入可回收的运行时管理域，并在正常退出、崩溃或 `SIGKILL` 后完成清理。

---

## 1. 设计结论

`pi-guard` 不是 Pi 内置 `bash` 的替代实现，也不是简单的 shell alias。

它是 Pi 前面的一个 **runtime launcher**：

```text
用户
 |
 |  pi-guard [Pi arguments...]
 v
+-----------------------+
| pi-guard launcher     |
+-----------+-----------+
            |
            +------> mandatory janitor
            |
            +------> OS runtime domain
                       |
                       +------> real pi
                                  |
                                  +-- Guard extension
                                  +-- built-in bash
                                  +-- extension A
                                  +-- extension B
                                  +-- language servers
                                  +-- dev servers
                                  +-- other descendants
```

核心原则：

1. **Janitor 必须先于 Pi 启动成功。**
2. **Guard Extension 必须由 `pi-guard` 显式注入。**
3. **真实 Pi 必须在 OS 级 execution domain 中运行。**
4. **Launcher 不直接 `exec()` Pi；Launcher 必须保留，用于信号协调和正常退出流程。**
5. **最终 runtime cleanup 由 Janitor 统一执行。**
6. **如果 Janitor 在 Pi 运行期间异常死亡，Guard 进入 fail-closed：停止 Pi，而不是继续无保护运行。**
7. **Linux 优先使用 systemd/cgroup；macOS 使用 POSIX process group + descendant registry。**
8. **不替换 Pi 内置 `bash` tool。Runtime 级清理不依赖 bash interception。**

---

## 2. 与当前 Pi CLI 的集成方式

当前 Pi Coding Agent 的 CLI 命令为：

```text
pi
```

官方 npm package 的 CLI entry 为：

```text
@earendil-works/pi-coding-agent
└── bin
    └── pi -> dist/cli.js
```

Pi CLI 支持：

```text
-e, --extension <source>
```

显式加载 extension。

因此 `pi-guard` 不需要修改 Pi 安装目录，也不需要把 Guard extension 复制到：

```text
~/.pi/agent/extensions/
```

推荐方式是每次启动时自动注入：

```text
pi-guard --model xxx
```

实际内部执行参数：

```text
real-pi
  --extension /absolute/path/to/pi-process-guard/dist/extension.js
  --model xxx
```

这带来几个好处：

- Guard extension 不依赖项目 `.pi/`；
- 不受 project trust 是否允许项目 extension 的影响；
- 用户即使指定 `--no-extensions`，仍可保留显式 `--extension` 的 Guard extension；
- `pi-guard` 可以确认 Guard extension 是否真正完成初始化；
- 不要求用户重复安装 extension；
- Launcher、Extension、Janitor 可以来自同一个 npm package 和同一个版本。

---

## 3. 推荐安装模型

### 3.1 一个 npm package

推荐包结构：

```text
pi-process-guard/
├── package.json
├── dist/
│   ├── bin/
│   │   ├── pi-guard.js
│   │   └── janitor.js
│   ├── extension.js
│   ├── launcher/
│   │   ├── cli.js
│   │   ├── runtime.js
│   │   ├── signals.js
│   │   └── pi-resolver.js
│   ├── janitor/
│   │   ├── protocol.js
│   │   ├── registry.js
│   │   └── cleanup.js
│   └── platform/
│       ├── linux-systemd.js
│       ├── linux-posix.js
│       └── macos.js
└── README.md
```

`package.json`：

```json
{
  "name": "pi-process-guard",
  "type": "module",
  "bin": {
    "pi-guard": "./dist/bin/pi-guard.js"
  },
  "files": [
    "dist",
    "README.md"
  ]
}
```

用户安装：

```bash
npm install -g pi-process-guard
```

之后 PATH 中出现：

```bash
pi-guard
```

真实 Pi 仍由用户按 Pi 官方方式安装。

### 3.2 不把 Pi 作为硬 dependency

建议 `pi-process-guard` **不要把 Pi 本身作为普通 runtime dependency**。

原因：

- 用户可能通过 npm 全局安装 Pi；
- 用户也可能通过 Pi 官方 installer 安装独立 executable；
- Node version manager 可能让多个 Pi 版本并存；
- Guard 应代理用户当前 PATH 中的 Pi，而不是偷偷启动 npm package 内另一份 Pi。

因此：

```text
pi-process-guard
  -> resolve user's real `pi`
  -> launch it
```

而不是：

```text
pi-process-guard
  -> node_modules/@earendil-works/pi-coding-agent/dist/cli.js
```

---

## 4. CLI 语义

### 4.1 基本代理

用户：

```bash
pi-guard
```

等价于受保护地启动：

```bash
pi
```

参数透明传递：

```bash
pi-guard .
pi-guard --model openai/...
pi-guard -c
pi-guard --resume
pi-guard --mode rpc
pi-guard -p "review this code"
```

### 4.2 Guard 自己的参数

为了避免与 Pi CLI 参数冲突，Guard 自己的参数统一使用：

```text
--guard-*
```

例如：

```text
--guard-debug
--guard-doctor
--guard-pi-bin <path>
--guard-runtime-dir <path>
--guard-grace-ms <number>
--guard-require-cgroup
```

其它参数全部原样传给 Pi。

### 4.3 不使用 shell 代理

Launcher 必须：

```ts
spawn(piBinary, args, {
  shell: false
});
```

不要执行：

```ts
spawn(`pi ${args.join(" ")}`, {
  shell: true
});
```

原因：

- 避免 shell quoting 问题；
- 避免命令注入；
- 避免 shell alias/function 影响真实 Pi 解析；
- 参数可以一项一项原样传递；
- CLI prompt 中包含空格、引号或特殊字符时不会被二次解析。

---

## 5. 启动状态机

完整启动过程定义为：

```text
INIT
 |
 v
PREFLIGHT
 |
 v
RUNTIME_DIR_CREATED
 |
 v
JANITOR_STARTING
 |
 v
JANITOR_READY
 |
 v
BACKEND_READY
 |
 v
PI_STARTING
 |
 v
EXTENSION_READY
 |
 v
RUNNING
 |
 +-------------------------------+
 |                               |
 v                               v
STOP_REQUESTED                FAILURE
 |                               |
 v                               v
JANITOR_CLEANUP <---------------+
 |
 v
CLEAN
 |
 v
EXIT
```

任何阶段失败都必须：

```text
禁止进入下一阶段
+
回收已创建资源
+
返回非 0 exit code
```

尤其：

```text
Janitor 未 READY
=> 不允许启动 Pi
```

---

# 6. Phase 0：CLI 分类

不是所有 `pi` 命令都需要创建完整 runtime。

建议把 Pi invocation 分为两类。

## 6.1 Agent Runtime 命令

需要完整 Guard：

```text
pi
pi -p ...
pi --mode json ...
pi --mode rpc ...
pi -c
pi -r
pi --session ...
pi --fork ...
```

这些命令可能：

- 加载 extension；
- 调用 bash；
- 创建 language server/helper；
- 创建长生命周期子进程。

因此使用完整：

```text
Launcher + Janitor + OS Domain + Guard Extension
```

## 6.2 Administrative 命令

可以直接透明 passthrough：

```text
pi --help
pi --version

pi install ...
pi remove ...
pi uninstall ...
pi update ...
pi list
pi config
```

这些命令的主要目标是 Pi 自身/package 管理，而不是运行 Agent Runtime。

推荐：

```text
pi-guard update --self
```

内部：

```text
resolve real pi
-> spawn real pi directly
-> inherit stdio
-> return exit code
```

不创建 Janitor。

这样避免：

- `pi update --self` 更新可执行文件时受到 runtime wrapper 干扰；
- `--version` 为了输出一行版本号却启动完整 Janitor；
- package management 命令错误地要求 Guard extension READY。

如果未来 Pi 增加新的 administrative command，应更新 classifier。

也可以提供：

```text
--guard-force-runtime
```

强制所有 invocation 进入完整 Guard。

---

# 7. Phase 1：Preflight

启动真正的 Pi 前必须完成本地检查。

## 7.1 平台检查

允许：

```text
process.platform === "linux"
process.platform === "darwin"
```

其它平台：

```text
Unsupported platform
```

退出。

## 7.2 Node 运行时

Janitor 与 Launcher 都使用当前：

```ts
process.execPath
```

因此无需额外安装一份 Node。

检查：

```text
process.execPath 存在
当前 runtime 满足 package engines
```

## 7.3 Guard 文件完整性

确认：

```text
extension.js
janitor.js
```

存在且来自当前 package。

建议从：

```ts
import.meta.url
```

解析绝对路径，不依赖 cwd。

## 7.4 Linux backend 探测

顺序：

```text
1. `systemd-run` 是否存在
2. `systemctl --user` 是否可连接
3. user manager 是否可用
```

例如：

```bash
systemctl --user show-environment
```

成功：

```text
backend = linux-systemd
protection = strong
```

失败：

```text
backend = linux-posix
protection = degraded
```

如果用户指定：

```text
--guard-require-cgroup
```

则 systemd user manager 不可用时直接退出。

## 7.5 macOS backend

默认：

```text
backend = macos-posix
protection = best-effort-high
```

Janitor 必须启用。

---

# 8. Phase 2：解析真实 Pi executable

这是启动链路里非常重要的一步。

## 8.1 解析优先级

### Priority 1：显式配置

```bash
pi-guard --guard-pi-bin /absolute/path/to/pi
```

或：

```bash
export PI_GUARD_PI_BIN=/absolute/path/to/pi
```

### Priority 2：PATH

Launcher 自己遍历：

```text
process.env.PATH
```

寻找第一个可执行：

```text
pi
```

不要通过 shell 执行：

```bash
command -v pi
```

作为核心实现。

可以自行：

```ts
for (const dir of PATH.split(path.delimiter)) {
  candidate = join(dir, "pi");
  check executable;
}
```

## 8.2 防止递归启动

考虑：

```text
pi -> pi-guard
```

或用户创建了错误 symlink。

Launcher 必须设置：

```text
PI_GUARD_LAUNCH_DEPTH=1
```

如果新启动的 `pi-guard` 发现：

```text
PI_GUARD_LAUNCH_DEPTH >= 1
```

则：

```text
Refusing recursive pi-guard launch
```

并退出。

另外对 candidate 执行：

```text
realpath(candidate)
```

与当前 `pi-guard` executable/entry 比较。

如果解析到自身：

```text
reject candidate
```

## 8.3 不受 shell alias 影响

因为 `spawn(..., { shell: false })` 不启动 shell：

```bash
alias pi=pi-guard
```

本身不会被 Node 的 PATH lookup 当成 executable。

真正需要防的是：

```text
PATH 中的 `pi` 文件本身
```

指回 `pi-guard`。

## 8.4 Doctor 模式验证

正常启动不必每次执行额外 `pi --version`。

但：

```bash
pi-guard --guard-doctor
```

应该检查：

```text
Pi executable: /...
Pi version: ...
Guard extension: ...
Janitor: ...
Backend: ...
systemd user: ...
Runtime dir writable: ...
```

---

# 9. Phase 3：创建 Runtime Identity

每次 `pi-guard` invocation 都创建唯一：

```text
guardId
```

推荐：

```ts
crypto.randomUUID()
```

例如：

```text
3d9e916f-f4a1-40db-96d9-3dd6e12080cd
```

派生短 ID：

```text
3d9e916f
```

可用于 systemd unit：

```text
pi-guard-3d9e916f.scope
```

不要仅使用 PID 作为 identity。

错误：

```text
pi-guard-1234
```

因为 PID 会 reuse。

正确：

```text
PID + random guardId + start identity
```

---

# 10. Phase 4：Runtime Directory

每个 invocation 创建独立 runtime directory。

示例：

```text
~/.cache/pi-process-guard/runtime/
└── 3d9e916f-f4a1-40db-96d9-3dd6e12080cd/
    ├── state.json
    ├── janitor.sock
    ├── ready
    └── janitor.log        # debug 时才创建
```

## 10.1 权限

目录：

```text
0700
```

state：

```text
0600
```

Unix socket 仅当前用户访问。

## 10.2 不保存敏感 CLI 内容

Pi CLI 允许：

```bash
pi -p "some prompt"
```

所以 runtime registry **不得保存完整 argv**。

否则可能把用户 prompt 写入 cache。

state 只保存运行时管理元数据：

```json
{
  "schemaVersion": 1,
  "guardId": "...",
  "state": "starting",
  "platform": "darwin",
  "backend": "macos-posix",
  "launcher": {
    "pid": 5001,
    "startIdentity": "..."
  },
  "janitor": null,
  "pi": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

禁止默认保存：

```text
API keys
完整 environment
Pi prompt
完整 command line
模型 provider credentials
```

---

# 11. Phase 5：启动 Mandatory Janitor

Janitor 必须在真实 Pi 之前启动。

## 11.1 启动方式

Launcher：

```ts
const janitor = spawn(
  process.execPath,
  [
    janitorEntry,
    "--runtime-dir",
    runtimeDir,
    "--guard-id",
    guardId,
    "--launcher-pid",
    String(process.pid)
  ],
  {
    detached: true,
    stdio: "ignore",
    env: minimalJanitorEnv
  }
);

janitor.unref();
```

## 11.2 为什么 detached

Janitor 必须：

```text
不属于 Pi runtime process group
不依赖 Launcher event loop
Launcher SIGKILL 后仍运行
Pi SIGKILL 后仍运行
```

因此：

```text
detached: true
stdio: ignore
unref()
```

## 11.3 Janitor environment

不要把整个用户环境无脑复制给 Janitor。

推荐只保留：

```text
PATH
HOME
USER
LOGNAME
TMPDIR
XDG_RUNTIME_DIR
DBUS_SESSION_BUS_ADDRESS   # Linux systemd --user 可能需要
LANG / LC_*
```

以及：

```text
PI_GUARD_INTERNAL=janitor
```

Janitor 不需要：

```text
ANTHROPIC_API_KEY
OPENAI_API_KEY
其它 provider secrets
```

如果实现上无法安全过滤，应至少确保 Janitor 不记录 environment。

---

# 12. Phase 6：Janitor Handshake

仅仅 `spawn()` 成功不代表 Janitor 真正可用。

因此必须有 READY handshake。

## 12.1 Janitor 启动

Janitor：

```text
读取 runtime dir
-> 校验目录 owner/permission
-> 校验 guardId
-> 记录自身 PID + start identity
-> bind janitor.sock
-> atomically 更新 state.json
-> 发布 READY
```

## 12.2 READY 条件

Launcher 只有收到：

```json
{
  "type": "READY",
  "guardId": "...",
  "janitorPid": 5002,
  "protocolVersion": 1
}
```

才继续。

默认 timeout：

```text
2000 ms
```

可配置：

```text
--guard-janitor-ready-timeout-ms
```

## 12.3 READY 失败

如果：

```text
janitor crash
socket bind 失败
protocol version 不兼容
timeout
```

则：

```text
不要启动 Pi
删除 runtime dir
exit non-zero
```

这是“Janitor 必选”的核心语义。

---

# 13. Phase 7：准备 Guard Extension 注入参数

Guard extension 路径从当前 package 绝对解析：

```text
/absolute/path/pi-process-guard/dist/extension.js
```

组装参数时必须放在用户参数前：

```ts
const guardedPiArgs = [
  "--extension",
  extensionPath,
  ...forwardedPiArgs
];
```

不要放在末尾，因为用户参数可能包含：

```text
--
```

option terminator。

## 13.1 `--no-extensions`

用户：

```bash
pi-guard --no-extensions
```

仍然应该得到：

```text
--extension <guard>
--no-extensions
```

语义是：

```text
禁用自动发现的 extensions
+
显式加载 Guard
```

Guard 自身不能被用户无意禁用，否则就失去安全保证。

如果用户确实想不使用 Guard：

```text
直接运行 pi
```

即可。

## 13.2 防重复加载

如果用户又手动安装了 Guard extension，可能出现：

```text
auto-discovery Guard
+
CLI -e Guard
```

同一运行时（同一次加载 pass）内同一扩展的两个模块实例（源码 `.ts` + 编译版 `.js`）只允许一个注册。

但注意：Pi 在 `/new`、`/reload`、`/resume`、`/fork` 时会**重新执行扩展 factory**，用新的 `ExtensionAPI` 绑定新 runtime 的 runner。因此不能用进程级 boolean 单例——否则新会话的 handler/command 全部丢失（tool_call 不再包装 bash 命令，新会话的进程脱离管理）。

注册去重必须按**运行时代际**进行：

```ts
const GENERATION_KEY = Symbol.for("pi-process-guard.extension.generation");
const REGISTRATION_KEY = Symbol.for("pi-process-guard.extension.registration-generation");

// factory 内：
const g = globalThis as Record<symbol, unknown>;
const generation = (g[GENERATION_KEY] as number) ?? 0;
if (g[REGISTRATION_KEY] === generation) return; // 同代重复调用 = 双加载 → 跳过
(g as Record<symbol, unknown>)[REGISTRATION_KEY] = generation;

// session_shutdown handler 内（Pi 在重新执行 factory 之前触发）：
(g as Record<symbol, unknown>)[GENERATION_KEY] = ((g[GENERATION_KEY] as number) ?? 0) + 1;
```

`Symbol.for` 保证 `.ts`/`.js` 两个模块实例共享同一代际计数；`session_shutdown` 推进代际，使新 runtime 的 factory 调用重新注册而非被当作重复跳过。

另外可以检测：

```text
PI_GUARD_ID
```

确认当前是由 Launcher 启动。

---

# 14. Phase 8：注入运行时环境

真实 Pi 收到：

```text
PI_PROCESS_GUARD=1
PI_GUARD_ID=<uuid>
PI_GUARD_BACKEND=<backend>
PI_GUARD_RUNTIME_DIR=<path>
PI_GUARD_LAUNCHER_PID=<pid>
```

不要依赖：

```text
PI_GUARD_JANITOR_SECRET
```

这种被所有 descendants 继承的“秘密 token”。

本地安全边界主要依赖：

```text
runtime dir 0700
socket filesystem permission
PID/start identity verification
```

Extension 通过这些环境变量知道：

```text
当前 Pi 已处于 Guard runtime 中
```

如果用户直接运行 `pi`，但 Guard extension 被 auto-discover：

```text
PI_PROCESS_GUARD != 1
```

则 extension 不应宣称保护已启用。

推荐显示：

```text
Process Guard extension loaded without pi-guard launcher.
Runtime process cleanup guarantee is inactive.
Start with: pi-guard
```

---

# 15. Phase 9A：Linux 启动真实 Pi

## 15.1 推荐 backend：systemd scope

Linux 上优先：

```text
systemd --user
+
transient scope
+
cgroup
```

概念命令：

```bash
systemd-run \
  --user \
  --scope \
  --quiet \
  --collect \
  --unit="pi-guard-3d9e916f.scope" \
  --property=KillMode=control-group \
  --property=KillSignal=SIGTERM \
  --property=SendSIGKILL=yes \
  --property=TimeoutStopSec=2s \
  -- \
  /absolute/path/to/pi \
  --extension /absolute/path/to/extension.js \
  ...
```

`systemd-run --scope` 的重要特点：

- 用 transient scope 管理一组外部进程；
- scope 中的所有进程是同等成员；
- scope 的生命周期与 cgroup 内是否仍有进程相关；
- stop scope 时可按 control group 清理；
- 对 fork/double-fork 不依赖 PPID。

## 15.2 进程结构

```text
terminal shell
 |
 +-- pi-guard launcher
 |    |
 |    +-- systemd-run
 |
 +-- janitor                 # 不属于 Pi scope

systemd --user
 |
 +-- pi-guard-3d9e916f.scope
      |
      +-- real pi
           |
           +-- Guard extension
           +-- extension A helper
           +-- extension B helper
           +-- bash
           +-- npm
           +-- node
           +-- python
```

Janitor 必须处于 scope 外。

## 15.3 为什么使用 scope

对交互式 Pi，scope 比把 Pi 当普通 daemon service 更自然：

```text
terminal stdio 继续由调用链继承
+
进程被统一放入 cgroup
```

无需把 Pi 设计成长期后台 service。

## 15.4 Janitor 注册 Linux runtime

scope 创建后 Launcher 发送：

```json
{
  "type": "REGISTER_RUNTIME",
  "platform": "linux",
  "backend": "systemd",
  "unit": "pi-guard-3d9e916f.scope"
}
```

Janitor 持久化：

```json
{
  "linux": {
    "unit": "pi-guard-3d9e916f.scope"
  }
}
```

从这一刻开始：

```text
即使 launcher SIGKILL
Janitor 也知道应该 stop 哪个 unit
```

---

# 16. Phase 9B：Linux fallback

当：

```text
systemd --user unavailable
```

且用户没有：

```text
--guard-require-cgroup
```

可以进入 POSIX fallback。

状态明确显示：

```text
backend=linux-posix
protection=degraded
```

Janitor 仍然必选。

fallback 不应被宣传成 cgroup 等价保证。

---

# 17. Phase 9C：macOS 启动真实 Pi

macOS 没有 Linux cgroup。

因此 runtime protection 使用：

```text
POSIX process group/session
+
Janitor descendant sampling
+
PID start identity
+
final sweep
```

## 17.1 启动

概念：

```ts
const pi = spawn(piBinary, guardedPiArgs, {
  cwd: process.cwd(),
  env: guardedEnv,
  stdio: "inherit",
  detached: true,
  shell: false
});
```

POSIX 平台上 Node `detached: true` 会让 child 成为新的 process group/session leader。

因此：

```text
piPid = pi.pid
piPgid = pi.pid
```

概念结构：

```text
terminal
 |
 +-- pi-guard launcher
 |
 +-- janitor                  PGID J
 |
 +-- pi                       PGID P
      |
      +-- extension helper    PGID P
      +-- bash                PGID P
      +-- npm                 PGID P
      +-- node                PGID P
```

## 17.2 stdio

Pi 必须：

```text
stdio: inherit
```

否则会破坏交互式 TUI。

Janitor：

```text
stdio: ignore
```

两者不要混淆。

## 17.3 信号

因为 Pi 位于独立 group/session，Launcher 必须负责转发终端相关信号。

至少：

```text
SIGINT
SIGTERM
SIGHUP
SIGWINCH
SIGQUIT
SIGCONT
```

例如：

```ts
process.on("SIGWINCH", () => {
  safeKillProcessGroup(piPgid, "SIGWINCH");
});
```

对于 job-control 信号（例如 `SIGTSTP`），需要单独做终端兼容测试。

如果 Node `detached` 在某个终端环境下导致 TUI/job-control 行为不兼容，macOS backend 可以升级为随包分发的极小 POSIX `exec` helper；但 Janitor 仍保持 JavaScript/TypeScript 实现。

## 17.4 Janitor runtime 注册

Pi PID 获得后：

```json
{
  "type": "REGISTER_RUNTIME",
  "platform": "darwin",
  "backend": "macos-posix",
  "piPid": 5100,
  "piPgid": 5100,
  "piStartIdentity": "..."
}
```

Janitor 从此开始 descendant sampling。

---

# 18. Phase 10：Guard Extension READY

仅仅 Pi process 已创建还不够。

必须确认：

```text
Guard extension 真正加载成功
```

## 18.1 Extension factory

Guard extension 初始化时：

```ts
export default async function (pi) {
  const runtime = readGuardEnvironment();

  if (!runtime.active) {
    // passive warning / diagnostics only
    return;
  }

  await notifyJanitor({
    type: "EXTENSION_READY",
    guardId: runtime.guardId,
    piPid: process.pid
  });

  registerLifecycleHandlers(pi);
  registerDiagnostics(pi);
}
```

## 18.2 为什么需要 EXTENSION_READY

它可以检测：

- extension path 错误；
- package 发布漏掉 extension.js；
- Pi extension API 发生不兼容变化；
- extension factory crash；
- CLI 参数注入失败。

## 18.3 Launcher readiness timeout

推荐：

```text
5000 ms
```

如果 Pi 在 timeout 前退出：

```text
按 Pi exit code 结束
```

如果 Pi 仍存活但 Extension 没有 READY：

```text
Guard initialization failure
-> 请求 Janitor cleanup
-> stop Pi runtime
-> exit non-zero
```

这样不会出现：

```text
用户以为在 pi-guard 下
实际上 Guard extension 根本没加载
```

---

# 19. Phase 11：RUNNING

进入 RUNNING 后：

```text
Launcher:
  - 不读取业务 stdin
  - 等待 Pi
  - 转发必要 signals
  - 监控 Janitor 健康

Janitor:
  - 监控 Launcher PID/start identity
  - 监控 Pi/runtime domain
  - macOS 周期扫描 descendants
  - 等待 cleanup request 或 owner death

Extension:
  - 处理 session lifecycle
  - 提供 /process-guard
  - 可管理 session-owned jobs
  - 不替换 built-in bash
```

---

# 20. Launcher 与 Janitor 的健康协议

建议使用本地 Unix domain socket。

协议采用 newline-delimited JSON：

```json
{"type":"READY","protocolVersion":1}
{"type":"REGISTER_RUNTIME","...":"..."}
{"type":"EXTENSION_READY","piPid":1234}
{"type":"HEARTBEAT","launcherPid":1233}
{"type":"CLEANUP_REQUEST","reason":"pi-exit"}
{"type":"CLEANUP_DONE","result":"clean"}
```

## 20.1 Heartbeat

默认：

```text
1000 ms
```

但不能只依赖 heartbeat。

Janitor 同时检查：

```ts
process.kill(launcherPid, 0)
```

以及 start identity。

这样：

```text
Launcher event loop 卡顿
```

不会立刻被误判为死亡。

## 20.2 start identity

所有关键 PID：

```text
launcher
janitor
pi
tracked descendants
```

都尽可能保存：

```text
PID + process start identity
```

避免 PID reuse。

---

# 21. macOS Descendant Registry

macOS Janitor 必须在 Pi 存活时持续采样。

默认周期：

```text
1000 ms
```

可调：

```text
250 - 5000 ms
```

## 21.1 采样内容

至少：

```text
PID
PPID
PGID
SID
START_TIME
```

必要时为了诊断可以临时读取 command，但不要默认持久化完整 command line。

## 21.2 图遍历

每轮构建：

```text
parent PID -> children[]
```

从：

```text
piPid
```

做 DFS/BFS。

所有确认 descendant：

```text
加入 runtime registry
```

例如：

```json
{
  "pid": 5200,
  "startIdentity": "...",
  "firstSeenAt": 1786111200000,
  "lastSeenAt": 1786111203000,
  "lastPpid": 5100,
  "lastPgid": 5100
}
```

如果某进程之后：

```text
setsid()
```

脱离原 PGID，但之前已经采样过：

```text
Janitor 仍保留 PID/start identity
```

最终可以单独清理。

---

# 22. 正常退出流程

假设用户正常退出 Pi。

```text
Pi
 |
 | session_shutdown(reason=quit)
 v
Guard Extension
 |
 | 清理 session-owned resources
 v
Pi process exits
 |
 v
Launcher detects exit
 |
 | CLEANUP_REQUEST(reason=pi-exit)
 v
Janitor
 |
 | runtime final cleanup
 v
CLEANUP_DONE
 |
 v
Launcher exits with Pi exit code
```

## 22.1 Exit code

Launcher 应尽量保留真实 Pi exit code：

```text
Pi exit 0 -> pi-guard exit 0
Pi exit 1 -> pi-guard exit 1
```

Guard 自己失败时使用单独代码。

建议：

```text
70  Guard internal failure
71  Janitor unavailable
72  Backend unavailable
73  Extension readiness failure
74  Cleanup incomplete
```

具体值可以调整，但必须稳定记录。

---

# 23. Ctrl+C / SIGTERM / SIGHUP

Launcher 收到终止信号时：

```text
1. 标记 STOP_REQUESTED
2. 只处理一次
3. 将信号转发给 Pi/runtime
4. 给 Pi 一个短暂正常退出窗口
5. 请求 Janitor cleanup
6. 等待 CLEANUP_DONE
7. 按约定 exit
```

禁止：

```text
Launcher 收到 SIGTERM
-> 自己立刻 process.exit()
```

否则会把正常 cleanup 全部交给 crash path。

## 23.1 幂等

同时可能发生：

```text
Launcher SIGTERM
+
Pi 自己退出
+
Extension session_shutdown
```

所有 cleanup request 必须使用：

```text
guardId + cleanupGeneration
```

或 Janitor 内部原子状态：

```text
RUNNING
-> CLEANING
-> CLEAN
```

后续请求只返回已有结果。

---

# 24. Pi Crash

场景：

```text
Pi segfault / uncaught fatal / abnormal exit
```

Launcher 仍活着：

```text
Pi exit
-> Launcher requests cleanup
-> Janitor cleans descendants
-> Launcher reports abnormal Pi exit
```

Extension 是否收到 shutdown 不重要。

Runtime cleanup 不依赖 extension。

---

# 25. Pi 被 SIGKILL

```text
kill -9 <piPid>
```

Pi 无法执行：

```text
session_shutdown
process.on("exit")
finally
```

流程：

```text
Pi disappears
 |
 +-- Launcher detects child exit
 |
 +-- Janitor detects Pi/runtime change
 |
 v
Janitor cleanup
 |
 +-- Linux: stop cgroup/scope
 |
 +-- macOS: kill PGID + registry survivors
```

这正是 Janitor 必选的原因之一。

---

# 26. Launcher 被 SIGKILL

更重要的异常：

```text
kill -9 <pi-guard-launcher-pid>
```

此时：

```text
Launcher 完全无法执行 cleanup
```

但 Janitor 是独立 process：

```text
Janitor
 |
 | detects launcher PID gone
 v
OWNER_LOST
 |
 v
立即开始 runtime cleanup
```

设计语义：

> Launcher 死亡意味着 Guard ownership 丢失，因此不允许 Pi 继续无人监管地运行。

即：

```text
launcher dead
=> kill guarded Pi runtime
```

---

# 27. Janitor 自己异常退出

Janitor 是必选组件，所以不能：

```text
Janitor dead
-> Pi 继续运行
```

Launcher 必须监控 Janitor。

如果发现 Janitor 意外死亡：

```text
1. 输出 Guard fatal error
2. 进入 fail-closed
3. Launcher 执行 emergency runtime stop
4. 不再继续 Pi session
5. exit Guard internal failure
```

Linux emergency cleanup：

```text
systemctl --user stop <unit>
```

macOS emergency cleanup：

```text
kill Pi PGID
+
当前可见 descendants
```

这个 emergency path 不是用来替代 Janitor，而是避免：

```text
已知 Janitor 不存在
却继续让 Pi 创建更多进程
```

---

# 28. Linux 最终 Cleanup

Janitor 收到 cleanup：

```text
state = CLEANING
```

执行：

```bash
systemctl --user stop pi-guard-<id>.scope
```

scope 的 kill policy：

```text
KillMode=control-group
KillSignal=SIGTERM
SendSIGKILL=yes
TimeoutStopSec=<grace>
```

systemd 会：

```text
SIGTERM
-> grace
-> SIGKILL survivors
```

Janitor 再验证：

```text
unit inactive/dead
cgroup no remaining process
```

然后：

```text
state = CLEAN
```

如果超出 final timeout：

```text
cleanup result = incomplete
```

不要谎报成功。

---

# 29. macOS 最终 Cleanup

推荐顺序：

```text
1. 冻结 registry 更新快照
2. SIGTERM Pi process group
3. 对 registry 中身份匹配的逃逸进程 SIGTERM
4. grace period
5. 再扫描
6. SIGKILL Pi process group survivors
7. 对身份匹配 survivors SIGKILL
8. final verification
```

伪代码：

```ts
async function cleanupMac(runtime) {
  signalGroup(runtime.piPgid, "SIGTERM");

  for (const proc of verifiedTrackedProcesses()) {
    signalPid(proc.pid, "SIGTERM");
  }

  await sleep(graceMs);

  signalGroup(runtime.piPgid, "SIGKILL");

  for (const proc of verifiedSurvivors()) {
    signalPid(proc.pid, "SIGKILL");
  }

  return verifyNoManagedProcessesRemain();
}
```

每次单 PID kill 前都必须验证：

```text
PID
+
start identity
```

防止 PID reuse 误杀。

---

# 30. Cleanup 完成后的 Janitor 生命周期

Janitor 不是常驻 daemon。

正常：

```text
cleanup complete
-> write CLEAN
-> notify launcher
-> close socket
-> delete transient registry
-> remove runtime dir
-> exit 0
```

debug 模式可以保留：

```text
state.json
janitor.log
```

一段时间用于诊断。

默认则尽量不残留。

---

# 31. Stale Runtime Recovery

即使 Janitor 也是进程，也存在：

```text
机器突然掉电
OS crash
Janitor 被 SIGKILL
```

下一次 `pi-guard` 启动时扫描：

```text
runtime/*
```

对 stale entry：

```text
owner PID identity 不匹配
+
janitor PID identity 不匹配
```

执行 recovery。

Linux：

```text
检查旧 systemd unit 是否还存在
-> stop
```

macOS：

```text
根据 registry 做 identity-safe survivor sweep
```

完成后删除 stale runtime dir。

因此 preflight 包含：

```text
recover stale guards
```

但 recovery 必须：

```text
严格校验 guardId/PID start identity
```

不能只看 PID。

---

# 32. Guard Extension 的职责边界

Guard Extension 不负责整个 runtime 的最终保证。

它主要负责：

```text
1. EXTENSION_READY handshake
2. session lifecycle
3. session-owned process registry
4. /process-guard diagnostics
5. 可选 shell session tagging
```

不应该：

```text
monkey-patch 全局 child_process.spawn
替换 Pi built-in bash
假设自己能处理 SIGKILL
承担 runtime final cleanup 的唯一责任
```

---

# 33. Bash 的处理

## 33.1 Runtime 级

不需要覆盖 bash。

因为：

```text
Pi 在 cgroup/process domain 中
-> Pi 启动的 bash 自动继承 runtime ownership
```

例如：

```text
Pi
└── bash
    └── npm
        └── vite
```

都属于 Guard runtime。

## 33.2 Session 级

如果需要：

```text
/new
```

只杀旧 session dev server，但不杀长期 extension helper，则 Extension 可以对：

```text
bash tool
! / !!
```

增加 session ownership/tagging。

这是第二层能力，不是启动 Guard 的必要条件。

建议实现顺序：

```text
V1 runtime cleanup
V2 session-scoped cleanup
```

---

# 34. `/process-guard` 诊断命令

Extension 提供：

```text
/process-guard
```

建议显示：

```text
Pi Process Guard

Guard ID:       3d9e916f
State:          RUNNING
Launcher PID:   5001
Janitor PID:    5002
Pi PID:         5100
Platform:       macOS
Backend:        process-group + registry
Protection:     best-effort-high
Tracked:        7 processes
Janitor:        healthy
Runtime age:    00:14:23
```

Linux：

```text
Backend:        systemd-cgroup
Unit:           pi-guard-3d9e916f.scope
Protection:     strong
```

Extension 通过 runtime socket/state 获取信息，不自己猜。

---

# 35. 日志设计

默认尽量安静。

普通用户只看到 fatal/warning。

## 35.1 Debug

```bash
pi-guard --guard-debug
```

可以记录：

```text
[launcher] resolved pi=/...
[launcher] guardId=...
[janitor] ready pid=...
[linux] scope=...
[extension] ready piPid=...
[janitor] cleanup reason=pi-exit
[janitor] clean
```

## 35.2 日志隐私

禁止记录：

```text
完整 prompt
API key
完整 environment
bash command 内容（默认）
```

可以记录：

```text
PID
PGID
unit
signal
状态变化
计数
耗时
```

---

# 36. 推荐超时

初始建议：

```json
{
  "janitorReadyTimeoutMs": 2000,
  "extensionReadyTimeoutMs": 5000,
  "heartbeatIntervalMs": 1000,
  "descendantScanIntervalMs": 1000,
  "gracePeriodMs": 2000,
  "finalCleanupTimeoutMs": 5000
}
```

这些值都应可配置。

不要让无限等待阻塞终端退出。

---

# 37. Launcher 伪代码

```ts
async function main() {
  const parsed = parseGuardArgs(process.argv.slice(2));

  const piBinary = resolveRealPi(parsed);

  if (isAdministrativeInvocation(parsed.piArgs)) {
    return passthrough(piBinary, parsed.piArgs);
  }

  await recoverStaleRuntimes();

  const backend = await selectBackend(parsed);
  const runtime = await createRuntimeDirectory({
    backend,
    launcherPid: process.pid
  });

  const janitor = await startMandatoryJanitor(runtime);

  await janitor.waitReady();

  const extensionPath = resolveBundledExtension();

  const piArgs = [
    "--extension",
    extensionPath,
    ...parsed.piArgs
  ];

  const env = buildGuardedEnvironment(runtime);

  let child;

  if (backend.kind === "linux-systemd") {
    child = await launchInSystemdScope({
      piBinary,
      piArgs,
      env,
      runtime
    });
  } else {
    child = await launchInPosixDomain({
      piBinary,
      piArgs,
      env,
      runtime
    });
  }

  await janitor.registerRuntime(child.runtimeIdentity);

  installSignalForwarding(child, janitor);
  installJanitorHealthMonitor(janitor, child);

  const readiness = await waitForExtensionOrPiExit({
    janitor,
    child,
    timeoutMs: 5000
  });

  if (readiness.kind === "extension-timeout") {
    await janitor.cleanup("extension-not-ready");
    return EXIT_EXTENSION_FAILURE;
  }

  if (readiness.kind === "pi-exit") {
    await janitor.cleanup("pi-exit-before-ready");
    return readiness.exitCode;
  }

  const result = await waitForPiExit(child);

  const cleanup = await janitor.cleanup("pi-exit");

  if (!cleanup.complete) {
    return EXIT_CLEANUP_INCOMPLETE;
  }

  return normalizePiExit(result);
}
```

---

# 38. Janitor 伪代码

```ts
async function main() {
  const args = parseJanitorArgs();

  const runtime = await openAndValidateRuntime(args.runtimeDir);

  const socket = await bindControlSocket(runtime);

  await publishReady(runtime);

  const ownerWatcher = watchProcessIdentity(runtime.launcher);

  let registeredRuntime = null;
  let state = "READY";

  while (state !== "CLEAN") {
    const event = await nextEventOrHealthTick();

    if (event.type === "REGISTER_RUNTIME") {
      registeredRuntime = validateRuntimeIdentity(event);
      await persistRuntime(registeredRuntime);
      state = "RUNNING";
      continue;
    }

    if (event.type === "EXTENSION_READY") {
      await persistPiIdentity(event);
      continue;
    }

    if (event.type === "OWNER_DEAD") {
      state = "CLEANING";
      await cleanupRuntime("launcher-dead");
      state = "CLEAN";
      break;
    }

    if (event.type === "PI_DEAD") {
      state = "CLEANING";
      await cleanupRuntime("pi-dead");
      state = "CLEAN";
      break;
    }

    if (event.type === "CLEANUP_REQUEST") {
      state = "CLEANING";
      await cleanupRuntime(event.reason);
      state = "CLEAN";
      break;
    }

    if (event.type === "SCAN_TICK" && isMacOS()) {
      await updateDescendantRegistry();
    }
  }

  await publishCleanupResult();
  await removeRuntimeArtifacts();
}
```

---

# 39. Extension 伪代码

```ts
export default async function processGuardExtension(pi) {
  const guard = loadGuardRuntimeFromEnv();

  if (!guard.active) {
    pi.registerCommand("process-guard", {
      handler: async (_args, ctx) => {
        ctx.ui.notify(
          "Process Guard launcher is not active. Start Pi with `pi-guard`.",
          "warning"
        );
      }
    });

    return;
  }

  await sendExtensionReady({
    runtimeDir: guard.runtimeDir,
    guardId: guard.guardId,
    piPid: process.pid
  });

  pi.on("session_shutdown", async (event) => {
    await cleanupSessionOwnedProcesses(event.reason);
  });

  pi.registerCommand("process-guard", {
    handler: async (_args, ctx) => {
      const status = await readRuntimeStatus();
      ctx.ui.notify(formatGuardStatus(status), "info");
    }
  });
}
```

---

# 40. 完整 Linux Sequence Diagram

```text
User          pi-guard        Janitor        systemd        Pi       Extension
 |               |               |              |            |           |
 | pi-guard ...  |               |              |            |           |
 |-------------->|               |              |            |           |
 |               | preflight     |              |            |           |
 |               | runtime dir   |              |            |           |
 |               | spawn         |              |            |           |
 |               |-------------->|              |            |           |
 |               |               | bind socket  |            |           |
 |               |<--------------| READY        |            |           |
 |               |               |              |            |           |
 |               | systemd-run --scope          |            |           |
 |               |------------------------------>|            |           |
 |               |               |              | spawn pi   |           |
 |               |               |              |----------->|           |
 |               |               |              |            | load -e   |
 |               |               |<--------------------------------------|
 |               |               |        EXTENSION_READY(piPid)          |
 |               |<--------------| extension ready                       |
 |               |               |              |            |           |
 |<===========================================================| TUI       |
 |               |               |              |            |           |
 | exit Pi       |               |              |            |           |
 |               |<-------------------------------------------| exit      |
 |               | CLEANUP_REQ   |              |            |           |
 |               |-------------->|              |            |           |
 |               |               | stop scope   |            |           |
 |               |               |------------->|            |           |
 |               |               | verify empty |            |           |
 |               |<--------------| CLEAN         |            |           |
 |<--------------| exit code     |              |            |           |
```

---

# 41. 完整 macOS Sequence Diagram

```text
User          pi-guard        Janitor             Pi            Extension
 |               |               |                 |                 |
 | pi-guard      |               |                 |                 |
 |-------------->|               |                 |                 |
 |               | spawn detached janitor          |                 |
 |               |-------------->|                 |                 |
 |               |<--------------| READY           |                 |
 |               |               |                 |                 |
 |               | spawn detached Pi group         |                 |
 |               |-------------------------------->|                 |
 |               |               | REGISTER PGID   |                 |
 |               |-------------->|                 |                 |
 |               |               | scan descendants                 |
 |               |               |<----------------------------------|
 |               |               | EXTENSION_READY                   |
 |               |<--------------|                 |                 |
 |<=============================================== | TUI             |
 |               |               |                 |                 |
 | Ctrl+C        |               |                 |                 |
 |-------------->| forward SIGINT to PGID          |                 |
 |               |-------------------------------->|                 |
 |               |               |                 | shutdown        |
 |               |               |                 |---------------->|
 |               |               |                 | exit            |
 |               | CLEANUP_REQ   |                 |                 |
 |               |-------------->|                 |                 |
 |               |               | TERM PGID + tracked escapees      |
 |               |               | KILL survivors                    |
 |               |<--------------| CLEAN                             |
 |<--------------| exit          |                 |                 |
```

---

# 42. Launcher SIGKILL Sequence

```text
pi-guard launcher      Janitor          Pi/runtime
       |                  |                 |
       | running          | monitoring      |
       |                  |                 |
       X SIGKILL          |                 |
                          | detect owner gone|
                          |----------------- |
                          | cleanup          |
                          |----------------->|
                          | TERM -> KILL     |
                          | verify           |
                          | remove registry  |
                          | exit             |
```

此路径中：

```text
Guard extension 完全不参与
```

因此可以覆盖 Launcher/Pi 无法执行 JavaScript finally 的情况。

---

# 43. 安装后的用户体验

安装：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g pi-process-guard
```

检查：

```bash
pi-guard --guard-doctor
```

启动：

```bash
pi-guard
```

继续 session：

```bash
pi-guard -c
```

指定模型：

```bash
pi-guard --model <model>
```

以后如果用户愿意，可以自己在 shell 设置：

```bash
alias pg="pi-guard"
```

不建议直接覆盖：

```bash
alias pi="pi-guard"
```

不是因为 Node `spawn()` 会读取 shell alias，而是因为：

- 调试时难区分 Guard 与原始 Pi；
- `pi update --self` 等管理命令更容易产生认知混淆；
- 故障排查时保留原始 `pi` 命令很有价值。

---

# 44. 推荐的启动输出

正常模式尽量保持 Pi 原体验，不打印大量日志。

可只在 degraded backend 时显示：

```text
[pi-guard] Linux systemd user manager unavailable.
[pi-guard] Falling back to POSIX process tracking; protection is degraded.
```

Janitor 失败：

```text
[pi-guard] Failed to start mandatory janitor; Pi was not launched.
```

Extension 未就绪：

```text
[pi-guard] Guard extension did not initialize; terminating guarded Pi runtime.
```

---

# 45. 验收测试

## 45.1 通用

必须测试：

```text
pi-guard 正常进入 interactive TUI
所有 Pi CLI 参数正常转发
cwd 保持不变
stdin/stdout/stderr 行为不变
exit code 保持
Guard extension 必定加载
Janitor 启动失败时 Pi 不启动
```

## 45.2 Linux

测试：

```text
Pi extension spawn child
child fork grandchild
bash 启动后台 dev server
Pi 正常退出
Pi SIGTERM
Pi SIGKILL
Launcher SIGKILL
Janitor crash
```

每次最终验证：

```text
systemd scope empty/nonexistent
无 managed descendant
```

## 45.3 macOS

测试：

```text
interactive typing
Ctrl+C
terminal resize
SIGTERM
SIGHUP
Pi SIGKILL
Launcher SIGKILL
background child
fork child
child setsid after being sampled
PID reuse protection
```

尤其必须验证：

```text
detached Pi + inherited TTY
```

在 Terminal.app、iTerm2 等常见环境下的输入和 resize 行为。

## 45.4 Administrative passthrough

测试：

```text
pi-guard --version
pi-guard --help
pi-guard list
pi-guard update --self
```

确保不会错误等待 `EXTENSION_READY`。

---

# 46. 不变量（Invariants）

实现时建议把以下条件当成不可破坏的 invariant。

### Invariant 1

```text
RUNNING Pi
=> 存在健康 Janitor
```

### Invariant 2

```text
Guard 宣称 active
=> Guard Extension 已 READY
```

### Invariant 3

```text
Janitor 属于 Pi cleanup domain
=> BUG
```

Janitor 必须在外面。

### Invariant 4

```text
Registry 中只有 PID
=> BUG
```

必须配合 start identity。

### Invariant 5

```text
Runtime registry 保存完整 Pi argv/env
=> BUG
```

避免泄漏 prompt/credentials。

### Invariant 6

```text
Janitor death + Pi continue
=> BUG
```

必须 fail-closed。

### Invariant 7

```text
Cleanup 重复执行导致误杀
=> BUG
```

Cleanup 必须幂等和 identity-safe。

---

# 47. V1 推荐实现范围

为了降低第一版复杂度，建议 V1 聚焦：

```text
✓ pi-guard CLI
✓ real Pi resolver
✓ mandatory JS Janitor
✓ Unix socket handshake
✓ explicit Guard extension injection
✓ EXTENSION_READY handshake
✓ Linux systemd scope
✓ macOS process group
✓ macOS descendant registry
✓ normal exit cleanup
✓ Pi SIGKILL cleanup
✓ Launcher SIGKILL cleanup
✓ /process-guard diagnostics
```

暂缓：

```text
- 每个 bash job 独立 cgroup
- /new 精细 session process isolation
- native macOS libproc addon
- native setpgid helper
- Windows
- container integration
```

先把最重要的语义做到：

> **只要用户通过 `pi-guard` 启动 Pi，Pi Runtime 结束后就尽最大平台能力回收 Pi 与普通 extension 所创建的本地子进程；Janitor 始终存在并负责异常退出兜底。**

---

# 48. V2：Session-owned Process

V2 再增加：

```text
Session A
├── bash dev server
└── test watcher

/new

Session B
```

做到：

```text
/new
=> kill Session A jobs
=> 不 kill runtime-scoped extension helper
```

这时才需要 extension 对 built-in bash / user bash 增加 session tagging。

仍然不需要“替换 Pi bash”。

---

# 49. 最终推荐启动链路

最终推荐实现可以概括为：

```text
pi-guard
 |
 +-- classify invocation
 |
 +-- resolve real pi
 |
 +-- stale runtime recovery
 |
 +-- select platform backend
 |
 +-- create guardId/runtime dir
 |
 +-- spawn mandatory detached JS Janitor
 |
 +-- wait Janitor READY
 |
 +-- inject bundled Guard extension via --extension
 |
 +-- Linux:
 |     systemd transient scope
 |       -> real pi
 |
 +-- macOS:
 |     isolated POSIX group/session
 |       -> real pi
 |
 +-- register runtime with Janitor
 |
 +-- wait EXTENSION_READY
 |
 +-- RUNNING
 |
 +-- signal forwarding / health monitoring
 |
 +-- Pi exit OR owner loss
 |
 +-- Janitor TERM -> grace -> KILL -> verify
 |
 +-- CLEAN
 |
 +-- preserve Pi exit code
```

---

# 50. 实现前的三个关键技术决策

## 50.1 Linux

默认：

```text
systemd scope
```

不是重新实现 PPID tree killer。

## 50.2 macOS

V1：

```text
Node detached Pi
+
inherited stdio
+
signal forwarding
+
Janitor process scan
```

必须通过完整 TTY compatibility test。

如果发现 job-control 兼容问题：

```text
只替换 macOS launch backend
```

为极小 native `setpgid/exec` helper。

不需要改变：

```text
Janitor
registry
extension
protocol
```

## 50.3 Extension 加载

始终由 Launcher：

```text
--extension <bundled absolute path>
```

注入。

不要把“用户是否正确把 extension 安装到 ~/.pi”作为安全前提。

---

# 51. 参考实现依据

本设计基于以下当前行为进行集成：

- Pi Coding Agent 当前 npm package 暴露 `pi` CLI；
- Pi CLI 支持 `-e` / `--extension <source>` 显式加载 extension；
- Pi 文档说明 CLI 显式 extension 可在 project trust 前加载；
- Pi extension 与 Pi 进程具有相同本地用户权限，因此 OS runtime isolation 必须位于 extension 外层；
- Linux `systemd-run --scope` 可创建 transient scope，scope 管理一组进程；
- systemd `KillMode=control-group` 可在 unit stop 时清理 control group 中的剩余进程；
- Node.js 在非 Windows 平台上使用 `child_process.spawn(..., { detached: true })` 时，会让 child 成为新的 process group/session leader。

实现时应针对 Pi 当前版本持续运行 compatibility tests，而不要把某个 Pi 内部源码路径或未公开内部 API 作为稳定契约。
