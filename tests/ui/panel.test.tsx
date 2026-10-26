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

// jest-dom's bundled adapter targets Vitest 4's one-parameter Assertion.
// Vitest 5 exposes the result type and subject type separately.
declare module "vitest" {
  interface Assertion<
    R extends void | Promise<void> = void,
    T = unknown,
  > extends TestingLibraryMatchers<T, R> {}
}
expect.extend(matchers);
import type { PluginContext } from "@hermes/plugin-sdk";
import { TimberPanel } from "../../ui/panel";
import plugin from "../../ui/plugin";
import type { TimberState, Worktree } from "../../ui/contracts";
import { host, resetHost, switchScope } from "./sdk-stub";

const clean: Worktree = {
  name: "done",
  repo: "app",
  path: "/trees/app/done",
  clean: true,
  merged: true,
  statusError: false,
  commit: "abc",
  ahead: 0,
  behind: 1,
  todoDone: 2,
  todoTotal: 3,
  pullRequest: "#12",
};
const dirty: Worktree = {
  name: "working",
  repo: "app",
  path: "/trees/app/working",
  clean: false,
  merged: false,
  statusError: false,
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
  worktrees: [dirty, clean, broken],
  warnings: [],
};
const rest = vi.fn<PluginContext["rest"]>();
const register = vi.fn<PluginContext["register"]>(() => () => {});
const context: PluginContext = {
  rest: async <T,>(
    path: string,
    options?: Parameters<PluginContext["rest"]>[1],
  ) => (await rest(path, options)) as T,
  register,
};
let client: QueryClient;

