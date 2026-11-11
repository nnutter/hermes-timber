import type { PrEntry, StackInfo, Worktree } from "./contracts";
import { safeToRemove } from "./contracts";

export type SortMode = "recent" | "repo" | "name";
export type RowAction =
  "delete" | "push" | "merge" | "open-pr" | "create-pr" | "blocked" | null;

export function rowKey(worktree: Worktree): string {
  return `${worktree.repo}\0${worktree.name}`;
}

export function rowActionId(verb: string, worktree: Worktree): string {
  return `${verb}\0${rowKey(worktree)}`;
}

export function repoActionId(verb: string, repo: string): string {
  return `${verb}\0${repo}`;
}

export function sessionTitle(worktree: Worktree): string {
  return `${worktree.name}@${worktree.repo}`;
}

export function stackHasOpenPr(stack: StackInfo | null | undefined): boolean {
  return Boolean(stack?.prs.some((pr) => pr.state === "OPEN"));
}

export function canRemove(
  worktree: Worktree,
  pr: PrEntry | undefined,
): boolean {
  return safeToRemove(worktree) && !stackHasOpenPr(pr?.stack);
}

export function actionFor(
  worktree: Worktree,
  pr: PrEntry | undefined,
  prsLoaded: boolean,
): RowAction {
  const removable = canRemove(worktree, pr);
  if (worktree.merged) return removable ? "delete" : null;
  if (removable) return "delete";
  if (!prsLoaded) return null;
  const canUpload = Boolean(
    pr && pr.unpushed > 0 && pr.ff && !worktree.statusError,
  );
  if (canUpload) return "push";
  if (stackHasOpenPr(pr?.stack)) return null;
  const openPr = Boolean(pr?.url);
  const mergeReason = openPr ? (pr?.mergeBlocker ?? null) : null;
  if (openPr) return mergeReason === null ? "merge" : "open-pr";
  const behindRemote = Boolean(
    pr && pr.destExists && !pr.ff && !worktree.statusError,
  );
  if (behindRemote) return "blocked";
  if (worktree.statusError) return null;
  return "create-pr";
}

function dimShade(color: string): string {
  return `color-mix(in srgb, ${color} 78%, var(--ui-bg-primary))`;
}

export function actionColor(
  action: RowAction,
  worktree: Worktree,
  checks: string | null | undefined,
): string {
  if (action === "delete") return "var(--ui-purple)";
  if (action === "merge") return "var(--ui-green)";
  if (action === "push" || action === "create-pr") {
    return dimShade(
      worktree.clean && !worktree.statusError
        ? "var(--ui-green)"
        : "var(--ui-yellow)",
    );
  }
  if (action === "open-pr") {
    return checks === "failed" ? "var(--ui-red)" : dimShade("var(--ui-yellow)");
  }
  if (action === "blocked") return "var(--ui-red)";
  return "var(--ui-text-quaternary)";
}

export function filterWorktrees(
  worktrees: Worktree[],
  search: string,
  prs: Record<string, PrEntry>,
): Worktree[] {
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
      worktree.todoTotal !== undefined
        ? `todo ${worktree.todoDone ?? 0}/${worktree.todoTotal}`
        : "",
      worktree.pullRequest ?? "",
      pr?.title ?? "",
      pr?.url ?? "",
      pr?.checks ?? "",
      pr?.stack
        ? pr.stack.prs
            .map((entry) => `${entry.number} ${entry.branch} ${entry.title}`)
            .join(" ")
        : "",
    ];
    return fields.some((field) => field.toLocaleLowerCase().includes(needle));
  });
}

export function sortWorktrees(
  worktrees: Worktree[],
  sort: SortMode,
  pinnedPath: string,
  recent: Record<string, number>,
): Worktree[] {
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
      return (
        left.repo.localeCompare(right.repo) ||
        left.name.localeCompare(right.name)
      );
    }
    return (
      left.name.localeCompare(right.name) || left.repo.localeCompare(right.repo)
    );
  });
  return rows;
}

export function timeAgo(at: number | null | undefined): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
