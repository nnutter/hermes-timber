import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  Button,
  Codicon,
  Input,
  useQuery,
  useQueryClient,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import { message, parseState, parseTodoList } from "./contracts";
import type { TodoList } from "./contracts";
import { authenticationFailure, pollDelay } from "./polling";
import { assertScope } from "./scope";

const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
};
const muted: CSSProperties = {
  color: "var(--ui-text-secondary)",
  fontSize: 12,
  overflowWrap: "anywhere",
};
const selectStyle: CSSProperties = {
  color: "var(--ui-text-primary)",
  background: "var(--ui-bg-secondary)",
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 4,
  padding: 6,
  width: "100%",
  minWidth: 0,
};

export function TodoView({
  context,
  scope,
  online,
  cwd,
  surface,
}: {
  context: PluginContext;
  scope: string;
  online: boolean;
  cwd: string;
  surface: "panel" | "page";
}) {
  const client = useQueryClient();
  const listingKey = ["hermes-timber", scope, "state"] as const;
  const failures = useRef(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(() =>
    authenticationFailure(client.getQueryState(listingKey)?.error),
  );
  const listing = useQuery({
    queryKey: listingKey,
    queryFn: async () => {
      assertScope(scope);
      try {
        const result = parseState(await context.rest<unknown>("/state"));
        assertScope(scope);
        failures.current = 0;
        setAuthenticationRequired(false);
        return result;
      } catch (failure) {
        failures.current += 1;
        if (authenticationFailure(failure)) setAuthenticationRequired(true);
        throw failure;
      }
    },
    enabled: online && !authenticationRequired,
    refetchInterval: () =>
      authenticationRequired ? false : pollDelay(failures.current),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 10_000,
  });
  const [chosen, setChosen] = useState<{
    repo: string;
    name: string;
  } | null>(null);
  const [todoScope, setTodoScope] = useState<"worktree" | "repo">("worktree");
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const armedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftInput = useRef<HTMLInputElement | null>(null);

  const worktrees = listing.data?.worktrees ?? [];
  const picked = chosen
    ? worktrees.find(
        (worktree) =>
          worktree.repo === chosen.repo && worktree.name === chosen.name,
      )
    : undefined;
  const current =
    picked ??
    worktrees.find((worktree) => worktree.path === cwd) ??
    worktrees[0];
  const currentAt = current ? worktrees.indexOf(current) : -1;
  const todoKey = current
    ? ([
        "hermes-timber",
        scope,
        "todo",
        current.repo,
        current.name,
        todoScope,
      ] as const)
    : null;
  const todos = useQuery({
    queryKey: todoKey ?? ["hermes-timber", scope, "todo", "none"],
    queryFn: async () => {
      if (!current) throw new Error("No worktree selected.");
      assertScope(scope);
      const query = new URLSearchParams({
        repo: current.repo,
        name: current.name,
        scope: todoScope,
      });
      const result = parseTodoList(
        await context.rest<unknown>(`/todo?${query.toString()}`),
      );
      assertScope(scope);
      return result;
    },
    enabled: online && !authenticationRequired && current !== undefined,
    refetchInterval: 15_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const list = todos.data;

  useEffect(
    () => () => {
      if (armedTimer.current !== null) clearTimeout(armedTimer.current);
    },
    [],
  );

  async function write(
    route: string,
    fields: Record<string, unknown>,
  ): Promise<TodoList | null> {
    if (!current || busy) return null;
    setBusy(true);
    setError(null);
    try {
      assertScope(scope);
      const answer = parseTodoList(
        await context.rest<unknown>(route, {
          method: "POST",
          body: {
            repo: current.repo,
            name: current.name,
            scope: todoScope,
            ...fields,
          },
        }),
      );
      assertScope(scope);
      if (todoKey) client.setQueryData(todoKey, answer);
      return answer;
    } catch (failure) {
      if (authenticationFailure(failure)) setAuthenticationRequired(true);
      setError(message(failure));
      return null;
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    void write("/todo-add", { text }).then((answer) => {
      if (answer === null) return;
      setDraft("");
      draftInput.current?.focus();
    });
  }

  function toggle(todo: TodoList["todos"][number]) {
    if (busy) return;
    void write("/todo-toggle", {
      id: todo.id,
      title: todo.title,
      complete: !todo.complete,
    });
  }

  function remove(todo: TodoList["todos"][number]) {
    if (busy) return;
    const key = `${todo.id}\0${todo.title}`;
    if (armed !== key) {
      setArmed(key);
      if (armedTimer.current !== null) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setArmed(null), 5000);
      return;
    }
    setArmed(null);
    if (armedTimer.current !== null) clearTimeout(armedTimer.current);
    void write("/todo-remove", { id: todo.id, title: todo.title });
  }

  const done = list?.summary.complete ?? 0;
  const total = (list?.summary.complete ?? 0) + (list?.summary.incomplete ?? 0);

  if (listing.isPending && online && !listing.data)
    return (
      <section aria-label="Timber TODOs" style={{ ...stackStyle, padding: 12 }}>
        <p role="status">Loading TODOs…</p>
      </section>
    );
  if (listing.isError && !listing.data)
    return (
      <section aria-label="Timber TODOs" style={{ ...stackStyle, padding: 12 }}>
        <p role="alert">Cannot load Timber. {message(listing.error)}</p>
      </section>
    );
  if (listing.data && !current)
    return (
      <section aria-label="Timber TODOs" style={{ ...stackStyle, padding: 12 }}>
        <p>No worktrees yet, so there is no TODO list to show.</p>
      </section>
    );

  return (
    <section
      aria-label="Timber TODOs"
      style={{
        ...stackStyle,
        padding: 12,
        height: "100%",
        overflow: "hidden",
        color: "var(--ui-text-primary)",
        fontSize: 13,
      }}
    >
      {surface === "page" && (
        <header style={stackStyle}>
          <strong style={{ fontSize: 20, lineHeight: 1.2 }}>TODOs</strong>
          <span style={muted}>
            {current ? `${current.name}@${current.repo}` : "Timber"}
          </span>
        </header>
      )}
      <div
        role="group"
        aria-label="Which TODO list"
        style={{
          display: "inline-flex",
          alignSelf: "flex-start",
          border: "1px solid var(--ui-stroke-secondary)",
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        {(["worktree", "repo"] as const).map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={todoScope === id}
            disabled={busy}
            onClick={() => setTodoScope(id)}
            style={{
              padding: "4px 10px",
              border: "none",
              borderRight:
                id === "worktree"
                  ? "1px solid var(--ui-stroke-secondary)"
                  : "none",
              background:
                todoScope === id
                  ? "var(--ui-row-active-background)"
                  : "transparent",
              color: "var(--ui-text-primary)",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            {id === "worktree" ? "Worktree" : "Repository"}
          </button>
        ))}
      </div>
      <select
        aria-label="Worktree"
        style={selectStyle}
        value={String(currentAt)}
        disabled={busy}
        onChange={(event) => {
          const next = worktrees[Number(event.target.value)];
          setChosen(next ? { repo: next.repo, name: next.name } : null);
        }}
      >
        {worktrees.map((worktree, index) => (
          <option key={worktree.path} value={String(index)}>
            {worktree.name}@{worktree.repo}
          </option>
        ))}
      </select>
      <form onSubmit={add} style={{ display: "flex", gap: 6 }}>
        <Input
          ref={draftInput}
          value={draft}
          placeholder="Add a task"
          aria-label="New task"
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
          {busy ? "Saving…" : "Add"}
        </Button>
      </form>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {!online && (
          <p role="status">Gateway offline. The TODO list is stale.</p>
        )}
        {authenticationRequired && (
          <p role="alert">
            Gateway sign-in or permission is required. Automatic requests are
            paused.
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        {todos.isError && !error && <p role="alert">{message(todos.error)}</p>}
        {list && list.todos.length === 0 && (
          <p style={muted}>
            No tasks in{" "}
            {todoScope === "repo"
              ? "this repository's list"
              : "this worktree's list"}
            .
          </p>
        )}
        <ul
          aria-label="TODOs"
          style={{
            ...stackStyle,
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {(list?.todos ?? []).map((todo) => {
            const removeKey = `${todo.id}\0${todo.title}`;
            const armedRow = armed === removeKey;
            return (
              <li
                key={todo.id}
                style={{
                  borderTop: "1px solid var(--ui-stroke-secondary)",
                  paddingLeft: todo.depth * 14,
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 4,
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "7px 0",
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={todo.complete}
                      disabled={busy}
                      aria-label={`${todo.complete ? "Done" : "Open"}: ${todo.title}`}
                      onChange={() => toggle(todo)}
                      style={{
                        flex: "none",
                        width: 15,
                        height: 15,
                        margin: "2px 0 0",
                        padding: 0,
                        accentColor: "var(--ui-accent)",
                      }}
                    />
                    <span
                      style={{
                        minWidth: 0,
                        overflowWrap: "anywhere",
                        ...(todo.complete
                          ? {
                              color: "var(--ui-text-secondary)",
                              textDecoration: "line-through",
                            }
                          : {}),
                      }}
                    >
                      {todo.title}
                    </span>
                  </label>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    title={
                      armedRow
                        ? `Click again within 5s to remove ${todo.title}`
                        : `Remove ${todo.title}`
                    }
                    aria-label={
                      armedRow
                        ? `Confirm remove ${todo.title}`
                        : `Remove ${todo.title}`
                    }
                    style={{
                      color: armedRow
                        ? "var(--ui-red)"
                        : "var(--ui-text-quaternary)",
                      marginTop: 3,
                    }}
                    onClick={() => remove(todo)}
                  >
                    {armedRow ? "Remove?" : <Codicon name="trash" />}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderTop: "1px solid var(--ui-stroke-secondary)",
          paddingTop: 8,
        }}
      >
        <span style={muted} aria-live="polite">
          {list ? `${done} of ${total} done` : ""}
        </span>
        <span
          style={{ ...muted, marginLeft: "auto" }}
          title={
            todoScope === "repo"
              ? "The list that every worktree of this repository shares"
              : "This worktree's own list"
          }
        >
          {todoScope === "repo" ? "TODO.repo.md" : "TODO.md"}
        </span>
      </div>
    </section>
  );
}
