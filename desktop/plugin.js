// ui/plugin.tsx
import { host as host3, KEYBINDS_AREA, PALETTE_AREA } from "@hermes/plugin-sdk";

// ui/panel.tsx
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  Codicon,
  host as host2,
  Input,
  useMutation,
  useQuery,
  useQueryClient
} from "@hermes/plugin-sdk";

// ui/contracts.ts
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function isWorktree(value) {
  if (!record(value)) return false;
  return ["name", "repo", "path"].every((key) => typeof value[key] === "string") && typeof value.clean === "boolean" && typeof value.merged === "boolean" && ["upstream", "commit"].every(
    (key) => value[key] == null || typeof value[key] === "string"
  ) && typeof value.statusError === "boolean" && ["ahead", "behind", "todoDone", "todoTotal"].every(
    (key) => value[key] === void 0 || typeof value[key] === "number" && Number.isFinite(value[key])
  ) && (value.pullRequest === void 0 || typeof value.pullRequest === "string");
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
    warnings: value.warnings
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
  return worktree.clean && worktree.merged && !worktree.statusError;
}
function responseWarnings(value) {
  if (!record(value) || !strings(value.warnings))
    throw new Error(
      "The Timber backend returned an invalid mutation response."
    );
  return value.warnings;
}
function message(error) {
  return error instanceof Error ? error.message : "The operation failed.";
}

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
  return JSON.stringify([scopeKey(), host.state.gateway.get()]);
}
function subscribe(changed) {
  const disposers = [
    host.state.profile.listen(changed),
    host.state.connectionId.listen(changed),
    host.state.gateway.listen(changed),
    host.onEvent("*", changed)
  ];
  return () => disposers.forEach((dispose) => dispose());
}
function useScope() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return { key: scopeKey(), online: host.state.gateway.get() === "open" };
}
function assertScope(key) {
  if (scopeKey() !== key || host.state.gateway.get() !== "open") {
    throw new Error(
      "The gateway changed or is offline. Refresh Timber before continuing."
    );
  }
}

