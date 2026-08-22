# Skill Observatory operations

Run commands from the installed `skill-observatory` directory, or define its absolute path without committing that path anywhere:

```zsh
SKILL_ROOT="/absolute/path/to/skill-observatory"
```

## Setup

Require Node.js 22.13.0 or newer and npm. The setup script never installs either tool or any system package.

Preview without filesystem changes or network access, then install only after approval:

```zsh
node "$SKILL_ROOT/scripts/setup.mjs" --dry-run
node "$SKILL_ROOT/scripts/setup.mjs"
```

If `npm ci` fails, resolve the displayed npm or network error and rerun setup. A failed dependency install is never recorded as success.

## Migrate existing state

Pass an absolute legacy state directory:

```zsh
OBSERVATORY_LEGACY_STATE="/absolute/path/to/old/state"
node "$SKILL_ROOT/scripts/setup.mjs" --migrate-from "$OBSERVATORY_LEGACY_STATE"
```

Migration copies only `catalog.json`, `history-cache.json`, and `skill-validations.json`. Existing destination files are preserved and the source directory is never deleted or changed.

If the previous local checkout also has private matching overrides, migrate that file explicitly:

```zsh
OBSERVATORY_LEGACY_OVERRIDES="/absolute/path/to/old/data/skill-overrides.json"
node "$SKILL_ROOT/scripts/setup.mjs" \
  --migrate-from "$OBSERVATORY_LEGACY_STATE" \
  --migrate-overrides-from "$OBSERVATORY_LEGACY_OVERRIDES"
```

The override file is copied to private runtime state as `skill-overrides.json` with mode `0600`. It is never added to the published Skill tree, and an existing destination file is preserved.
The two migration flags are independent. Always pass the override file separately when the earlier installation contains private aliases or intent tags; migrating only the catalog does not preserve those matching rules.

Runtime state defaults to `$CODEX_HOME/state/skill-observatory/`, or `~/.codex/state/skill-observatory/` when `CODEX_HOME` is unset. Set `SKILL_OBSERVATORY_DATA_DIR` only to an absolute directory. The runtime directory must have mode `0700`; state JSON files use mode `0600`.

## Start and synchronize

Start the dashboard, or refresh the catalog without opening it:

```zsh
node "$SKILL_ROOT/scripts/start.mjs"
node "$SKILL_ROOT/scripts/sync.mjs"
node "$SKILL_ROOT/scripts/sync.mjs" --full
```

The service listens only on `127.0.0.1`. The dashboard normally opens at `http://localhost:3000/` and the API uses `http://127.0.0.1:4318/`.

## Verify

Run lint and tests; add live checks only while the dashboard is already running:

```zsh
node "$SKILL_ROOT/scripts/verify.mjs"
node "$SKILL_ROOT/scripts/verify.mjs" --live
```

Use `--dashboard-url "http://localhost:3000/"` only with `--live`. Only loopback HTTP URLs are accepted.

## Install a macOS launcher

Choose an absolute destination directory:

```zsh
OBSERVATORY_LAUNCHER_DIR="/absolute/destination/directory"
node "$SKILL_ROOT/scripts/install-launcher.mjs" --target "$OBSERVATORY_LAUNCHER_DIR"
```

The generated `技能看台.command` checks both the local API and UI. It opens an already healthy dashboard; otherwise it runs this installed Skill's `scripts/start.mjs`. Existing files are preserved by default. Replace only after explicit approval:

```zsh
node "$SKILL_ROOT/scripts/install-launcher.mjs" --target "$OBSERVATORY_LAUNCHER_DIR" --replace
```

## GitHub authentication

GitHub discovery requires an explicitly supplied token. The Skill will not start GitHub CLI or browser login and will not fall back to anonymous search. Read the token without echoing it, export it only in the current shell, start the server process, then remove the shell variable:

```zsh
read -rs "GITHUB_TOKEN?GitHub token: "
export GITHUB_TOKEN
node "$SKILL_ROOT/scripts/start.mjs"
unset GITHUB_TOKEN
```

不会启动 GitHub CLI 或浏览器登录。`GITHUB_TOKEN` 只存在于服务端进程内存，不会写入浏览器代码、缓存、状态或仓库。不要把它放进 Skill 目录。没有有效 GitHub Token 时保持本机模式，也不会匿名回退；原文外发仍需逐次确认。

## Three-level local matching and two-stage GitHub discovery

本地匹配始终先运行，并采用受保护的语义强匹配：精确 Skill 名称或精确别名可直接成为强匹配；其他候选只有同时满足受控意图、独立能力证据、分数阈值和领先门槛才能成为强匹配，不能只凭总分升级。本地强匹配时只显示最多三个本机 Skill，并且不会访问 GitHub。本地只有弱相关结果时，这些 Skill 会标记为“可能相关”，同时自动发送界面展示的受控脱敏能力词搜索 GitHub；本地没有相关结果时进入同一脱敏搜索。自动请求只包含界面所示的白名单能力词，不包含未识别的名称、项目名或自由文本。

