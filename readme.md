# dsh 使用手册 —— 安装 / 注意事项 / 故障处理

> **本机实测环境**（2026-09-10，用户 `ygtqy`）
>
> - Node **v22.23.1** · npm **10.9.8** · pnpm **10.14.0**
> - dsh **0.1.5-rc.1**（全局装在 `D:\nvm4w\nodejs`，nvm-windows 软链到 `D:\Program\nvm\v22.23.1`）
> - 数据目录 `C:\Users\ygtqy\.dsh`（未设置 `DSH_HOME`）
> - 原生模块工具链**已装好**：VS Build Tools 2022 **17.14.40** + Windows SDK **26100**（在 `D:\Windows Kits\10`）+ Python **3.12.9**
>
> 本文取代旧的《dsh 从 0 安装 + 全部插件安装指南》
> 文中所有"注意事项"均来自实际踩坑，命令都已在本机验证过。

---

## 0. 六条铁律（先看这个）

| # | 铁律 | 原因 |
| --- | --- | --- |
| 1 | 插件必须与宿主**同代**，装前先查它声明的宿主版本 | 插件直接 import 宿主内部 API，跨版本即崩 |
| 2 | 装完插件**必须重启 `dsh web`**，再 Ctrl+F5 | bundle 层只在进程启动时装载 |
| 3 | **不要装皮肤 / 主题类插件**（`*-theme`、`*-skin`） | 最容易崩，而且会让**整个宿主起不来** |
| 4 | `--dump-config` 退出码 0 **不等于**能启动 | 它只组合配置，不加载插件代码（本机翻过车） |
| 5 | 启动失败**不要 `rmdir` profile** | 先摘问题包，或用 rescue profile（见第 6 节） |
| 6 | pnpm 10 **默认跳过依赖的构建脚本** | 原生模块（ssh2/cpu-features）必须额外放行 |

---

## 1. 核心概念

**① launcher 与数据分离**

- dsh 本体（launcher）在全局 node_modules 里；所有数据（profile、插件、会话、凭据、设置）都在 `~/.dsh`。
- 所以升级 / 重装 / 换 npx 装法，**都不会丢数据**；但反过来说，**删 `~/.dsh/profiles/web` 就等于删掉全部插件**（会话历史在 `~/.dsh/sessions`，不受影响）。

**② 插件装在 profile 里，以"bundle 层"顺序加载**

```
~/.dsh/
├─ profiles/web/            # web profile（插件装这里）
│  ├─ package.json          # dependencies + dsh.profile.bundles（层顺序）
│  ├─ pnpm-workspace.yaml   # nodeLinker: hoisted / autoInstallPeers: false / onlyBuiltDependencies
│  ├─ pnpm-lock.yaml
│  ├─ cordis.patch.yml      # 用户补丁层（覆盖用）
│  └─ node_modules/         # 插件实体
├─ sessions/                # 会话历史（删 profile 不影响这里）
├─ storages/                # 持久化存储
├─ settings.yaml
└─ .credentials.yaml
```

- 插件不是 `require` 进来的，而是**启动时按 `dsh.profile.bundles` 的顺序装载**；
- 任何一个 bundle 抛错，整个 `dsh web` **直接启动失败**（不是只坏那一个插件）——这是所有"升级完打不开"问题的根因；
- profile 用 `nodeLinker: hoisted`，所以包在 `node_modules/` **顶层**，不在 `.pnpm/`（旧指南的验证脚本路径是错的）。

**③ 版本配对是硬约束**

```powershell
# 装之前查：这个包要求的宿主版本
npm view <包名> dsh.engines.dsh
# 查可用版本 / 通道
npm view <包名> dist-tags
npm view <包名> versions
```

本机宿主 `0.1.5-rc.1` 对应的正确版本：

| 包 | 本机应装版本 | 说明 |
| --- | --- | --- |
| `@linxin666/*`（6 个） | **0.3.20** | 0.3.20 声明 `dsh.engines.dsh: >=0.1.5-rc.1`；0.3.19 只声明 `>=0.1.2-rc.1` |
| `dsh-better-sidebar` | **0.19.0** | peerDeps 指向 `^0.1.5-rc.1`；0.18.1 指向 `^0.1.2-rc.1` |
| `dshmarket` / `dsh-find-plugin` / `dsh-chrome` | 1.45.1 / 0.3.7 / 0.1.3 | 当前 latest |

