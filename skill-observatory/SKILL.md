---
name: skill-observatory
description: Discover, verify, classify, visualize, and recommend locally installed Codex Skills. Use when the user asks to inventory installed Skills, check readiness, find a Skill for a task, open or synchronize the private Skill dashboard, or—after local matching fails—search GitHub for validated Skill candidates.
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

本地匹配始终先运行。有本地结果时不访问 GitHub；本地零结果后，系统自动发送界面展示的受控脱敏能力词，且不会把未识别的名称、项目名或自由文本混入这一阶段的请求。

脱敏搜索完整零结果，或无法形成安全能力词时，界面会完整展示原始任务。只有用户逐次点击 `确认发送原文到 GitHub` 后，原文才会外发；原文不写入搜索缓存或日志。限流、超时、网络失败或验证不完整只允许重试脱敏搜索，不会发放原文许可。

GitHub 搜索不承诺一定找到匹配项。系统返回最多三个经过结构验证的候选，主要按仓库 Stars 排序；Stars 是仓库关注度，不是 Skill 评分、安全认证或可用性保证。建议不会自动安装、更新或执行；任何后续安装仍需单独审阅和批准。

## Safety boundaries

- Keep runtime state under `$CODEX_HOME/state/skill-observatory/`, or `~/.codex/state/skill-observatory/` when `CODEX_HOME` is unset. Accept only an absolute `SKILL_OBSERVATORY_DATA_DIR` override.
- Keep the service on `127.0.0.1`; do not expose it to the LAN or deploy it publicly.
- Never install Node.js, npm, Homebrew, GitHub CLI, or other system packages.
- Never read browser Cookies or persist `GITHUB_TOKEN`. Use an explicitly supplied token only from the server process environment. A token can raise API limits but never bypasses per-task confirmation before sending original text.
- Preserve existing state and a customized `skill-radar` when a conflict is reported.
- Treat malformed, non-private, linked, or special-file private overrides as a blocking setup/sync error; never silently discard them.

Read [references/operations.md](references/operations.md) for exact commands, migration details, launcher behavior, and troubleshooting.
