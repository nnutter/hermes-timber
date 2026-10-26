# Hermes Timber

Manage Timber worktrees from a native Hermes Desktop panel.
Each repository maps to one Hermes Project, with its worktrees as Project folders.

## Develop

Install `mise`, `uv`, Git, and [Timber](https://github.com/nnutter/timber) first.
Then run:

```sh
mise trust
mise install
uv python install
uv sync --locked
mise exec -- npm ci
uv run invoke fix
uv run invoke build
uv run invoke check
uv run invoke test
```

`mise.toml` pins Node.
`uv` manages Python and the development dependencies.
Invoke is the task entrypoint.
The npm scripts are implementation details used by Invoke.

The TypeScript configuration enables `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and unused-code checks.
The build bundles `ui/plugin.tsx` into `desktop/plugin.js` and leaves the three Hermes-supported imports external.
The generated JavaScript is committed because the Hermes plugin loader does not compile TypeScript.
The backend tests require a Hermes checkout at `~/.hermes/hermes-agent`, or a path supplied through `HERMES_SOURCE`.
They use real Timber and Git with isolated homes and local origins.

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

## Use the panel

Create worktrees from a registered repository.
Leave the branch name empty to let Timber choose a name.
The plugin uses `--no-herdr` and does not enable mise trust or repository hooks.
Existing Timber configuration can still run repository setup during creation.

Use **Sync Projects** to reconcile existing worktrees with Hermes Projects.
Listing worktrees does not create or modify Projects.
The plugin records the folder associations it creates and preserves associations that it does not own.
Empty repository Projects remain available after cleanup.

Cleanup removes both the worktree directory and its branch.
The plugin permits cleanup only for clean, merged worktrees with a known status.
Ignored files also block cleanup, even when Timber reports the worktree as clean.
Sync preserves an existing checkout's folder when Timber omits the checkout, including detached worktrees.
A confirmation applies to the exact previewed worktree state and expires.
The backend checks the state again before removal and never uses `--force`.
Do not use cleanup as a backup for local notes or commits.

## Explore the code

- `ui/plugin.tsx` is the Desktop entrypoint.
- `dashboard/plugin_api.py` owns the backend routes, Timber operations, and Project reconciliation.
- `typings/` describes the Hermes Python APIs consumed by the backend.
- `tests/` protects the backend contracts and Desktop user actions.
- `tasks.py` owns the development and packaging commands.

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
