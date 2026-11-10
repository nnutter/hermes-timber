import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<
    R extends void | Promise<void> = void,
    T = unknown,
  > extends TestingLibraryMatchers<T, R> {}
}
expect.extend(matchers);

import type {
  KeybindContribution,
  PaletteContribution,
  PluginContext,
  RouteContribution,
  SidebarNavContribution,
} from "@hermes/plugin-sdk";
import { TimberPanel } from "../../ui/panel";
import plugin from "../../ui/plugin";
import { TodoView } from "../../ui/todos";
import type {
  PrEntry,
  TimberState,
  TodoList,
  Worktree,
} from "../../ui/contracts";
import { host, os, resetHost, switchScope } from "./sdk-stub";
import { scopeKey } from "../../ui/scope";

const done: Worktree = {
  name: "done",
  repo: "app",
  path: "/trees/app/done",
  clean: true,
  merged: true,
  statusError: false,
  commit: "abc",
  upstream: "origin/main",
  ahead: 0,
  behind: 1,
  todoDone: 2,
  todoTotal: 3,
  pullRequest: "#12",
  review: { approved: 2, total: 4 },
};
const dirty: Worktree = {
  name: "working",
  repo: "app",
  path: "/trees/app/working",
  clean: false,
  merged: false,
  statusError: false,
  ahead: 1,
  behind: 0,
};
const broken: Worktree = {
  name: "broken",
  repo: "lib",
  path: "/trees/lib/broken",
  clean: true,
  merged: true,
  statusError: true,
};
const state: TimberState = {
  host: "gateway-a",
  hermes_home: "/home/test/.hermes",
  repositories: ["app", "lib", "empty"],
  projects: { app: "project-app", lib: "project-lib" },
  worktrees: [dirty, done, broken],
  warnings: [],
  at: Date.now(),
  fetchedAt: Date.now(),
  fetchError: null,
  prs: {},
  prsAt: Date.now(),
};
const rest = vi.fn<PluginContext["rest"]>();
const register = vi.fn<PluginContext["register"]>(() => () => {});
const registerMany = vi.fn<PluginContext["registerMany"]>(() => () => {});
const context: PluginContext = {
  rest: async <T,>(
    path: string,
    options?: Parameters<PluginContext["rest"]>[1],
  ) => (await rest(path, options)) as T,
  register,
  registerMany,
  os,
};
let client: QueryClient;

function mountPanel() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TimberPanel context={context} />
      </QueryClientProvider>
    </StrictMode>,
  );
}

function mountTodo() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TodoView
          context={context}
          scope={scopeKey()}
          online
          cwd={dirty.path}
          surface="panel"
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

async function loaded(text = "done") {
  const list = await screen.findByRole("list", { name: "Worktrees" });
  await within(list).findByText(text);
  return list;
}

function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function order(list: HTMLElement) {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.getAttribute("data-worktree"));
}

beforeEach(() => {
  resetHost();
  rest.mockReset();
  register.mockClear();
  registerMany.mockClear();
  rest.mockResolvedValue(state);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.useRealTimers();
});

