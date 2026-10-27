import {
  host,
  KEYBINDS_AREA,
  PALETTE_AREA,
  queryClient,
} from "@hermes/plugin-sdk";
import type {
  HermesPlugin,
  KeybindContribution,
  PaletteContribution,
} from "@hermes/plugin-sdk";
import { TimberPanel } from "./panel";
import { message, responseWarnings } from "./contracts";
import { assertScope, scopeKey } from "./scope";

const plugin: HermesPlugin = {
  id: "hermes-timber",
  name: "Timber",
  description:
    "Create, open, and safely remove Timber worktrees in repository Projects.",
  register(context) {
    let syncing = false;
    context.register({
      id: "panel",
      area: "panes",
      title: "Timber",
      data: { placement: "right", width: "400px" },
      render: () => <TimberPanel context={context} />,
    });
    const shortcut: KeybindContribution = {
      id: "hermes-timber.show",
      label: "Show Timber worktrees",
      category: "view",
      defaults: [],
      run: () => host.revealPane("hermes-timber:panel"),
    };
    context.register({ id: "shortcut", area: KEYBINDS_AREA, data: shortcut });
    const command: PaletteContribution = {
      id: "show-timber",
      label: "Show Timber worktrees",
      keywords: ["worktree", "repository", "project", "branch"],
      run: () => host.revealPane("hermes-timber:panel"),
    };
    context.register({ id: command.id, area: PALETTE_AREA, data: command });
    const sync: PaletteContribution = {
      id: "sync-projects",
      label: "Timber: Sync Projects",
      keywords: ["timber", "worktree", "repository"],
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
    context.register({ id: sync.id, area: PALETTE_AREA, data: sync });
  },
};

export default plugin;