---

## 2. 安装插件的正确姿势

```powershell
# 通用形式（-w 是给 pnpm workspace root 用的；pnpm 10 可省略，写上无害）
dsh plugin --profile web add -w --save-exact <包名>@<版本>

# 卸载
dsh plugin --profile web remove -w <包名>
```

**装完必须重启**（否则插件不生效；而且此时 `/dsh-agent/bridge` 等路由还不存在）：

```powershell
# 在跑 dsh web 的窗口里 Ctrl+C，然后
dsh web
```

启动成功会打印一行带 token 的地址，形如：

```
dsh web: http://127.0.0.1:3080/?token=xxxxxxxx
```

> 直接访问 `http://127.0.0.1:3080/`（不带 token）会返回 **401**，这是正常的鉴权行为，不是故障。

---

## 3. 已验证可用的插件清单（10 个）+ 一键重装

> 本清单在 0.1.5-rc.1 上**已实测启动成功**（并用 WebSocket 握手探测验证过 dsh-chrome 桥接）。

```powershell
dsh plugin --profile web add -w --save-exact `
  dshmarket@1.45.1 `
  dsh-find-plugin@0.3.7 `
  dsh-better-sidebar@0.19.0 `
  "@linxin666/dsh-client-ui-preset-center@0.3.20" `
  "@linxin666/dsh-client-ui-git-graph@0.3.20" `
  "@linxin666/dsh-client-ui-model-capabilities@0.3.20" `
  "@linxin666/dsh-client-ui-task-board@0.3.20" `
  "@linxin666/dsh-remote-web-ui@0.3.20" `
  "@linxin666/dsh-ssh@0.3.20" `
  dsh-chrome@0.1.3
```

| # | 包 | 版本 | 作用 |
| --- | --- | --- | --- |
| 1 | `dshmarket` | 1.45.1 | 可视化插件市场（浏览 / 一键安装 / 更新 / 备份） |
| 2 | `dsh-find-plugin` | 0.3.7 | 插件搜索（市场配套） |
| 3 | `dsh-better-sidebar` | 0.19.0 | 右侧面板（资源管理器 / 编辑器 / 终端 / Git） |
| 4 | `@linxin666/dsh-client-ui-preset-center` | 0.3.20 | Agent 预设面板 |
| 5 | `@linxin666/dsh-client-ui-git-graph` | 0.3.20 | Git 分支选择器 + 提交图谱 |
| 6 | `@linxin666/dsh-client-ui-model-capabilities` | 0.3.20 | 自定义模型能力（图片输入 / 推理档位） |
| 7 | `@linxin666/dsh-client-ui-task-board` | 0.3.20 | 任务看板（含 cron 定时） |
| 8 | `@linxin666/dsh-remote-web-ui` | 0.3.20 | 移动端 / PC 远程控制 |
| 9 | `@linxin666/dsh-ssh` | 0.3.20 | SSH 运维面板（终端 / 传输 / 隧道 / 集群） |
| 10 | `dsh-chrome` | 0.1.3 | Chrome 侧栏 + 浏览器控制（需装扩展，见第 5 节） |

**已知不能装（会炸）**：

| 包 | 症状 | 何时能装 |
| --- | --- | --- |
| `@nanmicoder/dsh-agent-teams`（含 0.1.16-rc.3） | 启动即崩：`agent-teams: unsupported Harness subagent contract`，**整个宿主起不来** | 等作者发布声明 `dsh.engines.dsh: >=0.1.5-rc.1` 的版本；装前用 `npm view @nanmicoder/dsh-agent-teams dist-tags` 确认 |
| `dsh-neu-theme`、`dsh-sky-skin` 等皮肤/主题 | 启动即崩：`does not provide an export named 'settingsNamespace'` | 皮肤类插件直接 import 宿主内部 API，**建议长期不装**，或等其明确声明适配当前宿主版本 |

---

## 4. 原生模块（ssh2 / cpu-features）—— pnpm 10 的坑

