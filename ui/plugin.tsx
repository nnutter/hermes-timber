import {
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
} from "@hermes/plugin-sdk";
import type {
  HermesPlugin,
  KeybindContribution,
  PaletteContribution,
  RouteContribution,
  SidebarNavContribution,
} from "@hermes/plugin-sdk";
import { message, responseWarnings } from "./contracts";
import { TimberPage, TimberTodosPage } from "./page";
import { TimberPanel, TimberTodosPanel } from "./panel";
import { assertScope, scopeKey } from "./scope";

const plugin: HermesPlugin = {
  id: "hermes-timber",
  name: "Timber",
  description:
    "Manage Timber worktrees, repositories, TODOs, and pull requests in Hermes.",
  register(context) {
    let syncing = false;
    const sync: PaletteContribution = {
      id: "sync-projects",
      label: "Timber: Sync Projects",
      keywords: ["timber", "worktree", "repository", "project"],
      run: () => {
        if (syncing) return;
        const scope = scopeKey();
        try {
          assertScope(scope);
        } catch (error) {
          host.notify({ kind: "error", message: message(error) });
          return;
        }
        syncing = true;
        void (async () => {
          try {
            const result = await context.rest<unknown>("/sync", {
              method: "POST",
              body: {},
            });
            assertScope(scope);
            const warnings = responseWarnings(result);
            await queryClient.invalidateQueries({
              queryKey: ["hermes-timber", scope, "state"],
              exact: true,
            });
            assertScope(scope);
            host.notify({
              kind: warnings.length ? "warning" : "success",
              message: warnings.length
                ? warnings.join("\n")
                : "Projects synced.",
            });
          } catch (error) {
            if (scopeKey() === scope && host.state.gateway.get() === "open")
              host.notify({
                kind: "error",
                message: `Project sync failed: ${message(error)}`,
              });
          } finally {
            syncing = false;
          }
        })();
      },
    };
    const showWorktrees: PaletteContribution = {
      id: "show-timber",
      label: "Timber: Show worktrees",
      keywords: ["worktree", "repository", "branch", "project"],
      run: () => host.navigate("/timber"),
    };
    const showTodos: PaletteContribution = {
      id: "show-timber-todos",
      label: "Timber: Show TODOs",
      keywords: ["todo", "task", "checklist", "timber"],
      run: () => host.navigate("/timber-todos"),
    };
    const shortcut: KeybindContribution = {
      id: "hermes-timber.show",
      label: "Show Timber worktrees",
      category: "view",
      defaults: [],
      run: () => host.revealPane("hermes-timber:panel"),
    };
    context.registerMany([
      {
        id: "page",
        area: ROUTES_AREA,
        title: "Timber",
        data: { path: "/timber" } satisfies RouteContribution,
        render: () => <TimberPage context={context} />,
      },
      {
        id: "todos-page",
        area: ROUTES_AREA,
        title: "Timber TODOs",
        data: { path: "/timber-todos" } satisfies RouteContribution,
        render: () => <TimberTodosPage context={context} />,
      },
      {
        id: "nav",
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: {
          codicon: "git-branch",
          label: "Timber",
          path: "/timber",
        } satisfies SidebarNavContribution,
      },
      {
        id: "todos-nav",
        area: SIDEBAR_NAV_AREA,
        order: 61,
        data: {
          codicon: "checklist",
          label: "Timber TODOs",
          path: "/timber-todos",
        } satisfies SidebarNavContribution,
      },
      {
        id: "panel",
        area: "panes",
        title: "Worktrees",
        data: {
          placement: "right",
          width: "440px",
          collapsible: true,
        },
        render: () => <TimberPanel context={context} />,
      },
      {
        id: "todos-panel",
        area: "panes",
        title: "TODOs",
        data: {
          placement: "right",
          width: "400px",
          collapsible: true,
        },
        render: () => <TimberTodosPanel context={context} />,
      },
      { id: shortcut.id, area: KEYBINDS_AREA, data: shortcut },
      { id: showWorktrees.id, area: PALETTE_AREA, data: showWorktrees },
      { id: showTodos.id, area: PALETTE_AREA, data: showTodos },
      { id: sync.id, area: PALETTE_AREA, data: sync },
    ]);
  },
};

export default plugin;
