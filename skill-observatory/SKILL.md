---
name: skill-observatory
description: Discover, verify, classify, visualize, and recommend locally installed Codex Skills. Use when the user asks to inventory installed Skills, check readiness, find a Skill for a task, open or synchronize the private Skill dashboard, or search GitHub for validated Skill candidates when local matching is weak or finds none; strong local matches stay local.
---

# Skill Observatory

Manage the private local Skill catalog through deterministic bundled scripts. Resolve every script from this Skill directory; never assume the current working directory or a source-repository path.

## Choose the operation

1. Run setup before the first start or after installing a new release:
   - Run `node scripts/setup.mjs --dry-run` first.
   - Explain the reported filesystem and dependency actions.
   - Obtain explicit approval before running `node scripts/setup.mjs` because it writes private state, runs `npm ci`, and installs the bundled `skill-radar`.
   - Add `--migrate-from "/absolute/legacy/state"` only when the user asks to preserve an earlier catalog. Private matching rules are separate: when present, also add `--migrate-overrides-from "/absolute/legacy/data/skill-overrides.json"`. Keep both sources unchanged.
2. Run `node scripts/start.mjs` to synchronize, start the loopback-only API and dashboard, and open the page.
3. Run `node scripts/sync.mjs` to refresh the catalog without opening the dashboard. Forward `--full` only when a full history rebuild is needed.
4. Run `node scripts/verify.mjs` for static and test verification. Add `--live` only when the dashboard is already running and the user wants live API/UI checks.
5. Run `node scripts/install-launcher.mjs --target "/absolute/directory"` only after the user explicitly requests a macOS launcher. Do not overwrite an existing launcher unless the user approves `--replace`.

## Match and discover Skills

Prefer the synchronized local matcher. Preserve status labels such as `可用`, `需配置`, `异常`, and `待检查` when reporting results.

本地匹配始终先运行，并采用受保护的语义强匹配：精确 Skill 名称或精确别名可直接成为强匹配；其他候选只有同时满足受控意图、独立能力证据、分数阈值和领先门槛才能成为强匹配，不能只凭总分升级。本地强匹配时只显示最多三个本机 Skill，并且不会访问 GitHub。本地只有弱相关结果时，这些 Skill 会标记为“可能相关”，同时自动发送界面展示的受控脱敏能力词搜索 GitHub；本地没有相关结果时进入同一脱敏搜索。自动请求不会把未识别的名称、项目名或自由文本混入这一阶段。

仓库搜索先运行；经过严格文件验证后仍不足三个相关候选时，随后最多执行一次 SKILL.md 文件检索回退。两个阶段共用同一组脱敏能力词和严格的 `SKILL.md` 结构、路径、内容与去重验证。候选先通过相关性验证，再按仓库 Stars 从高到低排序，最多返回三个，界面最多三个；不足三个时不使用无关结果补齐。仓库 Stars 只代表关注度，不代表安全、质量、兼容性或可用性，也不是 Skill 评分。

完整零结果只表示这次受限查询没有找到通过验证的候选，不能证明 GitHub 上不存在相关 Skill。只有完整的脱敏搜索结果会缓存 24 小时；不完整结果、错误、原文搜索、许可与任务文本都不会缓存。

`GITHUB_TOKEN` 只存在于服务端进程内存，不写入浏览器、缓存、状态或仓库，也不会匿名回退。没有有效 GitHub Token 时保持本机模式，并区分 `missing-token`、`invalid-token`、`rate-limited` 与 `github-unavailable`；仓库搜索与 SKILL.md 文件检索的剩余量和重置时间分别显示。仓库搜索额度耗尽时进入 rate-limited 并保持本机模式；只有 SKILL.md 文件检索额度耗尽时仍可使用仓库搜索，GitHub 状态保持 ready，只跳过文件检索回退。限流时等待界面显示的重置时间；Token 修正后重新启动，暂时不可用时可由用户稍后重试。系统不会自动重试，也不要循环重试。

脱敏搜索完整零结果，或无法形成安全能力词时，界面会完整展示原始任务。只有用户逐次点击 `确认发送原文到 GitHub` 后，原文才会外发；原文不写入搜索缓存或日志。限流、超时、网络失败或验证不完整不会被当成零结果，只允许有界的用户重试，不会发放原文许可。

取消、编辑或重新匹配会先撤销旧的一次性许可。控制器等待本机撤销接口返回 204 后，才报告取消完成并允许新搜索；撤销失败时禁止原文确认并提供重试。页面卸载只做一次 `keepalive` 尽力撤销，短时过期机制作为最终兜底。

复制测试记录只包含固定安全诊断字段，不包含原始任务、GitHub Token、一次性许可、私有路径、Skill 内容、错误正文或堆栈；复制只写入本机剪贴板，不会发送记录。系统不会自动安装、更新、删除或执行候选；任何后续操作都需要单独审阅和批准。

## Safety boundaries

- Keep runtime state under `$CODEX_HOME/state/skill-observatory/`, or `~/.codex/state/skill-observatory/` when `CODEX_HOME` is unset. Accept only an absolute `SKILL_OBSERVATORY_DATA_DIR` override.
- Keep the service on `127.0.0.1`; do not expose it to the LAN or deploy it publicly.
- Never install Node.js, npm, Homebrew, GitHub CLI, or other system packages.
- Never read browser Cookies or persist `GITHUB_TOKEN`. Use an explicitly supplied token only in server-process memory, never fall back to anonymous GitHub search, and never bypass per-task confirmation before sending original text. Follow the shell-only token flow in `references/operations.md`.
- Preserve existing state and a customized `skill-radar` when a conflict is reported.
- Treat malformed, non-private, linked, or special-file private overrides as a blocking setup/sync error; never silently discard them.

Read [references/operations.md](references/operations.md) for exact commands, migration details, launcher behavior, and troubleshooting.