**症状**：`pnpm rebuild ssh2 cpu-features` 退出码 0、**没有任何输出**、`.node` 文件依然不存在。
**真因**：pnpm 10 起，依赖的构建脚本**默认不执行**（供应链安全策略），重建被静默跳过。
装了 VS Build Tools **也修不好**——工具链和"放行"是两个独立条件。

**排查（一条命令）**：

```powershell
Select-String -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\.modules.yaml" -Pattern 'ignoredBuilds' -Context 0,5
```

输出非空（例如 `- cpu-features` / `- ssh2`）= 有包没编译。

**修复三步**：

```powershell
# ① 放行：写进 pnpm-workspace.yaml（不能写 package.json！见下方"坑"）
#    文件 ~/.dsh/profiles/web/pnpm-workspace.yaml 追加：
#      onlyBuiltDependencies:
#        - ssh2
#        - cpu-features
#    或者交互式：cd ~/.dsh/profiles/web; pnpm approve-builds

# ② 真正编译
Set-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm rebuild ssh2 cpu-features

# ③ 验证（注意：包在 node_modules 顶层，不是 .pnpm 里）
$nm = "$env:USERPROFILE\.dsh\profiles\web\node_modules"
Test-Path "$nm\ssh2\lib\protocol\crypto\build\Release\sshcrypto.node"   # 期望 True
Test-Path "$nm\cpu-features\build\Release\cpufeatures.node"            # 期望 True
node -e "console.log(require(process.argv[1])())" "$nm\cpu-features"   # 期望打印 CPU 特性
```

**两个实际踩到的坑**：

1. 写 `package.json` 的 `pnpm.onlyBuiltDependencies` **不生效** —— profile 是 pnpm workspace root，pnpm 10 只读 `pnpm-workspace.yaml`；
2. **别指望安装时的警告** —— 非交互环境下 pnpm 连 `Ignored build scripts` 那行都不打印（原始安装日志里就没有），只能查 `.modules.yaml`。

**工具链（本机已装好，重装系统时才需要）**：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --force `
  --accept-package-agreements --accept-source-agreements --disable-interactivity `
  --override "--quiet --wait --norestart --add Microsoft.Component.MSBuild --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.VC.CoreBuildTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
```

> 注意：Windows SDK 默认可能落在 `D:\Windows Kits\10`（不一定是 C 盘）。

---

## 5. Chrome 扩展（dsh-chrome）

```powershell
# 宿主插件装好后，把扩展文件释放出来
node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-chrome\bin\cli.js" install
# 或：npx dsh-chrome install
```

然后手动：

1. 打开 `chrome://extensions` → 开启右上角**开发者模式**；
2. **加载已解压的扩展程序** → 选择 `%LOCALAPPDATA%\dsh-chrome\extension`
   （即 `C:\Users\<用户名>\AppData\Local\dsh-chrome\extension`）；
3. 点工具栏 **dsh-chrome** 图标打开侧栏（需 Chrome 118+，且 `dsh web` 在运行）。

> 升级 dsh-chrome 后要重跑 `dsh-chrome install`，再到 `chrome://extensions` 点"重新加载"。

**连接验证**（期望 `HTTP/1.1 101 Switching Protocols`）：

```powershell
curl.exe -s -i --max-time 8 --http1.1 `
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' `
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' `
  http://127.0.0.1:3080/dsh-agent/bridge
```

---

## 6. 故障处理手册

### 6.1 宿主启动失败（最严重，"升级/装插件之后打不开"）

**症状**（控制台最后几行）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): loader entries failed to apply
Error: failed to import loader entry <entry-id> (<包名>): ...
```

**定位**：错误里 `(<包名>)` 括号中的就是元凶（本机两次分别是 `dsh-neu-theme` / `dsh-sky-skin`，以及更早的 `@nanmicoder/dsh-agent-teams`）。

**处理顺序**（从轻到重，**别一上来就删 profile**）：