// ui/panel.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var stack = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0
};
var row = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6
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
function TimberPanel({ context }) {
  const scope = useScope();
  return /* @__PURE__ */ jsx(
    ScopedPanel,
    {
      context,
      scope: scope.key,
      online: scope.online
    },
    JSON.stringify([scope.key, scope.online])
  );
}
function ScopedPanel({
  context,
  scope,
  online
}) {
  const client = useQueryClient();
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && scopeKey() === scope;
  const consentVersion = useRef(0);
  const consentTimer = useRef(null);
  const consent = useRef(null);
  const consentSnapshot = useRef("");
  const consentDeadline = useRef(0);
  const actionLocked = useRef(false);
  const disarm = () => {
    consentVersion.current++;
    consent.current = null;
    if (consentTimer.current !== null) clearTimeout(consentTimer.current);
    consentTimer.current = null;
    setPreview(null);
  };
  useEffect(
    () => () => {
      consentVersion.current++;
      if (consentTimer.current !== null) clearTimeout(consentTimer.current);
    },
    []
  );
  const queryKey = ["hermes-timber", scope, "state"];
  const consecutiveFailures = useRef(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(
    () => authenticationFailure(client.getQueryState(queryKey)?.error)
  );
  const pauseForAuthentication = (failure) => {
    if (current() && authenticationFailure(failure))
      setAuthenticationRequired(true);
  };
  const listing = useQuery({
    queryKey,
    queryFn: async () => {
      assertScope(scope);
      disarm();
      try {
        const result = parseState(await context.rest("/state"));
        assertScope(scope);
        consecutiveFailures.current = 0;
        setAuthenticationRequired(false);
        return result;
      } catch (failure) {
        consecutiveFailures.current++;
        pauseForAuthentication(failure);
        throw failure;
      }
    },
    enabled: online && !authenticationRequired,
    refetchInterval: () => authenticationRequired ? false : pollDelay(consecutiveFailures.current),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 1e4
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [creating, setCreating] = useState(false);
  const [createRepo, setCreateRepo] = useState("");
  const [name, setName] = useState("");
  const [upstream, setUpstream] = useState("");
  const [preview, setPreview] = useState(null);
  const [notice, setNotice] = useState([]);
  const [error, setError] = useState(null);
  const [recent, setRecent] = useState({});
  const data = listing.data;
  const ready = online && !authenticationRequired && Boolean(data) && !listing.isError;
  const check = () => {
    assertScope(scope);
    if (authenticationRequired || !alive.current || client.getQueryState(queryKey)?.status !== "success") {
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
  const operation = useMutation({
    mutationKey: ["hermes-timber", scope, "operation"],
    retry: false,
    mutationFn: async (run2) => {
      check();
      await run2();
    },
    onMutate: () => {
      setError(null);
      setNotice([]);
    },
    onError: (failure) => {
      if (current()) {
        pauseForAuthentication(failure);
        setError(message(failure));
        setPreview(null);
      }
    }
  });
  const busy = operation.isPending;
  const disabled = !ready || busy || error !== null || listing.isFetching;
  const run = (action) => {
    if (actionLocked.current) return;
    actionLocked.current = true;
    operation.mutate(action, {
      onSettled: () => {
        actionLocked.current = false;
      }
    });
  };
  const warnings = (response) => {
    const result = responseWarnings(response);
    if (current()) setNotice(result.length ? result : ["Completed."]);
  };
  async function open(worktree) {
    check();
    const project = data?.projects[worktree.repo];
    if (!project)
      throw new Error(
        "No Hermes Project exists for this repository. Select Sync Projects first."
      );
    const selected = await host2.request("projects.set_active", {
      id: project,
      profile: host2.state.profile.get()
    });
    check();
    if (!record(selected) || selected.active_id !== project)
      throw new Error("Hermes did not activate the repository Project.");
    const created = await host2.request("session.create", {
      cwd: worktree.path,
      title: worktree.name,
      source: "desktop",
      profile: host2.state.profile.get()
    });
    check();
    if (!record(created) || typeof created.stored_session_id !== "string" || !created.stored_session_id || !record(created.info) || created.info.cwd !== worktree.path) {
      throw new Error(
        "Hermes did not confirm the requested working directory. The chat was not opened."
      );
    }
    await host2.openSession(created.stored_session_id, {
      profile: host2.state.profile.get(),
      awaitHydration: true,
      keepAllProfilesScope: true
    });
    check();
    const moved = await host2.request("session.workspace.move", {
      session_key: created.stored_session_id,
      cwd: worktree.path,
      profile: host2.state.profile.get()
    });
    check();
    if (!record(moved) || moved.cwd !== worktree.path)
      throw new Error("Hermes did not confirm the opened chat's workspace.");
    setRecent((previous) => ({ ...previous, [worktree.path]: Date.now() }));
    setNotice([`Opened ${worktree.name}@${worktree.repo} in Hermes.`]);
  }
  async function prepareRemove(worktree) {
    if (!safeToRemove(worktree))
      throw new Error(
        "Only clean, merged worktrees without status errors can be removed."
      );
    const version = consentVersion.current;
    const snapshot2 = JSON.stringify(worktree);
    const result = parsePreview(
      await post("/remove/preview", {
        repo: worktree.repo,
        name: worktree.name
      })
    );
    if (!safeToRemove(result.worktree) || result.worktree.repo !== worktree.repo || result.worktree.name !== worktree.name || result.worktree.path !== worktree.path) {
      throw new Error(
        "The worktree changed. Refresh Timber before requesting another preview."
      );
    }
    const latest = client.getQueryData(queryKey)?.worktrees.find(
      (item) => item.repo === worktree.repo && item.name === worktree.name
    );
    if (!current() || version !== consentVersion.current || JSON.stringify(latest) !== snapshot2)
      return;
    consentSnapshot.current = snapshot2;
    consentDeadline.current = Date.now() + 5e3;
    consent.current = result;
    setPreview(result);
    consentTimer.current = setTimeout(disarm, 5e3);
  }
  function create(event) {
    event.preventDefault();
    run(async () => {
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
      warnings(response);
      if (current()) {
        setCreating(false);
        setName("");
        setUpstream("");
      }
      await refresh();
    });
  }
  const filtered = (data?.worktrees ?? []).filter((worktree) => {
    const needle = search.trim().toLocaleLowerCase();
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
      worktree.pullRequest ?? ""
    ];
    return fields.some((field) => field.toLocaleLowerCase().includes(needle));
  }).sort((left, right) => {
    if (sort === "recent") {
      const difference = (recent[right.path] ?? 0) - (recent[left.path] ?? 0);
      if (difference) return difference;
      return 0;
    }
    return (sort === "repo" ? left.repo.localeCompare(right.repo) : left.name.localeCompare(right.name)) || left.repo.localeCompare(right.repo) || left.name.localeCompare(right.name);
  });
  const previewCurrent = preview && data?.worktrees.some(
    (worktree) => worktree.repo === preview.worktree.repo && worktree.name === preview.worktree.name && worktree.path === preview.worktree.path && worktree.commit === preview.worktree.commit && safeToRemove(worktree)
  );
  return /* @__PURE__ */ jsxs(
    "section",
    {
      "aria-label": "Timber worktrees",
      style: {
        ...stack,
        padding: 12,
        height: "100%",
        overflow: "auto",
        color: "var(--ui-text-primary)",
        fontSize: 13
      },
      children: [
        /* @__PURE__ */ jsxs("header", { style: stack, children: [
          /* @__PURE__ */ jsxs("div", { style: { ...row, justifyContent: "space-between" }, children: [
            /* @__PURE__ */ jsx("strong", { children: "Timber" }),
            /* @__PURE__ */ jsxs("div", { style: row, children: [
              /* @__PURE__ */ jsx(Badge, { variant: ready ? "muted" : "warn", children: !online ? "Offline" : authenticationRequired ? "Sign-in required" : listing.isError ? "Stale" : "Connected" }),
              /* @__PURE__ */ jsx(
                Button,
                {
                  type: "button",
                  size: "xs",
                  variant: "ghost",
                  disabled: !online || busy || listing.isFetching,
                  "aria-label": authenticationRequired ? "Retry after sign-in" : "Refresh",
                  title: authenticationRequired ? "Retry after sign-in" : "Reload worktrees",
                  onClick: () => {
                    setError(null);
                    void refresh().catch((failure) => {
                      if (current()) setError(message(failure));
                    });
                  },
                  children: /* @__PURE__ */ jsx(Codicon, { name: "refresh" })
                }
              )
            ] })
          ] }),
          data && /* @__PURE__ */ jsxs("div", { style: muted, children: [
            data.host,
            " \xB7 ",
            host2.state.profile.get(),
            /* @__PURE__ */ jsx("br", {}),
            data.hermes_home
          ] }),
          /* @__PURE__ */ jsxs("div", { style: row, children: [
            /* @__PURE__ */ jsx(
              Button,
              {
                type: "button",
                size: "sm",
                variant: "secondary",
                disabled: disabled || !data?.repositories.length,
                onClick: () => {
                  disarm();
                  setCreating((value) => !value);
                },
                children: "New worktree"
              }
            ),
            /* @__PURE__ */ jsx(
              Button,
              {
                type: "button",
                size: "sm",
                variant: "outline",
                disabled,
                onClick: () => {
                  disarm();
                  run(async () => {
                    warnings(await post("/sync", {}));
                    await refresh();
                  });
                },
                children: "Sync Projects"
              }
            )
          ] })
        ] }),
        !online && /* @__PURE__ */ jsx("p", { role: "status", children: "Gateway offline. Cached results are stale. Actions are disabled." }),
        listing.isPending && online && /* @__PURE__ */ jsx("p", { role: "status", children: "Loading worktrees\u2026" }),
        authenticationRequired && /* @__PURE__ */ jsx("p", { role: "alert", children: "Gateway sign-in or permission is required. Automatic requests are paused. Sign in through Hermes Connections, then select Retry after sign-in. Cached results are stale and actions are disabled." }),
        listing.isError && !authenticationRequired && /* @__PURE__ */ jsxs("p", { role: "alert", children: [
          data ? "Cached results are stale. " : "Cannot load Timber. ",
          message(listing.error),
          " Actions are disabled until a successful refresh."
        ] }),
        error && !authenticationRequired && /* @__PURE__ */ jsx("p", { role: "alert", children: error }),
        notice.length > 0 && /* @__PURE__ */ jsx("div", { role: "status", children: notice.map((text, index) => /* @__PURE__ */ jsx("p", { children: text }, index)) }),
        data?.warnings.length ? /* @__PURE__ */ jsx("div", { "aria-label": "Backend warnings", children: data.warnings.map((text, index) => /* @__PURE__ */ jsx("p", { style: muted, children: text }, index)) }) : null,
        creating && /* @__PURE__ */ jsxs(
          "form",
          {
            "aria-label": "Create worktree",
            onSubmit: create,
            style: {
              ...stack,
              border: "1px solid var(--ui-stroke-secondary)",
              padding: 10,
              borderRadius: 4
            },
            children: [
              /* @__PURE__ */ jsxs("label", { style: stack, children: [
                "Repository",
                /* @__PURE__ */ jsx(
                  "select",
                  {
                    "aria-label": "Create repository",
                    style: selectStyle,
                    value: createRepo || data?.repositories[0] || "",
                    disabled,
                    onChange: (event) => setCreateRepo(event.target.value),
                    children: data?.repositories.map((item) => /* @__PURE__ */ jsx("option", { value: item, children: item }, item))
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("label", { style: stack, children: [
                "Branch name (optional)",
                /* @__PURE__ */ jsx(
                  Input,
                  {
                    value: name,
                    disabled,
                    placeholder: "Let Timber choose",
                    onChange: (event) => setName(event.target.value)
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("label", { style: stack, children: [
                "Upstream (optional)",
                /* @__PURE__ */ jsx(
                  Input,
                  {
                    value: upstream,
                    disabled,
                    placeholder: "Repository default",
                    onChange: (event) => setUpstream(event.target.value)
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("div", { style: row, children: [
                /* @__PURE__ */ jsx(Button, { type: "submit", size: "sm", disabled, children: "Create worktree" }),
                /* @__PURE__ */ jsx(
                  Button,
                  {
                    type: "button",
                    size: "sm",
                    variant: "ghost",
                    disabled: busy,
                    onClick: () => setCreating(false),
                    children: "Cancel"
                  }
                )
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxs(
          "div",
          {
            style: {
              display: "grid",
              gridTemplateColumns: "minmax(0, 1fr) minmax(100px, auto)",
              gap: 8
            },
            children: [
              /* @__PURE__ */ jsxs("label", { style: stack, children: [
                "Find worktrees",
                /* @__PURE__ */ jsx(
                  Input,
                  {
                    type: "search",
                    value: search,
                    placeholder: "Search worktrees",
                    onChange: (event) => {
                      disarm();
                      setSearch(event.target.value);
                    }
                  }
                )
              ] }),
              /* @__PURE__ */ jsxs("label", { style: stack, children: [
                "Sort",
                /* @__PURE__ */ jsxs(
                  "select",
                  {
                    style: selectStyle,
                    value: sort,
                    onChange: (event) => {
                      disarm();
                      setSort(event.target.value);
                    },
                    children: [
                      /* @__PURE__ */ jsx("option", { value: "recent", children: "Recent" }),
                      /* @__PURE__ */ jsx("option", { value: "repo", children: "Repository" }),
                      /* @__PURE__ */ jsx("option", { value: "name", children: "Name" })
                    ]
                  }
                )
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxs("div", { "aria-live": "polite", style: muted, children: [
          data ? `${filtered.length} of ${data.worktrees.length} worktrees` : "",
          busy ? " \xB7 Working\u2026" : ""
        ] }),
        data && filtered.length === 0 && /* @__PURE__ */ jsx("p", { children: data.worktrees.length ? "No matching worktrees." : "No worktrees yet. Create one from a repository above." }),
        /* @__PURE__ */ jsx(
          "ul",
          {
            "aria-label": "Worktrees",
            style: { ...stack, listStyle: "none", margin: 0, padding: 0 },
            children: filtered.map((worktree) => /* @__PURE__ */ jsxs(
              "li",
              {
                style: {
                  ...stack,
                  borderTop: "1px solid var(--ui-stroke-secondary)",
                  paddingTop: 10
                },
                children: [
                  /* @__PURE__ */ jsxs("div", { style: { overflowWrap: "anywhere" }, children: [
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        title: worktree.path,
                        style: { color: "var(--ui-text-primary)" },
                        children: worktree.name
                      }
                    ),
                    " @ ",
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        title: worktree.upstream ? `Upstream: ${worktree.upstream}` : "No upstream",
                        style: { color: "var(--ui-text-primary)" },
                        children: worktree.repo
                      }
                    )
                  ] }),
                  /* @__PURE__ */ jsxs(
                    "div",
                    {
                      style: {
                        display: "grid",
                        gridTemplateColumns: "max-content 70px 80px 80px minmax(0, 1fr) max-content",
                        alignItems: "center",
                        columnGap: 10,
                        overflowX: "auto"
                      },
                      children: [
                        /* @__PURE__ */ jsx(
                          Button,
                          {
                            type: "button",
                            size: "xs",
                            variant: "ghost",
                            disabled,
                            "aria-label": `Open ${worktree.name}@${worktree.repo} in Hermes`,
                            title: "New session",
                            onClick: () => {
                              disarm();
                              run(() => open(worktree));
                            },
                            children: /* @__PURE__ */ jsx(Codicon, { name: "add" })
                          }
                        ),
                        /* @__PURE__ */ jsx("div", { style: { display: "flex", justifyContent: "center" }, children: /* @__PURE__ */ jsx(
                          Badge,
                          {
                            variant: !worktree.clean ? "warn" : worktree.merged ? "success" : "muted",
                            children: worktree.merged ? "Merged" : worktree.clean ? "Clean" : "Dirty"
                          }
                        ) }),
                        /* @__PURE__ */ jsxs(
                          "span",
                          {
                            style: { ...muted, textAlign: "center", whiteSpace: "nowrap" },
                            children: [
                              "\u2191",
                              worktree.ahead ?? 0,
                              " \u2193",
                              worktree.behind ?? 0
                            ]
                          }
                        ),
                        /* @__PURE__ */ jsx(
                          "span",
                          {
                            style: {
                              display: "flex",
                              justifyContent: "center",
                              minWidth: 0
                            },
                            children: worktree.todoTotal !== void 0 && /* @__PURE__ */ jsxs(
                              "span",
                              {
                                style: {
                                  ...muted,
                                  display: "inline-flex",
                                  alignItems: "center",
                                  gap: 4
                                },
                                "aria-label": `TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done`,
                                children: [
                                  /* @__PURE__ */ jsx(Codicon, { name: "check-all" }),
                                  " ",
                                  worktree.todoDone ?? 0,
                                  "/",
                                  worktree.todoTotal
                                ]
                              }
                            )
                          }
                        ),
                        /* @__PURE__ */ jsx("span", { style: muted, children: worktree.pullRequest ? `PR ${worktree.pullRequest}` : "" }),
                        /* @__PURE__ */ jsx(
                          Button,
                          {
                            type: "button",
                            size: "xs",
                            variant: "ghost",
                            style: {
                              marginLeft: "auto",
                              color: preview?.worktree.path === worktree.path ? "var(--ui-red)" : "var(--ui-text-quaternary)"
                            },
                            disabled: disabled || !safeToRemove(worktree),
                            title: safeToRemove(worktree) ? preview?.worktree.path === worktree.path ? `Click again to delete ${preview.worktree.name}@${preview.worktree.repo}, branch ${preview.branch}, directory ${preview.worktree.path}, and worktree-local TODO notes within five seconds.` : "Preview removal" : "Requires clean, merged status without errors",
                            "aria-label": preview?.worktree.path === worktree.path ? `Remove ${worktree.name}@${worktree.repo}. Click again to delete branch ${preview.branch}, directory ${preview.worktree.path}, and worktree-local TODO notes within five seconds.` : `Remove ${worktree.name}@${worktree.repo}`,
                            onClick: () => {
                              const armed = consent.current;
                              if (armed && armed.worktree.repo === worktree.repo && armed.worktree.name === worktree.name && previewCurrent && Date.now() < consentDeadline.current && JSON.stringify(
                                client.getQueryData(queryKey)?.worktrees.find(
                                  (item) => item.repo === worktree.repo && item.name === worktree.name
                                )
                              ) === consentSnapshot.current) {
                                disarm();
                                run(async () => {
                                  const result = await post("/remove", {
                                    token: armed.token
                                  });
                                  if (!record(result) || !result.removed)
                                    throw new Error("The backend did not confirm removal.");
                                  warnings(result);
                                  await refresh();
                                });
                              } else {
                                disarm();
                                run(() => prepareRemove(worktree));
                              }
                            },
                            children: /* @__PURE__ */ jsx(Codicon, { name: "trash" })
                          }
                        )
                      ]
                    }
                  ),
                  worktree.statusError && /* @__PURE__ */ jsx("p", { role: "status", style: muted, children: "Git status could not be read. Removal is disabled." })
                ]
              },
              JSON.stringify([worktree.repo, worktree.name])
            ))
          }
        )
      ]
    }
  );
}

// ui/plugin.tsx
import { jsx as jsx2 } from "react/jsx-runtime";
var plugin = {
  id: "hermes-timber",
  name: "Timber",
  description: "Create, open, and safely remove Timber worktrees in repository Projects.",
  register(context) {
    context.register({
      id: "panel",
      area: "panes",
      title: "Timber",
      data: { placement: "right", width: "400px" },
      render: () => /* @__PURE__ */ jsx2(TimberPanel, { context })
    });
    const shortcut = {
      id: "hermes-timber.show",
      label: "Show Timber worktrees",
      category: "view",
      defaults: [],
      run: () => host3.revealPane("hermes-timber:panel")
    };
    context.register({ id: "shortcut", area: KEYBINDS_AREA, data: shortcut });
    const command = {
      id: "show-timber",
      label: "Show Timber worktrees",
      keywords: ["worktree", "repository", "project", "branch"],
      run: () => host3.revealPane("hermes-timber:panel")
    };
    context.register({ id: command.id, area: PALETTE_AREA, data: command });
  }
};
var plugin_default = plugin;
export {
  plugin_default as default
};
