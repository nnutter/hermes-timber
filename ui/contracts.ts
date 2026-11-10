export interface ReviewProgress {
  approved: number;
  total: number;
}

export interface Worktree {
  name: string;
  repo: string;
  path: string;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  commit?: string | null;
  clean: boolean;
  merged: boolean;
  statusError: boolean;
  todoDone?: number;
  todoTotal?: number;
  pullRequest?: string;
  review?: ReviewProgress | null;
}

export interface StackPr {
  number: number;
  url: string;
  title: string;
  branch: string;
  position: number;
  state: string;
  current: boolean;
  checks: string;
  blocker: string | null;
}

export interface StackInfo {
  number: number;
  url: string;
  size: number;
  base: string;
  prs: StackPr[];
}

export interface PrEntry {
  number?: number | null;
  url?: string | null;
  title?: string | null;
  destExists: boolean;
  unpushed: number;
  ff: boolean;
  mergeBlocker?: string | null;
  checks?: string | null;
  repo?: string | null;
  stack?: StackInfo | null;
}

export interface TimberState {
  host: string;
  hermes_home: string;
  repositories: string[];
  worktrees: Worktree[];
  projects: Record<string, string>;
  warnings: string[];
  at: number;
  fetchedAt: number | null;
  fetchError: string | null;
  prs: Record<string, PrEntry>;
  prsAt: number | null;
}

export interface RemovePreview {
  token: string;
  worktree: Worktree;
  branch: string;
  warning: string;
}

export interface WorktreeState {
  worktree: Worktree;
  pr: PrEntry;
}

export interface PrCreated {
  url: string;
  number: number;
  created: boolean;
}

export interface TodoItem {
  id: number;
  title: string;
  complete: boolean;
  depth: number;
}

export interface TodoList {
  scope: "worktree" | "repo";
  summary: { incomplete: number; complete: number };
  todos: TodoItem[];
}

export interface SessionEntry {
  id: string;
  title: string;
  updated: number | null;
}

export interface SessionList {
  sessions: SessionEntry[];
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item: unknown) => typeof item === "string")
  );
}

function isReviewProgress(value: unknown): value is ReviewProgress {
  return (
    record(value) &&
    typeof value.approved === "number" &&
    Number.isInteger(value.approved) &&
    value.approved >= 0 &&
    typeof value.total === "number" &&
    Number.isInteger(value.total) &&
    value.total >= 0
  );
}

export function isWorktree(value: unknown): value is Worktree {
  if (!record(value)) return false;
  return (
    ["name", "repo", "path"].every((key) => typeof value[key] === "string") &&
    typeof value.clean === "boolean" &&
    typeof value.merged === "boolean" &&
    ["upstream", "commit"].every(
      (key) => value[key] == null || typeof value[key] === "string",
    ) &&
    typeof value.statusError === "boolean" &&
    ["ahead", "behind", "todoDone", "todoTotal"].every(
      (key) =>
        value[key] === undefined ||
        (typeof value[key] === "number" && Number.isFinite(value[key])),
    ) &&
    (value.pullRequest === undefined ||
      typeof value.pullRequest === "string") &&
    (value.review === undefined ||
      value.review === null ||
      isReviewProgress(value.review))
  );
}

function isStackPr(value: unknown): value is StackPr {
  return (
    record(value) &&
    typeof value.number === "number" &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.branch === "string" &&
    typeof value.position === "number" &&
    typeof value.state === "string" &&
    typeof value.current === "boolean" &&
    typeof value.checks === "string" &&
    (value.blocker === null || typeof value.blocker === "string")
  );
}

function isStackInfo(value: unknown): value is StackInfo {
  return (
    record(value) &&
    typeof value.number === "number" &&
    typeof value.url === "string" &&
    typeof value.size === "number" &&
    typeof value.base === "string" &&
    Array.isArray(value.prs) &&
    value.prs.every(isStackPr)
  );
}

function isPrEntry(value: unknown): value is PrEntry {
  if (!record(value)) return false;
  return (
    (value.number == null || typeof value.number === "number") &&
    (value.url == null || typeof value.url === "string") &&
    (value.title == null || typeof value.title === "string") &&
    typeof value.destExists === "boolean" &&
    typeof value.unpushed === "number" &&
    typeof value.ff === "boolean" &&
    (value.mergeBlocker == null || typeof value.mergeBlocker === "string") &&
    (value.checks == null || typeof value.checks === "string") &&
    (value.repo == null || typeof value.repo === "string") &&
    (value.stack == null || isStackInfo(value.stack))
  );
}

