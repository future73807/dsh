# dsh 从 0 安装 + 全部插件安装指南

> 适用环境：Windows + PowerShell
> 记录时间：2026-09-10（对应本机实际安装状态）
> 本机实测：Node **v22.20.0** / npm **10.9.3** / pnpm **9.15.9** / dsh **0.1.2-rc.1**（全局）
> 数据目录：`C:\Users\future\.dsh`（未设置 `DSH_HOME` 时的默认位置）

---

## 0. 先理解两件事

**① launcher 与数据分离**

- dsh 本体（launcher）装在全局 node_modules 里（本机：`D:\nvm4w\nodejs`）；
- 所有数据（profile、插件、会话历史、凭据、设置）都在 `~/.dsh`；
- 所以升级 launcher、从 npx 换成全局安装、重装 dsh，**都不会丢数据**。

**② 插件装在 profile 里**

- 默认 web profile 目录：`~/.dsh/profiles/web`；
- 插件用 `dsh plugin --profile web ...` 管理，本质是把参数转发给 pnpm 在 profile 目录执行；
- 装完需要**重启 `dsh web`** 并让浏览器硬刷新（Ctrl+F5）。

---

## 1. 前置依赖

```powershell
# Node.js >= 22（本机 v22.20.0）
node --version

# npm 随 Node 一起安装
npm --version

# pnpm（本机 9.15.9）
npm install -g pnpm
# 或者用 corepack：
# corepack enable pnpm

# nvm-windows 用户注意：全局包按 Node 版本隔离，切换 Node 后需要重新全局安装
npm prefix -g
```

---

## 2. 全局安装 dsh

```powershell
# 安装最新版（latest 通道）
npm install -g @deepseek-ai/dsh@latest

# 或锁定具体版本
npm install -g @deepseek-ai/dsh@0.1.2-rc.1

# 查看各通道可用版本
npm view @deepseek-ai/dsh dist-tags

# 验证
dsh --version
```

- 升级：`npm install -g @deepseek-ai/dsh@latest`
- 卸载：`npm uninstall -g @deepseek-ai/dsh`

> 通道说明：`latest` / `next` 为正式与预发布候选，`alpha` 为实验版。
> 插件对主机版本有要求（例如 agent-teams 推荐与宿主 0.1.2-rc.1 配对），不要盲目升级到 alpha。

---

## 3. 启动

```powershell
dsh web
# 默认地址 http://127.0.0.1:3080
```

首次启动会自动初始化 `~/.dsh/profiles/web`。目录结构大致为：

```
~/.dsh/
├─ profiles/web/          # web profile（插件装在这里）
│  ├─ package.json        # 依赖 + bundles 层列表
│  ├─ pnpm-workspace.yaml
│  ├─ cordis.patch.yml    # 用户补丁层
│  └─ node_modules/
├─ sessions/              # 会话历史
├─ storages/              # 持久化存储
├─ settings.yaml          # 设置
└─ .credentials.yaml      # 凭据
```

---

## 4. 安装插件的通用方法

```powershell
# 安装（-w 很关键，见下方说明）
dsh plugin --profile web add -w <包名>[@版本]

# 卸载
dsh plugin --profile web remove -w <包名>
```

**关于 `-w`**：profile 目录本身被声明为 pnpm workspace root（`pnpm-workspace.yaml` 里有 `packages: - .`）。
pnpm 9 在 workspace root 直接 `add` 会报 `ERR_PNPM_ADDING_TO_ROOT`，必须加 `-w` 明确写入根 package.json；
pnpm 10/11 没有这个限制，可省略。市场（dshmarket）自己的安装流程也会自动注入 `-w`。

**验证配置层是否正常**（退出码 0 即组合成功）：

```powershell
dsh --profile web --dump-config
```

---

## 5. 一次性安装当前全部插件（11 个）