```powershell
# ① 系统还能进 → 直接卸掉问题包，然后重启 dsh web
dsh plugin --profile web remove -w <包名>

# ② 进不去 → 手工编辑 profile 的 package.json，把该包从 dsh.profile.bundles 里删掉（dependencies 可先留着），再启动
notepad "$env:USERPROFILE\.dsh\profiles\web\package.json"

# ③ 还不行 → 用 rescue profile 起一个干净环境进去修（官方机制）
dsh --profile rescue --from-default-profile web

# ④ 最后手段：删掉 profile 目录（会丢失全部插件！删前先备份）
robocopy "$env:USERPROFILE\.dsh\profiles\web" "$env:USERPROFILE\dsh-profile-backup-$(Get-Date -Format yyyyMMdd-HHmm)" /E /XD node_modules /NFL /NDL /NJH /NJS
rmdir /S /Q "%USERPROFILE%\.dsh\profiles\web"
# 下次 dsh web 会自动重建"出厂"profile（只有 @deepseek-ai/dsh-base + dsh-web-app，没有任何插件）
```

> **删 profile 不会丢会话历史**：`sessions/`、`storages/`、`settings.yaml`、`.credentials.yaml` 都在 `~/.dsh` 下，不受影响。丢的只有插件和 profile 级配置。

### 6.2 `--dump-config` 的误导性

```powershell
dsh --profile web --dump-config   # 退出码 0 只代表"配置能组合"
```

它**不会加载插件代码**，所以像 `import` 报错这种运行时问题它发现不了（本机 agent-teams 就是 dump-config 通过、启动即崩）。
**唯一可靠的验证 = 真正启动一次**，或者用隔离环境冒烟测试（临时 `DSH_HOME` + junction 到真实 profile，换端口启动，确认无报错后再正式重启）。

### 6.3 Chrome 扩展报 WebSocket 失败

症状：`WebSocket connection to 'ws://127.0.0.1:3080/dsh-agent/bridge' failed: Connection closed before receiving a handshake response`

按顺序排查：

1. **宿主没重启**（最常见）——装了 dsh-chrome 但 `dsh web` 还是旧进程，`/dsh-agent/bridge` 返回 404；
2. `dsh-chrome` 不在 `dsh.profile.bundles` 里 → `dsh plugin --profile web add -w dsh-chrome@0.1.3`；
3. 宿主根本没起来（看第 6.1 节）。

扩展自带退避重连（2 秒起、最长 30 秒），宿主起来后它会自动接上，不用重装扩展。

### 6.4 端口被占用 / 进程杀不掉

```powershell
Get-NetTCPConnection -LocalPort 3080 -State Listen | Select-Object OwningProcess
Get-Process -Id <PID> | Select-Object Id,StartTime,Path
```

**杀不掉通常是权限不对等**：如果 dsh 是从"管理员"终端启动的，普通权限的脚本 `Stop-Process` 会静默失败（本机踩过：计划任务以 `RunLevel: Limited` 跑，杀不掉管理员进程，导致新进程起不来、旧进程一直占着端口）。
解决：用**同等权限**的终端操作，或注册计划任务时指定 `-Principal (New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest)`。

### 6.5 任务看板的告警（可忽略）

```
[dsh-task-board] session/list failed; treating the host session roster as unknown
TypertGatewayError: typert gateway: session/list: its strict definition was withdrawn and SRC fallback is forbidden
```

这是 `@linxin666/dsh-client-ui-task-board` 与宿主 gateway 的**非致命**不兼容（它自己降级为"未知"继续跑，不影响启动）。嫌吵就卸掉：

```powershell
dsh plugin --profile web remove -w "@linxin666/dsh-client-ui-task-board"
```

---

## 7. 备份 / 日志 / 回滚

```powershell
# 备份 dsh 数据（排除 node_modules，体积小；插件按第 3 节重装）
robocopy "$env:USERPROFILE\.dsh" "$env:USERPROFILE\dsh-backup-$(Get-Date -Format yyyyMMdd-HHmm)" /E /XD node_modules /NFL /NDL /NJH /NJS

# 备份单个 profile（动插件之前建议做一次）
robocopy "$env:USERPROFILE\.dsh\profiles\web" "$env:USERPROFILE\dsh-profile-backup-$(Get-Date -Format yyyyMMdd-HHmm)" /E /XD node_modules /NFL /NDL /NJH /NJS
```