function mount(mutationRetries = 0) {
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: mutationRetries, retryDelay: 1 },
    },
  });
  return render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TimberPanel context={context} />
      </QueryClientProvider>
    </StrictMode>,
  );
}
function deferred() {
  let resolve: (value: unknown) => void = () => {};
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function loaded() {
  await screen.findByText(
    (_, element) =>
      element?.tagName === "STRONG" && element.textContent === "done@app",
  );
}
async function refresh() {
  await act(async () => {
    await client.refetchQueries({ queryKey: ["hermes-timber"] });
  });
}
beforeEach(() => {
  resetHost();
  rest.mockReset();
  register.mockClear();
  rest.mockResolvedValue(state);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.useRealTimers();
});

describe("Timber desktop panel", () => {
  it.each([401, 403])(
    "pauses automatic reads after HTTP %i until explicit retry",
    async (status) => {
      vi.useFakeTimers();
      mount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(
        screen.getByText(
          (_, element) =>
            element?.tagName === "STRONG" && element.textContent === "done@app",
        ),
      ).toBeVisible();
      rest.mockRejectedValue(new Error(`${status}: {"reason":"no_cookie"}`));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(rest).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(600_000);
      });
      expect(rest).toHaveBeenCalledTimes(2);
      await act(async () => {
        host.state.gateway.set("closed");
        host.state.gateway.set("open");
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(rest).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Automatic requests are paused",
      );
      expect(
        screen.getByRole("button", { name: "Sync Projects" }),
      ).toBeDisabled();
      rest.mockResolvedValue(state);
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Retry after sign-in" }),
        );
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(rest).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(rest).toHaveBeenCalledTimes(4);
    },
  );

  it("backs off failed reads exponentially to a cap and resets after recovery", async () => {
    vi.useFakeTimers();
    rest.mockRejectedValue(new Error("503: gateway unavailable"));
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(rest).toHaveBeenCalledTimes(1);
    let attempts = 1;
    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(rest).toHaveBeenCalledTimes(attempts);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      attempts++;
      expect(rest).toHaveBeenCalledTimes(attempts);
    }
    rest.mockResolvedValue(state);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(rest).toHaveBeenCalledTimes(attempts + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_999);
    });
    expect(rest).toHaveBeenCalledTimes(attempts + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(rest).toHaveBeenCalledTimes(attempts + 2);
  });

  it("pauses after mutation auth failure without replaying the mutation", async () => {
    vi.useFakeTimers();
    rest
      .mockResolvedValueOnce(state)
      .mockRejectedValue(
        Object.assign(new Error("Access denied"), { statusCode: 401 }),
      );
    mount(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Sync Projects" }));
      await vi.advanceTimersByTimeAsync(600_000);
    });
    expect(rest.mock.calls.filter(([path]) => path === "/sync")).toHaveLength(
      1,
    );
    expect(rest.mock.calls.filter(([path]) => path === "/state")).toHaveLength(
      1,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Automatic requests are paused",
    );
    rest.mockResolvedValue(state);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Retry after sign-in" }),
      );
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(rest.mock.calls.filter(([path]) => path === "/sync")).toHaveLength(
      1,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("rejects unknown worktree status instead of enabling cleanup", async () => {
    const { statusError: _unknownStatus, ...unknownStatus } = clean;
    rest.mockResolvedValue({ ...state, worktrees: [unknownStatus] });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid state response",
    );
    expect(
      screen.queryByRole("button", { name: "Remove done@app" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync Projects" }),
    ).toBeDisabled();
  });

  it("filters fuzzy selectors and statuses, includes empty repositories, and sorts rows", async () => {
    mount();
    await loaded();
    const list = screen.getByRole("list", { name: "Worktrees" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getByRole("button", { name: "Remove working@app" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove broken@lib" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Find worktrees"), {
      target: { value: "dn@ap" },
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(
      within(list).getByText(
        (_, element) =>
          element?.tagName === "STRONG" && element.textContent === "done@app",
      ),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Find worktrees"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "safe" },
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "error" },
    });
    expect(
      within(list).getByText(
        (_, element) =>
          element?.tagName === "STRONG" && element.textContent === "broken@lib",
      ),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Status"), {
      target: { value: "all" },
    });
    fireEvent.change(screen.getByLabelText("Sort"), {
      target: { value: "name" },
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map(
          (item) =>
            within(item).getByText(
              (_, element) =>
                element?.tagName === "STRONG" &&
                Boolean(element.textContent?.includes("@")),
            ).textContent,
        ),
    ).toEqual(["broken@lib", "done@app", "working@app"]);
    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "empty" },
    });
    expect(screen.getByText("No matching worktrees.")).toBeVisible();
  });

  it("creates with Timber-selected branch and explicit upstream, then refreshes", async () => {
    const user = userEvent.setup();
    rest
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({
        worktree: clean,
        warnings: ["Project synchronized"],
      })
      .mockResolvedValue({ ...state, worktrees: [clean] });
    mount();
    await loaded();
    await user.click(screen.getByRole("button", { name: "New worktree" }));
    await user.selectOptions(
      screen.getByLabelText("Create repository"),
      "empty",
    );
    await user.type(
      screen.getByLabelText("Upstream (optional)"),
      "origin/main",
    );
    await user.click(screen.getByRole("button", { name: "Create worktree" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("form", { name: "Create worktree" }),
      ).not.toBeInTheDocument(),
    );
    expect(rest).toHaveBeenCalledWith("/create", {
      method: "POST",
      body: { repo: "empty", name: "", upstream: "origin/main" },
    });
    await screen.findByText("Project synchronized");
    await screen.findByText("1 of 1 worktrees");
  });

  it("blocks retries after a failed creation until the listing is refreshed", async () => {
    rest
      .mockResolvedValueOnce(state)
      .mockRejectedValueOnce(
        new Error("Creation outcome unknown; refresh before retrying"),
      );
    mount();
    await loaded();
    await userEvent.click(screen.getByRole("button", { name: "New worktree" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Create worktree" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Creation outcome unknown",
    );
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "STRONG" && element.textContent === "done@app",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Create worktree" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sync Projects" }),
    ).toBeDisabled();
    rest.mockResolvedValue(state);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Create worktree" }),
      ).toBeEnabled(),
    );
  });

  it("only reconciles Projects through the explicit Sync Projects action", async () => {
    rest
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({ warnings: [] })
      .mockResolvedValue(state);
    mount();
    await loaded();
    expect(rest.mock.calls.every(([path]) => path === "/state")).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Sync Projects" }),
    );
    await screen.findByText("Completed.");
    expect(rest).toHaveBeenCalledWith("/sync", { method: "POST", body: {} });
    await waitFor(() =>
      expect(
        rest.mock.calls.filter(([path]) => path === "/state"),
      ).toHaveLength(2),
    );
  });

  it("previews the exact selector, path, and branch before token-only removal", async () => {
    rest
      .mockResolvedValueOnce(state)
      .mockResolvedValueOnce({
        token: "snapshot-1",
        worktree: clean,
        branch: "feature/done",
        warning: "This deletes the branch.",
      })
      .mockResolvedValueOnce({ removed: true, warnings: [] })
      .mockResolvedValue({ ...state, worktrees: [dirty] });
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm worktree removal",
    });
    expect(within(dialog).getByText("Remove done@app?")).toBeVisible();
    expect(
      within(dialog).getByText("Delete directory: /trees/app/done"),
    ).toBeVisible();
    expect(
      within(dialog).getByText("Delete branch: feature/done"),
    ).toBeVisible();
    expect(rest).toHaveBeenCalledWith("/remove/preview", {
      method: "POST",
      body: { repo: "app", name: "done" },
    });
    expect(rest.mock.calls.some(([path]) => path === "/remove")).toBe(false);
    expect(within(dialog).getByText(/TODO/)).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(rest).toHaveBeenCalledWith("/remove", {
      method: "POST",
      body: { token: "snapshot-1" },
    });
    await waitFor(() =>
      expect(
        screen.queryByText(
          (_, element) =>
            element?.tagName === "STRONG" && element.textContent === "done@app",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("expires removal consent and requires a fresh preview", async () => {
    vi.useFakeTimers();
    rest.mockResolvedValueOnce(state).mockResolvedValue({
      token: "token",
      worktree: clean,
      branch: "done",
      warning: "Delete",
    });
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove done@app" }));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove done@app" }));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(
      rest.mock.calls.filter(([path]) => path === "/remove/preview"),
    ).toHaveLength(2);
    expect(rest.mock.calls.some(([path]) => path === "/remove")).toBe(false);
  });

  it("discards a late preview after the search changes", async () => {
    const pending = deferred();
    rest
      .mockResolvedValueOnce(state)
      .mockImplementationOnce(() => pending.promise);
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    fireEvent.change(screen.getByLabelText("Find worktrees"), {
      target: { value: "done" },
    });
    await act(async () => {
      pending.resolve({
        token: "late",
        worktree: clean,
        branch: "done",
        warning: "Delete",
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rest.mock.calls.some(([path]) => path === "/remove")).toBe(false);
  });

  it("disarms consent on refresh and on gateway disconnect", async () => {
    const preview = {
      token: "token",
      worktree: clean,
      branch: "done",
      warning: "Delete",
    };
    rest.mockImplementation(async (path) =>
      path === "/remove/preview" ? preview : state,
    );
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    await screen.findByRole("dialog");
    await refresh();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    await screen.findByRole("dialog");
    act(() => host.state.gateway.set("closed"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => host.state.gateway.set("open"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove done@app" }),
      ).toBeEnabled(),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    await screen.findByRole("dialog");
    expect(rest.mock.calls.some(([path]) => path === "/remove")).toBe(false);
  });

  it("keeps cached rows after a failed poll, disables actions, and recovers on refresh", async () => {
    mount();
    await loaded();
    rest.mockRejectedValue(new Error("Backend unreachable"));
    await refresh();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "STRONG" && element.textContent === "done@app",
      ),
    ).toBeVisible();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cached results are stale",
    );
    expect(
      screen.getByRole("button", { name: "Remove done@app" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Sync Projects" }),
    ).toBeDisabled();
    rest.mockResolvedValue(state);
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Sync Projects" }),
      ).toBeEnabled(),
    );
    act(() => {
      host.state.gateway.set("closed");
    });
    expect(
      screen.getByRole("button", { name: "Open done@app in Hermes" }),
    ).toBeDisabled();
    expect(screen.getByText(/Gateway offline/)).toBeVisible();
  });

  it.each(["source", "profile", "epoch"])(
    "discards rows and removal consent when the %s changes",
    async (change) => {
      rest.mockResolvedValueOnce(state).mockResolvedValueOnce({
        token: "old-token",
        worktree: clean,
        branch: "done",
        warning: "Delete",
      });
      mount();
      await loaded();
      await userEvent.click(
        screen.getByRole("button", { name: "Remove done@app" }),
      );
      await screen.findByRole("dialog");
      const pending = deferred();
      rest.mockImplementation(() => pending.promise);
      act(() => {
        switchScope(
          change === "source" ? "remote-b" : "local",
          change === "profile" ? "work" : "default",
        );
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          (_, element) =>
            element?.tagName === "STRONG" && element.textContent === "done@app",
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Sync Projects" }),
      ).toBeDisabled();
      await act(async () => {
        pending.resolve({ ...state, worktrees: [], host: "gateway-b" });
      });
      await screen.findByText(/No worktrees yet/);
    },
  );

  it("ignores an old preview completion after a same-profile source swap", async () => {
    const pending = deferred();
    rest
      .mockResolvedValueOnce(state)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue({ ...state, worktrees: [] });
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove done@app" }),
    );
    act(() => {
      switchScope("remote-b");
    });
    await screen.findByText(/No worktrees yet/);
    await act(async () => {
      pending.resolve({
        token: "late-token",
        worktree: clean,
        branch: "done",
        warning: "Delete",
      });
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(rest.mock.calls.some(([path]) => path === "/remove")).toBe(false);
  });

  it("opens a cwd-verified session in its repository Project, not a cwd-less draft", async () => {
    host.request
      .mockResolvedValueOnce({ active_id: "project-app" })
      .mockResolvedValueOnce({
        stored_session_id: "stored-new",
        info: { cwd: clean.path },
      })
      .mockResolvedValueOnce({ cwd: clean.path });
    host.openSession.mockResolvedValue();
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Open done@app in Hermes" }),
    );
    await screen.findByText("Opened done@app in Hermes.");
    expect(host.request).toHaveBeenNthCalledWith(1, "projects.set_active", {
      id: "project-app",
      profile: "default",
    });
    expect(host.request).toHaveBeenNthCalledWith(2, "session.create", {
      cwd: clean.path,
      title: "done",
      source: "desktop",
      profile: "default",
    });
    expect(host.request).toHaveBeenNthCalledWith(3, "session.workspace.move", {
      session_key: "stored-new",
      cwd: clean.path,
      profile: "default",
    });
    expect(host.openSession).toHaveBeenCalledWith("stored-new", {
      profile: "default",
      awaitHydration: true,
      keepAllProfilesScope: true,
    });
    expect(
      within(screen.getByRole("list", { name: "Worktrees" })).getAllByRole(
        "listitem",
      )[0],
    ).toHaveTextContent("done@app");
  });

  it("refuses to navigate when session.create does not confirm the requested cwd", async () => {
    host.request
      .mockResolvedValueOnce({ active_id: "project-app" })
      .mockResolvedValueOnce({
        stored_session_id: "wrong",
        info: { cwd: "/wrong" },
      });
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Open done@app in Hermes" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "did not confirm the requested working directory",
    );
    expect(host.openSession).not.toHaveBeenCalled();
  });

  it("does not create a session on a replacement route after project activation completes late", async () => {
    const pending = deferred();
    host.request.mockImplementationOnce(() => pending.promise);
    mount();
    await loaded();
    await userEvent.click(
      screen.getByRole("button", { name: "Open done@app in Hermes" }),
    );
    act(() => {
      switchScope("remote-b");
    });
    await loaded();
    await act(async () => {
      pending.resolve({ active_id: "project-app" });
    });
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.openSession).not.toHaveBeenCalled();
  });

  it("rejects malformed backend state instead of rendering trusted-looking rows", async () => {
    rest.mockResolvedValue({
      ...state,
      worktrees: [{ ...clean, clean: "yes" }],
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid state response",
    );
    expect(
      screen.queryByText(
        (_, element) =>
          element?.tagName === "STRONG" && element.textContent === "done@app",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New worktree" })).toBeDisabled();
  });

  it("registers a native pane and a command that reveals that exact pane", () => {
    plugin.register(context);
    const pane = register.mock.calls
      .map(([contribution]) => contribution)
      .find((item) => item.area === "panes");
    expect(pane?.title).toBe("Timber");
    expect(pane?.data).toEqual({ placement: "right", width: "400px" });
    const palette = register.mock.calls
      .map(([contribution]) => contribution)
      .find((item) => item.area === "palette");
    const data = palette?.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("run" in data) ||
      typeof data.run !== "function"
    )
      throw new Error("No palette command");
    data.run();
    expect(host.revealPane).toHaveBeenCalledWith("hermes-timber:panel");
  });
});
