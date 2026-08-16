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

## Optional GitHub authentication

Public GitHub search works without GitHub CLI. To increase API limits, export `GITHUB_TOKEN` in the current shell without saving it in this Skill, then start the server process:

```zsh
read -rs "GITHUB_TOKEN?GitHub token: "
export GITHUB_TOKEN
node "$SKILL_ROOT/scripts/start.mjs"
unset GITHUB_TOKEN
```

`GITHUB_TOKEN` 只存在于服务端进程环境，不会写入浏览器代码、缓存、状态或仓库。不要把它放进 Skill 目录。它可以提高 GitHub API 限额，但原文外发仍需逐次确认。

## Two-stage GitHub discovery

本地匹配始终先运行。有本地结果时不访问 GitHub；本地零结果后，系统自动发送界面展示的受控脱敏能力词。自动请求只包含界面所示的白名单能力词，不包含未识别的名称、项目名或自由文本。

脱敏搜索完整零结果，或无法形成安全能力词时，界面才会完整展示原始任务。只有用户点击 `确认发送原文到 GitHub` 后，当前展示的全文才会发送；许可短时有效、绑定当前任务且只能使用一次。原文不写入搜索缓存或日志，原文结果也不进入 24 小时建议缓存。

取消、编辑任务或重新匹配会调用本机 `POST /api/github-suggestions/revoke`，请求体只含一次性许可。控制器在 204 返回前保持“正在撤销授权”并阻止原文确认和新搜索；失败后保留许可用于再次撤销，但不再开放原文确认。输入框编辑不等待网络。页面卸载只发起一次 `keepalive` 尽力撤销并清空浏览器内存状态，许可的短时过期是最终兜底。

限流、超时、网络失败或验证不完整不会被当成零结果，也不会发放原文许可；保留界面所示脱敏词并重新执行脱敏搜索。GitHub 搜索不承诺一定找到结果。两级搜索都只返回最多三个经过结构验证的候选，主要按仓库 Stars 排序；建议不会自动安装、更新或执行。

失败恢复按阶段区分：脱敏搜索失败可直接重试，不需要原文许可；原文搜索失败后一次性许可已经消耗，不能复用原按钮或请求。必须重新提交并匹配任务，重新经过本地与脱敏阶段，取得新的逐次许可后才能再次发送原文。

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
- GitHub request limited: wait until the reported reset time or restart with an explicitly supplied `GITHUB_TOKEN`. Do not retry in a loop.
- `github-query-rejected`: GitHub 不接受当前查询。脱敏阶段请修改任务后重新执行；原文阶段则表示完整原文未被接受，系统没有截断或改写它。重新完成本地与脱敏阶段。
- `raw-consent-required` / 一次性许可已过期或已使用：重新提交任务；旧许可不能复用，也不能直接重试原文接口。
- GitHub unavailable or incomplete: retain the local no-match result. 脱敏阶段可使用“重试脱敏搜索”；原文阶段没有可复用的许可，必须重新提交任务并完成匹配。Local catalog, verification, and matching continue to work.
