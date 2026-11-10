import { useEffect, useRef, useState } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  Button,
  Codicon,
  host,
  Input,
  useQuery,
  useQueryClient,
} from "@hermes/plugin-sdk";
import type { PluginContext } from "@hermes/plugin-sdk";
import {
  actionColor,
  actionFor,
  canRemove,
  filterWorktrees,
  repoActionId,
  rowActionId,
  rowKey,
  sessionTitle,
  sortWorktrees,
  timeAgo,
} from "./actions";
import type { RowAction, SortMode } from "./actions";
import {
  isWorktree,
  message,
  parsePrCreated,
  parsePreview,
  parseSessions,
  parseState,
  parseWorktreeState,
  record,
  responseWarnings,
} from "./contracts";
import type {
  PrEntry,
  RemovePreview,
  StackInfo,
  TimberState,
  Worktree,
  WorktreeState,
} from "./contracts";
import {
  CreatePrIcon,
  ImportRepoIcon,
  MergeIcon,
  NewWorktreeIcon,
  PushIcon,
} from "./icons";
import { authenticationFailure, pollDelay } from "./polling";
import { assertScope } from "./scope";

const TOOLBAR_HEIGHT = 34;
const REMOVE_COLOR = "var(--ui-purple)";

const stackStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  minWidth: 0,
};
const rowStyle: CSSProperties = {
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
const faint: CSSProperties = {
  color: "var(--ui-text-quaternary)",
  fontSize: 11,
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
const boxed: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 4,
  padding: 10,
};
const iconButton = (size: number): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: size,
  height: size,
  minWidth: 0,
  minHeight: 0,
  padding: 0,
  flexShrink: 0,
});
const splitPart: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 0,
  border: "none",
  borderRadius: 0,
  background: "transparent",
};
const rowItem: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 28,
  boxSizing: "border-box",
  fontSize: 13,
  whiteSpace: "nowrap",
};

const SORT_MODES: Array<{
  id: SortMode;
  label: string;
  icon: string;
}> = [
  { id: "recent", label: "Activity", icon: "history" },
  { id: "repo", label: "Repository Name", icon: "repo" },
  { id: "name", label: "Worktree Name", icon: "git-branch" },
];

