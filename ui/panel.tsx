import type { PluginContext } from "@hermes/plugin-sdk";
import { useScope } from "./scope";
import { TodoView } from "./todos";
import { WorktreeView } from "./worktrees";

export function TimberPanel({ context }: { context: PluginContext }) {
  const scope = useScope();
  return (
    <WorktreeView
      key={JSON.stringify([scope.key, scope.online])}
      context={context}
      scope={scope.key}
      online={scope.online}
      cwd={scope.cwd}
      surface="panel"
    />
  );
}

export function TimberTodosPanel({ context }: { context: PluginContext }) {
  const scope = useScope();
  return (
    <TodoView
      key={JSON.stringify([scope.key, scope.online])}
      context={context}
      scope={scope.key}
      online={scope.online}
      cwd={scope.cwd}
      surface="panel"
    />
  );
}
