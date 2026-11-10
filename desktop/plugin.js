// ui/plugin.tsx
import {
  host as host3,
  KEYBINDS_AREA,
  PALETTE_AREA,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA
} from "@hermes/plugin-sdk";

// ui/contracts.ts
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isReviewProgress(value) {
  return record(value) && typeof value.approved === "number" && Number.isInteger(value.approved) && value.approved >= 0 && typeof value.total === "number" && Number.isInteger(value.total) && value.total >= 0;
}
function isWorktree(value) {
  if (!record(value)) return false;
  return ["name", "repo", "path"].every((key) => typeof value[key] === "string") && typeof value.clean === "boolean" && typeof value.merged === "boolean" && ["upstream", "commit"].every(
    (key) => value[key] == null || typeof value[key] === "string"
  ) && typeof value.statusError === "boolean" && ["ahead", "behind", "todoDone", "todoTotal"].every(
    (key) => value[key] === void 0 || typeof value[key] === "number" && Number.isFinite(value[key])
  ) && (value.pullRequest === void 0 || typeof value.pullRequest === "string") && (value.review === void 0 || value.review === null || isReviewProgress(value.review));
}
function isStackPr(value) {
  return record(value) && typeof value.number === "number" && typeof value.url === "string" && typeof value.title === "string" && typeof value.branch === "string" && typeof value.position === "number" && typeof value.state === "string" && typeof value.current === "boolean" && typeof value.checks === "string" && (value.blocker === null || typeof value.blocker === "string");
}
function isStackInfo(value) {
  return record(value) && typeof value.number === "number" && typeof value.url === "string" && typeof value.size === "number" && typeof value.base === "string" && Array.isArray(value.prs) && value.prs.every(isStackPr);
}
function isPrEntry(value) {
  if (!record(value)) return false;
  return (value.number == null || typeof value.number === "number") && (value.url == null || typeof value.url === "string") && (value.title == null || typeof value.title === "string") && typeof value.destExists === "boolean" && typeof value.unpushed === "number" && typeof value.ff === "boolean" && (value.mergeBlocker == null || typeof value.mergeBlocker === "string") && (value.checks == null || typeof value.checks === "string") && (value.repo == null || typeof value.repo === "string") && (value.stack == null || isStackInfo(value.stack));
}
function parsePrs(value) {
  if (!record(value)) return {};
  const prs = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPrEntry(entry)) prs[key] = entry;
  }
  return prs;
}
function parseState(value) {
  if (!record(value) || typeof value.host !== "string" || typeof value.hermes_home !== "string" || !strings(value.repositories) || !Array.isArray(value.worktrees) || !value.worktrees.every(isWorktree) || !record(value.projects) || !Object.values(value.projects).every((item) => typeof item === "string") || !strings(value.warnings))
    throw new Error("The Timber backend returned an invalid state response.");
  const projects = {};
  for (const [key, item] of Object.entries(value.projects)) {
    if (typeof item === "string") projects[key] = item;
  }
  return {
    host: value.host,
    hermes_home: value.hermes_home,
    repositories: value.repositories,
    worktrees: value.worktrees.filter(isWorktree),
    projects,
    warnings: value.warnings,
    at: typeof value.at === "number" ? value.at : 0,
    fetchedAt: typeof value.fetchedAt === "number" ? value.fetchedAt : null,
    fetchError: typeof value.fetchError === "string" ? value.fetchError : null,
    prs: parsePrs(value.prs),
    prsAt: typeof value.prsAt === "number" ? value.prsAt : null
  };
}
function parsePreview(value) {
  if (!record(value) || typeof value.token !== "string" || !value.token || !isWorktree(value.worktree) || typeof value.branch !== "string" || typeof value.warning !== "string") {
    throw new Error("The Timber backend returned an invalid removal preview.");
  }
  return {
    token: value.token,
    worktree: value.worktree,
    branch: value.branch,
    warning: value.warning
  };
}
function safeToRemove(worktree) {
  const synced = (worktree.ahead ?? 0) === 0 && (worktree.behind ?? 0) === 0;
  return worktree.clean && !worktree.statusError && (worktree.merged || synced);
}
function responseWarnings(value) {
  if (!record(value) || !strings(value.warnings))
    throw new Error(
      "The Timber backend returned an invalid mutation response."
    );
  return value.warnings;
}
function parseWorktreeState(value) {
  if (!record(value) || !isWorktree(value.worktree) || !isPrEntry(value.pr))
    throw new Error("The Timber backend returned an invalid worktree state.");
  return { worktree: value.worktree, pr: value.pr };
}
function parsePrCreated(value) {
  if (!record(value) || typeof value.url !== "string" || typeof value.number !== "number" || typeof value.created !== "boolean")
    throw new Error("The Timber backend returned an invalid PR response.");
  return { url: value.url, number: value.number, created: value.created };
}
function parseTodoList(value) {
  if (!record(value) || value.scope !== "worktree" && value.scope !== "repo" || !record(value.summary) || typeof value.summary.incomplete !== "number" || typeof value.summary.complete !== "number" || !Array.isArray(value.todos))
    throw new Error("The Timber backend returned an invalid TODO list.");
  const todos = [];
  for (const entry of value.todos) {
    if (record(entry) && typeof entry.id === "number" && typeof entry.title === "string" && typeof entry.complete === "boolean" && typeof entry.depth === "number") {
      todos.push({
        id: entry.id,
        title: entry.title,
        complete: entry.complete,
        depth: entry.depth
      });
    }
  }
  return {
    scope: value.scope,
    summary: {
      incomplete: value.summary.incomplete,
      complete: value.summary.complete
    },
    todos
  };
}
function parseSessions(value) {
  if (!record(value) || !Array.isArray(value.sessions))
    throw new Error("The Timber backend returned an invalid session list.");
  const sessions = [];
  for (const entry of value.sessions) {
    if (record(entry) && typeof entry.id === "string" && typeof entry.title === "string" && (entry.updated === null || typeof entry.updated === "number")) {
      sessions.push({
        id: entry.id,
        title: entry.title,
        updated: entry.updated
      });
    }
  }
  return sessions;
}
function message(error) {
  return error instanceof Error ? error.message : "The operation failed.";
}

// ui/scope.ts
import { useSyncExternalStore } from "react";
import { gatewayActivationEpoch, host } from "@hermes/plugin-sdk";
function scopeKey() {
  return JSON.stringify([
    gatewayActivationEpoch(),
    host.state.connectionId.get(),
    host.state.profile.get()
  ]);
}
function snapshot() {
  return JSON.stringify([
    scopeKey(),
    host.state.gateway.get(),
    host.state.cwd.get()
  ]);
}
function subscribe(changed) {
  const disposers = [
    host.state.profile.listen(changed),
    host.state.connectionId.listen(changed),
    host.state.gateway.listen(changed),
    host.state.cwd.listen(changed),
    host.onEvent("*", changed)
  ];
  return () => disposers.forEach((dispose) => dispose());
}
function useScope() {
  const value = JSON.parse(
    useSyncExternalStore(subscribe, snapshot, snapshot)
  );
  return { key: value[0], online: value[1] === "open", cwd: value[2] };
}
function assertScope(key) {
  if (scopeKey() !== key || host.state.gateway.get() !== "open") {
    throw new Error(
      "The gateway changed or is offline. Refresh Timber before continuing."
    );
  }
}

// ui/todos.tsx
import { useEffect, useRef, useState } from "react";
import {
  Button,
  Codicon,
  Input,
  useQuery,
  useQueryClient
} from "@hermes/plugin-sdk";

// ui/polling.ts
var NORMAL_POLL_MS = 15e3;
var MAX_POLL_MS = 3e5;
function pollDelay(consecutiveFailures) {
  return Math.min(
    NORMAL_POLL_MS * 2 ** Math.min(consecutiveFailures, 5),
    MAX_POLL_MS
  );
}
function authenticationFailure(error) {
  if (record(error)) {
    const status = error.status ?? error.statusCode;
    if (status === 401 || status === 403) return true;
  }
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b(?:401|403)(?=[:\s]|$)|\bno_cookie\b|\bunauthenticated\b|silent sign-in for this gateway failed|OAuth session partition is unavailable/i.test(
    text
  );
}