describe("Timber worktrees", () => {
  it("renders rows with counts, review progress, and one action", async () => {
    mountPanel();
    const list = await loaded();
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    const doneItem = within(list).getByTitle("/trees/app/done").closest("li");
    if (!doneItem) throw new Error("done row missing");
    expect(
      within(doneItem).getByLabelText("TODO 2 of 3 done"),
    ).toHaveTextContent("2/3");
    expect(
      within(doneItem).getByRole("img", {
        name: "Review 2 of 4 commits approved",
      }),
    ).toHaveTextContent("2/4");
    expect(
      within(list).getAllByRole("img", { name: "Review status unknown" })[0],
    ).toHaveTextContent("?");
    expect(
      within(doneItem).getByRole("button", { name: "Remove done@app" }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("button", {
        name: "Open or create a PR for working@app",
      }),
    ).toBeInTheDocument();
  });

  it("collects worktree and PR state when the panel opens cold", async () => {
    let collected = false;
    rest.mockImplementation(async (path) => {
      if (path === "/fetch") {
        collected = true;
        return { fetchedAt: Date.now(), errors: [] };
      }
      return collected
        ? { ...state, fetchedAt: Date.now(), prsAt: Date.now() }
        : { ...state, fetchedAt: null, prsAt: null };
    });
    mountPanel();
    await loaded();
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/fetch", {
        method: "POST",
        body: {},
      }),
    );
    const list = screen.getByRole("list", { name: "Worktrees" });
    expect(
      await within(list).findByRole("button", {
        name: "Open or create a PR for working@app",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("never")).not.toBeInTheDocument();
  });

  it("searches contiguous fields and cycles the sort modes", async () => {
    mountPanel();
    const list = await loaded();
    const search = screen.getByLabelText("Find worktrees");
    for (const [query, count] of [
      ["DONE@APP", 1],
      ["done @ app", 1],
      ["dn@ap", 0],
      ["app /trees", 0],
      ["dirty", 1],
      ["merged", 2],
      ["error", 1],
      ["behind", 3],
      ["ahead", 3],
      ["origin/main", 1],
      ["clean", 2],
      ["todo", 1],
    ] as const) {
      fireEvent.change(search, { target: { value: query } });
      expect(within(list).queryAllByRole("listitem"), query).toHaveLength(
        count,
      );
    }
    fireEvent.change(search, { target: { value: "" } });
    expect(order(list)).toEqual(["app/working", "app/done", "lib/broken"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Sort worktrees" }),
    );
    expect(order(list)).toEqual(["app/done", "app/working", "lib/broken"]);
    await userEvent.click(
      screen.getByRole("button", { name: "Sort worktrees" }),
    );
    expect(order(list)).toEqual(["lib/broken", "app/done", "app/working"]);
  });

  it("rejects unknown worktree status and disables actions", async () => {
    const { statusError: _unknownStatus, ...unknownStatus } = done;
    rest.mockResolvedValue({ ...state, worktrees: [unknownStatus] });
    mountPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid state response",
    );
    expect(
      screen.queryByRole("button", { name: /Remove done/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More actions" })).toBeDisabled();
  });

  it("rejects malformed review counts", async () => {
    const malformed = { ...done, review: { approved: "2", total: 4 } };
    rest.mockResolvedValue({ ...state, worktrees: [malformed] });
    mountPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid state response",
    );
    expect(screen.getByRole("button", { name: "More actions" })).toBeDisabled();
  });

  it("rebases a worktree from its down count", async () => {
    const behind: Worktree = {
      name: "behind",
      repo: "app",
      path: "/trees/app/behind",
      clean: true,
      merged: false,
      statusError: false,
      ahead: 1,
      behind: 2,
      commit: "b",
      upstream: "origin/main",
    };
    rest.mockImplementation(async (path) => {
      if (path === "/rebase")
        return { rebased: true, upstream: "origin/main", state: null };
      return { ...state, worktrees: [behind], prs: {} };
    });
    mountPanel();
    const list = await loaded("behind");
    await userEvent.click(
      within(list).getByRole("button", {
        name: "Rebase 2 commits from upstream for behind@app",
      }),
    );
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/rebase", {
        method: "POST",
        body: { repo: "app", name: "behind" },
      }),
    );
    await screen.findByText("Rebased behind@app onto origin/main.");
  });

  it("creates a worktree and opens its session", async () => {
    let created = false;
    rest.mockImplementation(async (path) => {
      if (path === "/create") {
        created = true;
        return { worktree: done, warnings: ["Project synchronized"] };
      }
      if (path.startsWith("/sessions?")) return { sessions: [] };
      return created ? { ...state, worktrees: [done] } : state;
    });
    host.request.mockImplementation(async (method) => {
      if (method === "projects.set_active") return { active_id: "project-app" };
      if (method === "session.create")
        return { stored_session_id: "s1", info: { cwd: done.path } };
      if (method === "session.workspace.move") return { cwd: done.path };
      return null;
    });
    mountPanel();
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "New worktree" }));
    await userEvent.selectOptions(
      screen.getByLabelText("Create repository"),
      "empty",
    );
    await userEvent.type(
      screen.getByLabelText("Upstream (optional)"),
      "origin/main",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Create worktree" }),
    );
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/create", {
        method: "POST",
        body: { repo: "empty", name: "", upstream: "origin/main" },
      }),
    );
    await screen.findByText("Created done@app.");
    expect(host.openSession).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ profile: "default" }),
    );
    await screen.findByText("1 of 1 worktrees");
    expect(screen.getByText("Project synchronized")).toBeVisible();
  });

  it("blocks create retries until a refresh clears the uncertainty", async () => {
    rest.mockImplementation(async (path) => {
      if (path === "/create")
        throw new Error("Creation outcome unknown; refresh before retrying");
      if (path === "/fetch") return { fetchedAt: 1, errors: [] };
      return state;
    });
    mountPanel();
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "New worktree" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create worktree" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Creation outcome unknown",
    );
    expect(
      screen.getByRole("button", { name: "Create worktree" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create worktree" }),
      ).toBeEnabled(),
    );
  });

  it("imports a repository from the toolbar menu", async () => {
    let added = false;
    rest.mockImplementation(async (path) => {
      if (path === "/repositories") {
        added = true;
        return { repository: "new/repo", warnings: ["Project sync failed"] };
      }
      if (path === "/fetch") return { fetchedAt: 1, errors: [] };
      return added
        ? { ...state, repositories: ["new/repo", "app", "lib", "empty"] }
        : state;
    });
    mountPanel();
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Import repo" }),
    );
    await userEvent.type(
      screen.getByLabelText("Repository URL or path"),
      "/tmp/origin",
    );
    await userEvent.type(
      screen.getByLabelText("Repository name (optional)"),
      "new/repo",
    );
    await userEvent.type(screen.getByLabelText("Alias (optional)"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/repositories", {
        method: "POST",
        body: { source: "/tmp/origin", name: "new/repo", alias: "short" },
      }),
    );
    await screen.findByText("Project sync failed");
  });

  it("previews and confirms a removal with a token", async () => {
    let removed = false;
    rest.mockImplementation(async (path) => {
      if (path === "/remove/preview")
        return {
          token: "token",
          worktree: done,
          branch: "done",
          warning: "Removes the checkout and branch.",
        };
      if (path === "/remove") {
        removed = true;
        return { removed: "done@app", warnings: [] };
      }
      if (path === "/sessions/archive") return { archived: 1, total: 1 };
      return removed ? { ...state, worktrees: [dirty, broken] } : state;
    });
    mountPanel();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: /Click again within 5s to delete done@app/,
      }),
    );
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/remove", {
        method: "POST",
        body: { token: "token" },
      }),
    );
    await screen.findByText("Removed done@app. Archived 1 session.");
  });

  it("opens the newest session already in the worktree folder", async () => {
    rest.mockImplementation(async (path) => {
      if (path.startsWith("/sessions?"))
        return {
          sessions: [{ id: "s1", title: "done@app", updated: 1 }],
        };
      return state;
    });
    mountPanel();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Open session in done@app" }),
    );
    await waitFor(() =>
      expect(host.openSession).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ profile: "default" }),
      ),
    );
    expect(host.request).not.toHaveBeenCalled();
    await screen.findByText("Opened the latest session in done@app.");
  });

  it("refuses an opened session whose cwd was not confirmed", async () => {
    rest.mockImplementation(async (path) =>
      path.startsWith("/sessions?") ? { sessions: [] } : state,
    );
    host.request.mockImplementation(async (method) => {
      if (method === "projects.set_active") return { active_id: "project-app" };
      if (method === "session.create")
        return { stored_session_id: "s1", info: { cwd: "/wrong" } };
      return null;
    });
    mountPanel();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Open session in done@app" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "did not confirm the requested working directory",
    );
    expect(host.openSession).not.toHaveBeenCalled();
  });

  it("selects push, merge, open-PR, and create-PR actions from PR state", async () => {
    const ready: Worktree = {
      name: "ready",
      repo: "app",
      path: "/trees/app/ready",
      clean: true,
      merged: false,
      statusError: false,
      ahead: 1,
      behind: 0,
      commit: "r",
    };
    const blocked: Worktree = {
      name: "blocked",
      repo: "app",
      path: "/trees/app/blocked",
      clean: true,
      merged: false,
      statusError: false,
      ahead: 1,
      behind: 0,
      commit: "b",
    };
    const nopr: Worktree = {
      name: "nopr",
      repo: "app",
      path: "/trees/app/nopr",
      clean: true,
      merged: false,
      statusError: false,
      ahead: 1,
      behind: 0,
      commit: "n",
    };
    const prs: Record<string, PrEntry> = {
      ["app\0ready"]: {
        number: 7,
        url: "https://github.com/o/r/pull/7",
        title: "Ready",
        destExists: true,
        unpushed: 0,
        ff: true,
        mergeBlocker: null,
        checks: "passed",
        repo: "o/r",
        stack: null,
      },
      ["app\0blocked"]: {
        number: 8,
        url: "https://github.com/o/r/pull/8",
        title: "Blocked",
        destExists: true,
        unpushed: 0,
        ff: true,
        mergeBlocker: "Checks have not all passed",
        checks: "pending",
        repo: "o/r",
        stack: null,
      },
    };
    rest.mockImplementation(async (path) => {
      if (path === "/merge")
        return { merged: 7, url: "https://github.com/o/r/pull/7", state: null };
      if (path === "/pr")
        return {
          url: "https://github.com/o/r/pull/9",
          number: 9,
          created: true,
        };
      return {
        ...state,
        worktrees: [ready, blocked, nopr],
        prs,
      };
    });
    mountPanel();
    const list = await loaded("ready");
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    await userEvent.click(
      within(list).getByRole("button", { name: "Merge PR #7" }),
    );
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/merge", {
        method: "POST",
        body: { repo: "app", name: "ready" },
      }),
    );
    await userEvent.click(
      within(list).getByRole("button", {
        name: /Cannot merge yet \(Checks have not all passed\); open PR #8/,
      }),
    );
    expect(os.openExternal).toHaveBeenCalledWith(
      "https://github.com/o/r/pull/8",
    );
    await userEvent.click(
      within(list).getByRole("button", {
        name: "Open or create a PR for nopr@app",
      }),
    );
    await userEvent.type(screen.getByLabelText("Subject"), "Title");
    await userEvent.click(screen.getByRole("button", { name: "Create PR" }));
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/pr", {
        method: "POST",
        body: { repo: "app", name: "nopr", title: "Title", body: "" },
      }),
    );
  });

  it("syncs projects from the palette once", async () => {
    const pending = deferred();
    rest.mockReturnValue(pending.promise);
    plugin.register(context);
    const contributions = registerMany.mock.calls[0]?.[0] ?? [];
    const sync = contributions.find((item) => item.id === "sync-projects")
      ?.data as PaletteContribution | undefined;
    if (!sync) throw new Error("Missing sync command");
    sync.run();
    sync.run();
    expect(rest).toHaveBeenCalledTimes(1);
    expect(rest).toHaveBeenCalledWith("/sync", { method: "POST", body: {} });
    pending.resolve({ warnings: [] });
    await waitFor(() =>
      expect(host.notify).toHaveBeenCalledWith({
        kind: "success",
        message: "Projects synced.",
      }),
    );
  });

  it("registers pages, sidebar links, panes, and commands", () => {
    plugin.register(context);
    const contributions = registerMany.mock.calls[0]?.[0] ?? [];
    const panes = contributions.filter((item) => item.area === "panes");
    expect(panes.map((item) => item.title)).toEqual(["Worktrees", "TODOs"]);
    expect(panes[0]?.data).toEqual({
      placement: "right",
      width: "440px",
      collapsible: true,
    });
    const routes = contributions
      .filter((item) => item.area === "routes")
      .map((item) => (item.data as RouteContribution).path);
    expect(routes).toEqual(["/timber", "/timber-todos"]);
    const nav = contributions
      .filter((item) => item.area === "sidebar.nav")
      .map((item) => (item.data as SidebarNavContribution).path);
    expect(nav).toEqual(["/timber", "/timber-todos"]);
    const keybind = contributions.find(
      (item) => item.id === "hermes-timber.show",
    )?.data as KeybindContribution | undefined;
    if (!keybind) throw new Error("Missing keybind");
    keybind.run();
    expect(host.revealPane).toHaveBeenCalledWith("hermes-timber:panel");
    const show = contributions.find((item) => item.id === "show-timber")
      ?.data as PaletteContribution | undefined;
    if (!show) throw new Error("Missing show command");
    show.run();
    expect(host.navigate).toHaveBeenCalledWith("/timber");
  });

  it("ignores a sync result after the gateway changes", async () => {
    const pending = deferred();
    rest.mockReturnValue(pending.promise);
    plugin.register(context);
    const contributions = registerMany.mock.calls[0]?.[0] ?? [];
    const sync = contributions.find((item) => item.id === "sync-projects")
      ?.data as PaletteContribution | undefined;
    if (!sync) throw new Error("Missing sync command");
    sync.run();
    await act(async () => {
      switchScope("other");
    });
    pending.resolve({ warnings: [] });
    await waitFor(() => expect(host.notify).not.toHaveBeenCalled());
  });
});

