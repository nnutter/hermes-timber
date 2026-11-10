# TODO

## Plugin architecture

The dashboard backend router is the right extension point for this plugin.
The panel needs host-side `timber`, `git`, and `gh` work on the gateway, including when Desktop runs on another machine, and the renderer must not run shells or hold repository credentials.
The Kanban plugin uses the same
`ROUTES_AREA` / `SIDEBAR_NAV_AREA` / pane + `dashboard/plugin_api.py` shape.

Keep the server-side checks authoritative: validate selectors, re-read the listing before destructive operations, keep the removal preview token, and verify stack state before a merge or removal.
The UI is not a trust boundary.

## Follow-ups

- [ ] Replace the direct `$HERMES_HOME/state.db` queries in
  `dashboard/plugin_api.py` with a supported Hermes session API.
  The current SQL reads `sessions.cwd`, `sessions.last_activity_at`, and `sessions.archived`, which is an internal schema; `projects_db` already has the same compatibility risk.
- [ ] Move the PR/stack/push logic into `timber` itself
  (`timber status --json`, PR view/push/merge, TODO edit verbs) so pi-pocket-timber and hermes-timber consume one contract instead of carrying two copies of the same GitHub logic.
- [ ] Replace the daemon-thread PR cache with an asyncio refresh task owned
  by the plugin lifetime.
  The current stale-while-revalidate cache mirrors
  Pi Pocket and is correct, but a single task is easier to observe and cancel.
- [ ] Re-check the `hermes_cli.projects_db` dependency whenever Hermes
  updates; it is an intentional internal API, not a versioned plugin API.
