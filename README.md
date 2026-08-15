# Skill Observatory · 技能看台

Skill Observatory 是一个本机私有的 Codex Skill 管理看台：它盘点已安装的 Skills、显示验证与配置状态、记录结构化使用证据，并根据任务描述推荐本机可用的 Skill。界面和 API 只监听回环地址，不作为公网服务部署。

## 要求

- Node.js `>=22.13.0`
- npm
- 已安装 Codex 的系统 `skill-installer`
- 能访问这个私有 GitHub 仓库的 Git 凭据

本 Skill 不会自动安装 Node.js、npm、Homebrew、GitHub CLI 或其他系统工具。

## 从私有 GitHub 仓库安装

把命令中的 `YOUR_GITHUB_OWNER` 替换为私有仓库的 GitHub 所有者：

```zsh
OBSERVATORY_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
/usr/bin/python3 "$OBSERVATORY_CODEX_HOME/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --repo "YOUR_GITHUB_OWNER/skill-observatory" \
  --path skill-observatory \
  --method git
```

安装器需要现有的私有仓库访问权限；本项目不会启动登录流程，也不会保存访问令牌。

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

## GitHub Skill 建议

本机任务匹配有结果时，系统只展示本机 Skill。当本机没有合格结果时，界面才显示“在 GitHub 查找”按钮以及准备发送的能力关键词；只有用户点击后才访问 GitHub。

远程候选必须包含可解析且结构有效的 `SKILL.md`。最多展示三个候选，主要按仓库 Stars 降序排列，并明确标注为“仓库 Stars”，不生成自定义 Skill 评分。候选只用于审阅；系统不会自动安装、更新或执行第三方 Skill。

## 隐私边界

- 完整任务文本不会自动发送给 GitHub；外部请求只包含界面预览过的受控能力关键词。
- 运行时目录、验证记录、历史缓存、生成目录、环境文件、令牌与 Cookie 均不进入此仓库。
- 运行时状态默认位于 `$CODEX_HOME/state/skill-observatory/`；未设置 `CODEX_HOME` 时位于 `~/.codex/state/skill-observatory/`。
- 可通过绝对路径 `SKILL_OBSERVATORY_DATA_DIR` 覆盖状态目录。
- GitHub 令牌如需使用，只能由用户显式提供给服务进程；不得写入 Skill、缓存或仓库。

这是私有首版仓库，不包含开源许可证，也不发布 Release 或 Skill 市场条目。