| 位置 | 内容 |
| --- | --- |
| `~\.dsh\profiles\web\package.json` | 依赖 + bundle 层顺序（排障第一现场） |
| `~\.dsh\profiles\web\node_modules\.modules.yaml` | pnpm 状态、`ignoredBuilds`（构建是否被跳过） |
| `~\dsh-web-restart\restart.log` | 自动重启记录（含 bridge 探测结果） |
| `~\dsh-web-restart\web.err.log` | 宿主启动失败的真实报错（排查必看） |
| `~\.dsh\profiles\web\*.bak-*` | 手工改配置前的备份 |

---

## 8. 常用命令速查

```powershell
dsh --version                                   # 宿主版本
npm view @deepseek-ai/dsh dist-tags             # 宿主可用版本通道
dsh --profile rescue --from-default-profile web # 干净的救火 profile
dsh --profile web --dump-config                 # 组合配置（不代表能启动）
dsh plugin --profile web add -w --save-exact <包>@<版本>
dsh plugin --profile web remove -w <包>
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"   # 看 bundle 层
npm view <包名> dsh.engines.dsh                  # 查插件要求的宿主版本
```

---

## 9. 升级策略（重要）

1. **升级宿主（`npm install -g @deepseek-ai/dsh@<版本>`）后，插件必须重新对齐版本**，否则大概率启动失败；
2. **不要盲目升到 alpha/latest**：先用 `npm view @deepseek-ai/dsh dist-tags` 看清通道，插件生态通常滞后；
3. **升级前先备份**（第 7 节）——出问题能几分钟还原；
4. **皮肤 / 主题类插件要格外小心**，升级宿主后它们往往最先崩，且崩的是整个宿主；
5. 升级完 ①重启 `dsh web` ②Ctrl+F5 ③（装了 dsh-chrome 的话）跑第 5 节的 bridge 探测确认 101。

---

## 10. OpenCode Go 本地转发代理

OpenCode Go 端点要求请求携带 `x-opencode-session`。Cherry Studio、Cursor、TRAE 等通用 OpenAI 兼容客户端通常不会自动发送这个请求头，可以使用仓库中的本地代理补齐请求头。

### 启动代理

确保已安装 Node.js 18 或更高版本，然后双击仓库根目录的：

```text
start-opencode-go-proxy.cmd
```

也可以在 PowerShell 中运行：

```powershell
& .\start-opencode-go-proxy.cmd
```

代理默认监听 `127.0.0.1:8788`，并把请求转发到 `https://opencode.ai/zen/go`。启动窗口保持运行即可；停止时在窗口中按 `Ctrl+C`。

启动时可以用参数指定思考强度，也可以不带参数让代理弹出菜单询问：

```powershell
& .\start-opencode-go-proxy.cmd high     # 直接指定
& .\start-opencode-go-proxy.cmd          # 弹菜单：1 不思考 / 2 低 / 3 标准 / 4 最大
```

| 参数 | 含义 | 注入的请求体字段 |
| --- | --- | --- |
| `none` | 不思考（最快、最省 token） | 清除 `reasoning_effort` / `thinking` |
| `low` | 轻度思考 | `"reasoning_effort": "low"` |
| `high` | 标准思考（**默认**，不带参数时回车即此档） | `"reasoning_effort": "high"` |
| `max` | 最大思考（最慢、最费 token） | `"reasoning_effort": "max"` |
| `off` | 代理完全不注入，请求体原样转发 | 不改请求体 |

兼容别名：`medium`/`xhigh`/`mid` → `high`，`minimal` → `low`，`no`/`false` → `off`。

> 档位取值沿用 DeepSeek 官方 `chat/completions` 的 `reasoning_effort` 定义（`none` / `low` / `high` / `max`）。
> 代理只改写 `/chat/completions` 请求，`GET`/`HEAD` 以及其它路径原样转发；改写时会同步修正 `Content-Length`。

### 客户端配置

在 Cherry Studio 或其它客户端中只需要把 **Base URL** 改为：

```text
http://127.0.0.1:8788/v1
```

其它配置保持不变：

- API 格式：`Chat Completions (/chat/completions)`；
- API Key：仍填写你自己的 OpenCode Key，代理只透传 `Authorization`，不会读取、保存或管理 Key；
- 模型：例如 `deepseek-v4.1-flash`。

