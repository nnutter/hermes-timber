import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  Badge,
  Button,
  Codicon,
  host,
  Input,
  useMutation,
  useQuery,
  useQueryClient,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import {
  isWorktree,
  message,
  parsePreview,
  parseState,
  record,
  responseWarnings,
  safeToRemove,
} from "./contracts";
import type { RemovePreview, Worktree } from "./contracts";
import { authenticationFailure, pollDelay } from "./polling";
import { assertScope, scopeKey, useScope } from "./scope";

const stack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
};
const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
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

export function TimberPanel({ context }: { context: PluginContext }) {
  const scope = useScope();
  // A different route gets a fresh local state, including destructive consent.
  return (
    <ScopedPanel
      key={JSON.stringify([scope.key, scope.online])}
      context={context}
      scope={scope.key}
      online={scope.online}
    />
  );
}

function ScopedPanel({
  context,
  scope,
  online,
}: {
  context: PluginContext;
  scope: string;
  online: boolean;
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
  const consentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consent = useRef<RemovePreview | null>(null);
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
    [],
  );
  const queryKey = ["hermes-timber", scope, "state"] as const;
  const consecutiveFailures = useRef(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(() =>
    authenticationFailure(client.getQueryState(queryKey)?.error),
  );
  const pauseForAuthentication = (failure: unknown) => {
    if (current() && authenticationFailure(failure))
      setAuthenticationRequired(true);
  };
  const listing = useQuery({
    queryKey,
    queryFn: async () => {
      assertScope(scope);
      disarm();
      try {
        const result = parseState(await context.rest<unknown>("/state"));
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
    refetchInterval: () =>
      authenticationRequired ? false : pollDelay(consecutiveFailures.current),
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
    staleTime: 10_000,
  });
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("recent");
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);
  const [created, setCreated] = useState(false);
  const addedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (addedTimer.current !== null) clearTimeout(addedTimer.current);
      if (createdTimer.current !== null) clearTimeout(createdTimer.current);
    },
    [],
  );
  const [source, setSource] = useState("");
  const [repoName, setRepoName] = useState("");
  const [alias, setAlias] = useState("");
  const [createRepo, setCreateRepo] = useState("");
  const [name, setName] = useState("");
  const [upstream, setUpstream] = useState("");
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [notice, setNotice] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [blockedCreate, setBlockedCreate] = useState(false);
  const [blockedAdd, setBlockedAdd] = useState(false);
  const operationKind = useRef<"create" | "add" | null>(null);
  const [recent, setRecent] = useState<Record<string, number>>({});
  const data = listing.data;
  const ready =
    online && !authenticationRequired && Boolean(data) && !listing.isError;

  const check = () => {
    assertScope(scope);
    if (
      authenticationRequired ||
      !alive.current ||
      client.getQueryState(queryKey)?.status !== "success"
    ) {
      throw new Error(
        "The listing is stale. Refresh Timber before continuing.",
      );
    }
  };

  const post = async (path: string, body: Record<string, unknown>) => {
    check();
    let response: unknown;
    try {
      response = await context.rest<unknown>(path, { method: "POST", body });
    } catch (failure) {
      if (
        path === "/repositories" &&
        ((record(failure) &&
          (failure.status === 404 || failure.statusCode === 404)) ||
          /\b404\b/.test(message(failure)))
      ) {
        throw new Error(
          "Repository endpoint not found (404). The Timber backend may be outdated; update and restart the dashboard, then refresh before retrying.",
        );
      }
      throw failure;
    }
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
    mutationFn: async (run: () => Promise<void>) => {
      check();
      await run();
    },
    onMutate: () => {
      setNotice([]);
    },
    onError: async (failure) => {
      if (current()) {
        if (operationKind.current === "create") setBlockedCreate(true);
        if (operationKind.current === "add") setBlockedAdd(true);
        pauseForAuthentication(failure);
        setError(message(failure));
        setPreview(null);
        if (!authenticationFailure(failure)) {
          try {
            await refresh();
          } catch {
            // The listing error keeps actions disabled until a successful refresh.
          }
        }
      }
    },
  });
  const busy = operation.isPending;
  const disabled = !ready || busy;
  const run = (
    action: () => Promise<void>,
    kind: "create" | "add" | null = null,
  ) => {
    if (
      actionLocked.current ||
      (kind === "create" && blockedCreate) ||
      (kind === "add" && blockedAdd)
    )
      return;
    operationKind.current = kind;
    actionLocked.current = true;
    operation.mutate(action, {
      onSettled: () => {
        actionLocked.current = false;
      },
    });
  };
  const warnings = (response: unknown) => {
    const result = responseWarnings(response);
    if (current()) setNotice(result.length ? result : ["Completed."]);
  };

  async function open(worktree: Worktree) {
    check();
    const project = data?.projects[worktree.repo];
    if (!project)
      throw new Error(
        "No Hermes Project exists for this repository. Run Sync Projects from the command palette first.",
      );
    const selected = await host.request<unknown>("projects.set_active", {
      id: project,
      profile: host.state.profile.get(),
    });
    check();
    if (!record(selected) || selected.active_id !== project)
      throw new Error("Hermes did not activate the repository Project.");
    const created = await host.request<unknown>("session.create", {
      cwd: worktree.path,
      title: worktree.name,
      source: "desktop",
      profile: host.state.profile.get(),
    });
    check();
    if (
      !record(created) ||
      typeof created.stored_session_id !== "string" ||
      !created.stored_session_id ||
      !record(created.info) ||
      created.info.cwd !== worktree.path
    ) {
      throw new Error(
        "Hermes did not confirm the requested working directory. The chat was not opened.",
      );
    }
    await host.openSession(created.stored_session_id, {
      profile: host.state.profile.get(),
      awaitHydration: true,
      keepAllProfilesScope: true,
    });
    check();
    // Empty local drafts resume without info.cwd. Reaffirm the workspace after
    // hydration so Hermes emits a session.info update for Files and Review.
    const moved = await host.request<unknown>("session.workspace.move", {
      session_key: created.stored_session_id,
      cwd: worktree.path,
      profile: host.state.profile.get(),
    });
    check();
    if (!record(moved) || moved.cwd !== worktree.path)
      throw new Error("Hermes did not confirm the opened chat's workspace.");
    setRecent((previous) => ({ ...previous, [worktree.path]: Date.now() }));
    setNotice([`Opened ${worktree.name}@${worktree.repo} in Hermes.`]);
  }

  async function prepareRemove(worktree: Worktree) {
    if (!safeToRemove(worktree))
      throw new Error(
        "Only clean, merged worktrees without status errors can be removed.",
      );
    const version = consentVersion.current;
    const snapshot = JSON.stringify(worktree);
    const result = parsePreview(
      await post("/remove/preview", {
        repo: worktree.repo,
        name: worktree.name,
      }),
    );
    if (
      !safeToRemove(result.worktree) ||
      result.worktree.repo !== worktree.repo ||
      result.worktree.name !== worktree.name ||
      result.worktree.path !== worktree.path
    ) {
      throw new Error(
        "The worktree changed. Refresh Timber before requesting another preview.",
      );
    }
    const latest = client
      .getQueryData<typeof data>(queryKey)
      ?.worktrees.find(
        (item) => item.repo === worktree.repo && item.name === worktree.name,
      );
    if (
      !current() ||
      version !== consentVersion.current ||
      JSON.stringify(latest) !== snapshot
    )
      return;
    consentSnapshot.current = snapshot;
    consentDeadline.current = Date.now() + 5000;
    consent.current = result;
    setPreview(result);
    consentTimer.current = setTimeout(disarm, 5000);
  }

  function create(event: FormEvent) {
    event.preventDefault();
    run(async () => {
      if (createdTimer.current !== null) clearTimeout(createdTimer.current);
      setCreated(false);
      const chosen = createRepo || data?.repositories[0];
      if (!chosen) throw new Error("Select a repository first.");
      const response = await post("/create", {
        repo: chosen,
        name: name.trim(),
        upstream: upstream.trim(),
      });
      if (!record(response) || !isWorktree(response.worktree))
        throw new Error(
          "The Timber backend returned an invalid create response.",
        );
      if (current()) setNotice(responseWarnings(response));
      if (current()) {
        setCreating(false);
        setName("");
        setUpstream("");
      }
      await refresh();
      if (current()) {
        setCreated(true);
        createdTimer.current = setTimeout(() => setCreated(false), 2000);
      }
    }, "create");
  }

  function addRepository(event: FormEvent) {
    event.preventDefault();
    disarm();
    run(async () => {
      if (addedTimer.current !== null) clearTimeout(addedTimer.current);
      setAdded(false);
      const response = await post("/repositories", {
        source,
        name: repoName,
        alias,
      });
      if (
        !record(response) ||
        typeof response.repository !== "string" ||
        !response.repository
      )
        throw new Error(
          "The backend did not confirm repository addition. Refresh before retrying.",
        );
      if (current()) setNotice(responseWarnings(response));
      if (current()) {
        setAdding(false);
        setSource("");
        setRepoName("");
        setAlias("");
      }
      await refresh();
      if (current()) {
        setAdded(true);
        addedTimer.current = setTimeout(() => setAdded(false), 2000);
      }
    }, "add");
  }

  const filtered = (data?.worktrees ?? [])
    .filter((worktree) => {
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
        worktree.todoTotal !== undefined
          ? `todo ${worktree.todoDone ?? 0}/${worktree.todoTotal}`
          : "",
        worktree.pullRequest ?? "",
      ];
      return fields.some((field) => field.toLocaleLowerCase().includes(needle));
    })
    .sort((left, right) => {
      if (sort === "recent") {
        const difference = (recent[right.path] ?? 0) - (recent[left.path] ?? 0);
        if (difference) return difference;
        // Timber's listing order is its recency order for worktrees not opened here.
        return 0;
      }
      return (
        (sort === "repo"
          ? left.repo.localeCompare(right.repo)
          : left.name.localeCompare(right.name)) ||
        left.repo.localeCompare(right.repo) ||
        left.name.localeCompare(right.name)
      );
    });
  const previewCurrent =
    preview &&
    data?.worktrees.some(
      (worktree) =>
        worktree.repo === preview.worktree.repo &&
        worktree.name === preview.worktree.name &&
        worktree.path === preview.worktree.path &&
        worktree.commit === preview.worktree.commit &&
        safeToRemove(worktree),
    );

  return (
    <section
      aria-label="Timber worktrees"
      style={{
        ...stack,
        padding: 12,
        height: "100%",
        overflow: "auto",
        color: "var(--ui-text-primary)",
        fontSize: 13,
      }}
    >
      <header style={stack}>
        <div
          style={{
            ...row,
            justifyContent: "space-between",
            alignItems: "flex-start",
          }}
        >
          <strong>Timber</strong>
          <div style={row}>
            <span
              title={
                data
                  ? `${data.host} · ${host.state.profile.get()}\n${data.hermes_home}`
                  : undefined
              }
            >
              <Badge variant={ready ? "muted" : "warn"}>
                {!online
                  ? "Offline"
                  : authenticationRequired
                    ? "Sign-in required"
                    : listing.isError
                      ? "Stale"
                      : "Connected"}
              </Badge>
            </span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={!online || busy}
              aria-label={
                authenticationRequired ? "Retry after sign-in" : "Refresh"
              }
              title={
                authenticationRequired
                  ? "Retry after sign-in"
                  : "Reload worktrees"
              }
              onClick={() => {
                void refresh()
                  .then(() => {
                    if (current()) {
                      setError(null);
                      setBlockedCreate(false);
                      setBlockedAdd(false);
                    }
                  })
                  .catch((failure: unknown) => {
                    if (current())
                      setError((previous) => previous ?? message(failure));
                  });
              }}
            >
              <Codicon name="refresh" />
            </Button>
          </div>
        </div>
        <div style={{ ...row, justifyContent: "space-between" }}>
          <div style={row}>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled || !data?.repositories.length}
              style={{ width: 132, justifyContent: "center" }}
              onClick={() => {
                disarm();
                setCreating((value) => !value);
              }}
            >
              New worktree
            </Button>
            {created && (
              <span
                role="status"
                aria-label="Worktree created"
                title="Worktree created"
                style={{ color: "#22c55e" }}
              >
                <Codicon name="check" />
              </span>
            )}
          </div>
          <div style={row}>
            {added && (
              <span
                role="status"
                aria-label="Repository added"
                title="Repository added"
                style={{ color: "#22c55e" }}
              >
                <Codicon name="check" />
              </span>
            )}
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={disabled}
              style={{ width: 132, justifyContent: "center" }}
              onClick={() => {
                disarm();
                setAdding((value) => !value);
              }}
            >
              Add repository
            </Button>
          </div>
        </div>
      </header>
      {!online && (
        <p role="status">
          Gateway offline. Cached results are stale. Actions are disabled.
        </p>
      )}
      {listing.isPending && online && <p role="status">Loading worktrees…</p>}
      {authenticationRequired && (
        <p role="alert">
          Gateway sign-in or permission is required. Automatic requests are
          paused. Sign in through Hermes Connections, then select Retry after
          sign-in. Cached results are stale and actions are disabled.
        </p>
      )}
      {listing.isError && !authenticationRequired && (
        <p role="alert">
          {data ? "Cached results are stale. " : "Cannot load Timber. "}
          {message(listing.error)} Actions are disabled until a successful
          refresh.
        </p>
      )}
      {error && !authenticationRequired && (
        <p role="alert">
          {error}
          {(blockedAdd || blockedCreate) &&
            " The operation may have partially completed. Review the listing, then use Refresh before retrying."}
        </p>
      )}
      {notice.length > 0 && (
        <div role="status">
          {notice.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </div>
      )}
      {data?.warnings.length ? (
        <div aria-label="Backend warnings">
          {data.warnings.map((text, index) => (
            <p key={index} style={muted}>
              {text}
            </p>
          ))}
        </div>
      ) : null}
      {adding && (
        <form
          aria-label="Add repository"
          onSubmit={addRepository}
          style={stack}
        >
          <label style={stack}>
            Repository URL or path
            <Input
              value={source}
              disabled={disabled}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <label style={stack}>
            Repository name (optional)
            <Input
              value={repoName}
              disabled={disabled}
              onChange={(event) => setRepoName(event.target.value)}
            />
          </label>
          <label style={stack}>
            Alias (optional)
            <Input
              value={alias}
              disabled={disabled}
              onChange={(event) => setAlias(event.target.value)}
            />
          </label>
          <div style={row}>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || blockedAdd || !source.trim()}
            >
              Add repo
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setAdding(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      {creating && (
        <form
          aria-label="Create worktree"
          onSubmit={create}
          style={{
            ...stack,
            border: "1px solid var(--ui-stroke-secondary)",
            padding: 10,
            borderRadius: 4,
          }}
        >
          <label style={stack}>
            Repository
            <select
              aria-label="Create repository"
              style={selectStyle}
              value={createRepo || data?.repositories[0] || ""}
              disabled={disabled}
              onChange={(event) => setCreateRepo(event.target.value)}
            >
              {data?.repositories.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>
          <label style={stack}>
            Branch name (optional)
            <Input
              value={name}
              disabled={disabled}
              placeholder="Let Timber choose"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label style={stack}>
            Upstream (optional)
            <Input
              value={upstream}
              disabled={disabled}
              placeholder="Repository default"
              onChange={(event) => setUpstream(event.target.value)}
            />
          </label>
          <div style={row}>
            <Button
              type="submit"
              size="sm"
              disabled={disabled || blockedCreate}
            >
              Create worktree
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(100px, auto)",
          gap: 8,
        }}
      >
        <label style={stack}>
          Find worktrees
          <Input
            type="search"
            value={search}
            placeholder="Search worktrees"
            onChange={(event) => {
              disarm();
              setSearch(event.target.value);
            }}
          />
        </label>
        <label style={stack}>
          Sort
          <select
            style={selectStyle}
            value={sort}
            onChange={(event) => {
              disarm();
              setSort(event.target.value);
            }}
          >
            <option value="recent">Recent</option>
            <option value="repo">Repository</option>
            <option value="name">Name</option>
          </select>
        </label>
      </div>
      <div aria-live="polite" style={muted}>
        {data ? `${filtered.length} of ${data.worktrees.length} worktrees` : ""}
        {busy ? " · Working…" : ""}
      </div>
      {data && filtered.length === 0 && (
        <p>
          {data.worktrees.length
            ? "No matching worktrees."
            : "No worktrees yet. Create one from a repository above."}
        </p>
      )}
      <ul
        aria-label="Worktrees"
        style={{ ...stack, listStyle: "none", margin: 0, padding: 0 }}
      >
        {filtered.map((worktree) => (
          <li
            key={JSON.stringify([worktree.repo, worktree.name])}
            style={{
              ...stack,
              borderTop: "1px solid var(--ui-stroke-secondary)",
              paddingTop: 10,
            }}
          >
            <div style={{ overflowWrap: "anywhere" }}>
              <span
                title={worktree.path}
                style={{ color: "var(--ui-text-primary)" }}
              >
                {worktree.name}
              </span>
              {" @ "}
              <span
                title={
                  worktree.upstream
                    ? `Upstream: ${worktree.upstream}`
                    : "No upstream"
                }
                style={{ color: "var(--ui-text-primary)" }}
              >
                {worktree.repo}
              </span>
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns:
                  "max-content 70px 80px 80px minmax(0, 1fr) max-content",
                alignItems: "center",
                columnGap: 10,
                overflowX: "auto",
              }}
            >
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={disabled}
                aria-label={`Open ${worktree.name}@${worktree.repo} in Hermes`}
                title="New session"
                onClick={() => {
                  disarm();
                  run(() => open(worktree));
                }}
              >
                <Codicon name="add" />
              </Button>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <Badge
                  variant={
                    !worktree.clean
                      ? "warn"
                      : worktree.merged
                        ? "success"
                        : "muted"
                  }
                >
                  {worktree.merged
                    ? "Merged"
                    : worktree.clean
                      ? "Clean"
                      : "Dirty"}
                </Badge>
              </div>
              <span
                style={{ ...muted, textAlign: "center", whiteSpace: "nowrap" }}
              >
                ↑{worktree.ahead ?? 0} ↓{worktree.behind ?? 0}
              </span>
              <span
                style={{
                  display: "flex",
                  justifyContent: "center",
                  minWidth: 0,
                }}
              >
                {worktree.todoTotal !== undefined && (
                  <span
                    style={{
                      ...muted,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                    aria-label={`TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done`}
                  >
                    <Codicon name="check-all" /> {worktree.todoDone ?? 0}/
                    {worktree.todoTotal}
                  </span>
                )}
              </span>
              <span style={muted}>
                {worktree.pullRequest ? `PR ${worktree.pullRequest}` : ""}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                style={{
                  marginLeft: "auto",
                  color:
                    preview?.worktree.path === worktree.path
                      ? "var(--ui-red)"
                      : "var(--ui-text-quaternary)",
                }}
                disabled={disabled || !safeToRemove(worktree)}
                title={
                  safeToRemove(worktree)
                    ? preview?.worktree.path === worktree.path
                      ? `Click again to delete ${preview.worktree.name}@${preview.worktree.repo}, branch ${preview.branch}, directory ${preview.worktree.path}, and worktree-local TODO notes within five seconds.`
                      : "Preview removal"
                    : "Requires clean, merged status without errors"
                }
                aria-label={
                  preview?.worktree.path === worktree.path
                    ? `Remove ${worktree.name}@${worktree.repo}. Click again to delete branch ${preview.branch}, directory ${preview.worktree.path}, and worktree-local TODO notes within five seconds.`
                    : `Remove ${worktree.name}@${worktree.repo}`
                }
                onClick={() => {
                  const armed = consent.current;
                  if (
                    armed &&
                    armed.worktree.repo === worktree.repo &&
                    armed.worktree.name === worktree.name &&
                    previewCurrent &&
                    Date.now() < consentDeadline.current &&
                    JSON.stringify(
                      client
                        .getQueryData<typeof data>(queryKey)
                        ?.worktrees.find(
                          (item) =>
                            item.repo === worktree.repo &&
                            item.name === worktree.name,
                        ),
                    ) === consentSnapshot.current
                  ) {
                    disarm();
                    run(async () => {
                      const result = await post("/remove", {
                        token: armed.token,
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
                }}
              >
                <Codicon name="trash" />
              </Button>
            </div>
            {worktree.statusError && (
              <p role="status" style={muted}>
                Git status could not be read. Removal is disabled.
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
