# Hermes Timber

Manage Timber worktrees from a native Hermes Desktop panel.
Each repository maps to one Hermes Project, with Timber's worktree base folder and any out-of-base checkouts associated as Project folders.

## Develop

Install `mise`, Git, and [Timber](https://github.com/nnutter/timber) first.
Then run:

```sh
mise trust
mise install
mise run setup
mise run fix
mise run build
mise run check
mise run test
mise run doctor
mise run smoke
```

`mise.toml` pins Python, Node, and the development tools.
`hk.pkl` is the single place that names the formatters, linters, and file patterns.
`mise run fix` and `mise run check` delegate to `hk`; `mise run lint` and `mise run fmt` alias those commands.
`uv` manages Python and the development dependencies.
Invoke is the task entrypoint for builds, packaging, and Hermes runtime checks.
The npm scripts are implementation details used by Invoke and hk.
The git hooks check and fix the staged files, and the `commit-msg` hook adds or preserves the Change-Id used by Timber review.

`mise run doctor` validates the plugin with Hermes's real Plugin Doctor.
`mise run smoke` exercises registration and the dashboard routes through the selected Hermes environment's Python with a temporary `HERMES_HOME`.

The TypeScript configuration enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and unused-code checks.
The build bundles `ui/plugin.tsx` into `desktop/plugin.js` and leaves the three Hermes-supported imports external.
The generated JavaScript is committed because the Hermes plugin loader does not compile TypeScript.
The backend tests require a Hermes checkout at `~/.hermes/hermes-agent`, or a path supplied through `HERMES_SOURCE`.
They use real Timber and Git with isolated homes and local origins.
Set `HERMES_PYTHON` to override the interpreter that `mise run smoke` uses.

## Sync the Desktop UI from frame

Run `scripts/sync-desktop` on the Mac, not on the gateway.
It requires Bash 3.2 or newer and a working SSH login to `frame`.
Verify that `ssh frame hostname` reports `frame` before the first sync.
The script uses batch-mode SSH and never bypasses host-key verification or prompts for credentials.

Install the script once on the Mac:

```sh
mkdir -p ~/.local/bin
scp frame:/home/nnutter/src/github.com/nnutter/hermes-timber/scripts/sync-desktop ~/.local/bin/sync-hermes-timber
chmod +x ~/.local/bin/sync-hermes-timber
```

After changes on frame, run:

```sh
~/.local/bin/sync-hermes-timber
```

The script checks TypeScript and builds on frame, then atomically replaces the Mac's `~/.hermes/desktop-plugins/hermes-timber/plugin.js`.
Build messages stay separate from the transferred artifact.
An unchanged artifact does not touch the installed file.
Failed builds, failed transfers, and empty downloads leave the installed plugin intact.
The script refuses to replace a development symlink.
Hermes watches the file and should hot-reload it automatically.
If the running Desktop build does not react, use **Reload desktop plugins** from its command palette.
The script does not change the backend, enable settings, or authentication state.

Configuration uses environment variables:

- `TIMBER_SYNC_HOST` selects the SSH destination, default `frame`.
- `TIMBER_SYNC_REPO` selects the absolute source checkout path on frame.
- `TIMBER_DESKTOP_PLUGIN_DIR` selects the absolute plugin directory on the Mac if Desktop uses a different local root.
- `TIMBER_SYNC_BUILD=0` copies the existing compiled artifact without a type check or build.

## Install on the correct machines

Build the plugin before installation.
The gateway needs Git and Timber on its service `PATH`.
The backend uses FastAPI and Pydantic supplied by Hermes, with no additional runtime dependencies.

For a local development installation, link this checkout into the active Hermes home's `plugins/hermes-timber` directory.
Do not replace an existing installation.
Enable the backend with `hermes plugins enable hermes-timber` on that host and profile.
Enable the Desktop component in **Capabilities > Plugins**.
Use **Rescan** if the package does not appear.

For a remote gateway, install the backend on the gateway and the Desktop component on the computer running Hermes Desktop.
A link on the gateway does not install UI files on a remote Desktop computer.
The panel sends Timber operations through `ctx.rest`, so paths belong to the connected gateway.

To create a runtime-only archive, run:

```sh
uv run invoke package
```

The archive is `dist/hermes-timber.zip`.
It excludes Node modules, the Python environment, development tools, and tests.

## Use the worktrees page and panel

The plugin adds two sidebar pages, **Timber** (`/timber`) and **Timber TODOs** (`/timber-todos`), and matching right-hand panes.
The page uses the full window on narrow screens; the panes become overlays there.
Both surfaces share the same state and refresh loop.

The worktrees toolbar has a split **New worktree** button, a search field, a sort control, a **Repositories** menu, and a refresh button.
Creating a worktree opens its session.
A row links its repository and open pull request, and shows its TODO and review counts, ahead/behind counts, and exactly one action button chosen from the row's state:

- **Delete** for a clean worktree that is merged or fully in sync, with no open stack PRs.
- **Push** when the branch has unpushed commits over `origin/<branch>` and a fast-forward path.
- **Merge** when the open PR can merge; otherwise the same button opens the PR and says why it cannot.
- **Create PR** when the branch has no open PR.
  Leave the subject empty to derive one from the commits ahead of the upstream.
- **Blocked** when `origin/<branch>` has commits the worktree lacks.

A worktree whose PR belongs to a GitHub stack lists the stack under the row.
Each open PR in the stack has its own merge button; merging a lower PR merges the stack up to it, and the top PR merges the whole stack.
Merging runs `gh pr merge` with the head commit pinned, or `gh stack merge` for a stack.
Pushing runs `git push origin HEAD:<branch>` without changing the upstream or forcing.
Clicking a row's ↓ count rebases the worktree onto its upstream (`git rebase @{u}`).
It is available only for a clean worktree; a conflict aborts the rebase and reports the conflict, leaving the worktree unchanged.
Refresh runs `timber git @repo -- fetch` for every repository with worktrees; the gateway also fetches every five minutes.

The **Timber TODOs** page shows one worktree's `TODO.md`, or the repository's shared `TODO.repo.md`.
It follows the session's folder, with a picker for another worktree and a Worktree/Repository toggle.
A task is added in one field, ticked to done, or removed with two taps.

Use **Import repo** in the toolbar's menu to register a gateway-local path or remote URL; credentials in URLs are rejected.
Adding a repository also syncs Projects.
If sync fails, the repository remains registered.
The **Repositories** menu renames a repository (moving its worktree folders) and removes one only when it has no worktrees.
Create worktrees from a registered repository; leave the branch name empty to let Timber choose a name.
The plugin uses `--no-herdr` and does not enable mise trust or repository hooks.
Existing Timber configuration can still run repository setup during creation.

Run **Sync Projects** from the command palette to reconcile existing worktrees with Hermes Projects, even when the panel is closed.
Listing worktrees does not create or modify Projects.
Sync associates `$TIMBER_WORKTREE_ROOT/<repo-name>` (default `~/worktrees/<repo-name>`) so sessions in Timber-managed checkouts inherit the repository Project.
Checkouts outside that base folder are associated individually.
The plugin records the folder associations it creates and preserves associations that it does not own.
Empty repository Projects remain available after cleanup.

Successful reads poll every 15 seconds.
Read failures back off to 30, 60, 120, 240, and then 300 seconds, with the delay reset after success.
HTTP 401 or 403 and recognized sign-in failures pause automatic requests instead of retrying.
Sign in through Hermes Connections, then select **Refresh** to resume reads.
A WebSocket reconnect alone does not clear this pause because REST and WebSocket authentication can differ.
Mutations never retry automatically, including after sign-in.

The open button reuses the newest session already in the worktree's folder and creates one only when the folder has none.
Removal archives the sessions that worked in that folder after the checkout is gone.

Cleanup removes both the worktree directory and its branch.
The plugin permits cleanup only for clean worktrees that are merged or fully in sync (0 ahead, 0 behind), with a known status and no open PRs in the worktree's stack.
Ignored files also block cleanup, even when Timber reports the worktree as clean.
Sync preserves an existing checkout's folder when Timber omits the checkout, including detached worktrees.
A confirmation applies to the exact previewed worktree state and expires.
The backend checks the state again before removal and never uses `--force`.
Do not use cleanup as a backup for local notes or commits.

## Repository HTTP contract

`POST /repositories` accepts `{"source": "URL or path", "name": "", "alias": ""}`; name and alias are optional.
It returns `{"repository": "registered name", "warnings": []}` only after a clean command and listing confirm one new repository.
On failure or an uncertain outcome it returns an error; refresh and inspect Timber before retrying.
No repository is removed automatically.

The remaining routes are `GET /state`, `POST /fetch`, `/create`, `/repo-rename`, `/repo-remove`, `/pr`, `/push`, `/rebase`, `/merge`, `/remove/preview`, `/remove`, `/todo`, `/todo-add`, `/todo-toggle`, `/todo-remove`, `GET /sessions`, and `POST /sessions/archive`.
The UI parses every response defensively; the backend re-reads the listing before a mutation and refuses diagnostics rather than acting on an uncertain listing.

## Explore the code

- `ui/plugin.tsx` is the Desktop entrypoint; it registers both pages, sidebar links, panes, commands, and the shortcut.
- `ui/worktrees.tsx` owns the worktree toolbar, rows, repository forms, PR form, and removal consent.
- `ui/todos.tsx` owns the TODO page and pane.
- `ui/actions.ts` chooses each row's single action, its color, and the search/sort behavior.
- `dashboard/plugin_api.py` owns the backend routes, Timber operations, PR cache, TODOs, sessions, and Project reconciliation.
- `typings/` describes the Hermes Python APIs consumed by the backend.
- `tests/` protects the backend contracts and Desktop user actions.
- `mise.toml` and `hk.pkl` own the development environment and file checks.
- `tasks.py` owns the development, packaging, and Hermes runtime commands.
- `scripts/smoke.py` exercises the installed plugin contracts through Hermes's Python.

Hermes owns the Projects database schema.
The plugin uses Hermes' Project functions instead of editing that schema directly.
Plugin ownership state belongs under the active profile's `plugin-data/hermes-timber/`, separate from the installation directory.

## Compatibility and verification

The backend targets POSIX gateways because its mutation lock uses `fcntl.flock`.
Windows gateways are not supported.
The UI uses a narrow local declaration of the Hermes Desktop SDK contracts it consumes.
The backend uses `hermes_cli.projects_db`, which is an internal Hermes API rather than a versioned plugin API.
Hermes' catalog validator warns about that import, so verify compatibility after Hermes updates.

The initial checks include Python lint and `ty`, strict TypeScript, backend integration tests, and React component tests.
A runtime-only package also passed Hermes Plugin Doctor and a create, sync, preview, and remove smoke test in the installed Hermes interpreter.
Those checks do not verify rendering or chat navigation inside a running Desktop app.
No live plugin installation or Project migration is part of those tests.

## References

- [Hermes Desktop plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
- [Build a Hermes plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins)
- [omarchy-timber](https://github.com/nnutter/omarchy-timber), the reference for list behavior and status badges