```powershell
dsh plugin --profile web add -w --save-exact `
  dshmarket@1.45.1 `
  dsh-find-plugin@0.3.7 `
  dsh-better-sidebar@0.18.1 `
  @linxin666/dsh-client-ui-preset-center@0.3.19 `
  @linxin666/dsh-client-ui-git-graph@0.3.19 `
  @linxin666/dsh-client-ui-model-capabilities@0.3.19 `
  @linxin666/dsh-client-ui-task-board@0.3.19 `
  @linxin666/dsh-remote-web-ui@0.3.19 `
  @linxin666/dsh-ssh@0.3.19 `
  @nanmicoder/dsh-agent-teams@0.1.16-rc.3 `
  dsh-chrome@0.1.3
```

单行版（方便复制）：

```powershell
dsh plugin --profile web add -w --save-exact dshmarket@1.45.1 dsh-find-plugin@0.3.7 dsh-better-sidebar@0.18.1 @linxin666/dsh-client-ui-preset-center@0.3.19 @linxin666/dsh-client-ui-git-graph@0.3.19 @linxin666/dsh-client-ui-model-capabilities@0.3.19 @linxin666/dsh-client-ui-task-board@0.3.19 @linxin666/dsh-remote-web-ui@0.3.19 @linxin666/dsh-ssh@0.3.19 @nanmicoder/dsh-agent-teams@0.1.16-rc.3 dsh-chrome@0.1.3
```

装完重启：

```powershell
# Ctrl+C 停止后重新启动
dsh web
```

---

## 6. 逐个安装（按需挑选）

| 功能 | 安装命令 |
| --- | --- |
| 插件市场（可视化安装/更新插件、皮肤、备份） | `dsh plugin --profile web add -w dshmarket` |
| 插件搜索（市场配套） | `dsh plugin --profile web add -w dsh-find-plugin` |
| 右侧面板（资源管理器/编辑器/终端/Git/浏览器） | `dsh plugin --profile web add -w dsh-better-sidebar` |
| Agent 预设（社区预设面板） | `dsh plugin --profile web add -w @linxin666/dsh-client-ui-preset-center` |
| Git 可视化（分支选择器 + 提交图谱） | `dsh plugin --profile web add -w @linxin666/dsh-client-ui-git-graph` |
| 自定义模型能力（逐模型图片输入/推理档位） | `dsh plugin --profile web add -w @linxin666/dsh-client-ui-model-capabilities` |
| 任务看板（多列看板 + cron 定时执行） | `dsh plugin --profile web add -w @linxin666/dsh-client-ui-task-board` |
| 移动端/PC 远程控制（扫码配对、SSE 同步） | `dsh plugin --profile web add -w @linxin666/dsh-remote-web-ui` |
| 远程服务器运维（SSH：终端/传输/隧道/集群） | `dsh plugin --profile web add -w @linxin666/dsh-ssh` |
| Agent 团队（多智能体协作、任务 DAG） | `dsh plugin --profile web add -w @nanmicoder/dsh-agent-teams@0.1.16-rc.3`（宿主 0.1.2-rc.1 的推荐配对） |
| Chrome 侧栏 + 浏览器控制 | `dsh plugin --profile web add -w dsh-chrome`（另有扩展步骤，见第 8 节） |

> 先装 `dshmarket` 后，其余插件也可以直接在 **设置 → 插件市场** 里搜索、一键安装。

---

## 7. 可选：Windows 原生模块编译工具链

**谁需要**：`@linxin666/dsh-ssh`（依赖 ssh2 / cpu-features 原生加密绑定）。
不装也能用（自动回退纯 JS 实现），但装好后 SSH 加密走原生 AES-NI，性能更好。

**典型报错**：`Unable to detect compiler type`、`Failed to build optional crypto binding`。

**最小安装**（VS Build Tools 2022，仅 4 个必需组件，本机实测约 1.6 GB）：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --force `
  --accept-package-agreements --accept-source-agreements --disable-interactivity `
  --override "--quiet --wait --norestart --add Microsoft.Component.MSBuild --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.VC.CoreBuildTools --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
```

