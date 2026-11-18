# dsh-wsl-overlay 使用说明

[English](README.md) | 简体中文

**一句话**：在 DeepSeek Harness（DSH）里打开一个位于 WSL 的工作区，会话里的 bash、文件读写、搜索就**透明地**跑在 Linux 发行版内——模型用的还是原来的工具名，你不需要改任何习惯。这就是"ZCode 连接 WSL"的体验。

## 它做什么 / 不做什么

**做**（会话的工作区是 `\\wsl.localhost\<发行版>\...` 时自动生效）：

- 原生 Bash 工具 → 发行版内的真 Linux bash（内核、信号、退出码都是真的）
- 原生文件工具（读/写/编辑/补丁）→ 发行版内文件系统：POSIX 权限、大小写敏感、原子写入 + 版本守卫、CRLF 字节保真
- `grep`/`glob` → 发行版自带的 ripgrep（无 9P 慢路径）
- 侧栏终端 → 真 Linux pty（`--cd` 直达工作区目录）
- 新会话自动进入 WSL 变体 preset；显式选择 preset 永远优先

**不做**：不改 Windows 工作区会话的任何行为（回归验证过：Windows 侧照旧 Git Bash）；不做文件监听（fs.watch）；不接受 `/mnt/...` 作为工作区根（Windows 解析不了）。

## 一次性准备

1. **WSL2 + 至少一个发行版**（本机：Ubuntu-24.04，已就绪）。
2. **发行版内必须有 node**（agent 以 `wsl.exe --exec node` 方式启动，不走登录 shell，nvm 用户注意）：

   ```powershell
   wsl -d Ubuntu-24.04 -u root -- apt install nodejs ripgrep
   ```

   nvm/fnm 用户：把插件配置 `nodePath` 设为 node 绝对路径（如 `/home/you/.nvm/versions/node/v22/bin/node`）。
3. ripgrep（grep/glob 工具需要）：同上命令已含。
4. 插件已装入 profile（desktop 已装；web 用 `dsh plugin --profile web add link:...`）。

## 日常使用

### 1. 准备一个 Linux 工作区目录

项目必须放在发行版的 Linux 文件系统里（`/home/...`），不能放 `/mnt`。目录要先存在：

```powershell
wsl -d Ubuntu-24.04 -- mkdir -p /home/lijh/my-project
```

### 2. 注册成 DSH 工作区（四选一）

**左侧栏面板（推荐）**：点击左侧栏的 **「WSL 工作区」** 入口（全局面板导航里，"插件"旁边）。面板上半是实时状态（发行版 / 已发布变体 / 活动通道数），下半是注册表单：选发行版、填 Linux 路径、点 **注册**——成功后工作区立即出现在侧边栏的工作区树里。

**让 agent 帮你做**：随便开个会话说

> 帮我把 /home/lijh/my-project 注册成工作区

（它调用插件自带的 `WSLWorkspace` 工具，action=create）

**浏览器**（web profile，仅限本机回环）：

```
POST http://127.0.0.1:3080/dsh-wsl-overlay/api/createWorkspace
{"path": "/home/lijh/my-project", "distro": "Ubuntu-24.04"}
```

**查询类**：`GET .../api/status`（变体/渠道诊断）、`GET .../api/listDistros`（发行版列表）。模型侧对应 `WSLWorkspace` 工具的 `status` / `listDistros` / `check`（探测路径存在性）。

注册后侧边栏会出现形如 `Ubuntu-24.04:/home/lijh/my-project` 的工作区（存进宿主自己的 workspace registry，插件零私有存储）。

### 3. 在该工作区开会话

工作区选择器切到它 → 新建会话。**自动**组合 `wsl-standard` 变体（会话横幅显示 *"The same agent, with its shell and file tools running inside WSL."*）。然后正常对话即可：

- "跑一下 uname -a" → 真 WSL2 内核
- "读一下 notes.txt" → 直接读 Linux 路径
- "把 main.py 里的 bug 修了" → 原生编辑工具在发行版内改文件

模型看到的都是 Linux 路径；Windows 盘在 `/mnt/<盘符>` 可见（迁移文件用）。

### 4. 变体与手动选择

每个现有 preset 都有对应 `wsl-<id>` 变体（本机：`wsl-standard` / `wsl-ptc` / `wsl-minimal` / `wsl-cordis`）。两个用途：

- 想在某次会话里换回 Windows 世界：preset 座位里手动选 `standard`（显式选择永远赢过自动默认）
- 想在**非 WSL 工作区**的会话里用 WSL 工具（比如在 G:\ 某项目里让 bash 跑 Linux）：手动选 `wsl-standard`，bash 的 cwd 会经 `/mnt` 映射进发行版

### 5. 多发行版

变体不钉死发行版：路径里写谁就是谁（`\\wsl.localhost\Debian\...` 即 Debian），一个变体覆盖全部已装发行版；纯 POSIX 路径回落到系统默认发行版。

## 配置项（patch 层可覆盖）

| 键 | 默认 | 说明 |
|---|---|---|
| `defaultPreset` | `wsl-standard` | WSL 工作区新会话的自动 preset；设为空串关闭自动切换 |
| `nodePath` | `node` | 发行版内启动 agent 的 node 可执行；nvm 用户给绝对路径 |
| `bootTimeoutMs` | 60000 | WSL 冷启动 + agent 首次 ping 的等待上限 |
| `idleTtlMs` | 600000 | agent channel 空闲自动关闭时间（下个请求透明重启） |

## 与 dsh-wsl-tool 的关系

共存不冲突。dsh-wsl-tool 是"显式工具"路线（10 个 `wsl*` 工具，模型主动调用，任何 preset 可用）；本插件是"透明接管"路线（原生工具换后端，preset 级）。Windows 工作区会话里只有前者有用；WSL 工作区会话里以本插件为主，前者的 `wsl-bootstrap`（装工具链）等偶尔仍有用。注意：走前者的 `wsl` 工具会绕过沙箱围栏（其 README 自述）。

## 安全边界

- 沙箱模式对模型报告为 `undefined`（发行版 VM 就是边界），但**每次写操作自建围栏**：`read-only` 拒绝；`workspace-write` 要求目标在工作区 root（映射进同一发行版）之内，按路径分量包含校验；映射不进去的 root 一律拒绝
- API 路由仅本机回环 + JSON 内容类型检查
- 拒绝把 `/` 等文件系统根作为删除目标；拒绝 `/mnt` 作为工作区根
- 剪贴板/通知/Windows 应用启动等主机互操作一概不做

## 故障排查

| 症状 | 原因与处理 |
|---|---|
| `node is not reachable as "node" inside the distro` | 发行版内没装 node 或 nvm 不在非登录 PATH：`apt install nodejs`，或设 `nodePath` 绝对路径 |
| 注册工作区报 ENOENT | 目录不存在：先在发行版里 `mkdir -p`，再注册 |
| 拒绝 `/mnt` 工作区 | 设计如此：把项目挪到 `/home` 下 |
| 会话里 `uname` 返回 MINGW64（还是 Windows） | 会话没在 wsl 变体：确认工作区路径是 `\\wsl.localhost\...` 且 preset 座位显示 wsl-standard；显式选过 standard 的会话以显式为准 |
| 编辑报 `FS_STALE_VERSION` | 文件在读取后被外部改过——重读再改，属正常保护 |
| 改了插件源码不生效 | web（link: 安装）重启 profile；desktop（file: 快照）重新执行一次安装命令 |