**不要继续使用** `https://opencode.ai/zen/go/v1` 作为客户端 Base URL，否则请求会绕过代理，仍然会收到 `Request is missing x-opencode-session`。

代理会在每个进程启动时生成一个稳定的 session ID，并在进程存活期间复用；同时覆盖请求中的 `User-Agent` 为编码客户端标识。查询参数、业务响应和流式响应会直接转发，不修改 IDE 配置，也不需要额外的 npm 依赖。请求体仅在注入思考强度时改写，`off` 档完全不动。

### 思考内容回传（代理自动处理）

DeepSeek 思考模式有一条硬性校验：历史里带 `tool_calls` 的 assistant 消息必须回传 `reasoning_content`，
否则整轮请求 400：

```text
The reasoning_content in the thinking mode must be passed back to the API.
```

这也解释了该报错的"时好时坏"现象：模型直接回答没问题，一旦调用工具，**下一轮就必然失败**。

**为什么客户端补不上**：VS Code Copilot 的回传逻辑被 `if (thinking.id)` 门控 —— 只有上游提供
`cot_id` / `reasoning_opaque` / `signature` 时才会带上 `reasoning_content`。DeepSeek 的流式响应只给
`reasoning_content`、不给 id，所以永远不回传。配置里的 `"thinking": true` 只满足外层开关，过不了
`thinking.id` 这道门。

**代理的做法**：

1. 旁路读取 `/chat/completions` 的响应流（**只读不改**，不影响转发），提取思考文本，按 `tool_call id` 缓存；
2. 后续请求中，凡带 `tool_calls` 但缺 `reasoning_content` 的 assistant 消息，用缓存的**真实内容**补回；
3. 缓存未命中时补一个非空占位串，保证不被上游挡下；
4. 缓存落盘到 `proxy-reasoning-cache.json`，使代理重启后旧会话仍能命中真实内容（500 条 LRU）。

客户端已自带 `reasoning_content` 时不会被覆盖；`none` 档不做回填（上游在该模式下不校验）。

VS Code 侧配置建议：

```jsonc
{
  "id": "deepseek-v4.1-flash",
  "url": "http://127.0.0.1:8788",
  "thinking": true,          // 保留：便于 VS Code 显示思考过程
  "toolCalling": true,
  "vision": true,
  "maxInputTokens": 1000000,
  "maxOutputTokens": 384000
}
```

不要配 `supportsReasoningEffort` / `reasoningEffortFormat` —— 思考强度由代理注入，配了只会让模型选择器
多出一个不起作用的 Thinking Effort 菜单。

### 连接验证

代理启动后，可用下面的命令验证本地转发是否工作（将 `<你的Key>` 替换为真实 Key；不要把 Key 写进脚本或提交到仓库）：

```powershell
curl.exe -i --max-time 30 `
  -X POST http://127.0.0.1:8788/v1/chat/completions `
  -H "Authorization: Bearer <你的Key>" `
  -H "Content-Type: application/json" `
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"ping"}]}'
```

返回上游的正常响应（例如 `200`）即表示转发成功；如果返回 `401`，通常是 Key 无效；如果客户端仍提示缺少 `x-opencode-session`，优先检查 Base URL 是否仍指向官方地址。

---

## 11. 相关链接

**dsh 本体**：npm https://www.npmjs.com/package/@deepseek-ai/dsh

**市场 / 目录**：https://dshmarket.com · https://awesome-dsh-plugin.com ·
https://github.com/dsh-market/dsh-market · https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

**已用插件**：https://github.com/awesome-dsh-plugin/dsh-find-plugin ·
https://github.com/omdsh-dev/DSH-better-sidebar ·
https://github.com/zhu1090093659/dsh-web（六个 `@linxin666/*` 的 monorepo）·
https://github.com/NanmiCoder/dsh-agent-teams（暂不可用）· https://github.com/stuarthu/dsh-chrome

**工具链**：https://nodejs.org · https://github.com/coreybutler/nvm-windows · https://pnpm.io ·
https://visualstudio.microsoft.com/visual-cpp-build-tools/