function parsePrs(value: unknown): Record<string, PrEntry> {
  if (!record(value)) return {};
  const prs: Record<string, PrEntry> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isPrEntry(entry)) prs[key] = entry;
  }
  return prs;
}

export function parseState(value: unknown): TimberState {
  if (
    !record(value) ||
    typeof value.host !== "string" ||
    typeof value.hermes_home !== "string" ||
    !strings(value.repositories) ||
    !Array.isArray(value.worktrees) ||
    !value.worktrees.every(isWorktree) ||
    !record(value.projects) ||
    !Object.values(value.projects).every((item) => typeof item === "string") ||
    !strings(value.warnings)
  )
    throw new Error("The Timber backend returned an invalid state response.");
  // Reconstruct instead of asserting a generic REST response to be trusted data.
  const projects: Record<string, string> = {};
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
    prsAt: typeof value.prsAt === "number" ? value.prsAt : null,
  };
}

export function parsePreview(value: unknown): RemovePreview {
  if (
    !record(value) ||
    typeof value.token !== "string" ||
    !value.token ||
    !isWorktree(value.worktree) ||
    typeof value.branch !== "string" ||
    typeof value.warning !== "string"
  ) {
    throw new Error("The Timber backend returned an invalid removal preview.");
  }
  return {
    token: value.token,
    worktree: value.worktree,
    branch: value.branch,
    warning: value.warning,
  };
}

export function safeToRemove(worktree: Worktree): boolean {
  const synced = (worktree.ahead ?? 0) === 0 && (worktree.behind ?? 0) === 0;
  return worktree.clean && !worktree.statusError && (worktree.merged || synced);
}

export function responseWarnings(value: unknown): string[] {
  if (!record(value) || !strings(value.warnings))
    throw new Error(
      "The Timber backend returned an invalid mutation response.",
    );
  return value.warnings;
}

export function parseWorktreeState(value: unknown): WorktreeState {
  if (!record(value) || !isWorktree(value.worktree) || !isPrEntry(value.pr))
    throw new Error("The Timber backend returned an invalid worktree state.");
  return { worktree: value.worktree, pr: value.pr };
}

export function parsePrCreated(value: unknown): PrCreated {
  if (
    !record(value) ||
    typeof value.url !== "string" ||
    typeof value.number !== "number" ||
    typeof value.created !== "boolean"
  )
    throw new Error("The Timber backend returned an invalid PR response.");
  return { url: value.url, number: value.number, created: value.created };
}

export function parseTodoList(value: unknown): TodoList {
  if (
    !record(value) ||
    (value.scope !== "worktree" && value.scope !== "repo") ||
    !record(value.summary) ||
    typeof value.summary.incomplete !== "number" ||
    typeof value.summary.complete !== "number" ||
    !Array.isArray(value.todos)
  )
    throw new Error("The Timber backend returned an invalid TODO list.");
  const todos: TodoItem[] = [];
  for (const entry of value.todos) {
    if (
      record(entry) &&
      typeof entry.id === "number" &&
      typeof entry.title === "string" &&
      typeof entry.complete === "boolean" &&
      typeof entry.depth === "number"
    ) {
      todos.push({
        id: entry.id,
        title: entry.title,
        complete: entry.complete,
        depth: entry.depth,
      });
    }
  }
  return {
    scope: value.scope,
    summary: {
      incomplete: value.summary.incomplete,
      complete: value.summary.complete,
    },
    todos,
  };
}

export function parseSessions(value: unknown): SessionEntry[] {
  if (!record(value) || !Array.isArray(value.sessions))
    throw new Error("The Timber backend returned an invalid session list.");
  const sessions: SessionEntry[] = [];
  for (const entry of value.sessions) {
    if (
      record(entry) &&
      typeof entry.id === "string" &&
      typeof entry.title === "string" &&
      (entry.updated === null || typeof entry.updated === "number")
    ) {
      sessions.push({
        id: entry.id,
        title: entry.title,
        updated: entry.updated,
      });
    }
  }
  return sessions;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}
