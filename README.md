# Skill Observatory · 技能看台 · Alpha 2

Skill Observatory 是一个本机私有的 Codex Skill 管理看台：它盘点已安装的 Skills、显示验证与配置状态、记录结构化使用证据，并根据任务描述推荐本机可用的 Skill。界面和 API 只监听回环地址，不作为公网服务部署。

## 要求

- Node.js `>=22.13.0`
- npm
- 已安装 Codex 的系统 `skill-installer`

本 Skill 不会自动安装 Node.js、npm、Homebrew、GitHub CLI 或其他系统工具。

## 从公开 GitHub 仓库安装

公开仓库地址为 `yyan3947-cpu/skill-observatory`，可按下面的准确路径安装：

```zsh
OBSERVATORY_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
/usr/bin/python3 "$OBSERVATORY_CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo "yyan3947-cpu/skill-observatory" \
  --path skill-observatory \
  --method git
```

安装仅复制这个公开仓库中的 `skill-observatory/` 目录；首次设置和运行时状态仍只保存在使用者本机。

## 首次设置与启动

先预览设置动作，确认后再执行：

```zsh
OBSERVATORY_SKILL_ROOT="${CODEX_HOME:-$HOME/.codex}/skills/skill-observatory"
node "$OBSERVATORY_SKILL_ROOT/scripts/setup.mjs" --dry-run
node "$OBSERVATORY_SKILL_ROOT/scripts/setup.mjs"
node "$OBSERVATORY_SKILL_ROOT/scripts/start.mjs"
```

同步目录而不打开看台：

```zsh
node "$OBSERVATORY_SKILL_ROOT/scripts/sync.mjs"
```

默认页面为 `http://localhost:3000/`，本机 API 为 `http://127.0.0.1:4318/`。详细迁移、验证、启动器与故障排查说明见 `skill-observatory/references/operations.md`。

## 三级本地匹配与 GitHub Skill 建议

本地匹配始终先运行，并采用受保护的语义强匹配：精确 Skill 名称或精确别名可直接成为强匹配；其他候选只有同时满足受控意图、独立能力证据、分数阈值和领先门槛才能成为强匹配，不能只凭总分升级。本地强匹配时只显示最多三个本机 Skill，并且不会访问 GitHub。本地只有弱相关结果时，这些 Skill 会标记为“可能相关”，同时自动发送界面展示的受控脱敏能力词搜索 GitHub；本地没有相关结果时进入同一脱敏搜索。自动请求不发送未识别名称、项目名或自由文本。

仓库搜索先运行；经过严格文件验证后仍不足三个相关候选时，随后最多执行一次 SKILL.md 文件检索回退。两个阶段共用同一组脱敏能力词和严格的 `SKILL.md` 结构、路径、内容与去重验证。候选先通过相关性验证，再按仓库 Stars 从高到低排序，最多返回三个，界面最多三个；不足三个时不使用无关结果补齐。仓库 Stars 只代表关注度，不代表安全、质量、兼容性或可用性，也不是 Skill 评分。

完整零结果只表示这次受限查询没有找到通过验证的候选，不能证明 GitHub 上不存在相关 Skill。只有完整的脱敏搜索结果会缓存 24 小时；不完整结果、错误、原文搜索、许可与任务文本都不会缓存。

`GITHUB_TOKEN` 只存在于服务端进程内存，不写入浏览器、缓存、状态或仓库，也不会匿名回退。没有有效 GitHub Token 时保持本机模式，并区分 `missing-token`、`invalid-token`、`rate-limited` 与 `github-unavailable`；仓库搜索与 SKILL.md 文件检索的剩余量和重置时间分别显示。仓库搜索额度耗尽时进入 rate-limited 并保持本机模式；只有 SKILL.md 文件检索额度耗尽时仍可使用仓库搜索，GitHub 状态保持 ready，只跳过文件检索回退。限流时等待界面显示的重置时间；Token 修正后重新启动，暂时不可用时可由用户稍后重试。系统不会自动重试，也不要循环重试。

脱敏搜索完整零结果，或无法形成安全能力词时，界面才会完整展示原始任务。只有用户逐次点击 `确认发送原文到 GitHub` 后，当前显示的全文才会外发；原文不写入搜索缓存或日志。限流、超时、网络失败或验证不完整不会被当成零结果，只提供有界的用户重试，不会启用原文发送。

取消、修改任务或重新匹配时，看台会先撤销旧的一次性许可；本机服务确认后才显示取消成功并允许新搜索。输入框编辑仍即时生效。撤销失败时禁止继续发送原文并提供安全重试；页面关闭只做一次 `keepalive` 尽力撤销，短时过期继续兜底。

复制测试记录只包含固定安全诊断字段，不包含原始任务、GitHub Token、一次性许可、私有路径、Skill 内容、错误正文或堆栈；复制只写入本机剪贴板，不会发送记录。系统不会自动安装、更新、删除或执行候选；任何后续操作都需要单独审阅和批准。

## 隐私边界

- 完整任务文本不会自动发送给 GitHub；只有上述逐次确认后才会发送，并且不会进入搜索缓存或日志。
- 运行时目录、验证记录、历史缓存、生成目录、环境文件、令牌与 Cookie 均不进入此仓库。
- 运行时状态默认位于 `$CODEX_HOME/state/skill-observatory/`；未设置 `CODEX_HOME` 时位于 `~/.codex/state/skill-observatory/`。
- 可通过绝对路径 `SKILL_OBSERVATORY_DATA_DIR` 覆盖状态目录。
- GitHub 令牌如需使用，只能由用户显式提供给服务进程内存；不得写入 Skill、缓存或仓库，也没有匿名搜索回退。令牌不会取消原文外发确认。

这是公开发布的 Alpha 2 版本。仓库当前不包含开源许可证，也不发布 Skill 市场条目；公开可见和可下载不等于授予再分发或修改许可。