// ui/todos.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var stackStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0
};
var muted = {
  color: "var(--ui-text-secondary)",
  fontSize: 12,
  overflowWrap: "anywhere"
};
var selectStyle = {
  color: "var(--ui-text-primary)",
  background: "var(--ui-bg-secondary)",
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 4,
  padding: 6,
  width: "100%",
  minWidth: 0
};
function TodoView({
  context,
  scope,
  online,
  cwd,
  surface
}) {
  const client = useQueryClient();
  const listingKey = ["hermes-timber", scope, "state"];
  const failures = useRef(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(
    () => authenticationFailure(client.getQueryState(listingKey)?.error)
  );
  const listing = useQuery({
    queryKey: listingKey,
    queryFn: async () => {
      assertScope(scope);
      try {
        const result = parseState(await context.rest("/state"));
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
    refetchInterval: () => authenticationRequired ? false : pollDelay(failures.current),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 1e4
  });
  const [chosen, setChosen] = useState(null);
  const [todoScope, setTodoScope] = useState("worktree");
  const [draft, setDraft] = useState("");
  const [armed, setArmed] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const armedTimer = useRef(null);
  const draftInput = useRef(null);
  const worktrees = listing.data?.worktrees ?? [];
  const picked = chosen ? worktrees.find(
    (worktree) => worktree.repo === chosen.repo && worktree.name === chosen.name
  ) : void 0;
  const current = picked ?? worktrees.find((worktree) => worktree.path === cwd) ?? worktrees[0];
  const currentAt = current ? worktrees.indexOf(current) : -1;
  const todoKey = current ? [
    "hermes-timber",
    scope,
    "todo",
    current.repo,
    current.name,
    todoScope
  ] : null;
  const todos = useQuery({
    queryKey: todoKey ?? ["hermes-timber", scope, "todo", "none"],
    queryFn: async () => {
      if (!current) throw new Error("No worktree selected.");
      assertScope(scope);
      const query = new URLSearchParams({
        repo: current.repo,
        name: current.name,
        scope: todoScope
      });
      const result = parseTodoList(
        await context.rest(`/todo?${query.toString()}`)
      );
      assertScope(scope);
      return result;
    },
    enabled: online && !authenticationRequired && current !== void 0,
    refetchInterval: 15e3,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false
  });
  const list = todos.data;
  useEffect(
    () => () => {
      if (armedTimer.current !== null) clearTimeout(armedTimer.current);
    },
    []
  );
  async function write(route, fields) {
    if (!current || busy) return null;
    setBusy(true);
    setError(null);
    try {
      assertScope(scope);
      const answer = parseTodoList(
        await context.rest(route, {
          method: "POST",
          body: {
            repo: current.repo,
            name: current.name,
            scope: todoScope,
            ...fields
          }
        })
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
  function add(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    void write("/todo-add", { text }).then((answer) => {
      if (answer === null) return;
      setDraft("");
      draftInput.current?.focus();
    });
  }
  function toggle(todo) {
    if (busy) return;
    void write("/todo-toggle", {
      id: todo.id,
      title: todo.title,
      complete: !todo.complete
    });
  }
  function remove(todo) {
    if (busy) return;
    const key = `${todo.id}\0${todo.title}`;
    if (armed !== key) {
      setArmed(key);
      if (armedTimer.current !== null) clearTimeout(armedTimer.current);
      armedTimer.current = setTimeout(() => setArmed(null), 5e3);
      return;
    }
    setArmed(null);
    if (armedTimer.current !== null) clearTimeout(armedTimer.current);
    void write("/todo-remove", { id: todo.id, title: todo.title });
  }
  const done = list?.summary.complete ?? 0;
  const total = (list?.summary.complete ?? 0) + (list?.summary.incomplete ?? 0);
  if (listing.isPending && online && !listing.data)
    return /* @__PURE__ */ jsx("section", { "aria-label": "Timber TODOs", style: { ...stackStyle, padding: 12 }, children: /* @__PURE__ */ jsx("p", { role: "status", children: "Loading TODOs\u2026" }) });
  if (listing.isError && !listing.data)
    return /* @__PURE__ */ jsx("section", { "aria-label": "Timber TODOs", style: { ...stackStyle, padding: 12 }, children: /* @__PURE__ */ jsxs("p", { role: "alert", children: [
      "Cannot load Timber. ",
      message(listing.error)
    ] }) });
  if (listing.data && !current)
    return /* @__PURE__ */ jsx("section", { "aria-label": "Timber TODOs", style: { ...stackStyle, padding: 12 }, children: /* @__PURE__ */ jsx("p", { children: "No worktrees yet, so there is no TODO list to show." }) });
  return /* @__PURE__ */ jsxs(
    "section",
    {
      "aria-label": "Timber TODOs",
      style: {
        ...stackStyle,
        padding: 12,
        height: "100%",
        overflow: "hidden",
        color: "var(--ui-text-primary)",
        fontSize: 13
      },
      children: [
        surface === "page" && /* @__PURE__ */ jsxs("header", { style: stackStyle, children: [
          /* @__PURE__ */ jsx("strong", { style: { fontSize: 20, lineHeight: 1.2 }, children: "TODOs" }),
          /* @__PURE__ */ jsx("span", { style: muted, children: current ? `${current.name}@${current.repo}` : "Timber" })
        ] }),
        /* @__PURE__ */ jsx(
          "div",
          {
            role: "group",
            "aria-label": "Which TODO list",
            style: {
              display: "inline-flex",
              alignSelf: "flex-start",
              border: "1px solid var(--ui-stroke-secondary)",
              borderRadius: 4,
              overflow: "hidden"
            },
            children: ["worktree", "repo"].map((id) => /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                "aria-pressed": todoScope === id,
                disabled: busy,
                onClick: () => setTodoScope(id),
                style: {
                  padding: "4px 10px",
                  border: "none",
                  borderRight: id === "worktree" ? "1px solid var(--ui-stroke-secondary)" : "none",
                  background: todoScope === id ? "var(--ui-row-active-background)" : "transparent",
                  color: "var(--ui-text-primary)",
                  fontSize: 12,
                  cursor: "pointer"
                },
                children: id === "worktree" ? "Worktree" : "Repository"
              },
              id
            ))
          }
        ),
        /* @__PURE__ */ jsx(
          "select",
          {
            "aria-label": "Worktree",
            style: selectStyle,
            value: String(currentAt),
            disabled: busy,
            onChange: (event) => {
              const next = worktrees[Number(event.target.value)];
              setChosen(next ? { repo: next.repo, name: next.name } : null);
            },
            children: worktrees.map((worktree, index) => /* @__PURE__ */ jsxs("option", { value: String(index), children: [
              worktree.name,
              "@",
              worktree.repo
            ] }, worktree.path))
          }
        ),
        /* @__PURE__ */ jsxs("form", { onSubmit: add, style: { display: "flex", gap: 6 }, children: [
          /* @__PURE__ */ jsx(
            Input,
            {
              ref: draftInput,
              value: draft,
              placeholder: "Add a task",
              "aria-label": "New task",
              disabled: busy,
              onChange: (event) => setDraft(event.target.value),
              style: { flex: 1, minWidth: 0 }
            }
          ),
          /* @__PURE__ */ jsx(Button, { type: "submit", size: "sm", disabled: busy || !draft.trim(), children: busy ? "Saving\u2026" : "Add" })
        ] }),
        /* @__PURE__ */ jsxs(
          "div",
          {
            style: {
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10
            },
            children: [
              !online && /* @__PURE__ */ jsx("p", { role: "status", children: "Gateway offline. The TODO list is stale." }),
              authenticationRequired && /* @__PURE__ */ jsx("p", { role: "alert", children: "Gateway sign-in or permission is required. Automatic requests are paused." }),
              error && /* @__PURE__ */ jsx("p", { role: "alert", children: error }),
              todos.isError && !error && /* @__PURE__ */ jsx("p", { role: "alert", children: message(todos.error) }),
              list && list.todos.length === 0 && /* @__PURE__ */ jsxs("p", { style: muted, children: [
                "No tasks in",
                " ",
                todoScope === "repo" ? "this repository's list" : "this worktree's list",
                "."
              ] }),
              /* @__PURE__ */ jsx(
                "ul",
                {
                  "aria-label": "TODOs",
                  style: {
                    ...stackStyle,
                    listStyle: "none",
                    margin: 0,
                    padding: 0
                  },
                  children: (list?.todos ?? []).map((todo) => {
                    const removeKey = `${todo.id}\0${todo.title}`;
                    const armedRow = armed === removeKey;
                    return /* @__PURE__ */ jsx(
                      "li",
                      {
                        style: {
                          borderTop: "1px solid var(--ui-stroke-secondary)",
                          paddingLeft: todo.depth * 14
                        },
                        children: /* @__PURE__ */ jsxs(
                          "div",
                          {
                            style: {
                              display: "flex",
                              alignItems: "flex-start",
                              gap: 4
                            },
                            children: [
                              /* @__PURE__ */ jsxs(
                                "label",
                                {
                                  style: {
                                    display: "flex",
                                    alignItems: "flex-start",
                                    gap: 8,
                                    padding: "7px 0",
                                    minWidth: 0,
                                    flex: 1
                                  },
                                  children: [
                                    /* @__PURE__ */ jsx(
                                      "input",
                                      {
                                        type: "checkbox",
                                        checked: todo.complete,
                                        disabled: busy,
                                        "aria-label": `${todo.complete ? "Done" : "Open"}: ${todo.title}`,
                                        onChange: () => toggle(todo),
                                        style: {
                                          flex: "none",
                                          width: 15,
                                          height: 15,
                                          margin: "2px 0 0",
                                          padding: 0,
                                          accentColor: "var(--ui-accent)"
                                        }
                                      }
                                    ),
                                    /* @__PURE__ */ jsx(
                                      "span",
                                      {
                                        style: {
                                          minWidth: 0,
                                          overflowWrap: "anywhere",
                                          ...todo.complete ? {
                                            color: "var(--ui-text-secondary)",
                                            textDecoration: "line-through"
                                          } : {}
                                        },
                                        children: todo.title
                                      }
                                    )
                                  ]
                                }
                              ),
                              /* @__PURE__ */ jsx(
                                Button,
                                {
                                  type: "button",
                                  size: "xs",
                                  variant: "ghost",
                                  disabled: busy,
                                  title: armedRow ? `Click again within 5s to remove ${todo.title}` : `Remove ${todo.title}`,
                                  "aria-label": armedRow ? `Confirm remove ${todo.title}` : `Remove ${todo.title}`,
                                  style: {
                                    color: armedRow ? "var(--ui-red)" : "var(--ui-text-quaternary)",
                                    marginTop: 3
                                  },
                                  onClick: () => remove(todo),
                                  children: armedRow ? "Remove?" : /* @__PURE__ */ jsx(Codicon, { name: "trash" })
                                }
                              )
                            ]
                          }
                        )
                      },
                      todo.id
                    );
                  })
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              borderTop: "1px solid var(--ui-stroke-secondary)",
              paddingTop: 8
            },
            children: [
              /* @__PURE__ */ jsx("span", { style: muted, "aria-live": "polite", children: list ? `${done} of ${total} done` : "" }),
              /* @__PURE__ */ jsx(
                "span",
                {
                  style: { ...muted, marginLeft: "auto" },
                  title: todoScope === "repo" ? "The list that every worktree of this repository shares" : "This worktree's own list",
                  children: todoScope === "repo" ? "TODO.repo.md" : "TODO.md"
                }
              )
            ]
          }
        )
      ]
    }
  );
}

// ui/worktrees.tsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2 } from "react";
import {
  Button as Button2,
  Codicon as Codicon2,
  host as host2,
  Input as Input2,
  useQuery as useQuery2,
  useQueryClient as useQueryClient2
} from "@hermes/plugin-sdk";

// ui/actions.ts
function rowKey(worktree) {
  return `${worktree.repo}\0${worktree.name}`;
}
function rowActionId(verb, worktree) {
  return `${verb}\0${rowKey(worktree)}`;
}
function repoActionId(verb, repo) {
  return `${verb}\0${repo}`;
}
function sessionTitle(worktree) {
  return `${worktree.name}@${worktree.repo}`;
}
function stackHasOpenPr(stack) {
  return Boolean(stack?.prs.some((pr) => pr.state === "OPEN"));
}
function canRemove(worktree, pr) {
  return safeToRemove(worktree) && !stackHasOpenPr(pr?.stack);
}
function actionFor(worktree, pr, prsLoaded) {
  const removable = canRemove(worktree, pr);
  if (worktree.merged) return removable ? "delete" : null;
  if (removable) return "delete";
  if (!prsLoaded) return null;
  const canUpload = Boolean(
    pr && pr.unpushed > 0 && pr.ff && !worktree.statusError
  );
  if (canUpload) return "push";
  if (stackHasOpenPr(pr?.stack)) return null;
  const openPr = Boolean(pr?.url);
  const mergeReason = openPr ? pr?.mergeBlocker ?? null : null;
  if (openPr) return mergeReason === null ? "merge" : "open-pr";
  const behindRemote = Boolean(
    pr && pr.destExists && !pr.ff && !worktree.statusError
  );
  if (behindRemote) return "blocked";
  if (worktree.statusError) return null;
  return "create-pr";
}
function dimShade(color) {
  return `color-mix(in srgb, ${color} 78%, var(--ui-bg-primary))`;
}
function actionColor(action, worktree, checks) {
  if (action === "delete") return "var(--ui-purple)";
  if (action === "merge") return "var(--ui-green)";
  if (action === "push" || action === "create-pr") {
    return dimShade(
      worktree.clean && !worktree.statusError ? "var(--ui-green)" : "var(--ui-yellow)"
    );
  }
  if (action === "open-pr") {
    return checks === "failed" ? "var(--ui-red)" : dimShade("var(--ui-yellow)");
  }
  if (action === "blocked") return "var(--ui-red)";
  return "var(--ui-text-quaternary)";
}
function filterWorktrees(worktrees, search, prs) {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return worktrees;
  return worktrees.filter((worktree) => {
    const pr = prs[rowKey(worktree)];
    const selector = `${worktree.name}@${worktree.repo}`;
    const fields = [
      selector,
      `${worktree.name} @ ${worktree.repo}`,
      worktree.name,
      worktree.repo,
      worktree.path,
      worktree.upstream ?? "",
      worktree.clean ? "clean" : "dirty",
      worktree.merged ? "merged" : "",
      worktree.statusError ? "status error" : "",
      `ahead ${worktree.ahead ?? 0}`,
      `behind ${worktree.behind ?? 0}`,
      worktree.todoTotal !== void 0 ? `todo ${worktree.todoDone ?? 0}/${worktree.todoTotal}` : "",
      worktree.pullRequest ?? "",
      pr?.title ?? "",
      pr?.url ?? "",
      pr?.checks ?? "",
      pr?.stack ? pr.stack.prs.map((entry) => `${entry.number} ${entry.branch} ${entry.title}`).join(" ") : ""
    ];
    return fields.some((field) => field.toLocaleLowerCase().includes(needle));
  });
}
function sortWorktrees(worktrees, sort, pinnedPath, recent) {
  const rows = [...worktrees];
  rows.sort((left, right) => {
    const leftPinned = left.path === pinnedPath ? 0 : 1;
    const rightPinned = right.path === pinnedPath ? 0 : 1;
    if (leftPinned !== rightPinned) return leftPinned - rightPinned;
    if (sort === "recent") {
      const difference = (recent[right.path] ?? 0) - (recent[left.path] ?? 0);
      if (difference) return difference;
      return 0;
    }
    if (sort === "repo") {
      return left.repo.localeCompare(right.repo) || left.name.localeCompare(right.name);
    }
    return left.name.localeCompare(right.name) || left.repo.localeCompare(right.repo);
  });
  return rows;
}
function timeAgo(at) {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1e3));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ui/worktrees.tsx
import { Fragment, jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var TOOLBAR_HEIGHT = 34;
var REMOVE_COLOR = "var(--ui-purple)";
var stackStyle2 = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0
};
var rowStyle = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6
};
var muted2 = {
  color: "var(--ui-text-secondary)",
  fontSize: 12,
  overflowWrap: "anywhere"
};
var faint = {
  color: "var(--ui-text-quaternary)",
  fontSize: 11,
  overflowWrap: "anywhere"
};
var selectStyle2 = {
  color: "var(--ui-text-primary)",
  background: "var(--ui-bg-secondary)",
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 4,
  padding: 6,
  width: "100%",
  minWidth: 0
};
var boxed = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 4,
  padding: 10
};
var iconButton = (size) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: size,
  height: size,
  minWidth: 0,
  minHeight: 0,
  padding: 0,
  flexShrink: 0
});
var splitPart = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 0,
  border: "none",
  borderRadius: 0,
  background: "transparent"
};
var rowItem = {
  display: "inline-flex",
  alignItems: "center",
  height: 28,
  boxSizing: "border-box",
  fontSize: 13,
  whiteSpace: "nowrap"
};
var SORT_MODES = [
  { id: "recent", label: "Activity", icon: "history" },
  { id: "repo", label: "Repository Name", icon: "repo" },
  { id: "name", label: "Worktree Name", icon: "git-branch" }
];
function WorktreeView({
  context,
  scope,
  online,
  cwd,
  surface
}) {
  const client = useQueryClient2();
  const queryKey = ["hermes-timber", scope, "state"];
  const failures = useRef2(0);
  const [authenticationRequired, setAuthenticationRequired] = useState2(
    () => authenticationFailure(client.getQueryState(queryKey)?.error)
  );
  const listing = useQuery2({
    queryKey,
    queryFn: async () => {
      assertScope(scope);
      try {
        const result = parseState(await context.rest("/state"));
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
    refetchInterval: () => authenticationRequired ? false : pollDelay(failures.current),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 1e4
  });
  const data = listing.data;
  const ready = online && !authenticationRequired && Boolean(data) && !listing.isError;
  const [search, setSearch] = useState2("");
  const [sort, setSort] = useState2("recent");
  const [openMenu, setOpenMenu] = useState2(null);
  const [creating, setCreating] = useState2(false);
  const [adding, setAdding] = useState2(false);
  const [showRepos, setShowRepos] = useState2(false);
  const [renaming, setRenaming] = useState2(null);
  const [renameTo, setRenameTo] = useState2("");
  const [createRepo, setCreateRepo] = useState2("");
  const [name, setName] = useState2("");
  const [upstream, setUpstream] = useState2("");
  const [source, setSource] = useState2("");
  const [repoName, setRepoName] = useState2("");
  const [alias, setAlias] = useState2("");
  const [prWorktree, setPrWorktree] = useState2(null);
  const [prTitle, setPrTitle] = useState2("");
  const [prBody, setPrBody] = useState2("");
  const [preview, setPreview] = useState2(null);
  const [notice, setNotice] = useState2([]);
  const [error, setError] = useState2(null);
  const [blockedCreate, setBlockedCreate] = useState2(false);
  const [blockedAdd, setBlockedAdd] = useState2(false);
  const [running, setRunning] = useState2(() => /* @__PURE__ */ new Set());
  const runningRef = useRef2(/* @__PURE__ */ new Set());
  const [collecting, setCollecting] = useState2(false);
  const collected = useRef2(false);
  const [recent, setRecent] = useState2({});
  const consentVersion = useRef2(0);
  const consentTimer = useRef2(null);
  const consent = useRef2(null);
  const consentSnapshot = useRef2("");
  const consentDeadline = useRef2(0);
  const menuAnchor = useRef2(null);
  const disarm = () => {
    consentVersion.current++;
    consent.current = null;
    if (consentTimer.current !== null) clearTimeout(consentTimer.current);
    consentTimer.current = null;
    setPreview(null);
  };
  useEffect2(
    () => () => {
      consentVersion.current++;
      if (consentTimer.current !== null) clearTimeout(consentTimer.current);
    },
    []
  );
  useEffect2(() => {
    if (openMenu === null) return void 0;
    const onDown = (event) => {
      if (menuAnchor.current && event.target instanceof Node && !menuAnchor.current.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    const onKey = (event) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);
  const start = (id) => {
    runningRef.current = new Set(runningRef.current).add(id);
    setRunning(new Set(runningRef.current));
  };
  const end = (id) => {
    const next = new Set(runningRef.current);
    next.delete(id);
    runningRef.current = next;
    setRunning(new Set(next));
  };
  const toolbarBusy = ["create", "add", "refresh"].some(
    (id) => running.has(id)
  );
  const rowBusy = (worktree) => ["open", "pr", "push", "rebase", "merge", "remove"].some(
    (verb) => running.has(rowActionId(verb, worktree))
  );
  const repoBusy = (repo) => ["repo-rename", "repo-remove"].some(
    (verb) => running.has(repoActionId(verb, repo))
  );
  const disabled = !ready || toolbarBusy || collecting;
  const check = () => {
    assertScope(scope);
    if (authenticationRequired || client.getQueryState(queryKey)?.status !== "success") {
      throw new Error(
        "The listing is stale. Refresh Timber before continuing."
      );
    }
  };
  const post = async (path, body) => {
    check();
    const response = await context.rest(path, {
      method: "POST",
      body
    });
    check();
    return response;
  };
  const refresh = async () => {
    assertScope(scope);
    const refreshed = await listing.refetch();
    if (refreshed.error) throw refreshed.error;
    assertScope(scope);
  };
  useEffect2(() => {
    if (!ready || !data || collected.current) return;
    if (data.fetchedAt !== null && data.prsAt !== null) {
      collected.current = true;
      return;
    }
    collected.current = true;
    setCollecting(true);
    void (async () => {
      try {
        await post("/fetch", {});
        await refresh();
      } catch (failure) {
        if (authenticationFailure(failure)) setAuthenticationRequired(true);
      } finally {
        setCollecting(false);
      }
    })();
  }, [ready, data, data?.fetchedAt, data?.prsAt]);
  const run = (id, action, kind = null) => {
    if (id !== null && runningRef.current.has(id)) return;
    if (kind === "create" && blockedCreate || kind === "add" && blockedAdd)
      return;
    if (id !== null) start(id);
    setNotice([]);
    void (async () => {
      try {
        await action();
      } catch (failure) {
        if (authenticationFailure(failure)) setAuthenticationRequired(true);
        setError(message(failure));
        setPreview(null);
        if (kind === "create") setBlockedCreate(true);
        if (kind === "add") setBlockedAdd(true);
        if (!authenticationFailure(failure)) {
          try {
            await refresh();
          } catch {
          }
        }
      } finally {
        if (id !== null) end(id);
      }
    })();
  };
  const applyState = (fresh) => {
    if (!record(fresh)) return false;
    const parsed = parseWorktreeState(fresh);
    const key = rowKey(parsed.worktree);
    client.setQueryData(
      queryKey,
      (previous) => previous ? {
        ...previous,
        worktrees: previous.worktrees.map(
          (worktree) => rowKey(worktree) === key ? parsed.worktree : worktree
        ),
        prs: { ...previous.prs, [key]: parsed.pr }
      } : previous
    );
    return true;
  };
  async function open(worktree, announce = true) {
    check();
    const profile = host2.state.profile.get();
    try {
      const sessions = parseSessions(
        await context.rest(
          `/sessions?path=${encodeURIComponent(worktree.path)}`
        )
      );
      if (sessions[0]) {
        await host2.openSession(sessions[0].id, {
          profile,
          awaitHydration: true,
          keepAllProfilesScope: true
        });
        check();
        setRecent((previous) => ({
          ...previous,
          [worktree.path]: Date.now()
        }));
        if (announce)
          setNotice([
            `Opened the latest session in ${worktree.name}@${worktree.repo}.`
          ]);
        return;
      }
    } catch {
    }
    const project = data?.projects[worktree.repo];
    if (!project)
      throw new Error(
        "No Hermes Project exists for this repository. Run Sync Projects from the command palette first."
      );
    const selected = await host2.request("projects.set_active", {
      id: project,
      profile
    });
    check();
    if (!record(selected) || selected.active_id !== project)
      throw new Error("Hermes did not activate the repository Project.");
    const created = await host2.request("session.create", {
      cwd: worktree.path,
      title: sessionTitle(worktree),
      source: "desktop",
      profile
    });
    check();
    if (!record(created) || typeof created.stored_session_id !== "string" || !created.stored_session_id || !record(created.info) || created.info.cwd !== worktree.path) {
      throw new Error(
        "Hermes did not confirm the requested working directory. The chat was not opened."
      );
    }
    await host2.openSession(created.stored_session_id, {
      profile,
      awaitHydration: true,
      keepAllProfilesScope: true
    });
    check();
    const moved = await host2.request("session.workspace.move", {
      session_key: created.stored_session_id,
      cwd: worktree.path,
      profile
    });
    check();
    if (!record(moved) || moved.cwd !== worktree.path)
      throw new Error("Hermes did not confirm the opened chat's workspace.");
    setRecent((previous) => ({
      ...previous,
      [worktree.path]: Date.now()
    }));
    if (announce)
      setNotice([`Opened ${worktree.name}@${worktree.repo} in Hermes.`]);
  }
  async function prepareRemove(worktree) {
    const pr = data?.prs[rowKey(worktree)];
    if (!canRemove(worktree, pr))
      throw new Error(
        "Only clean worktrees that are merged or fully in sync, without status errors or open stack PRs, can be removed."
      );
    const version = consentVersion.current;
    const snapshot2 = JSON.stringify(worktree);
    const result = parsePreview(
      await post("/remove/preview", {
        repo: worktree.repo,
        name: worktree.name
      })
    );
    if (!canRemove(result.worktree, data?.prs[rowKey(result.worktree)]) || result.worktree.repo !== worktree.repo || result.worktree.name !== worktree.name || result.worktree.path !== worktree.path) {
      throw new Error(
        "The worktree changed. Refresh Timber before requesting another preview."
      );
    }
    const latest = client.getQueryData(queryKey)?.worktrees.find(
      (item) => item.repo === worktree.repo && item.name === worktree.name
    );
    if (version !== consentVersion.current || JSON.stringify(latest) !== snapshot2)
      return;
    consentSnapshot.current = snapshot2;
    consentDeadline.current = Date.now() + 5e3;
    consent.current = result;
    setPreview(result);
    consentTimer.current = setTimeout(disarm, 5e3);
  }
  async function archiveSessions(path) {
    try {
      const answer = await context.rest("/sessions/archive", {
        method: "POST",
        body: { path }
      });
      if (record(answer) && typeof answer.archived === "number" && typeof answer.total === "number" && answer.total > 0) {
        const many = answer.total === 1 ? "1 session" : `${answer.total} sessions`;
        return answer.archived === answer.total ? ` Archived ${many}.` : ` Archived ${answer.archived} of ${many}.`;
      }
    } catch {
    }
    return "";
  }
  function remove(worktree) {
    const armed = consent.current;
    const latest = client.getQueryData(queryKey)?.worktrees.find(
      (item) => item.repo === worktree.repo && item.name === worktree.name
    );
    if (armed && armed.worktree.repo === worktree.repo && armed.worktree.name === worktree.name && Date.now() < consentDeadline.current && JSON.stringify(latest) === consentSnapshot.current) {
      disarm();
      run(rowActionId("remove", worktree), async () => {
        const result = await post("/remove", { token: armed.token });
        if (!record(result) || !result.removed)
          throw new Error("The backend did not confirm removal.");
        const archived = await archiveSessions(worktree.path);
        setNotice([
          ...responseWarnings(result),
          `Removed ${worktree.name}@${worktree.repo}.${archived}`
        ]);
        await refresh();
      });
    } else {
      disarm();
      run(rowActionId("remove", worktree), () => prepareRemove(worktree));
    }
  }
  function create(event) {
    event.preventDefault();
    run(
      "create",
      async () => {
        const chosen = createRepo || data?.repositories[0];
        if (!chosen) throw new Error("Select a repository first.");
        const response = await post("/create", {
          repo: chosen,
          name: name.trim(),
          upstream: upstream.trim()
        });
        if (!record(response) || !isWorktree(response.worktree))
          throw new Error(
            "The Timber backend returned an invalid create response."
          );
        const created = response.worktree;
        const createdWarnings = responseWarnings(response);
        setCreating(false);
        setName("");
        setUpstream("");
        await refresh();
        try {
          await open(created, false);
          setNotice([
            `Created ${created.name}@${created.repo}.`,
            ...createdWarnings
          ]);
        } catch (failure) {
          setNotice([
            `Created ${created.name}@${created.repo}, but its session did not open: ${message(failure)}`,
            ...createdWarnings
          ]);
        }
      },
      "create"
    );
  }
  function addRepository(event) {
    event.preventDefault();
    disarm();
    run(
      "add",
      async () => {
        const response = await post("/repositories", {
          source,
          name: repoName,
          alias
        });
        if (!record(response) || typeof response.repository !== "string" || !response.repository)
          throw new Error(
            "The backend did not confirm repository addition. Refresh before retrying."
          );
        setAdding(false);
        setSource("");
        setRepoName("");
        setAlias("");
        setNotice(responseWarnings(response));
        await refresh();
      },
      "add"
    );
  }
  function renameRepository(repo) {
    const to = renameTo.trim();
    if (!to) {
      setError("Enter the new repository name.");
      return;
    }
    run(repoActionId("repo-rename", repo), async () => {
      const result = await post("/repo-rename", { repo, to });
      if (!record(result) || typeof result.to !== "string" || typeof result.worktrees !== "number")
        throw new Error("The backend did not confirm the rename.");
      const moved = result.worktrees === 0 ? "" : ` Moved ${result.worktrees} worktree folder${result.worktrees === 1 ? "" : "s"}; sessions in the old ones no longer open them.`;
      setNotice([`Renamed ${repo} to ${result.to}.${moved}`]);
      setRenaming(null);
      setRenameTo("");
      setCreateRepo("");
      await refresh();
    });
  }
  function removeRepository(repo) {
    run(repoActionId("repo-remove", repo), async () => {
      const result = await post("/repo-remove", { repo });
      if (!record(result) || result.removed !== repo)
        throw new Error("The backend did not confirm repository removal.");
      setNotice([`Removed repository ${repo}.`]);
      setRenaming(null);
      setCreateRepo("");
      await refresh();
    });
  }
  function push(worktree) {
    run(rowActionId("push", worktree), async () => {
      const result = await post("/push", {
        repo: worktree.repo,
        name: worktree.name
      });
      if (!record(result) || result.pushed !== true)
        throw new Error("The backend did not confirm the push.");
      if (!applyState(result.state)) await refresh();
      setNotice([
        `Pushed ${worktree.name}@${worktree.repo} to origin/${worktree.name}.`
      ]);
    });
  }
  function rebase(worktree) {
    run(rowActionId("rebase", worktree), async () => {
      const result = await post("/rebase", {
        repo: worktree.repo,
        name: worktree.name
      });
      if (!record(result) || result.rebased !== true || typeof result.upstream !== "string")
        throw new Error("The backend did not confirm the rebase.");
      if (!applyState(result.state)) await refresh();
      setNotice([
        `Rebased ${worktree.name}@${worktree.repo} onto ${result.upstream}.`
      ]);
    });
  }
  function merge(worktree, number) {
    run(rowActionId("merge", worktree), async () => {
      const result = await post("/merge", {
        repo: worktree.repo,
        name: worktree.name,
        ...number ? { number } : {}
      });
      if (!record(result) || typeof result.merged !== "number" || typeof result.url !== "string")
        throw new Error("The backend did not confirm the merge.");
      if (!applyState(result.state)) await refresh();
      setNotice([
        result.whole === true ? `Merged the whole stack through PR #${result.merged}.` : result.stack === true ? `Merged the stack up to PR #${result.merged}.` : `Merged PR #${result.merged}.`
      ]);
    });
  }
  function createPr(worktree) {
    run(rowActionId("pr", worktree), async () => {
      const response = await post("/pr", {
        repo: worktree.repo,
        name: worktree.name,
        title: prTitle.trim(),
        body: prBody.trim()
      });
      const created = parsePrCreated(response);
      setPrWorktree(null);
      setPrTitle("");
      setPrBody("");
      setNotice([
        `${created.created ? "Created" : "Found"} PR #${created.number}: ${created.url}`
      ]);
      await refresh();
    });
  }
  function openPr(worktree, pr) {
    if (!pr?.url) return;
    void context.os.openExternal(pr.url);
    setRecent((previous) => ({
      ...previous,
      [worktree.path]: Date.now()
    }));
  }
  function openRepo(pr) {
    if (!pr?.repo) return;
    void context.os.openExternal(`https://github.com/${pr.repo}`);
  }
  const worktrees = data?.worktrees ?? [];
  const prsLoaded = data?.prsAt != null;
  const filtered = data ? sortWorktrees(
    filterWorktrees(worktrees, search, data.prs),
    sort,
    cwd,
    recent
  ) : [];
  const current = data?.worktrees.find((worktree) => worktree.path === cwd);
  return /* @__PURE__ */ jsxs2(
    "section",
    {
      "aria-label": "Timber worktrees",
      style: {
        ...stackStyle2,
        padding: 12,
        height: "100%",
        overflow: "hidden",
        width: surface === "page" ? "100%" : void 0,
        maxWidth: surface === "page" ? 760 : void 0,
        margin: surface === "page" ? "0 auto" : void 0,
        color: "var(--ui-text-primary)",
        fontSize: 13
      },
      children: [
        /* @__PURE__ */ jsxs2("header", { style: stackStyle2, children: [
          /* @__PURE__ */ jsx2(
            "strong",
            {
              style: { fontSize: surface === "page" ? 20 : 17, lineHeight: 1.2 },
              children: "Worktrees"
            }
          ),
          /* @__PURE__ */ jsx2("span", { style: muted2, children: current ? current.repo.split("/").at(-1) : "Timber" })
        ] }),
        /* @__PURE__ */ jsxs2(
          "div",
          {
            ref: menuAnchor,
            style: {
              display: "grid",
              gridTemplateColumns: "auto minmax(0,1fr) auto",
              gap: 8,
              flex: "none"
            },
            children: [
              /* @__PURE__ */ jsxs2("div", { style: { position: "relative", display: "inline-flex" }, children: [
                /* @__PURE__ */ jsxs2(
                  "div",
                  {
                    style: {
                      display: "inline-flex",
                      alignItems: "stretch",
                      alignSelf: "center",
                      border: "1px solid var(--ui-stroke-secondary)",
                      borderRadius: 4,
                      overflow: "hidden"
                    },
                    children: [
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "button",
                          size: "xs",
                          variant: "ghost",
                          disabled: disabled || !data?.repositories.length,
                          title: "New worktree",
                          "aria-label": "New worktree",
                          onClick: () => {
                            setOpenMenu(null);
                            setCreating((value) => !value);
                          },
                          style: { ...iconButton(TOOLBAR_HEIGHT), ...splitPart },
                          children: /* @__PURE__ */ jsx2(Codicon2, { name: "new-folder", size: 18 })
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        "span",
                        {
                          "aria-hidden": "true",
                          style: {
                            width: 1,
                            background: "var(--ui-stroke-secondary)"
                          }
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "button",
                          size: "xs",
                          variant: "ghost",
                          disabled,
                          title: "More actions",
                          "aria-label": "More actions",
                          "aria-haspopup": "menu",
                          "aria-expanded": openMenu === "add",
                          onClick: () => setOpenMenu(openMenu === "add" ? null : "add"),
                          style: {
                            ...splitPart,
                            ...iconButton(TOOLBAR_HEIGHT),
                            width: 28
                          },
                          children: /* @__PURE__ */ jsx2(Codicon2, { name: "chevron-down" })
                        }
                      )
                    ]
                  }
                ),
                openMenu === "add" && /* @__PURE__ */ jsxs2("div", { role: "menu", style: menuStyle, children: [
                  /* @__PURE__ */ jsxs2(
                    "button",
                    {
                      type: "button",
                      role: "menuitem",
                      style: menuItemStyle,
                      onClick: () => {
                        setOpenMenu(null);
                        setAdding(true);
                      },
                      children: [
                        /* @__PURE__ */ jsx2(Codicon2, { name: "repo-clone", size: 16 }),
                        /* @__PURE__ */ jsx2("span", { children: "Import repo" })
                      ]
                    }
                  ),
                  /* @__PURE__ */ jsx2("div", { "aria-hidden": "true", style: menuSeparatorStyle }),
                  /* @__PURE__ */ jsxs2(
                    "button",
                    {
                      type: "button",
                      role: "menuitem",
                      style: menuItemStyle,
                      onClick: () => {
                        setOpenMenu(null);
                        setShowRepos(true);
                      },
                      children: [
                        /* @__PURE__ */ jsx2(Codicon2, { name: "repo" }),
                        /* @__PURE__ */ jsx2("span", { children: "Repositories" })
                      ]
                    }
                  )
                ] })
              ] }),
              /* @__PURE__ */ jsx2(
                Input2,
                {
                  type: "search",
                  "aria-label": "Find worktrees",
                  value: search,
                  placeholder: "Search worktrees",
                  onChange: (event) => {
                    disarm();
                    setSearch(event.target.value);
                  },
                  style: { height: TOOLBAR_HEIGHT, padding: "0 10px" }
                }
              ),
              /* @__PURE__ */ jsxs2("div", { style: { position: "relative", display: "inline-flex" }, children: [
                /* @__PURE__ */ jsxs2(
                  "div",
                  {
                    style: {
                      display: "inline-flex",
                      alignItems: "stretch",
                      alignSelf: "center",
                      border: "1px solid var(--ui-stroke-secondary)",
                      borderRadius: 4,
                      overflow: "hidden"
                    },
                    children: [
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "button",
                          size: "xs",
                          variant: "ghost",
                          title: "Choose how to sort",
                          "aria-label": "Choose how to sort",
                          "aria-haspopup": "menu",
                          "aria-expanded": openMenu === "sort",
                          onClick: () => setOpenMenu(openMenu === "sort" ? null : "sort"),
                          style: {
                            ...splitPart,
                            ...iconButton(TOOLBAR_HEIGHT),
                            width: 28
                          },
                          children: /* @__PURE__ */ jsx2(Codicon2, { name: "chevron-down" })
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        "span",
                        {
                          "aria-hidden": "true",
                          style: {
                            width: 1,
                            background: "var(--ui-stroke-secondary)"
                          }
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "button",
                          size: "xs",
                          variant: "ghost",
                          title: `Sort: ${SORT_MODES.find((mode) => mode.id === sort)?.label ?? ""}. Click to change the order.`,
                          "aria-label": "Sort worktrees",
                          onClick: () => {
                            const index = SORT_MODES.findIndex((mode) => mode.id === sort);
                            const next = SORT_MODES[(index + 1) % SORT_MODES.length];
                            if (next) {
                              disarm();
                              setSort(next.id);
                            }
                          },
                          style: { ...splitPart, ...iconButton(TOOLBAR_HEIGHT) },
                          children: /* @__PURE__ */ jsx2(
                            Codicon2,
                            {
                              name: SORT_MODES.find((mode) => mode.id === sort)?.icon ?? "history"
                            }
                          )
                        }
                      )
                    ]
                  }
                ),
                openMenu === "sort" && /* @__PURE__ */ jsx2("div", { role: "menu", style: { ...menuStyle, left: "auto", right: 0 }, children: SORT_MODES.map((mode) => /* @__PURE__ */ jsxs2(
                  "button",
                  {
                    type: "button",
                    role: "menuitemradio",
                    "aria-checked": mode.id === sort,
                    style: {
                      ...menuItemStyle,
                      background: mode.id === sort ? "var(--ui-row-active-background)" : "transparent"
                    },
                    onClick: () => {
                      disarm();
                      setSort(mode.id);
                      setOpenMenu(null);
                    },
                    children: [
                      /* @__PURE__ */ jsx2(Codicon2, { name: mode.icon }),
                      /* @__PURE__ */ jsx2("span", { children: mode.label })
                    ]
                  },
                  mode.id
                )) })
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxs2(
          "div",
          {
            style: {
              flex: "1",
              minHeight: 0,
              overflowY: "auto",
              display: "flex",
              flexDirection: "column",
              gap: 10
            },
            children: [
              !online && /* @__PURE__ */ jsx2("p", { role: "status", children: "Gateway offline. Cached results are stale. Actions are disabled." }),
              listing.isPending && online && /* @__PURE__ */ jsx2("p", { role: "status", children: "Loading worktrees\u2026" }),
              collecting && /* @__PURE__ */ jsx2("p", { role: "status", children: "Collecting worktree and pull request state\u2026" }),
              authenticationRequired && /* @__PURE__ */ jsx2("p", { role: "alert", children: "Gateway sign-in or permission is required. Automatic requests are paused. Sign in through Hermes Connections, then select Refresh. Cached results are stale and actions are disabled." }),
              listing.isError && !authenticationRequired && /* @__PURE__ */ jsxs2("p", { role: "alert", children: [
                data ? "Cached results are stale. " : "Cannot load Timber. ",
                message(listing.error),
                " Actions are disabled until a successful refresh."
              ] }),
              error && !authenticationRequired && /* @__PURE__ */ jsxs2("p", { role: "alert", children: [
                error,
                (blockedAdd || blockedCreate) && " The operation may have partially completed. Review the listing, then use Refresh before retrying."
              ] }),
              notice.length > 0 && /* @__PURE__ */ jsx2("div", { role: "status", children: notice.map((text, index) => /* @__PURE__ */ jsx2("p", { style: index ? muted2 : void 0, children: text }, index)) }),
              data?.warnings.length ? /* @__PURE__ */ jsx2("div", { "aria-label": "Backend warnings", children: data.warnings.map((text, index) => /* @__PURE__ */ jsx2("p", { style: muted2, children: text }, index)) }) : null,
              adding && /* @__PURE__ */ jsxs2(
                "form",
                {
                  "aria-label": "Add repository",
                  onSubmit: addRepository,
                  style: boxed,
                  children: [
                    /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                      /* @__PURE__ */ jsx2("span", { style: muted2, children: "Repository URL or path" }),
                      /* @__PURE__ */ jsx2(
                        Input2,
                        {
                          value: source,
                          disabled,
                          placeholder: "git@github.com:org/repo or /path/to/repo",
                          onChange: (event) => setSource(event.target.value)
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                      /* @__PURE__ */ jsx2("span", { style: muted2, children: "Repository name (optional)" }),
                      /* @__PURE__ */ jsx2(
                        Input2,
                        {
                          value: repoName,
                          disabled,
                          onChange: (event) => setRepoName(event.target.value)
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                      /* @__PURE__ */ jsx2("span", { style: muted2, children: "Alias (optional)" }),
                      /* @__PURE__ */ jsx2(
                        Input2,
                        {
                          value: alias,
                          disabled,
                          onChange: (event) => setAlias(event.target.value)
                        }
                      )
                    ] }),
                    /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "submit",
                          size: "sm",
                          disabled: disabled || blockedAdd || !source.trim(),
                          children: running.has("add") ? "Adding\u2026" : "Add repo"
                        }
                      ),
                      /* @__PURE__ */ jsx2(
                        Button2,
                        {
                          type: "button",
                          size: "sm",
                          variant: "ghost",
                          disabled: toolbarBusy,
                          onClick: () => setAdding(false),
                          children: "Cancel"
                        }
                      )
                    ] })
                  ]
                }
              ),
              creating && /* @__PURE__ */ jsxs2("form", { "aria-label": "Create worktree", onSubmit: create, style: boxed, children: [
                /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                  /* @__PURE__ */ jsx2("span", { style: muted2, children: "Repository" }),
                  /* @__PURE__ */ jsx2(
                    "select",
                    {
                      "aria-label": "Create repository",
                      style: selectStyle2,
                      value: createRepo || data?.repositories[0] || "",
                      disabled,
                      onChange: (event) => setCreateRepo(event.target.value),
                      children: data?.repositories.map((item) => /* @__PURE__ */ jsx2("option", { value: item, children: item }, item))
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                  /* @__PURE__ */ jsx2("span", { style: muted2, children: "Branch name (optional \u2014 Timber chooses when empty)" }),
                  /* @__PURE__ */ jsx2(
                    Input2,
                    {
                      value: name,
                      disabled,
                      placeholder: "Let Timber choose",
                      onChange: (event) => setName(event.target.value)
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                  /* @__PURE__ */ jsx2("span", { style: muted2, children: "Upstream (optional)" }),
                  /* @__PURE__ */ jsx2(
                    Input2,
                    {
                      value: upstream,
                      disabled,
                      placeholder: "Repository default",
                      onChange: (event) => setUpstream(event.target.value)
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                  /* @__PURE__ */ jsx2(
                    Button2,
                    {
                      type: "submit",
                      size: "sm",
                      disabled: disabled || blockedCreate,
                      children: running.has("create") ? "Creating\u2026" : "Create worktree"
                    }
                  ),
                  /* @__PURE__ */ jsx2(
                    Button2,
                    {
                      type: "button",
                      size: "sm",
                      variant: "ghost",
                      disabled: toolbarBusy,
                      onClick: () => setCreating(false),
                      children: "Cancel"
                    }
                  )
                ] })
              ] }),
              showRepos && /* @__PURE__ */ jsxs2("div", { role: "group", "aria-label": "Repositories", style: boxed, children: [
                /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                  /* @__PURE__ */ jsx2("strong", { children: "Repositories" }),
                  /* @__PURE__ */ jsx2(
                    Button2,
                    {
                      type: "button",
                      size: "xs",
                      variant: "ghost",
                      disabled: toolbarBusy,
                      style: { marginLeft: "auto" },
                      onClick: () => {
                        setShowRepos(false);
                        setRenaming(null);
                      },
                      children: "Done"
                    }
                  )
                ] }),
                data && data.repositories.length === 0 && /* @__PURE__ */ jsx2("p", { style: muted2, children: "No repositories yet. Import one to start." }),
                (data?.repositories ?? []).map((repo) => {
                  const count = worktrees.filter(
                    (worktree) => worktree.repo === repo
                  ).length;
                  const busy = repoBusy(repo);
                  return /* @__PURE__ */ jsxs2(
                    "div",
                    {
                      style: {
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        borderTop: "1px solid var(--ui-stroke-secondary)",
                        paddingTop: 8
                      },
                      children: [
                        /* @__PURE__ */ jsxs2(
                          "div",
                          {
                            style: {
                              display: "flex",
                              alignItems: "baseline",
                              gap: 8
                            },
                            children: [
                              /* @__PURE__ */ jsx2("span", { style: { minWidth: 0, overflowWrap: "anywhere" }, children: repo }),
                              /* @__PURE__ */ jsx2("span", { style: { ...muted2, marginLeft: "auto" }, children: count === 0 ? "No worktrees" : `${count} worktree${count === 1 ? "" : "s"}` })
                            ]
                          }
                        ),
                        /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                          /* @__PURE__ */ jsx2(
                            Button2,
                            {
                              type: "button",
                              size: "xs",
                              variant: "secondary",
                              disabled: toolbarBusy || busy,
                              title: `Rename ${repo}`,
                              "aria-label": `Rename ${repo}`,
                              "aria-expanded": renaming === repo,
                              onClick: () => {
                                setRenameTo(repo);
                                setRenaming(renaming === repo ? null : repo);
                              },
                              children: "Rename"
                            }
                          ),
                          count === 0 && /* @__PURE__ */ jsx2(
                            Button2,
                            {
                              type: "button",
                              size: "xs",
                              variant: "ghost",
                              disabled: toolbarBusy || busy,
                              title: `Remove repository ${repo}`,
                              "aria-label": `Remove repository ${repo}`,
                              style: { color: REMOVE_COLOR },
                              onClick: () => removeRepository(repo),
                              children: running.has(repoActionId("repo-remove", repo)) ? /* @__PURE__ */ jsx2(Codicon2, { name: "loading", spinning: true }) : /* @__PURE__ */ jsx2(Codicon2, { name: "trash" })
                            }
                          )
                        ] }),
                        renaming === repo && /* @__PURE__ */ jsxs2(
                          "form",
                          {
                            style: { ...stackStyle2, gap: 6 },
                            onSubmit: (event) => {
                              event.preventDefault();
                              if (!toolbarBusy && !busy) renameRepository(repo);
                            },
                            children: [
                              /* @__PURE__ */ jsx2(
                                Input2,
                                {
                                  value: renameTo,
                                  disabled: toolbarBusy || busy,
                                  "aria-label": `New name for ${repo}`,
                                  onChange: (event) => setRenameTo(event.target.value)
                                }
                              ),
                              /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                                /* @__PURE__ */ jsx2(
                                  Button2,
                                  {
                                    type: "submit",
                                    size: "xs",
                                    disabled: toolbarBusy || busy || !renameTo.trim(),
                                    children: running.has(repoActionId("repo-rename", repo)) ? "Renaming\u2026" : "Rename"
                                  }
                                ),
                                /* @__PURE__ */ jsx2(
                                  Button2,
                                  {
                                    type: "button",
                                    size: "xs",
                                    variant: "ghost",
                                    disabled: toolbarBusy || busy,
                                    onClick: () => setRenaming(null),
                                    children: "Cancel"
                                  }
                                )
                              ] })
                            ]
                          }
                        )
                      ]
                    },
                    repo
                  );
                })
              ] }),
              data && filtered.length === 0 && /* @__PURE__ */ jsx2("p", { children: worktrees.length ? "No matching worktrees." : "No worktrees yet. Create one above." }),
              /* @__PURE__ */ jsx2(
                "ul",
                {
                  "aria-label": "Worktrees",
                  style: {
                    ...stackStyle2,
                    listStyle: "none",
                    margin: 0,
                    padding: 0
                  },
                  children: filtered.map((worktree) => {
                    const key = rowKey(worktree);
                    const pr = data?.prs[key];
                    const stack = pr?.stack ?? null;
                    const prUrl = pr?.url ?? null;
                    const repoUrl = pr?.repo ? `https://github.com/${pr.repo}` : null;
                    const merged = worktree.merged;
                    const currentRow = Boolean(cwd) && worktree.path === cwd;
                    const action = actionFor(worktree, pr, prsLoaded);
                    const color = actionColor(action, worktree, pr?.checks);
                    const behind = worktree.behind ?? 0;
                    const canRebase = worktree.clean && !worktree.statusError && behind > 0;
                    const rebaseHint = !worktree.clean || worktree.statusError ? "Rebase requires a clean worktree; commit or stash changes first" : `Rebase ${behind} commit${behind === 1 ? "" : "s"} onto ${worktree.upstream ?? "upstream"}; conflicts are aborted`;
                    return /* @__PURE__ */ jsxs2(
                      "li",
                      {
                        "data-worktree": `${worktree.repo}/${worktree.name}`,
                        title: currentRow ? "This session works here" : void 0,
                        style: {
                          position: "relative",
                          display: "flex",
                          flexDirection: "column",
                          gap: 6,
                          borderTop: "1px solid var(--ui-stroke-secondary)",
                          padding: "10px 10px 10px 12px"
                        },
                        children: [
                          currentRow && /* @__PURE__ */ jsx2(
                            "span",
                            {
                              "aria-hidden": "true",
                              style: {
                                position: "absolute",
                                left: 2,
                                top: 9,
                                bottom: 9,
                                width: 3,
                                borderRadius: 2,
                                background: "var(--ui-accent)",
                                opacity: 0.85
                              }
                            }
                          ),
                          /* @__PURE__ */ jsxs2(
                            "div",
                            {
                              style: {
                                display: "flex",
                                alignItems: "baseline",
                                gap: 8
                              },
                              children: [
                                /* @__PURE__ */ jsxs2("span", { style: { minWidth: 0, overflowWrap: "anywhere" }, children: [
                                  /* @__PURE__ */ jsx2("strong", { title: worktree.path, children: worktree.name }),
                                  /* @__PURE__ */ jsx2("span", { style: muted2, children: " @ " }),
                                  repoUrl ? /* @__PURE__ */ jsx2(
                                    "a",
                                    {
                                      href: repoUrl,
                                      title: repoUrl,
                                      style: { ...muted2, textDecoration: "underline" },
                                      onClick: (event) => {
                                        event.preventDefault();
                                        openRepo(pr);
                                      },
                                      children: worktree.repo
                                    }
                                  ) : /* @__PURE__ */ jsx2(
                                    "span",
                                    {
                                      style: muted2,
                                      title: worktree.upstream ? `Upstream: ${worktree.upstream}` : "No upstream",
                                      children: worktree.repo
                                    }
                                  )
                                ] }),
                                !stack && prUrl && /* @__PURE__ */ jsxs2(
                                  "a",
                                  {
                                    href: prUrl,
                                    title: pr?.title || prUrl,
                                    style: {
                                      ...muted2,
                                      marginLeft: "auto",
                                      flex: "none",
                                      whiteSpace: "nowrap"
                                    },
                                    onClick: (event) => {
                                      event.preventDefault();
                                      openPr(worktree, pr);
                                    },
                                    children: [
                                      "PR #",
                                      pr?.number
                                    ]
                                  }
                                ),
                                !stack && !prUrl && worktree.pullRequest && /* @__PURE__ */ jsxs2(
                                  "span",
                                  {
                                    style: {
                                      ...muted2,
                                      marginLeft: "auto",
                                      flex: "none",
                                      whiteSpace: "nowrap"
                                    },
                                    children: [
                                      "PR ",
                                      worktree.pullRequest
                                    ]
                                  }
                                )
                              ]
                            }
                          ),
                          stack && /* @__PURE__ */ jsx2(
                            StackLines,
                            {
                              stack,
                              worktree,
                              busy: disabled || rowBusy(worktree) || toolbarBusy,
                              onOpen: (entry) => void context.os.openExternal(entry.url),
                              onOpenStack: () => void context.os.openExternal(stack.url),
                              onMerge: (entry) => merge(worktree, entry.number)
                            }
                          ),
                          /* @__PURE__ */ jsxs2("div", { style: { display: "flex", alignItems: "center" }, children: [
                            /* @__PURE__ */ jsx2(
                              Button2,
                              {
                                type: "button",
                                size: "xs",
                                variant: "ghost",
                                disabled: disabled || rowBusy(worktree),
                                title: `Open session in ${worktree.path}`,
                                "aria-label": `Open session in ${worktree.name}@${worktree.repo}`,
                                onClick: () => run(rowActionId("open", worktree), () => open(worktree)),
                                style: iconButton(TOOLBAR_HEIGHT),
                                children: running.has(rowActionId("open", worktree)) ? /* @__PURE__ */ jsx2(Codicon2, { name: "loading", spinning: true }) : /* @__PURE__ */ jsx2(Codicon2, { name: "comment-discussion", size: 17 })
                              }
                            ),
                            /* @__PURE__ */ jsx2(
                              "span",
                              {
                                style: {
                                  ...rowItem,
                                  ...muted2,
                                  minWidth: 52,
                                  marginLeft: 20,
                                  gap: 4,
                                  flex: "none"
                                },
                                "aria-label": worktree.todoTotal !== void 0 ? `TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done` : void 0,
                                title: worktree.todoTotal !== void 0 ? `TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done` : "No TODOs",
                                children: worktree.todoTotal !== void 0 && /* @__PURE__ */ jsxs2(Fragment, { children: [
                                  /* @__PURE__ */ jsx2(Codicon2, { name: "check-all" }),
                                  worktree.todoDone ?? 0,
                                  "/",
                                  worktree.todoTotal
                                ] })
                              }
                            ),
                            /* @__PURE__ */ jsxs2(
                              "span",
                              {
                                role: "img",
                                "aria-label": worktree.review ? `Review ${worktree.review.approved} of ${worktree.review.total} commits approved` : "Review status unknown",
                                title: worktree.review ? `Review ${worktree.review.approved} of ${worktree.review.total} commits approved` : "Review status unknown",
                                style: {
                                  ...rowItem,
                                  ...muted2,
                                  minWidth: 48,
                                  marginLeft: 8,
                                  gap: 4,
                                  flex: "none"
                                },
                                children: [
                                  /* @__PURE__ */ jsx2(Codicon2, { name: "eye" }),
                                  worktree.review ? `${worktree.review.approved}/${worktree.review.total}` : "?"
                                ]
                              }
                            ),
                            /* @__PURE__ */ jsxs2(
                              "div",
                              {
                                style: {
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  marginLeft: "auto"
                                },
                                children: [
                                  /* @__PURE__ */ jsxs2(
                                    "span",
                                    {
                                      style: {
                                        ...rowItem,
                                        ...muted2,
                                        width: 64,
                                        flex: "none",
                                        justifyContent: "flex-end"
                                      },
                                      children: [
                                        (worktree.ahead ?? 0) > 0 && /* @__PURE__ */ jsxs2(
                                          "span",
                                          {
                                            title: `${worktree.ahead} commit${worktree.ahead === 1 ? "" : "s"} ahead`,
                                            children: [
                                              "\u2191",
                                              worktree.ahead
                                            ]
                                          }
                                        ),
                                        (worktree.behind ?? 0) > 0 && /* @__PURE__ */ jsx2(
                                          Button2,
                                          {
                                            type: "button",
                                            size: "xs",
                                            variant: "ghost",
                                            disabled: disabled || rowBusy(worktree) || !canRebase,
                                            title: rebaseHint,
                                            "aria-label": `Rebase ${behind} commit${behind === 1 ? "" : "s"} from upstream for ${worktree.name}@${worktree.repo}`,
                                            onClick: () => rebase(worktree),
                                            style: {
                                              ...rowItem,
                                              minWidth: 0,
                                              minHeight: 0,
                                              height: 28,
                                              padding: "0 2px",
                                              fontSize: 13,
                                              whiteSpace: "nowrap",
                                              color: "var(--ui-text-secondary)"
                                            },
                                            children: running.has(rowActionId("rebase", worktree)) ? /* @__PURE__ */ jsx2(Codicon2, { name: "loading", spinning: true, size: 12 }) : `\u2193${behind}`
                                          }
                                        )
                                      ]
                                    }
                                  ),
                                  /* @__PURE__ */ jsx2(
                                    RowActionButton,
                                    {
                                      action,
                                      color,
                                      worktree,
                                      pr,
                                      preview,
                                      disabled: disabled || rowBusy(worktree),
                                      running,
                                      onDelete: () => remove(worktree),
                                      onPush: () => push(worktree),
                                      onMerge: () => merge(worktree),
                                      onOpenPr: () => openPr(worktree, pr),
                                      onCreatePr: () => {
                                        setPrWorktree(worktree);
                                        setPrTitle("");
                                        setPrBody("");
                                        setError(null);
                                      }
                                    }
                                  )
                                ]
                              }
                            )
                          ] }),
                          prWorktree && prWorktree.repo === worktree.repo && prWorktree.name === worktree.name && /* @__PURE__ */ jsxs2(
                            "form",
                            {
                              style: boxed,
                              onSubmit: (event) => {
                                event.preventDefault();
                                if (!toolbarBusy && !rowBusy(worktree)) {
                                  createPr(worktree);
                                }
                              },
                              children: [
                                /* @__PURE__ */ jsxs2("strong", { children: [
                                  "Create PR for ",
                                  worktree.name,
                                  "@",
                                  worktree.repo
                                ] }),
                                /* @__PURE__ */ jsx2("span", { style: muted2, children: "Leave both fields empty to use the commits ahead of the upstream. A draft session continues if you cancel." }),
                                /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                                  /* @__PURE__ */ jsx2("span", { style: muted2, children: "Subject" }),
                                  /* @__PURE__ */ jsx2(
                                    Input2,
                                    {
                                      value: prTitle,
                                      disabled: toolbarBusy || rowBusy(worktree),
                                      onChange: (event) => setPrTitle(event.target.value)
                                    }
                                  )
                                ] }),
                                /* @__PURE__ */ jsxs2("label", { style: stackStyle2, children: [
                                  /* @__PURE__ */ jsx2("span", { style: muted2, children: "Body" }),
                                  /* @__PURE__ */ jsx2(
                                    "textarea",
                                    {
                                      value: prBody,
                                      disabled: toolbarBusy || rowBusy(worktree),
                                      rows: 5,
                                      style: {
                                        ...selectStyle2,
                                        resize: "vertical",
                                        fontFamily: "inherit"
                                      },
                                      onChange: (event) => setPrBody(event.target.value)
                                    }
                                  )
                                ] }),
                                /* @__PURE__ */ jsxs2("div", { style: rowStyle, children: [
                                  /* @__PURE__ */ jsx2(
                                    Button2,
                                    {
                                      type: "submit",
                                      size: "sm",
                                      disabled: toolbarBusy || rowBusy(worktree) || prBody.trim() !== "" && prTitle.trim() === "",
                                      children: running.has(rowActionId("pr", worktree)) ? "Creating\u2026" : "Create PR"
                                    }
                                  ),
                                  /* @__PURE__ */ jsx2(
                                    Button2,
                                    {
                                      type: "button",
                                      size: "sm",
                                      variant: "ghost",
                                      disabled: toolbarBusy || rowBusy(worktree),
                                      onClick: () => setPrWorktree(null),
                                      children: "Cancel"
                                    }
                                  )
                                ] })
                              ]
                            }
                          ),
                          (worktree.statusError || merged && !canRemove(worktree, pr)) && /* @__PURE__ */ jsx2("p", { style: muted2, role: "status", children: worktree.statusError ? "Git status could not be read. Removal is disabled." : "Merged, but has uncommitted changes or an open stack PR. Finish them to remove." })
                        ]
                      },
                      `${worktree.repo}/${worktree.name}`
                    );
                  })
                }
              )
            ]
          }
        ),
        /* @__PURE__ */ jsxs2(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              flex: "none",
              borderTop: "1px solid var(--ui-stroke-secondary)",
              paddingTop: 10
            },
            children: [
              /* @__PURE__ */ jsxs2("span", { style: { ...muted2, marginRight: "auto" }, "aria-live": "polite", children: [
                data ? `${filtered.length} of ${worktrees.length} worktrees` : "",
                collecting ? " \xB7 Collecting\u2026" : toolbarBusy ? " \xB7 Working\u2026" : ""
              ] }),
              data ? /* @__PURE__ */ jsx2(
                "span",
                {
                  style: { ...muted2, minWidth: 64, textAlign: "right" },
                  title: data.fetchError ? data.fetchError : "Worktrees and remotes refreshed",
                  children: timeAgo(data.fetchedAt)
                }
              ) : /* @__PURE__ */ jsx2("span", { style: { ...muted2, minWidth: 64, textAlign: "right" }, children: "Stale" }),
              /* @__PURE__ */ jsx2(
                Button2,
                {
                  type: "button",
                  size: "xs",
                  variant: "ghost",
                  disabled: toolbarBusy || !online,
                  title: "Refresh: list worktrees and fetch their remotes",
                  "aria-label": "Refresh",
                  onClick: () => run("refresh", async () => {
                    const response = await post("/fetch", {});
                    const errors = record(response) && Array.isArray(response.errors) ? response.errors.filter(
                      (item) => typeof item === "string"
                    ) : [];
                    await refresh();
                    if (errors.length)
                      setNotice([`Fetch reported: ${errors.join("; ")}`]);
                    setError(null);
                    setBlockedCreate(false);
                    setBlockedAdd(false);
                  }),
                  style: iconButton(TOOLBAR_HEIGHT),
                  children: running.has("refresh") ? /* @__PURE__ */ jsx2(Codicon2, { name: "loading", spinning: true }) : /* @__PURE__ */ jsx2(Codicon2, { name: "refresh" })
                }
              )
            ]
          }
        )
      ]
    }
  );
}
function RowActionButton({
  action,
  color,
  worktree,
  pr,
  preview,
  disabled,
  running,
  onDelete,
  onPush,
  onMerge,
  onOpenPr,
  onCreatePr
}) {
  const armed = preview?.worktree.path === worktree.path;
  const idFor = (verb2) => rowActionId(verb2, worktree);
  if (action === null)
    return /* @__PURE__ */ jsx2(
      "span",
      {
        "aria-hidden": "true",
        style: { width: TOOLBAR_HEIGHT, flexShrink: 0 }
      }
    );
  const title = action === "delete" ? armed ? `Click again within 5s to delete ${preview?.worktree.name}@${preview?.worktree.repo}, branch ${preview?.branch}, and its directory.` : `Remove ${worktree.name}@${worktree.repo}` : action === "push" ? `Push ${pr?.unpushed ?? 0} commit${pr?.unpushed === 1 ? "" : "s"} to origin/${worktree.name}` : action === "merge" ? `Merge PR #${pr?.number}` : action === "open-pr" ? pr?.mergeBlocker ? `Cannot merge yet (${pr.mergeBlocker}); open PR #${pr.number}` : `Open PR #${pr?.number}` : action === "create-pr" ? `Open or create a PR for ${worktree.name}@${worktree.repo}` : `origin/${worktree.name} has commits this worktree lacks. Pull or rebase before opening or updating a PR.`;
  const onClick = action === "delete" ? onDelete : action === "push" ? onPush : action === "merge" ? onMerge : action === "open-pr" ? onOpenPr : action === "create-pr" ? onCreatePr : void 0;
  const verb = action === "delete" ? "remove" : action === "push" ? "push" : action === "merge" ? "merge" : action === "create-pr" ? "pr" : null;
  return /* @__PURE__ */ jsx2(
    Button2,
    {
      type: "button",
      size: "xs",
      variant: "ghost",
      disabled: disabled || action === "blocked",
      title,
      "aria-label": title,
      style: { ...iconButton(TOOLBAR_HEIGHT), color },
      onClick,
      children: verb !== null && running.has(idFor(verb)) ? /* @__PURE__ */ jsx2(Codicon2, { name: "loading", spinning: true }) : action === "delete" ? /* @__PURE__ */ jsx2(Codicon2, { name: "trash", size: 15 }) : action === "push" ? /* @__PURE__ */ jsx2(Codicon2, { name: "cloud-upload", size: 16 }) : action === "merge" ? /* @__PURE__ */ jsx2(Codicon2, { name: "git-merge", size: 16 }) : action === "open-pr" ? /* @__PURE__ */ jsx2(Codicon2, { name: "git-pull-request", size: 16 }) : action === "create-pr" ? /* @__PURE__ */ jsx2(Codicon2, { name: "git-pull-request-create", size: 16 }) : /* @__PURE__ */ jsx2(Codicon2, { name: "warning", size: 16 })
    }
  );
}
function StackLines({
  stack,
  worktree,
  busy,
  onOpen,
  onOpenStack,
  onMerge
}) {
  const allMerged = stack.prs.every((entry) => entry.state !== "OPEN");
  return /* @__PURE__ */ jsxs2(
    "div",
    {
      role: "group",
      "aria-label": `Stack #${stack.number} of ${worktree.name}@${worktree.repo}`,
      style: {
        display: "flex",
        flexDirection: "column",
        gap: 4,
        border: "1px solid var(--ui-stroke-secondary)",
        borderRadius: 4,
        padding: "6px 8px"
      },
      children: [
        /* @__PURE__ */ jsxs2("div", { style: { display: "flex", alignItems: "baseline", gap: 6 }, children: [
          /* @__PURE__ */ jsx2(Codicon2, { name: "layers", style: { color: "var(--ui-accent)" } }),
          /* @__PURE__ */ jsxs2(
            "a",
            {
              href: stack.url,
              onClick: (event) => {
                event.preventDefault();
                onOpenStack();
              },
              title: stack.url,
              style: {
                color: "var(--ui-accent)",
                fontWeight: 600,
                fontSize: 12
              },
              children: [
                "Stack #",
                stack.number
              ]
            }
          ),
          /* @__PURE__ */ jsxs2("span", { style: faint, children: [
            "\xB7 ",
            stack.size,
            " PRs"
          ] }),
          /* @__PURE__ */ jsx2("span", { style: faint, children: allMerged ? "all merged" : "top PR merges all" })
        ] }),
        stack.prs.map((entry) => {
          const color = entry.state === "MERGED" ? "var(--ui-purple)" : entry.blocker ? "var(--ui-red)" : entry.checks === "pending" ? "var(--ui-yellow)" : "var(--ui-green)";
          return /* @__PURE__ */ jsxs2(
            "div",
            {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 6,
                paddingLeft: entry.current ? 0 : 8
              },
              children: [
                /* @__PURE__ */ jsx2(
                  "span",
                  {
                    style: {
                      ...faint,
                      minWidth: 0,
                      overflowWrap: "anywhere"
                    },
                    children: entry.branch || `PR #${entry.number}`
                  }
                ),
                /* @__PURE__ */ jsxs2(
                  "a",
                  {
                    href: entry.url,
                    title: entry.title || entry.url,
                    style: { ...muted2, flex: "none" },
                    onClick: (event) => {
                      event.preventDefault();
                      onOpen(entry);
                    },
                    children: [
                      "#",
                      entry.number
                    ]
                  }
                ),
                /* @__PURE__ */ jsx2("span", { style: { ...faint, marginLeft: "auto", flex: "none" }, children: entry.state === "MERGED" ? "merged" : entry.state === "CLOSED" ? "closed" : entry.blocker ?? "ready" }),
                entry.state === "OPEN" && /* @__PURE__ */ jsx2(
                  Button2,
                  {
                    type: "button",
                    size: "xs",
                    variant: "ghost",
                    disabled: busy || entry.blocker !== null,
                    title: entry.blocker ? `Cannot merge: ${entry.blocker}` : `Merge the stack through PR #${entry.number}`,
                    "aria-label": `Merge stack PR #${entry.number}`,
                    style: { ...iconButton(24), color },
                    onClick: () => onMerge(entry),
                    children: /* @__PURE__ */ jsx2(Codicon2, { name: "git-merge", size: 15 })
                  }
                )
              ]
            },
            entry.number
          );
        })
      ]
    }
  );
}
var menuStyle = {
  position: "absolute",
  top: `calc(100% + 4px)`,
  left: 0,
  zIndex: 5,
  minWidth: 170,
  padding: 4,
  background: "var(--ui-bg-elevated)",
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)"
};
var menuItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "var(--ui-text-primary)",
  textAlign: "left",
  whiteSpace: "nowrap",
  cursor: "pointer"
};
var menuSeparatorStyle = {
  display: "block",
  height: 1,
  margin: "4px 0",
  background: "var(--ui-stroke-secondary)"
};