export function WorktreeView({
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
  const queryKey = ["hermes-timber", scope, "state"] as const;
  const failures = useRef(0);
  const [authenticationRequired, setAuthenticationRequired] = useState(() =>
    authenticationFailure(client.getQueryState(queryKey)?.error),
  );
  const listing = useQuery({
    queryKey,
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
  const data = listing.data;
  const ready =
    online && !authenticationRequired && Boolean(data) && !listing.isError;

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortMode>("recent");
  const [openMenu, setOpenMenu] = useState<"add" | "sort" | null>(null);
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);
  const [showRepos, setShowRepos] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameTo, setRenameTo] = useState("");
  const [createRepo, setCreateRepo] = useState("");
  const [name, setName] = useState("");
  const [upstream, setUpstream] = useState("");
  const [source, setSource] = useState("");
  const [repoName, setRepoName] = useState("");
  const [alias, setAlias] = useState("");
  const [prWorktree, setPrWorktree] = useState<Worktree | null>(null);
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [preview, setPreview] = useState<RemovePreview | null>(null);
  const [notice, setNotice] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [blockedCreate, setBlockedCreate] = useState(false);
  const [blockedAdd, setBlockedAdd] = useState(false);
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const runningRef = useRef<Set<string>>(new Set());
  const [recent, setRecent] = useState<Record<string, number>>({});
  const consentVersion = useRef(0);
  const consentTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consent = useRef<RemovePreview | null>(null);
  const consentSnapshot = useRef("");
  const consentDeadline = useRef(0);
  const menuAnchor = useRef<HTMLDivElement | null>(null);

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
  useEffect(() => {
    if (openMenu === null) return undefined;
    const onDown = (event: PointerEvent) => {
      if (
        menuAnchor.current &&
        event.target instanceof Node &&
        !menuAnchor.current.contains(event.target)
      ) {
        setOpenMenu(null);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [openMenu]);

  const start = (id: string) => {
    runningRef.current = new Set(runningRef.current).add(id);
    setRunning(new Set(runningRef.current));
  };
  const end = (id: string) => {
    const next = new Set(runningRef.current);
    next.delete(id);
    runningRef.current = next;
    setRunning(new Set(next));
  };
  const toolbarBusy = ["create", "add", "refresh"].some((id) =>
    running.has(id),
  );
  const rowBusy = (worktree: Worktree) =>
    ["open", "pr", "push", "merge", "remove"].some((verb) =>
      running.has(rowActionId(verb, worktree)),
    );
  const repoBusy = (repo: string) =>
    ["repo-rename", "repo-remove"].some((verb) =>
      running.has(repoActionId(verb, repo)),
    );
  const disabled = !ready || toolbarBusy;

  const check = () => {
    assertScope(scope);
    if (
      authenticationRequired ||
      client.getQueryState(queryKey)?.status !== "success"
    ) {
      throw new Error(
        "The listing is stale. Refresh Timber before continuing.",
      );
    }
  };
  const post = async (path: string, body: Record<string, unknown>) => {
    check();
    const response = await context.rest<unknown>(path, {
      method: "POST",
      body,
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
  const run = (
    id: string | null,
    action: () => Promise<void>,
    kind: "create" | "add" | null = null,
  ) => {
    if (id !== null && runningRef.current.has(id)) return;
    if ((kind === "create" && blockedCreate) || (kind === "add" && blockedAdd))
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
            // The listing error keeps actions disabled until a refresh.
          }
        }
      } finally {
        if (id !== null) end(id);
      }
    })();
  };
  const applyState = (fresh: unknown) => {
    if (!record(fresh)) return false;
    const parsed: WorktreeState = parseWorktreeState(fresh);
    const key = rowKey(parsed.worktree);
    client.setQueryData<TimberState>(queryKey, (previous) =>
      previous
        ? {
            ...previous,
            worktrees: previous.worktrees.map((worktree) =>
              rowKey(worktree) === key ? parsed.worktree : worktree,
            ),
            prs: { ...previous.prs, [key]: parsed.pr },
          }
        : previous,
    );
    return true;
  };

  async function open(worktree: Worktree, announce = true) {
    check();
    const profile = host.state.profile.get();
    try {
      const sessions = parseSessions(
        await context.rest<unknown>(
          `/sessions?path=${encodeURIComponent(worktree.path)}`,
        ),
      );
      if (sessions[0]) {
        await host.openSession(sessions[0].id, {
          profile,
          awaitHydration: true,
          keepAllProfilesScope: true,
        });
        check();
        setRecent((previous) => ({
          ...previous,
          [worktree.path]: Date.now(),
        }));
        if (announce)
          setNotice([
            `Opened the latest session in ${worktree.name}@${worktree.repo}.`,
          ]);
        return;
      }
    } catch {
      // Session lookup is a convenience; a missing store creates a new chat.
    }
    const project = data?.projects[worktree.repo];
    if (!project)
      throw new Error(
        "No Hermes Project exists for this repository. Run Sync Projects from the command palette first.",
      );
    const selected = await host.request<unknown>("projects.set_active", {
      id: project,
      profile,
    });
    check();
    if (!record(selected) || selected.active_id !== project)
      throw new Error("Hermes did not activate the repository Project.");
    const created = await host.request<unknown>("session.create", {
      cwd: worktree.path,
      title: sessionTitle(worktree),
      source: "desktop",
      profile,
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
      profile,
      awaitHydration: true,
      keepAllProfilesScope: true,
    });
    check();
    const moved = await host.request<unknown>("session.workspace.move", {
      session_key: created.stored_session_id,
      cwd: worktree.path,
      profile,
    });
    check();
    if (!record(moved) || moved.cwd !== worktree.path)
      throw new Error("Hermes did not confirm the opened chat's workspace.");
    setRecent((previous) => ({
      ...previous,
      [worktree.path]: Date.now(),
    }));
    if (announce)
      setNotice([`Opened ${worktree.name}@${worktree.repo} in Hermes.`]);
  }

  async function prepareRemove(worktree: Worktree) {
    const pr = data?.prs[rowKey(worktree)];
    if (!canRemove(worktree, pr))
      throw new Error(
        "Only clean worktrees that are merged or fully in sync, without status errors or open stack PRs, can be removed.",
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
      !canRemove(result.worktree, data?.prs[rowKey(result.worktree)]) ||
      result.worktree.repo !== worktree.repo ||
      result.worktree.name !== worktree.name ||
      result.worktree.path !== worktree.path
    ) {
      throw new Error(
        "The worktree changed. Refresh Timber before requesting another preview.",
      );
    }
    const latest = client
      .getQueryData<TimberState>(queryKey)
      ?.worktrees.find(
        (item) => item.repo === worktree.repo && item.name === worktree.name,
      );
    if (
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

  async function archiveSessions(path: string): Promise<string> {
    try {
      const answer = await context.rest<unknown>("/sessions/archive", {
        method: "POST",
        body: { path },
      });
      if (
        record(answer) &&
        typeof answer.archived === "number" &&
        typeof answer.total === "number" &&
        answer.total > 0
      ) {
        const many =
          answer.total === 1 ? "1 session" : `${answer.total} sessions`;
        return answer.archived === answer.total
          ? ` Archived ${many}.`
          : ` Archived ${answer.archived} of ${many}.`;
      }
    } catch {
      // A failed archive leaves the removal done; the notice says so.
    }
    return "";
  }

  function remove(worktree: Worktree) {
    const armed = consent.current;
    const latest = client
      .getQueryData<TimberState>(queryKey)
      ?.worktrees.find(
        (item) => item.repo === worktree.repo && item.name === worktree.name,
      );
    if (
      armed &&
      armed.worktree.repo === worktree.repo &&
      armed.worktree.name === worktree.name &&
      Date.now() < consentDeadline.current &&
      JSON.stringify(latest) === consentSnapshot.current
    ) {
      disarm();
      run(rowActionId("remove", worktree), async () => {
        const result = await post("/remove", { token: armed.token });
        if (!record(result) || !result.removed)
          throw new Error("The backend did not confirm removal.");
        const archived = await archiveSessions(worktree.path);
        setNotice([
          ...responseWarnings(result),
          `Removed ${worktree.name}@${worktree.repo}.${archived}`,
        ]);
        await refresh();
      });
    } else {
      disarm();
      run(rowActionId("remove", worktree), () => prepareRemove(worktree));
    }
  }

  function create(event: FormEvent) {
    event.preventDefault();
    run(
      "create",
      async () => {
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
            ...createdWarnings,
          ]);
        } catch (failure) {
          setNotice([
            `Created ${created.name}@${created.repo}, but its session did not open: ${message(failure)}`,
            ...createdWarnings,
          ]);
        }
      },
      "create",
    );
  }

  function addRepository(event: FormEvent) {
    event.preventDefault();
    disarm();
    run(
      "add",
      async () => {
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
        setAdding(false);
        setSource("");
        setRepoName("");
        setAlias("");
        setNotice(responseWarnings(response));
        await refresh();
      },
      "add",
    );
  }

  function renameRepository(repo: string) {
    const to = renameTo.trim();
    if (!to) {
      setError("Enter the new repository name.");
      return;
    }
    run(repoActionId("repo-rename", repo), async () => {
      const result = await post("/repo-rename", { repo, to });
      if (
        !record(result) ||
        typeof result.to !== "string" ||
        typeof result.worktrees !== "number"
      )
        throw new Error("The backend did not confirm the rename.");
      const moved =
        result.worktrees === 0
          ? ""
          : ` Moved ${result.worktrees} worktree folder${result.worktrees === 1 ? "" : "s"}; sessions in the old ones no longer open them.`;
      setNotice([`Renamed ${repo} to ${result.to}.${moved}`]);
      setRenaming(null);
      setRenameTo("");
      setCreateRepo("");
      await refresh();
    });
  }

  function removeRepository(repo: string) {
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

  function push(worktree: Worktree) {
    run(rowActionId("push", worktree), async () => {
      const result = await post("/push", {
        repo: worktree.repo,
        name: worktree.name,
      });
      if (!record(result) || result.pushed !== true)
        throw new Error("The backend did not confirm the push.");
      if (!applyState(result.state)) await refresh();
      setNotice([
        `Pushed ${worktree.name}@${worktree.repo} to origin/${worktree.name}.`,
      ]);
    });
  }

  function merge(worktree: Worktree, number?: number) {
    run(rowActionId("merge", worktree), async () => {
      const result = await post("/merge", {
        repo: worktree.repo,
        name: worktree.name,
        ...(number ? { number } : {}),
      });
      if (
        !record(result) ||
        typeof result.merged !== "number" ||
        typeof result.url !== "string"
      )
        throw new Error("The backend did not confirm the merge.");
      if (!applyState(result.state)) await refresh();
      setNotice([
        result.whole === true
          ? `Merged the whole stack through PR #${result.merged}.`
          : result.stack === true
            ? `Merged the stack up to PR #${result.merged}.`
            : `Merged PR #${result.merged}.`,
      ]);
    });
  }

  function createPr(worktree: Worktree) {
    run(rowActionId("pr", worktree), async () => {
      const response = await post("/pr", {
        repo: worktree.repo,
        name: worktree.name,
        title: prTitle.trim(),
        body: prBody.trim(),
      });
      const created = parsePrCreated(response);
      setPrWorktree(null);
      setPrTitle("");
      setPrBody("");
      setNotice([
        `${created.created ? "Created" : "Found"} PR #${created.number}: ${created.url}`,
      ]);
      await refresh();
    });
  }

  function openPr(worktree: Worktree, pr: PrEntry | undefined) {
    if (!pr?.url) return;
    void context.os.openExternal(pr.url);
    setRecent((previous) => ({
      ...previous,
      [worktree.path]: Date.now(),
    }));
  }

  function openRepo(pr: PrEntry | undefined) {
    if (!pr?.repo) return;
    void context.os.openExternal(`https://github.com/${pr.repo}`);
  }

  const worktrees = data?.worktrees ?? [];
  const prsLoaded = data?.prsAt != null;
  const filtered = data
    ? sortWorktrees(
        filterWorktrees(worktrees, search, data.prs),
        sort,
        cwd,
        recent,
      )
    : [];
  const current = data?.worktrees.find((worktree) => worktree.path === cwd);

  return (
    <section
      aria-label="Timber worktrees"
      style={{
        ...stackStyle,
        padding: 12,
        height: "100%",
        overflow: "hidden",
        width: surface === "page" ? "100%" : undefined,
        maxWidth: surface === "page" ? 760 : undefined,
        margin: surface === "page" ? "0 auto" : undefined,
        color: "var(--ui-text-primary)",
        fontSize: 13,
      }}
    >
      <header style={stackStyle}>
        <strong
          style={{ fontSize: surface === "page" ? 20 : 17, lineHeight: 1.2 }}
        >
          Worktrees
        </strong>
        <span style={muted}>
          {current ? current.repo.split("/").at(-1) : "Timber"}
        </span>
      </header>
      <div
        ref={menuAnchor}
        style={{
          display: "grid",
          gridTemplateColumns: "auto minmax(0,1fr) auto",
          gap: 8,
          flex: "none",
        }}
      >
        <div style={{ position: "relative", display: "inline-flex" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "stretch",
              alignSelf: "center",
              border: "1px solid var(--ui-stroke-secondary)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled || !data?.repositories.length}
              title="New worktree"
              aria-label="New worktree"
              onClick={() => {
                setOpenMenu(null);
                setCreating((value) => !value);
              }}
              style={{ ...iconButton(TOOLBAR_HEIGHT), ...splitPart }}
            >
              <NewWorktreeIcon size={16} />
            </Button>
            <span
              aria-hidden="true"
              style={{
                width: 1,
                background: "var(--ui-stroke-secondary)",
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              title="More actions"
              aria-label="More actions"
              aria-haspopup="menu"
              aria-expanded={openMenu === "add"}
              onClick={() => setOpenMenu(openMenu === "add" ? null : "add")}
              style={{ ...splitPart, ...iconButton(28) }}
            >
              <Codicon name="chevron-down" />
            </Button>
          </div>
          {openMenu === "add" && (
            <div role="menu" style={menuStyle}>
              <button
                type="button"
                role="menuitem"
                style={menuItemStyle}
                onClick={() => {
                  setOpenMenu(null);
                  setAdding(true);
                }}
              >
                <ImportRepoIcon size={16} />
                <span>Import repo</span>
              </button>
              <div aria-hidden="true" style={menuSeparatorStyle} />
              <button
                type="button"
                role="menuitem"
                style={menuItemStyle}
                onClick={() => {
                  setOpenMenu(null);
                  setShowRepos(true);
                }}
              >
                <Codicon name="repo" />
                <span>Repositories</span>
              </button>
            </div>
          )}
        </div>
        <Input
          type="search"
          aria-label="Find worktrees"
          value={search}
          placeholder="Search worktrees"
          onChange={(event) => {
            disarm();
            setSearch(event.target.value);
          }}
          style={{ height: TOOLBAR_HEIGHT, padding: "0 10px" }}
        />
        <div style={{ position: "relative", display: "inline-flex" }}>
          <div
            style={{
              display: "inline-flex",
              alignItems: "stretch",
              alignSelf: "center",
              border: "1px solid var(--ui-stroke-secondary)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <Button
              type="button"
              size="xs"
              variant="ghost"
              title="Choose how to sort"
              aria-label="Choose how to sort"
              aria-haspopup="menu"
              aria-expanded={openMenu === "sort"}
              onClick={() => setOpenMenu(openMenu === "sort" ? null : "sort")}
              style={{ ...splitPart, ...iconButton(28) }}
            >
              <Codicon name="chevron-down" />
            </Button>
            <span
              aria-hidden="true"
              style={{
                width: 1,
                background: "var(--ui-stroke-secondary)",
              }}
            />
            <Button
              type="button"
              size="xs"
              variant="ghost"
              title={`Sort: ${SORT_MODES.find((mode) => mode.id === sort)?.label ?? ""}. Click to change the order.`}
              aria-label="Sort worktrees"
              onClick={() => {
                const index = SORT_MODES.findIndex((mode) => mode.id === sort);
                const next = SORT_MODES[(index + 1) % SORT_MODES.length];
                if (next) {
                  disarm();
                  setSort(next.id);
                }
              }}
              style={{ ...splitPart, ...iconButton(TOOLBAR_HEIGHT) }}
            >
              <Codicon
                name={
                  SORT_MODES.find((mode) => mode.id === sort)?.icon ?? "history"
                }
              />
            </Button>
          </div>
          {openMenu === "sort" && (
            <div role="menu" style={{ ...menuStyle, left: "auto", right: 0 }}>
              {SORT_MODES.map((mode) => (
                <button
                  key={mode.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={mode.id === sort}
                  style={{
                    ...menuItemStyle,
                    background:
                      mode.id === sort
                        ? "var(--ui-row-active-background)"
                        : "transparent",
                  }}
                  onClick={() => {
                    disarm();
                    setSort(mode.id);
                    setOpenMenu(null);
                  }}
                >
                  <Codicon name={mode.icon} />
                  <span>{mode.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div
        style={{
          flex: "1",
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {!online && (
          <p role="status">
            Gateway offline. Cached results are stale. Actions are disabled.
          </p>
        )}
        {listing.isPending && online && <p role="status">Loading worktrees…</p>}
        {authenticationRequired && (
          <p role="alert">
            Gateway sign-in or permission is required. Automatic requests are
            paused. Sign in through Hermes Connections, then select Refresh.
            Cached results are stale and actions are disabled.
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
              <p key={index} style={index ? muted : undefined}>
                {text}
              </p>
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
            style={boxed}
          >
            <label style={stackStyle}>
              <span style={muted}>Repository URL or path</span>
              <Input
                value={source}
                disabled={disabled}
                placeholder="git@github.com:org/repo or /path/to/repo"
                onChange={(event) => setSource(event.target.value)}
              />
            </label>
            <label style={stackStyle}>
              <span style={muted}>Repository name (optional)</span>
              <Input
                value={repoName}
                disabled={disabled}
                onChange={(event) => setRepoName(event.target.value)}
              />
            </label>
            <label style={stackStyle}>
              <span style={muted}>Alias (optional)</span>
              <Input
                value={alias}
                disabled={disabled}
                onChange={(event) => setAlias(event.target.value)}
              />
            </label>
            <div style={rowStyle}>
              <Button
                type="submit"
                size="sm"
                disabled={disabled || blockedAdd || !source.trim()}
              >
                {running.has("add") ? "Adding…" : "Add repo"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={toolbarBusy}
                onClick={() => setAdding(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {creating && (
          <form aria-label="Create worktree" onSubmit={create} style={boxed}>
            <label style={stackStyle}>
              <span style={muted}>Repository</span>
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
            <label style={stackStyle}>
              <span style={muted}>
                Branch name (optional — Timber chooses when empty)
              </span>
              <Input
                value={name}
                disabled={disabled}
                placeholder="Let Timber choose"
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label style={stackStyle}>
              <span style={muted}>Upstream (optional)</span>
              <Input
                value={upstream}
                disabled={disabled}
                placeholder="Repository default"
                onChange={(event) => setUpstream(event.target.value)}
              />
            </label>
            <div style={rowStyle}>
              <Button
                type="submit"
                size="sm"
                disabled={disabled || blockedCreate}
              >
                {running.has("create") ? "Creating…" : "Create worktree"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={toolbarBusy}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
        {showRepos && (
          <div role="group" aria-label="Repositories" style={boxed}>
            <div style={rowStyle}>
              <strong>Repositories</strong>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={toolbarBusy}
                style={{ marginLeft: "auto" }}
                onClick={() => {
                  setShowRepos(false);
                  setRenaming(null);
                }}
              >
                Done
              </Button>
            </div>
            {data && data.repositories.length === 0 && (
              <p style={muted}>No repositories yet. Import one to start.</p>
            )}
            {(data?.repositories ?? []).map((repo) => {
              const count = worktrees.filter(
                (worktree) => worktree.repo === repo,
              ).length;
              const busy = repoBusy(repo);
              return (
                <div
                  key={repo}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    borderTop: "1px solid var(--ui-stroke-secondary)",
                    paddingTop: 8,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "baseline",
                      gap: 8,
                    }}
                  >
                    <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                      {repo}
                    </span>
                    <span style={{ ...muted, marginLeft: "auto" }}>
                      {count === 0
                        ? "No worktrees"
                        : `${count} worktree${count === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <div style={rowStyle}>
                    <Button
                      type="button"
                      size="xs"
                      variant="secondary"
                      disabled={toolbarBusy || busy}
                      title={`Rename ${repo}`}
                      aria-label={`Rename ${repo}`}
                      aria-expanded={renaming === repo}
                      onClick={() => {
                        setRenameTo(repo);
                        setRenaming(renaming === repo ? null : repo);
                      }}
                    >
                      Rename
                    </Button>
                    {count === 0 && (
                      <Button
                        type="button"
                        size="xs"
                        variant="ghost"
                        disabled={toolbarBusy || busy}
                        title={`Remove repository ${repo}`}
                        aria-label={`Remove repository ${repo}`}
                        style={{ color: REMOVE_COLOR }}
                        onClick={() => removeRepository(repo)}
                      >
                        {running.has(repoActionId("repo-remove", repo)) ? (
                          <Codicon name="loading" spinning />
                        ) : (
                          <Codicon name="trash" />
                        )}
                      </Button>
                    )}
                  </div>
                  {renaming === repo && (
                    <form
                      style={{ ...stackStyle, gap: 6 }}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!toolbarBusy && !busy) renameRepository(repo);
                      }}
                    >
                      <Input
                        value={renameTo}
                        disabled={toolbarBusy || busy}
                        aria-label={`New name for ${repo}`}
                        onChange={(event) => setRenameTo(event.target.value)}
                      />
                      <div style={rowStyle}>
                        <Button
                          type="submit"
                          size="xs"
                          disabled={toolbarBusy || busy || !renameTo.trim()}
                        >
                          {running.has(repoActionId("repo-rename", repo))
                            ? "Renaming…"
                            : "Rename"}
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={toolbarBusy || busy}
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {data && filtered.length === 0 && (
          <p>
            {worktrees.length
              ? "No matching worktrees."
              : "No worktrees yet. Create one above."}
          </p>
        )}
        <ul
          aria-label="Worktrees"
          style={{
            ...stackStyle,
            listStyle: "none",
            margin: 0,
            padding: 0,
          }}
        >
          {filtered.map((worktree) => {
            const key = rowKey(worktree);
            const pr = data?.prs[key];
            const stack = pr?.stack ?? null;
            const prUrl = pr?.url ?? null;
            const repoUrl = pr?.repo ? `https://github.com/${pr.repo}` : null;
            const merged = worktree.merged;
            const currentRow = Boolean(cwd) && worktree.path === cwd;
            const action = actionFor(worktree, pr, prsLoaded);
            const color = actionColor(action, worktree, pr?.checks);
            return (
              <li
                key={`${worktree.repo}/${worktree.name}`}
                data-worktree={`${worktree.repo}/${worktree.name}`}
                title={currentRow ? "This session works here" : undefined}
                style={{
                  position: "relative",
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  borderTop: "1px solid var(--ui-stroke-secondary)",
                  padding: "10px 10px 10px 12px",
                }}
              >
                {currentRow && (
                  <span
                    aria-hidden="true"
                    style={{
                      position: "absolute",
                      left: 2,
                      top: 9,
                      bottom: 9,
                      width: 3,
                      borderRadius: 2,
                      background: "var(--ui-accent)",
                      opacity: 0.85,
                    }}
                  />
                )}
                <div
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    gap: 8,
                  }}
                >
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>
                    <strong title={worktree.path}>{worktree.name}</strong>
                    <span style={muted}> @ </span>
                    {repoUrl ? (
                      <a
                        href={repoUrl}
                        title={repoUrl}
                        style={{ ...muted, textDecoration: "underline" }}
                        onClick={(event) => {
                          event.preventDefault();
                          openRepo(pr);
                        }}
                      >
                        {worktree.repo}
                      </a>
                    ) : (
                      <span
                        style={muted}
                        title={
                          worktree.upstream
                            ? `Upstream: ${worktree.upstream}`
                            : "No upstream"
                        }
                      >
                        {worktree.repo}
                      </span>
                    )}
                  </span>
                  {!stack && prUrl && (
                    <a
                      href={prUrl}
                      title={pr?.title || prUrl}
                      style={{
                        ...muted,
                        marginLeft: "auto",
                        flex: "none",
                        whiteSpace: "nowrap",
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        openPr(worktree, pr);
                      }}
                    >
                      PR #{pr?.number}
                    </a>
                  )}
                  {!stack && !prUrl && worktree.pullRequest && (
                    <span
                      style={{
                        ...muted,
                        marginLeft: "auto",
                        flex: "none",
                        whiteSpace: "nowrap",
                      }}
                    >
                      PR {worktree.pullRequest}
                    </span>
                  )}
                </div>
                {stack && (
                  <StackLines
                    stack={stack}
                    worktree={worktree}
                    busy={disabled || rowBusy(worktree) || toolbarBusy}
                    onOpen={(entry) => void context.os.openExternal(entry.url)}
                    onOpenStack={() => void context.os.openExternal(stack.url)}
                    onMerge={(entry) => merge(worktree, entry.number)}
                  />
                )}
                <div style={{ display: "flex", alignItems: "center" }}>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={disabled || rowBusy(worktree)}
                    title={`Open session in ${worktree.path}`}
                    aria-label={`Open session in ${worktree.name}@${worktree.repo}`}
                    onClick={() =>
                      run(rowActionId("open", worktree), () => open(worktree))
                    }
                    style={iconButton(TOOLBAR_HEIGHT)}
                  >
                    {running.has(rowActionId("open", worktree)) ? (
                      <Codicon name="loading" spinning />
                    ) : (
                      <Codicon name="comment-discussion" />
                    )}
                  </Button>
                  <span
                    style={{
                      ...rowItem,
                      ...muted,
                      minWidth: 52,
                      marginLeft: 20,
                      gap: 4,
                      flex: "none",
                    }}
                    aria-label={
                      worktree.todoTotal !== undefined
                        ? `TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done`
                        : undefined
                    }
                    title={
                      worktree.todoTotal !== undefined
                        ? `TODO ${worktree.todoDone ?? 0} of ${worktree.todoTotal} done`
                        : "No TODOs"
                    }
                  >
                    {worktree.todoTotal !== undefined && (
                      <>
                        <Codicon name="check-all" />
                        {worktree.todoDone ?? 0}/{worktree.todoTotal}
                      </>
                    )}
                  </span>
                  <span
                    role="img"
                    aria-label={
                      worktree.review
                        ? `Review ${worktree.review.approved} of ${worktree.review.total} commits approved`
                        : "Review status unknown"
                    }
                    title={
                      worktree.review
                        ? `Review ${worktree.review.approved} of ${worktree.review.total} commits approved`
                        : "Review status unknown"
                    }
                    style={{
                      ...rowItem,
                      ...muted,
                      minWidth: 48,
                      marginLeft: 8,
                      gap: 4,
                      flex: "none",
                    }}
                  >
                    <Codicon name="eye" />
                    {worktree.review
                      ? `${worktree.review.approved}/${worktree.review.total}`
                      : "?"}
                  </span>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      marginLeft: "auto",
                    }}
                  >
                    <span
                      style={{
                        ...rowItem,
                        ...muted,
                        width: 64,
                        flex: "none",
                        justifyContent: "flex-end",
                      }}
                    >
                      {(worktree.ahead ?? 0) > 0 && (
                        <span
                          title={`${worktree.ahead} commit${worktree.ahead === 1 ? "" : "s"} ahead`}
                        >
                          ↑{worktree.ahead}
                        </span>
                      )}
                      {(worktree.behind ?? 0) > 0 && (
                        <span
                          style={{ marginLeft: 6 }}
                          title={`${worktree.behind} commit${worktree.behind === 1 ? "" : "s"} behind`}
                        >
                          ↓{worktree.behind}
                        </span>
                      )}
                    </span>
                    <RowActionButton
                      action={action}
                      color={color}
                      worktree={worktree}
                      pr={pr}
                      preview={preview}
                      disabled={disabled || rowBusy(worktree)}
                      running={running}
                      onDelete={() => remove(worktree)}
                      onPush={() => push(worktree)}
                      onMerge={() => merge(worktree)}
                      onOpenPr={() => openPr(worktree, pr)}
                      onCreatePr={() => {
                        setPrWorktree(worktree);
                        setPrTitle("");
                        setPrBody("");
                        setError(null);
                      }}
                    />
                  </div>
                </div>
                {prWorktree &&
                  prWorktree.repo === worktree.repo &&
                  prWorktree.name === worktree.name && (
                    <form
                      style={boxed}
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!toolbarBusy && !rowBusy(worktree)) {
                          createPr(worktree);
                        }
                      }}
                    >
                      <strong>
                        Create PR for {worktree.name}@{worktree.repo}
                      </strong>
                      <span style={muted}>
                        Leave both fields empty to use the commits ahead of the
                        upstream. A draft session continues if you cancel.
                      </span>
                      <label style={stackStyle}>
                        <span style={muted}>Subject</span>
                        <Input
                          value={prTitle}
                          disabled={toolbarBusy || rowBusy(worktree)}
                          onChange={(event) => setPrTitle(event.target.value)}
                        />
                      </label>
                      <label style={stackStyle}>
                        <span style={muted}>Body</span>
                        <textarea
                          value={prBody}
                          disabled={toolbarBusy || rowBusy(worktree)}
                          rows={5}
                          style={{
                            ...selectStyle,
                            resize: "vertical",
                            fontFamily: "inherit",
                          }}
                          onChange={(event) => setPrBody(event.target.value)}
                        />
                      </label>
                      <div style={rowStyle}>
                        <Button
                          type="submit"
                          size="sm"
                          disabled={
                            toolbarBusy ||
                            rowBusy(worktree) ||
                            (prBody.trim() !== "" && prTitle.trim() === "")
                          }
                        >
                          {running.has(rowActionId("pr", worktree))
                            ? "Creating…"
                            : "Create PR"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={toolbarBusy || rowBusy(worktree)}
                          onClick={() => setPrWorktree(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                {(worktree.statusError ||
                  (merged && !canRemove(worktree, pr))) && (
                  <p style={muted} role="status">
                    {worktree.statusError
                      ? "Git status could not be read. Removal is disabled."
                      : "Merged, but has uncommitted changes or an open stack PR. Finish them to remove."}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flex: "none",
          borderTop: "1px solid var(--ui-stroke-secondary)",
          paddingTop: 10,
        }}
      >
        <span style={{ ...muted, marginRight: "auto" }} aria-live="polite">
          {data ? `${filtered.length} of ${worktrees.length} worktrees` : ""}
          {toolbarBusy ? " · Working…" : ""}
        </span>
        {data ? (
          <span
            style={{ ...muted, minWidth: 64, textAlign: "right" }}
            title={
              data.fetchError
                ? data.fetchError
                : "Worktrees and remotes refreshed"
            }
          >
            {timeAgo(data.fetchedAt)}
          </span>
        ) : (
          <span style={{ ...muted, minWidth: 64, textAlign: "right" }}>
            Stale
          </span>
        )}
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={toolbarBusy || !online}
          title="Refresh: list worktrees and fetch their remotes"
          aria-label="Refresh"
          onClick={() =>
            run("refresh", async () => {
              const response = await post("/fetch", {});
              const errors =
                record(response) && Array.isArray(response.errors)
                  ? response.errors.filter(
                      (item): item is string => typeof item === "string",
                    )
                  : [];
              await refresh();
              if (errors.length)
                setNotice([`Fetch reported: ${errors.join("; ")}`]);
              setError(null);
              setBlockedCreate(false);
              setBlockedAdd(false);
            })
          }
          style={iconButton(TOOLBAR_HEIGHT)}
        >
          {running.has("refresh") ? (
            <Codicon name="loading" spinning />
          ) : (
            <Codicon name="refresh" />
          )}
        </Button>
      </div>
    </section>
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
  onCreatePr,
}: {
  action: RowAction;
  color: string;
  worktree: Worktree;
  pr: PrEntry | undefined;
  preview: RemovePreview | null;
  disabled: boolean;
  running: Set<string>;
  onDelete: () => void;
  onPush: () => void;
  onMerge: () => void;
  onOpenPr: () => void;
  onCreatePr: () => void;
}) {
  const armed = preview?.worktree.path === worktree.path;
  const idFor = (verb: string) => rowActionId(verb, worktree);
  if (action === null)
    return (
      <span
        aria-hidden="true"
        style={{ width: TOOLBAR_HEIGHT, flexShrink: 0 }}
      />
    );
  const title =
    action === "delete"
      ? armed
        ? `Click again within 5s to delete ${preview?.worktree.name}@${preview?.worktree.repo}, branch ${preview?.branch}, and its directory.`
        : `Remove ${worktree.name}@${worktree.repo}`
      : action === "push"
        ? `Push ${pr?.unpushed ?? 0} commit${pr?.unpushed === 1 ? "" : "s"} to origin/${worktree.name}`
        : action === "merge"
          ? `Merge PR #${pr?.number}`
          : action === "open-pr"
            ? pr?.mergeBlocker
              ? `Cannot merge yet (${pr.mergeBlocker}); open PR #${pr.number}`
              : `Open PR #${pr?.number}`
            : action === "create-pr"
              ? `Open or create a PR for ${worktree.name}@${worktree.repo}`
              : `origin/${worktree.name} has commits this worktree lacks. Pull or rebase before opening or updating a PR.`;
  const onClick =
    action === "delete"
      ? onDelete
      : action === "push"
        ? onPush
        : action === "merge"
          ? onMerge
          : action === "open-pr"
            ? onOpenPr
            : action === "create-pr"
              ? onCreatePr
              : undefined;
  const verb =
    action === "delete"
      ? "remove"
      : action === "push"
        ? "push"
        : action === "merge"
          ? "merge"
          : action === "create-pr"
            ? "pr"
            : null;
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={disabled || action === "blocked"}
      title={title}
      aria-label={title}
      style={{ ...iconButton(TOOLBAR_HEIGHT), color }}
      onClick={onClick}
    >
      {verb !== null && running.has(idFor(verb)) ? (
        <Codicon name="loading" spinning />
      ) : action === "delete" ? (
        <Codicon name="trash" />
      ) : action === "push" ? (
        <PushIcon />
      ) : action === "merge" || action === "open-pr" ? (
        <MergeIcon />
      ) : action === "create-pr" ? (
        <CreatePrIcon />
      ) : (
        <Codicon name="warning" />
      )}
    </Button>
  );
}

function StackLines({
  stack,
  worktree,
  busy,
  onOpen,
  onOpenStack,
  onMerge,
}: {
  stack: StackInfo;
  worktree: Worktree;
  busy: boolean;
  onOpen: (entry: StackInfo["prs"][number]) => void;
  onOpenStack: () => void;
  onMerge: (entry: StackInfo["prs"][number]) => void;
}) {
  const allMerged = stack.prs.every((entry) => entry.state !== "OPEN");
  return (
    <div
      role="group"
      aria-label={`Stack #${stack.number} of ${worktree.name}@${worktree.repo}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        border: "1px solid var(--ui-stroke-secondary)",
        borderRadius: 4,
        padding: "6px 8px",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
        <Codicon name="layers" style={{ color: "var(--ui-accent)" }} />
        <a
          href={stack.url}
          onClick={(event) => {
            event.preventDefault();
            onOpenStack();
          }}
          title={stack.url}
          style={{
            color: "var(--ui-accent)",
            fontWeight: 600,
            fontSize: 12,
          }}
        >
          Stack #{stack.number}
        </a>
        <span style={faint}>· {stack.size} PRs</span>
        <span style={faint}>
          {allMerged ? "all merged" : "top PR merges all"}
        </span>
      </div>
      {stack.prs.map((entry) => {
        const color =
          entry.state === "MERGED"
            ? "var(--ui-purple)"
            : entry.blocker
              ? "var(--ui-red)"
              : entry.checks === "pending"
                ? "var(--ui-yellow)"
                : "var(--ui-green)";
        return (
          <div
            key={entry.number}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              paddingLeft: entry.current ? 0 : 8,
            }}
          >
            <span
              style={{
                ...faint,
                minWidth: 0,
                overflowWrap: "anywhere",
              }}
            >
              {entry.branch || `PR #${entry.number}`}
            </span>
            <a
              href={entry.url}
              title={entry.title || entry.url}
              style={{ ...muted, flex: "none" }}
              onClick={(event) => {
                event.preventDefault();
                onOpen(entry);
              }}
            >
              #{entry.number}
            </a>
            <span style={{ ...faint, marginLeft: "auto", flex: "none" }}>
              {entry.state === "MERGED"
                ? "merged"
                : entry.state === "CLOSED"
                  ? "closed"
                  : (entry.blocker ?? "ready")}
            </span>
            {entry.state === "OPEN" && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={busy || entry.blocker !== null}
                title={
                  entry.blocker
                    ? `Cannot merge: ${entry.blocker}`
                    : `Merge the stack through PR #${entry.number}`
                }
                aria-label={`Merge stack PR #${entry.number}`}
                style={{ ...iconButton(24), color }}
                onClick={() => onMerge(entry)}
              >
                <MergeIcon size={14} />
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const menuStyle: CSSProperties = {
  position: "absolute",
  top: `calc(100% + 4px)`,
  left: 0,
  zIndex: 5,
  minWidth: 170,
  padding: 4,
  background: "var(--ui-bg-elevated)",
  border: "1px solid var(--ui-stroke-secondary)",
  borderRadius: 6,
  boxShadow: "0 8px 24px rgba(0, 0, 0, 0.4)",
};
const menuItemStyle: CSSProperties = {
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
  cursor: "pointer",
};
const menuSeparatorStyle: CSSProperties = {
  display: "block",
  height: 1,
  margin: "4px 0",
  background: "var(--ui-stroke-secondary)",
};
