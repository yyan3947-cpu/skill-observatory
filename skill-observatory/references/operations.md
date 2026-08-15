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

The token is not written to browser code, cache files, state, or the repository. Do not place it in this Skill folder.

GitHub search occurs only after local matching returns no result and the user clicks the GitHub search action. The previewed capability keywords are sent; the full task text is not. Suggestions are never auto-installed or executed.

## Troubleshooting

- `node-22.13.0-required`: install or select Node.js 22.13.0 or newer yourself, then rerun setup.
- `npm-required`: make npm available on `PATH`; the Skill does not install it.
- `npm-ci-failed`: inspect npm output, restore network or registry access, and retry. Do not treat the partial setup as complete.
- `setup-required`: run the setup dry-run, approve its actions, and complete setup.
- `private-runtime-directory-required`: use a private directory with exact mode `0700`; do not weaken permissions.
- `skill-radar-conflict`: the existing installed `skill-radar` differs from the bundled template. Preserve it and inspect the difference before choosing any manual replacement.
- `launcher-exists`: preserve the current launcher or rerun with `--replace` only after approval.
- Dashboard port conflict: check whether both `http://127.0.0.1:4318/api/catalog` and `http://localhost:3000/` are healthy. If not, report the conflict; never terminate an unknown process.
- GitHub request limited: wait until the reported reset time or restart with an explicitly supplied `GITHUB_TOKEN`. Do not retry in a loop.
- GitHub unavailable or incomplete: retain the local no-match result and retry later. Local catalog, verification, and matching continue to work.
