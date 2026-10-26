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
}

export interface TimberState {
  host: string;
  hermes_home: string;
  repositories: string[];
  worktrees: Worktree[];
  projects: Record<string, string>;
  warnings: string[];
}

export interface RemovePreview {
  token: string;
  worktree: Worktree;
  branch: string;
  warning: string;
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
    (value.pullRequest === undefined || typeof value.pullRequest === "string")
  );
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
  return worktree.clean && worktree.merged && !worktree.statusError;
}

export function responseWarnings(value: unknown): string[] {
  if (!record(value) || !strings(value.warnings))
    throw new Error(
      "The Timber backend returned an invalid mutation response.",
    );
  return value.warnings;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : "The operation failed.";
}