// ui/page.tsx
import { jsx as jsx3 } from "react/jsx-runtime";
function TimberPage({ context }) {
  const scope = useScope();
  return /* @__PURE__ */ jsx3(
    WorktreeView,
    {
      context,
      scope: scope.key,
      online: scope.online,
      cwd: scope.cwd,
      surface: "page"
    },
    JSON.stringify([scope.key, scope.online])
  );
}
function TimberTodosPage({ context }) {
  const scope = useScope();
  return /* @__PURE__ */ jsx3(
    TodoView,
    {
      context,
      scope: scope.key,
      online: scope.online,
      cwd: scope.cwd,
      surface: "page"
    },
    JSON.stringify([scope.key, scope.online])
  );
}

// ui/panel.tsx
import { jsx as jsx4 } from "react/jsx-runtime";
function TimberPanel({ context }) {
  const scope = useScope();
  return /* @__PURE__ */ jsx4(
    WorktreeView,
    {
      context,
      scope: scope.key,
      online: scope.online,
      cwd: scope.cwd,
      surface: "panel"
    },
    JSON.stringify([scope.key, scope.online])
  );
}
function TimberTodosPanel({ context }) {
  const scope = useScope();
  return /* @__PURE__ */ jsx4(
    TodoView,
    {
      context,
      scope: scope.key,
      online: scope.online,
      cwd: scope.cwd,
      surface: "panel"
    },
    JSON.stringify([scope.key, scope.online])
  );
}