const todoList: TodoList = {
  scope: "worktree",
  summary: { incomplete: 1, complete: 1 },
  todos: [
    { id: 1, title: "First", complete: false, depth: 0 },
    { id: 2, title: "Second", complete: true, depth: 1 },
  ],
};

describe("Timber TODOs", () => {
  beforeEach(() => {
    rest.mockImplementation(async (path) => {
      if (path.startsWith("/todo?")) return todoList;
      if (path === "/todo-add")
        return {
          ...todoList,
          summary: { incomplete: 2, complete: 1 },
          todos: [
            ...todoList.todos,
            { id: 3, title: "New task", complete: false, depth: 0 },
          ],
        };
      if (path === "/todo-toggle" || path === "/todo-remove") return todoList;
      return state;
    });
  });

  it("lists nested TODOs and reports the count", async () => {
    mountTodo();
    const list = await screen.findByRole("list", { name: "TODOs" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("First")).toBeVisible();
    expect(within(list).getByText("Second")).toHaveStyle({
      textDecoration: "line-through",
    });
    expect(screen.getByText("1 of 2 done")).toBeVisible();
  });

  it("adds, toggles, and removes items", async () => {
    mountTodo();
    await screen.findByRole("list", { name: "TODOs" });
    await userEvent.type(screen.getByLabelText("New task"), "New task");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/todo-add", {
        method: "POST",
        body: {
          repo: "app",
          name: "working",
          scope: "worktree",
          text: "New task",
        },
      }),
    );
    await userEvent.click(screen.getByLabelText("Open: First"));
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/todo-toggle", {
        method: "POST",
        body: {
          repo: "app",
          name: "working",
          scope: "worktree",
          id: 1,
          title: "First",
          complete: true,
        },
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove First" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Confirm remove First" }),
    );
    await waitFor(() =>
      expect(rest).toHaveBeenCalledWith("/todo-remove", {
        method: "POST",
        body: {
          repo: "app",
          name: "working",
          scope: "worktree",
          id: 1,
          title: "First",
        },
      }),
    );
  });
});
