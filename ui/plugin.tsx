import { host, KEYBINDS_AREA, PALETTE_AREA } from "@hermes/plugin-sdk";
import type {
  HermesPlugin,
  KeybindContribution,
  PaletteContribution,
} from "@hermes/plugin-sdk";
import { TimberPanel } from "./panel";

const plugin: HermesPlugin = {
  id: "hermes-timber",
  name: "Timber",
  description:
    "Create, open, and safely remove Timber worktrees in repository Projects.",
  register(context) {
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
      defaults: ["ctrl+t"],
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
  },
};

export default plugin;