装完后在 profile 目录重新编译原生模块：

```powershell
Push-Location "$env:USERPROFILE\.dsh\profiles\web"
pnpm rebuild ssh2 cpu-features
Pop-Location
```

验证（原生模块不是 profile 顶层依赖，需要用实际路径加载）：

```powershell
$pnpmDir = "$env:USERPROFILE\.dsh\profiles\web\node_modules\.pnpm"
$ssh2 = (Get-ChildItem $pnpmDir -Directory -Filter 'ssh2@*' | Select-Object -First 1).FullName
$cf   = (Get-ChildItem $pnpmDir -Directory -Filter 'cpu-features@*' | Select-Object -First 1).FullName

# sshcrypto.node 存在 = ssh2 原生绑定编译成功
Test-Path "$ssh2\node_modules\ssh2\lib\protocol\crypto\build\Release\sshcrypto.node"

# 能打印 CPU 特性 = cpu-features 可用
node -e "console.log(require(process.argv[1])())" "$cf\node_modules\cpu-features"
```

> 建议：先装工具链，再执行第 5 节的一键安装，原生模块会在安装时自动编译成功。

---

## 8. dsh-chrome 的 Chrome 扩展部分

宿主插件装好后，还需要把 Chrome 扩展复制出来并在浏览器加载：

```powershell
# 方式一：用已安装包里的 CLI
node "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-chrome\bin\cli.js" install

# 方式二：直接 npx
npx dsh-chrome install
```

然后手动操作：

1. 打开 `chrome://extensions`，开启右上角**开发者模式**；
2. 点**加载已解压的扩展程序**，选择目录：
   `%LOCALAPPDATA%\dsh-chrome\extension`
   （即 `C:\Users\<用户名>\AppData\Local\dsh-chrome\extension`）
3. 点工具栏的 **dsh-chrome** 图标打开侧栏（需要 Chrome 118+，且 `dsh web` 正在运行）。

> 升级 dsh-chrome 后要重新执行一次 `dsh-chrome install`，再在 `chrome://extensions` 里点“重新加载”。

---

## 9. 升级

| 对象 | 方法 |
| --- | --- |
| dsh 本体 | `npm install -g @deepseek-ai/dsh@latest` |
| 全部插件 | 重启 dsh web → **设置 → 插件 → 插件配置** → 更新；或跑第 5 节命令（把版本号改 `@latest`） |
| 单个插件 | `dsh plugin --profile web add -w <包名>@latest` |
| 插件市场自身 | 设置 → 插件 → 插件配置 → 更新（可选 stable/beta 通道） |

升级前建议先备份（见下节）。重启 `dsh web` 后浏览器硬刷新。

---

## 10. 备份 / 迁移 / 排障

```powershell
# 备份 dsh 数据（排除插件 node_modules，体积小；插件可按第 5 节命令重装）
robocopy "$env:USERPROFILE\.dsh" "$env:USERPROFILE\dsh-backup-$(Get-Date -Format yyyyMMdd)" /E /XD node_modules /NFL /NDL /NJH /NJS

# 排障：检查 profile 组合是否正常（退出码 0 = 正常）
dsh --profile web --dump-config

# 查看 profile 当前依赖与 bundle 层顺序
Get-Content "$env:USERPROFILE\.dsh\profiles\web\package.json"
```

- **迁移到新机器**：安装 Node/pnpm → 全局安装 dsh → 拷回 `~/.dsh`（或只拷 `settings.yaml`、`.credentials.yaml`、`sessions/`）→ 按第 5 节重装插件。
- **排障顺序**：① 重启 `dsh web`；② `dsh --profile web --dump-config`；③ 市场内置的 **设置 → 插件 → 诊断**（看版本冲突/重复项）。

---

## 11. 当前插件清单（2026-09-10）