仓库搜索先运行；经过严格文件验证后仍不足三个相关候选时，随后最多执行一次 SKILL.md 文件检索回退。两个阶段共用同一组脱敏能力词和严格的 `SKILL.md` 结构、路径、内容与去重验证。候选先通过相关性验证，再按仓库 Stars 从高到低排序，最多返回三个，界面最多三个；不足三个时不使用无关结果补齐。仓库 Stars 只代表关注度，不代表安全、质量、兼容性或可用性，也不是 Skill 评分。

完整零结果只表示这次受限查询没有找到通过验证的候选，不能证明 GitHub 上不存在相关 Skill。只有完整的脱敏搜索结果会缓存 24 小时；不完整结果、错误、原文搜索、许可与任务文本都不会缓存。

状态栏明确区分 `missing-token`（缺少 Token）、`invalid-token`（Token 无效）、`rate-limited`（限流）与 `github-unavailable`（GitHub 暂不可用）。仓库搜索与 SKILL.md 文件检索的剩余量和重置时间分别显示。仓库搜索额度耗尽时进入 rate-limited 并保持本机模式；只有 SKILL.md 文件检索额度耗尽时仍可使用仓库搜索，GitHub 状态保持 ready，只跳过文件检索回退。没有有效 GitHub Token 时保持本机模式；修正 Token 后重新启动。遇到限流时等待界面显示的重置时间，暂时不可用时由用户稍后再试。系统不会自动重试，也不要循环重试。

脱敏搜索完整零结果，或无法形成安全能力词时，界面才会完整展示原始任务。只有用户点击 `确认发送原文到 GitHub` 后，当前展示的全文才会发送；许可短时有效、绑定当前任务且只能使用一次。原文不写入搜索缓存或日志。限流、超时、网络失败或验证不完整不会被当成零结果，也不会发放原文许可。

取消、编辑任务或重新匹配会调用本机 `POST /api/github-suggestions/revoke`，请求体只含一次性许可。控制器在 204 返回前保持“正在撤销授权”并阻止原文确认和新搜索；失败后保留许可用于再次撤销，但不再开放原文确认。输入框编辑不等待网络。页面卸载只发起一次 `keepalive` 尽力撤销并清空浏览器内存状态，许可的短时过期是最终兜底。

复制测试记录只包含固定安全诊断字段，不包含原始任务、GitHub Token、一次性许可、私有路径、Skill 内容、错误正文或堆栈；复制只写入本机剪贴板，不会发送记录。系统不会自动安装、更新、删除或执行候选；任何后续操作都需要单独审阅和批准。

失败恢复按阶段区分：脱敏搜索失败可直接重试，不需要原文许可；用户可重新执行脱敏搜索，但系统不会自动或循环重试。原文搜索失败后一次性许可已经消耗，不能复用原按钮或请求。必须重新提交并匹配任务，重新经过本地与脱敏阶段，取得新的逐次许可后才能再次发送原文。

## Troubleshooting

- `node-22.13.0-required`: install or select Node.js 22.13.0 or newer yourself, then rerun setup.
- `npm-required`: make npm available on `PATH`; the Skill does not install it.
- `npm-ci-failed`: inspect npm output, restore network or registry access, and retry. Do not treat the partial setup as complete.
- `setup-required`: run the setup dry-run, approve its actions, and complete setup.
- `private-runtime-directory-required`: use a private directory with exact mode `0700`; do not weaken permissions.
- `private-skill-overrides-invalid`: repair or restore the private override JSON as a regular `0600` file. Sync fails closed instead of ignoring malformed rules.
- `override-migration-source-file-required` or `override-migration-json-object-required`: select a regular, non-linked JSON override file with the documented object structure.
- `override-migration-destination-file-required` or `override-migration-destination-json-object-required`: inspect the existing private-state destination; setup will not trust a symlink, special file, unsafe mode, or malformed JSON.
- `skill-radar-conflict`: the existing installed `skill-radar` differs from the bundled template. Preserve it and inspect the difference before choosing any manual replacement.
- `launcher-exists`: preserve the current launcher or rerun with `--replace` only after approval.
- Dashboard port conflict: check whether both `http://127.0.0.1:4318/api/catalog` and `http://localhost:3000/` are healthy. If not, report the conflict; never terminate an unknown process.
- GitHub request limited: 等待界面显示的重置时间；不要循环重试。若 Token 缺少或无效，修正 Token 后重新启动。
- `github-query-rejected`: GitHub 不接受当前查询。脱敏阶段请修改任务后重新执行；原文阶段则表示完整原文未被接受，系统没有截断或改写它。重新完成本地与脱敏阶段。
- `raw-consent-required` / 一次性许可已过期或已使用：重新提交任务；旧许可不能复用，也不能直接重试原文接口。
- GitHub unavailable or incomplete: retain the local no-match result. 脱敏阶段可使用“重试脱敏搜索”；原文阶段没有可复用的许可，必须重新提交任务并完成匹配。Local catalog, verification, and matching continue to work.