// ui/plugin.tsx
import { jsx as jsx5 } from "react/jsx-runtime";
var plugin = {
  id: "hermes-timber",
  name: "Timber",
  description: "Manage Timber worktrees, repositories, TODOs, and pull requests in Hermes.",
  register(context) {
    let syncing = false;
    const sync = {
      id: "sync-projects",
      label: "Timber: Sync Projects",
      keywords: ["timber", "worktree", "repository", "project"],
      run: () => {
        if (syncing) return;
        const scope = scopeKey();
        try {
          assertScope(scope);
        } catch (error) {
          host3.notify({ kind: "error", message: message(error) });
          return;
        }
        syncing = true;
        void (async () => {
          try {
            const result = await context.rest("/sync", {
              method: "POST",
              body: {}
            });
            assertScope(scope);
            const warnings = responseWarnings(result);
            await queryClient.invalidateQueries({
              queryKey: ["hermes-timber", scope, "state"],
              exact: true
            });
            assertScope(scope);
            host3.notify({
              kind: warnings.length ? "warning" : "success",
              message: warnings.length ? warnings.join("\n") : "Projects synced."
            });
          } catch (error) {
            if (scopeKey() === scope && host3.state.gateway.get() === "open")
              host3.notify({
                kind: "error",
                message: `Project sync failed: ${message(error)}`
              });
          } finally {
            syncing = false;
          }
        })();
      }
    };
    const showWorktrees = {
      id: "show-timber",
      label: "Timber: Show worktrees",
      keywords: ["worktree", "repository", "branch", "project"],
      run: () => host3.navigate("/timber")
    };
    const showTodos = {
      id: "show-timber-todos",
      label: "Timber: Show TODOs",
      keywords: ["todo", "task", "checklist", "timber"],
      run: () => host3.navigate("/timber-todos")
    };
    const shortcut = {
      id: "hermes-timber.show",
      label: "Show Timber worktrees",
      category: "view",
      defaults: [],
      run: () => host3.revealPane("hermes-timber:panel")
    };
    context.registerMany([
      {
        id: "page",
        area: ROUTES_AREA,
        title: "Timber",
        data: { path: "/timber" },
        render: () => /* @__PURE__ */ jsx5(TimberPage, { context })
      },
      {
        id: "todos-page",
        area: ROUTES_AREA,
        title: "Timber TODOs",
        data: { path: "/timber-todos" },
        render: () => /* @__PURE__ */ jsx5(TimberTodosPage, { context })
      },
      {
        id: "nav",
        area: SIDEBAR_NAV_AREA,
        order: 60,
        data: {
          codicon: "git-branch",
          label: "Timber",
          path: "/timber"
        }
      },
      {
        id: "todos-nav",
        area: SIDEBAR_NAV_AREA,
        order: 61,
        data: {
          codicon: "checklist",
          label: "Timber TODOs",
          path: "/timber-todos"
        }
      },
      {
        id: "panel",
        area: "panes",
        title: "Worktrees",
        data: {
          placement: "right",
          width: "440px",
          collapsible: true
        },
        render: () => /* @__PURE__ */ jsx5(TimberPanel, { context })
      },
      {
        id: "todos-panel",
        area: "panes",
        title: "TODOs",
        data: {
          placement: "right",
          width: "400px",
          collapsible: true
        },
        render: () => /* @__PURE__ */ jsx5(TimberTodosPanel, { context })
      },
      { id: shortcut.id, area: KEYBINDS_AREA, data: shortcut },
      { id: showWorktrees.id, area: PALETTE_AREA, data: showWorktrees },
      { id: showTodos.id, area: PALETTE_AREA, data: showTodos },
      { id: sync.id, area: PALETTE_AREA, data: sync }
    ]);
  }
};
var plugin_default = plugin;
export {
  plugin_default as default
};