| # | 包名 | 版本 | 作用 | 来源 |
| --- | --- | --- | --- | --- |
| 1 | `dshmarket` | 1.45.1 | 可视化插件市场（浏览/搜索/一键安装/更新/备份） | https://github.com/dsh-market/dsh-market |
| 2 | `dsh-find-plugin` | 0.3.7 | 插件搜索 | https://github.com/awesome-dsh-plugin/dsh-find-plugin |
| 3 | `dsh-better-sidebar` | 0.18.1 | 右侧面板（资源管理器/编辑器/终端/Git/浏览器） | https://github.com/omdsh-dev/DSH-better-sidebar |
| 4 | `@linxin666/dsh-client-ui-preset-center` | 0.3.19 | Agent 预设（社区预设面板） | https://github.com/zhu1090093659/dsh-web |
| 5 | `@linxin666/dsh-client-ui-git-graph` | 0.3.19 | Git 分支选择器 + 提交历史图谱 | https://github.com/zhu1090093659/dsh-web |
| 6 | `@linxin666/dsh-client-ui-model-capabilities` | 0.3.19 | 自定义模型能力（图片输入/推理档位） | https://github.com/zhu1090093659/dsh-web |
| 7 | `@linxin666/dsh-client-ui-task-board` | 0.3.19 | 任务看板（多列 + cron 定时真实执行） | https://github.com/zhu1090093659/dsh-web |
| 8 | `@linxin666/dsh-remote-web-ui` | 0.3.19 | 移动端/PC 远程控制（扫码配对、SSE） | https://github.com/zhu1090093659/dsh-web |
| 9 | `@linxin666/dsh-ssh` | 0.3.19 | SSH 运维面板（终端/传输/隧道/集群） | https://github.com/zhu1090093659/dsh-web |
| 10 | `@nanmicoder/dsh-agent-teams` | 0.1.16-rc.3 | 多智能体协作（captain + 成员 + 任务 DAG） | https://github.com/NanmiCoder/dsh-agent-teams |
| 11 | `dsh-chrome` | 0.1.3 | Chrome 侧栏 + 浏览器控制（含扩展） | https://github.com/stuarthu/dsh-chrome |

profile 的 bundle 层顺序（`~/.dsh/profiles/web/package.json` 里的 `dsh.profile.bundles`）：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
dshmarket
dsh-find-plugin
dsh-better-sidebar
@linxin666/dsh-client-ui-git-graph
@linxin666/dsh-client-ui-model-capabilities
@linxin666/dsh-client-ui-preset-center
@linxin666/dsh-client-ui-task-board
@linxin666/dsh-remote-web-ui
@linxin666/dsh-ssh
@nanmicoder/dsh-agent-teams
dsh-chrome
```

---

## 12. 相关 URL 汇总

**dsh 本体**

- npm 包：https://www.npmjs.com/package/@deepseek-ai/dsh
- 版本通道：`npm view @deepseek-ai/dsh dist-tags`

**插件生态/市场**

- 插件市场仓库：https://github.com/dsh-market/dsh-market
- 插件市场官网（创意工坊）：https://dshmarket.com
- 插件目录（市场数据源）：https://awesome-dsh-plugin.com
- 插件目录仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin

**已装插件**

- dsh-find-plugin：https://github.com/awesome-dsh-plugin/dsh-find-plugin
- dsh-better-sidebar：https://github.com/omdsh-dev/DSH-better-sidebar
- dsh-web（六个 `@linxin666/*` 包的 monorepo）：https://github.com/zhu1090093659/dsh-web
- dsh-agent-teams：https://github.com/NanmiCoder/dsh-agent-teams
- dsh-chrome：https://github.com/stuarthu/dsh-chrome

**工具链**

- Node.js：https://nodejs.org
- nvm-windows：https://github.com/coreybutler/nvm-windows
- pnpm：https://pnpm.io
- Visual Studio Build Tools（原生模块编译，可选）：https://visualstudio.microsoft.com/visual-cpp-build-tools/
