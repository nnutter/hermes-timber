"""Host-side Timber routes. Importable directly by the Hermes plugin loader."""

from __future__ import annotations

import contextlib
import fcntl
import functools
import hashlib
import json
import os
import re
import secrets
import socket
import sqlite3
import subprocess
import threading
import time
from collections.abc import Callable, Generator
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

router = APIRouter()
PLUGIN = "hermes-timber"
TOKEN_LIFETIME = 120
COMMAND_TIMEOUT = 60


class ReviewProgress(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)
	approved: int
	total: int


class Worktree(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)
	name: str
	repo: str
	path: str
	upstream: str = ""
	ahead: int = 0
	behind: int = 0
	commit: str
	clean: bool
	merged: bool
	statusError: bool
	todoDone: int = 0
	todoTotal: int = 0
	pullRequest: str = ""
	review: ReviewProgress | None = None


class State(BaseModel):
	host: str
	hermes_home: str
	repositories: list[str]
	worktrees: list[Worktree]
	projects: dict[str, str]
	warnings: list[str]
	at: float = 0.0
	fetchedAt: float | None = None
	fetchError: str | None = None
	prs: dict[str, PrEntry] = {}
	prsAt: float | None = None


class Empty(BaseModel):
	model_config = ConfigDict(extra="forbid", strict=True)


class Create(Empty):
	repo: str
	name: str = ""
	upstream: str = ""


class RepositoryAdd(Empty):
	source: str
	name: str = ""
	alias: str = ""


class RepositoryAdded(BaseModel):
	repository: str
	warnings: list[str]


class Target(Empty):
	repo: str
	name: str


class Removal(Empty):
	token: str = Field(min_length=1, max_length=256)


class Created(BaseModel):
	worktree: Worktree
	warnings: list[str]


class Preview(BaseModel):
	token: str
	worktree: Worktree
	branch: str
	warning: str


class Removed(BaseModel):
	removed: str
	warnings: list[str]


class StackPr(BaseModel):
	number: int
	url: str
	title: str = ""
	branch: str = ""
	position: int = 0
	state: str = "OPEN"
	current: bool = False
	checks: str = "none"
	blocker: str | None = None


class StackInfo(BaseModel):
	number: int
	url: str = ""
	size: int
	base: str = ""
	prs: list[StackPr]


class PrEntry(BaseModel):
	number: int | None = None
	url: str | None = None
	title: str | None = None
	destExists: bool = False
	unpushed: int = 0
	ff: bool = True
	mergeBlocker: str | None = None
	checks: str | None = None
	repo: str | None = None
	private: bool | None = None
	stack: StackInfo | None = None


State.model_rebuild()


class WorktreeState(BaseModel):
	worktree: Worktree
	pr: PrEntry


class RepoRename(Empty):
	repo: str
	to: str


class RepositoryTarget(Empty):
	repo: str


class RepositoryRenamed(BaseModel):
	from_: str = Field(alias="from")
	to: str
	worktrees: int
	warnings: list[str]


class PrCreate(Empty):
	repo: str
	name: str
	title: str = ""
	body: str = ""
	base: str = ""
	draft: bool = False


class PrCreated(BaseModel):
	url: str
	number: int
	created: bool


class Pushed(BaseModel):
	pushed: bool
	state: WorktreeState | None


class MergeRequest(Target):
	number: int | None = None


class Merged(BaseModel):
	merged: int
	url: str
	state: WorktreeState | None
	stack: bool = False
	whole: bool = False


class Rebased(BaseModel):
	rebased: bool
	upstream: str
	state: WorktreeState | None


class TodoItem(BaseModel):
	id: int
	title: str
	complete: bool
	depth: int


class TodoSummary(BaseModel):
	incomplete: int
	complete: int


class TodoList(BaseModel):
	scope: Literal["worktree", "repo"]
	summary: TodoSummary
	todos: list[TodoItem]


class TodoAdd(Empty):
	repo: str
	name: str
	scope: Literal["worktree", "repo"]
	text: str


class TodoToggle(Empty):
	repo: str
	name: str
	scope: Literal["worktree", "repo"]
	id: int
	title: str
	complete: bool


class TodoRemove(Empty):
	repo: str
	name: str
	scope: Literal["worktree", "repo"]
	id: int
	title: str


class SessionEntry(BaseModel):
	id: str
	title: str = ""
	updated: float | None = None


class SessionList(BaseModel):
	sessions: list[SessionEntry]


class ArchiveRequest(Empty):
	path: str


class Archived(BaseModel):
	archived: int
	total: int


@dataclass(frozen=True)
class Listing:
	repositories: list[str]
	worktrees: list[Worktree]
	warnings: list[str]


@dataclass(frozen=True)
class Snapshot:
	worktree: Worktree
	branch: str
	commit: str
	status: str
	git_dir: str
	common_dir: str
	todo_digest: str

	def encode(self) -> str:
		return json.dumps(
			{
				"worktree": self.worktree.model_dump(),
				"branch": self.branch,
				"commit": self.commit,
				"status": self.status,
				"git_dir": self.git_dir,
				"common_dir": self.common_dir,
				"todo_digest": self.todo_digest,
			},
			sort_keys=True,
		)


def home() -> Path:
	from hermes_constants import get_hermes_home

	return get_hermes_home().resolve()


def data_dir() -> Path:
	from plugins.plugin_storage import plugin_data_dir

	return plugin_data_dir(PLUGIN)


@contextlib.contextmanager
def locked() -> Generator[sqlite3.Connection]:
	from plugins.plugin_storage import plugin_db

	with (data_dir() / "mutation.lock").open("a") as lock:
		fcntl.flock(lock, fcntl.LOCK_EX)
		with contextlib.closing(plugin_db(PLUGIN, "state.sqlite3")) as db:
			db.executescript("""
			CREATE TABLE IF NOT EXISTS mappings(repo TEXT PRIMARY KEY, project TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS owned(project TEXT, path TEXT, fingerprint TEXT NOT NULL,
			PRIMARY KEY(project,path));
			CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, home TEXT NOT NULL,
			expires REAL NOT NULL, repo TEXT NOT NULL, name TEXT NOT NULL, snapshot TEXT NOT NULL);
			""")
			try:
				yield db
			finally:
				db.commit()


def run(
	argv: list[str], cwd: Path | None = None, timeout: int = COMMAND_TIMEOUT
) -> subprocess.CompletedProcess[str]:
	try:
		return subprocess.run(
			argv,
			cwd=cwd or Path("/"),
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=timeout,
			check=False,
		)
	except (OSError, subprocess.TimeoutExpired) as exc:
		raise HTTPException(502, f"Command failed: {argv[0]}: {exc}") from exc


def checked(argv: list[str], cwd: Path | None = None, timeout: int = COMMAND_TIMEOUT) -> str:
	result = run(argv, cwd, timeout)
	if result.returncode:
		raise HTTPException(502, f"Command failed: {' '.join(argv)}: {result.stderr.strip()}")
	return result.stdout


def command_warning(result: subprocess.CompletedProcess[str]) -> str | None:
	# Timber sends routine success messages to stderr, not only diagnostics.
	text = re.sub(r"\x1b\[[0-9;]*m", "", result.stderr)
	lines = [
		line.strip()
		for line in text.splitlines()
		if line.strip() and not line.strip().startswith(("created ", "removed "))
	]
	message = "\n".join(lines)
	return message or (f"Timber exited {result.returncode}" if result.returncode else None)


PR_CACHE_TTL = 60.0
PRIVATE_CACHE_TTL = 300.0
FETCH_CONCURRENCY = 4
FAILING_CONCLUSIONS = {"FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}
PASSING_CONCLUSIONS = {"SUCCESS", "NEUTRAL", "SKIPPED"}
PR_VIEW_FIELDS = "number,url,title,state,isDraft,statusCheckRollup,mergeStateStatus,headRefName"
PR_STACK_QUERY = """query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      stack {
        number
        size
        baseRefName
        entries(first: 100) {
          nodes {
            position
            pullRequest {
              number
              url
              title
              state
              isDraft
              headRefName
              mergeStateStatus
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun { status conclusion }
                    ... on StatusContext { state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}"""

_pr_cache: dict[str, PrEntry] = {}
_pr_cache_at: float | None = None
_pr_cache_stale = True
_pr_refreshing = False
_pr_lock = threading.Lock()
_fetch_at: float | None = None
_fetch_error: str | None = None
_fetch_lock = threading.Lock()
_background_started = False
_background_lock = threading.Lock()
_repo_private: dict[str, tuple[float, bool | None]] = {}
_repo_private_lock = threading.Lock()


@dataclass(frozen=True)
class PrView:
	number: int
	url: str
	title: str
	draft: bool
	checks: str
	mergeState: str | None
	branch: str


@dataclass(frozen=True)
class PushInfo:
	destExists: bool
	unpushed: int
	ff: bool


def record_at(value: object, *keys: str) -> dict[str, Any] | None:
	"""Return the record at a path of record fields, or None when a step is missing."""
	at: object = value
	for key in keys:
		if not isinstance(at, dict):
			return None
		at = at.get(key)
	if not isinstance(at, dict):
		return None
	return {str(key): item for key, item in at.items()}


def repo_from_remote_url(url: str) -> str | None:
	"""Return owner/name from a git remote URL, or None when it names no repository."""
	text = url.strip()
	if text.endswith(".git"):
		text = text[:-4]
	match = re.match(r"^[^@/]+@[^:/]+:(.+)$", text)
	if match:
		path = match.group(1)
	else:
		match = re.match(r"^(?:[a-z+]+://)?[^/]+/(.+)$", text, re.IGNORECASE)
		path = match.group(1) if match else ""
	parts = [part for part in path.split("/") if part]
	if len(parts) < 2:
		return None
	return f"{parts[-2]}/{parts[-1]}"


def origin_repo(cwd: Path) -> str | None:
	remote = run(["git", "remote", "get-url", "origin"], cwd)
	return repo_from_remote_url(remote.stdout) if remote.returncode == 0 else None


def repo_private(repo: str | None) -> bool | None:
	"""Whether a GitHub repository is private, cached per repository."""
	if repo is None or repo == "":
		return None
	now = time.time()
	with _repo_private_lock:
		cached = _repo_private.get(repo)
		if cached is not None and now - cached[0] < PRIVATE_CACHE_TTL:
			return cached[1]
	try:
		result = run(
			["gh", "repo", "view", repo, "--json", "isPrivate", "--jq", ".isPrivate"],
			timeout=30,
		)
	except HTTPException:
		value = None
	else:
		text = result.stdout.strip().lower()
		value = True if text == "true" else (False if text == "false" else None)
	with _repo_private_lock:
		_repo_private[repo] = (now, value)
	return value


def branch_of(cwd: Path) -> str | None:
	result = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd)
	name = result.stdout.strip()
	if result.returncode != 0 or name == "" or name == "HEAD":
		return None
	return name


def current_branch(cwd: Path) -> str:
	name = branch_of(cwd)
	if name is None:
		raise HTTPException(409, f"No branch is checked out in {cwd}.")
	return name


def check_passed(check: object) -> bool:
	if not isinstance(check, dict):
		return False
	if check.get("__typename") == "StatusContext":
		return bool(check.get("state") == "SUCCESS")
	return bool(
		check.get("status") == "COMPLETED" and check.get("conclusion") in PASSING_CONCLUSIONS
	)


def check_failed(check: object) -> bool:
	if not isinstance(check, dict):
		return False
	if check.get("__typename") == "StatusContext":
		return check.get("state") in {"FAILURE", "ERROR"}
	return check.get("conclusion") in FAILING_CONCLUSIONS


def checks_state(checks: object) -> str:
	if not isinstance(checks, list) or not checks:
		return "none"
	if any(check_failed(check) for check in checks):
		return "failed"
	if all(check_passed(check) for check in checks):
		return "passed"
	return "pending"


def parse_pr_view(stdout: str) -> PrView | None:
	try:
		parsed = json.loads(stdout)
	except (TypeError, ValueError):
		return None
	if (
		isinstance(parsed, dict)
		and parsed.get("state") == "OPEN"
		and isinstance(parsed.get("url"), str)
		and isinstance(parsed.get("number"), int)
	):
		merge_state = parsed.get("mergeStateStatus")
		branch = parsed.get("headRefName")
		title = parsed.get("title")
		return PrView(
			number=parsed["number"],
			url=parsed["url"],
			title=title if isinstance(title, str) else "",
			draft=parsed.get("isDraft") is True,
			checks=checks_state(parsed.get("statusCheckRollup")),
			mergeState=merge_state.upper() if isinstance(merge_state, str) else None,
			branch=branch if isinstance(branch, str) else "",
		)
	return None


def parse_pr_head(stdout: str) -> tuple[int, str] | None:
	try:
		parsed = json.loads(stdout)
	except (TypeError, ValueError):
		return None
	if not isinstance(parsed, dict):
		return None
	number = parsed.get("number")
	if not isinstance(number, int):
		return None
	branch = parsed.get("headRefName")
	return number, branch if isinstance(branch, str) else ""


def merge_state_blocker(pr: PrView) -> str | None:
	if pr.mergeState in (None, "CLEAN", "HAS_HOOKS", "UNSTABLE"):
		return None
	if pr.mergeState == "DRAFT":
		return "PR is a draft"
	if pr.mergeState == "DIRTY":
		return "The PR has conflicts with its base branch"
	if pr.mergeState == "BEHIND":
		return "The base branch has commits the PR lacks"
	if pr.mergeState == "BLOCKED":
		if pr.checks in {"failed", "pending"}:
			return "Checks have not all passed"
		return "GitHub blocks the merge: a required check or review is missing, or a thread is unresolved"
	return "GitHub has not finished reading the PR's merge state"


def merge_blocker(pr: PrView, push: PushInfo) -> str | None:
	if pr.draft:
		return "PR is a draft"
	if not push.destExists:
		return "Branch is not pushed"
	if not push.ff:
		return "origin has commits this branch lacks"
	if push.unpushed > 0:
		return "Local has unpushed commits"
	state_blocker = merge_state_blocker(pr)
	if state_blocker is not None:
		return state_blocker
	if pr.checks in {"failed", "pending"}:
		return "Checks have not all passed"
	return None


def stack_pr_blocker(pr: PrView) -> str | None:
	if pr.draft:
		return "PR is a draft"
	state_blocker = merge_state_blocker(pr)
	if state_blocker is not None:
		return state_blocker
	if pr.checks in {"failed", "pending"}:
		return "Checks have not all passed"
	return None


def parse_pr_stack(stdout: str, current_branch_name: str, push: PushInfo) -> StackInfo | None:
	try:
		parsed = json.loads(stdout)
	except (TypeError, ValueError):
		return None
	stack = record_at(parsed, "data", "repository", "pullRequest", "stack")
	if stack is None:
		return None
	entries = record_at(stack, "entries")
	nodes = entries.get("nodes") if entries is not None else None
	if not isinstance(nodes, list):
		nodes = []
	prs: list[StackPr] = []
	for node in nodes:
		if not isinstance(node, dict):
			continue
		pr = record_at(node, "pullRequest")
		if pr is None:
			continue
		number = pr.get("number")
		url = pr.get("url")
		if not isinstance(number, int) or not number or not isinstance(url, str) or not url:
			continue
		title = pr.get("title")
		branch = pr.get("headRefName")
		state = pr.get("state")
		contexts = record_at(pr, "statusCheckRollup", "contexts")
		context_nodes = contexts.get("nodes") if contexts is not None else None
		checks = checks_state(context_nodes if isinstance(context_nodes, list) else [])
		merge_state = pr.get("mergeStateStatus")
		view = PrView(
			number=number,
			url=url,
			title=title if isinstance(title, str) else "",
			draft=pr.get("isDraft") is True,
			checks=checks,
			mergeState=merge_state.upper() if isinstance(merge_state, str) else None,
			branch=branch if isinstance(branch, str) else "",
		)
		is_current = view.branch == current_branch_name
		position_value = node.get("position")
		position = position_value if isinstance(position_value, int) else 0
		prs.append(
			StackPr(
				number=number,
				url=url,
				title=view.title,
				branch=view.branch,
				position=position,
				state=state.upper() if isinstance(state, str) else "OPEN",
				current=is_current,
				checks=checks,
				blocker=merge_blocker(view, push)
				if state == "OPEN" and is_current
				else (stack_pr_blocker(view) if state == "OPEN" else None),
			)
		)
	if not prs:
		return None
	prs.sort(key=lambda pr: pr.position)
	number = stack.get("number")
	if not isinstance(number, int) or not number:
		return None
	size_value = stack.get("size")
	base_value = stack.get("baseRefName")
	return StackInfo(
		number=number,
		url=prs[0].url,
		size=size_value if isinstance(size_value, int) else len(prs),
		base=base_value if isinstance(base_value, str) else "",
		prs=prs,
	)


def read_pr_stack(
	repo: str, number: int, branch: str, push: PushInfo, cwd: Path
) -> StackInfo | None:
	parts = repo.split("/")
	if len(parts) != 2 or not parts[0] or not parts[1]:
		return None
	result = run(
		[
			"gh",
			"api",
			"graphql",
			"-f",
			f"query={PR_STACK_QUERY}",
			"-f",
			f"owner={parts[0]}",
			"-f",
			f"name={parts[1]}",
			"-F",
			f"number={number}",
		],
		cwd,
	)
	return parse_pr_stack(result.stdout, branch, push) if result.returncode == 0 else None


def push_info(cwd: Path, name: str) -> PushInfo:
	dest = f"origin/{name}"
	verify = run(["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/{dest}"], cwd)
	dest_exists = verify.returncode == 0
	unpushed = 0
	count = run(["git", "rev-list", "--count", f"{dest if dest_exists else '@{u}'}..HEAD"], cwd)
	if count.returncode == 0:
		with contextlib.suppress(ValueError):
			unpushed = max(0, int(count.stdout.strip()))
	if not dest_exists:
		return PushInfo(destExists=False, unpushed=unpushed, ff=True)
	base = run(["git", "merge-base", "--is-ancestor", dest, "HEAD"], cwd)
	return PushInfo(destExists=True, unpushed=unpushed, ff=base.returncode == 0)


def push_branch(worktree: Worktree) -> bool:
	push = push_info(Path(worktree.path), worktree.name)
	if push.destExists and push.unpushed == 0:
		return False
	if not push.ff:
		raise HTTPException(
			409,
			f"{worktree.name}@{worktree.repo} is not a fast-forward over origin/{worktree.name}; fetch first",
		)
	pushed = run(
		["git", "push", "origin", f"HEAD:{worktree.name}"], Path(worktree.path), timeout=180
	)
	if pushed.returncode != 0:
		raise HTTPException(
			502, pushed.stderr.strip() or f"git push failed (exit {pushed.returncode})"
		)
	return True


def rebase_worktree(worktree: Worktree) -> Rebased:
	if worktree.statusError:
		raise HTTPException(409, "Git status unknown; refresh and inspect first")
	if not worktree.clean:
		raise HTTPException(409, "Rebase requires a clean worktree; commit or stash changes first")
	if (worktree.behind or 0) == 0:
		raise HTTPException(409, f"Nothing to rebase for {worktree.name}@{worktree.repo}")
	cwd = Path(worktree.path)
	upstream = run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)
	upstream_name = upstream.stdout.strip()
	if upstream.returncode != 0 or not upstream_name:
		raise HTTPException(
			422,
			f"No upstream for {worktree.name}@{worktree.repo}; set one before rebasing",
		)
	for name in ("rebase-merge", "rebase-apply"):
		git_path = run(["git", "rev-parse", "--git-path", name], cwd)
		if git_path.returncode != 0:
			continue
		path = Path(git_path.stdout.strip())
		if not path.is_absolute():
			path = cwd / path
		if path.exists():
			raise HTTPException(409, "A rebase is already in progress in this worktree")
	try:
		result = run(["git", "rebase", "@{u}"], cwd, timeout=180)
	except HTTPException as exc:
		run(["git", "rebase", "--abort"], cwd)
		raise HTTPException(
			409, f"Rebase aborted; the worktree was restored. {exc.detail}"
		) from exc
	if result.returncode != 0:
		abort = run(["git", "rebase", "--abort"], cwd)
		output = "\n".join(
			line.strip()
			for line in f"{result.stderr}\n{result.stdout}".splitlines()
			if line.strip()
		)
		restored = (
			"the worktree was restored"
			if abort.returncode == 0
			else "the abort also failed; inspect the worktree"
		)
		raise HTTPException(409, f"Rebase aborted; {restored}. {output[:800]}".strip())
	with _pr_lock:
		_pr_cache_stale = True
	try:
		state = refresh_worktree_state(worktree.repo, worktree.name)
	except (HTTPException, OSError, sqlite3.Error):
		state = None
	return Rebased(rebased=True, upstream=upstream_name, state=state)


def pr_entry(pr: PrView, push: PushInfo, stack: StackInfo | None) -> PrEntry:
	return PrEntry(
		number=pr.number,
		url=pr.url,
		title=pr.title,
		checks=pr.checks,
		destExists=push.destExists,
		unpushed=push.unpushed,
		ff=push.ff,
		mergeBlocker=merge_blocker(pr, push),
		stack=stack,
	)


def read_push_and_pr(
	worktree: Worktree,
) -> tuple[str, PrView | None, PushInfo, str | None, StackInfo | None]:
	key = f"{worktree.repo}\x00{worktree.name}"
	cwd = Path(worktree.path)
	with ThreadPoolExecutor(max_workers=3) as pool:
		push_future = pool.submit(push_info, cwd, worktree.name)
		repo_future = pool.submit(origin_repo, cwd)
		branch_future = pool.submit(branch_of, cwd)
		push = push_future.result()
		repo = repo_future.result()
		branch = branch_future.result()
	args = ["gh", "pr", "view"]
	if branch is not None:
		args.append(branch)
		if repo is not None:
			args.extend(["--repo", repo])
	args.extend(["--json", PR_VIEW_FIELDS])
	viewed = run(args, cwd)
	pr = parse_pr_view(viewed.stdout) if viewed.returncode == 0 else None
	head = parse_pr_head(viewed.stdout) if viewed.returncode == 0 else None
	stack = (
		read_pr_stack(repo, head[0], head[1] or worktree.name, push, cwd)
		if head is not None and repo is not None
		else None
	)
	return key, pr, push, repo, stack


def worktree_stack(worktree: Worktree) -> StackInfo | None:
	"""Best-effort stack read; removal stays available when gh cannot answer."""
	try:
		_, _, _, _, stack = read_push_and_pr(worktree)
		return stack
	except (HTTPException, OSError, sqlite3.Error):
		return None


def read_pr_entries() -> None:
	global _pr_cache, _pr_cache_at, _pr_cache_stale
	items = listing()
	with ThreadPoolExecutor(max_workers=4) as pool:
		results = list(pool.map(read_push_and_pr, items.worktrees))
	origins = sorted(
		{origin for _, _, _, origin, _ in results if origin is not None and origin != ""}
	)
	privacy: dict[str, bool | None] = {}
	if origins:
		with ThreadPoolExecutor(max_workers=4) as pool:
			privacy = dict(zip(origins, pool.map(repo_private, origins), strict=True))
	cache: dict[str, PrEntry] = {}
	for key, pr, push, origin, stack in results:
		entry = (
			pr_entry(pr, push, stack)
			if pr is not None
			else PrEntry(destExists=push.destExists, unpushed=push.unpushed, ff=push.ff)
		)
		entry.repo = origin
		entry.private = privacy.get(origin) if origin is not None else None
		cache[key] = entry
	with _pr_lock:
		_pr_cache = cache
		_pr_cache_at = time.time()
		_pr_cache_stale = False


def refresh_worktree_state(repo: str, name: str) -> WorktreeState | None:
	global _pr_cache, _pr_cache_at
	key = f"{repo}\x00{name}"
	with _pr_lock:
		_pr_cache.pop(key, None)
	items = listing()
	found = next(
		(
			worktree
			for worktree in items.worktrees
			if worktree.repo == repo and worktree.name == name
		),
		None,
	)
	if found is None:
		return None
	entry_key, pr, push, origin, stack = read_push_and_pr(found)
	entry = (
		pr_entry(pr, push, stack)
		if pr is not None
		else PrEntry(destExists=push.destExists, unpushed=push.unpushed, ff=push.ff)
	)
	entry.repo = origin
	entry.private = repo_private(origin)
	with _pr_lock:
		_pr_cache = {**_pr_cache, entry_key: entry}
		_pr_cache_at = time.time()
	return WorktreeState(worktree=found, pr=entry)


def refresh_pr_cache() -> None:
	global _pr_refreshing
	with _pr_lock:
		if _pr_refreshing:
			return
		_pr_refreshing = True
	try:
		read_pr_entries()
	except (HTTPException, OSError, sqlite3.Error):
		# A failed pass keeps the cache it had; the next state read tries again.
		pass
	finally:
		with _pr_lock:
			_pr_refreshing = False


def trigger_pr_refresh() -> None:
	with _pr_lock:
		needed = (
			_pr_cache_at is None or _pr_cache_stale or time.time() - _pr_cache_at > PR_CACHE_TTL
		)
		if not needed or _pr_refreshing:
			return
	threading.Thread(target=refresh_pr_cache, daemon=True).start()


def pr_cache_snapshot() -> tuple[dict[str, PrEntry], float | None]:
	with _pr_lock:
		return dict(_pr_cache), _pr_cache_at


def fetch_all_repos() -> tuple[float, list[str]]:
	global _fetch_at, _fetch_error
	items = listing()
	repos = sorted({worktree.repo for worktree in items.worktrees})

	def fetch(repo: str) -> subprocess.CompletedProcess[str] | None:
		try:
			return run(["timber", "git", f"@{repo}", "--", "fetch"], timeout=120)
		except HTTPException:
			return None

	with ThreadPoolExecutor(max_workers=FETCH_CONCURRENCY) as pool:
		answers = list(pool.map(fetch, repos))
	errors: list[str] = []
	for repo, result in zip(repos, answers, strict=True):
		if result is None or result.returncode == 0 or not result.stderr.strip():
			continue
		errors.append(f"{repo}: {result.stderr.strip().splitlines()[0]}")
	with _fetch_lock:
		_fetch_at = time.time()
		_fetch_error = "; ".join(errors) if errors else None
		return _fetch_at, errors


def ensure_background_tasks() -> None:
	"""Start the periodic fetch/PR refresh once per plugin process."""
	global _background_started
	with _background_lock:
		if _background_started:
			return
		_background_started = True

	def loop() -> None:
		time.sleep(30)
		while True:
			try:
				fetch_all_repos()
				with _pr_lock:
					_pr_cache_stale = True
				refresh_pr_cache()
			except (HTTPException, OSError, sqlite3.Error):
				# The next cycle retries; the UI reports the last known state.
				pass
			time.sleep(300)

	threading.Thread(target=loop, daemon=True).start()


def stored_repo_name(value: str) -> str:
	edges = re.compile(r"^/+|/+$")
	return edges.sub("", edges.sub("", value.strip()).removesuffix(".git"))


def check_repo_name(value: str) -> str:
	name = value.strip()
	if not name:
		raise HTTPException(422, "Repository is empty")
	if name.startswith(("-", "@")) or "@" in name:
		raise HTTPException(422, f"Invalid repository: {name}")
	if any(ord(char) < 32 or ord(char) == 127 for char in name):
		raise HTTPException(422, "Invalid repository: control characters")
	return name


def refuse_on_warnings(warnings: list[str]) -> None:
	if warnings:
		raise HTTPException(409, "Listing reported diagnostics; refusing a destructive operation")


def drop_repo_entries(repo: str) -> None:
	global _pr_cache
	with _pr_lock:
		_pr_cache = {
			key: entry for key, entry in _pr_cache.items() if not key.startswith(f"{repo}\x00")
		}


def rename_repository(repo: str, to: str) -> RepositoryRenamed:
	source = check_repo_name(repo)
	target = check_repo_name(to)
	before = listing()
	refuse_on_warnings(before.warnings)
	if source not in before.repositories:
		raise HTTPException(404, f"Repository is not registered: {source}")
	if target == source:
		raise HTTPException(422, f"Repository is already named {source}")
	if target in before.repositories:
		raise HTTPException(409, f"Repository is already registered: {target}")
	moved = sum(1 for worktree in before.worktrees if worktree.repo == source)
	result = run(["timber", "repo", "rename", source, target])
	after = listing()
	renamed = target in after.repositories and source not in after.repositories
	if result.returncode != 0 or not renamed:
		detail = result.stderr.strip() or f"timber exited {result.returncode}"
		raise HTTPException(
			502, f"Rename not confirmed; inspect the repositories before retrying. {detail}"
		)
	global _pr_cache_stale
	with _pr_lock:
		_pr_cache_stale = True
	return RepositoryRenamed(
		**{"from": source},
		to=target,
		worktrees=moved,
		warnings=after.warnings,
	)


def remove_repository(repo: str) -> str:
	name = stored_repo_name(check_repo_name(repo))
	if not name:
		raise HTTPException(422, "Repository is empty")
	before = listing()
	refuse_on_warnings(before.warnings)
	if name not in before.repositories:
		raise HTTPException(404, f"Repository is not registered: {name}")
	left = [worktree.name for worktree in before.worktrees if worktree.repo == name]
	if left:
		raise HTTPException(
			409, f"Repository still has worktrees ({', '.join(left)}); remove them first"
		)
	result = run(["timber", "repo", "remove", name])
	after = listing()
	if result.returncode != 0 or name in after.repositories:
		detail = result.stderr.strip()
		raise HTTPException(
			502,
			f"Removal not verified; inspect the repositories before retrying.{f' {detail}' if detail else ''}",
		)
	drop_repo_entries(name)
	return name


def timber_message(stderr: str) -> str:
	lines = [
		line.strip()
		for line in stderr.splitlines()
		if line.strip() and line.strip() not in {"ERROR", "STATUS"}
	]
	message = ""
	for line in lines:
		if not message:
			message = line
		elif message.endswith("-"):
			message += line
		else:
			message += f" {line}"
	return message


def pr_target(cwd: Path, name: str) -> tuple[str, str, str]:
	up = run(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd)
	remote = ""
	base = ""
	if up.returncode == 0 and "/" in up.stdout.strip():
		upstream = up.stdout.strip()
		remote, _, base = upstream.partition("/")
	else:
		head = run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd)
		head_name = head.stdout.strip()
		if head.returncode != 0 or not head_name.startswith("origin/"):
			raise HTTPException(
				422,
				f"No upstream for {name}, so the pull request's repository and base branch are unknown. Set one with: git branch --set-upstream-to=origin/<branch>",
			)
		remote = "origin"
		base = head_name.removeprefix("origin/")
	url = run(["git", "remote", "get-url", remote], cwd)
	if url.returncode != 0:
		raise HTTPException(422, f"No remote named {remote} in {cwd}.")
	repo = repo_from_remote_url(url.stdout)
	if repo is None:
		raise HTTPException(
			422, f"The {remote} remote is not a GitHub repository: {url.stdout.strip()}"
		)
	return repo, base, remote


def fill_draft(cwd: Path, name: str) -> tuple[str, str]:
	log = run(["git", "log", "--reverse", "--format=%s%x1f%b%x1e", "@{u}..HEAD"], cwd)
	if log.returncode != 0:
		raise HTTPException(
			422,
			f"No upstream for {name}, so an empty form has no commits to describe. Type a subject, or set one with: git branch --set-upstream-to=origin/<branch>",
		)
	commits: list[tuple[str, str]] = []
	for record in log.stdout.split("\x1e"):
		record = record.removeprefix("\n")
		if not record.strip():
			continue
		subject, _, body = record.partition("\x1f")
		commits.append((subject.strip(), body.strip()))
	if not commits:
		raise HTTPException(
			422,
			f"No commits in {name} that its upstream lacks, so an empty form has nothing to describe. Type a subject.",
		)
	newest = commits[-1]
	if len(commits) == 1:
		return newest
	return name.replace("-", " ").replace("_", " "), "\n".join(
		f"- **{subject}**" for subject, _body in commits
	)


def pr_from_create_output(stdout: str) -> tuple[str, int] | None:
	found = re.search(r"https://[^\s]+/pull/(\d+)", stdout)
	if found is None:
		return None
	return found.group(0), int(found.group(1))


def open_or_create_pr(
	repo: str,
	name: str,
	title: str,
	body: str,
	base: str = "",
	draft: bool = False,
) -> PrCreated:
	check_repo_name(repo)
	valid_name(name)
	items = listing()
	found = next(
		(
			worktree
			for worktree in items.worktrees
			if worktree.repo == repo and worktree.name == name
		),
		None,
	)
	if found is None:
		raise HTTPException(404, f"Worktree not found: {name}@{repo}")
	cwd = Path(found.path)
	if not title.strip() and body.strip():
		raise HTTPException(422, "A PR subject is required when a body is provided.")
	draft_title, draft_body = (title, body) if title.strip() else fill_draft(cwd, name)
	created = run(
		[
			"timber",
			"pr",
			"create",
			f"{name}@{repo}",
			"--title",
			draft_title,
			*(["--base", base] if base else []),
			*(["--body", draft_body] if draft_body.strip() else []),
			*(["--draft"] if draft else []),
		]
	)
	printed = pr_from_create_output(created.stdout)
	if created.returncode == 0 and printed is not None:
		return PrCreated(url=printed[0], number=printed[1], created=True)
	if created.returncode == 0:
		raise HTTPException(
			502,
			"PR create reported success but printed no pull request; refresh and inspect before retrying.",
		)
	message = (
		timber_message(created.stderr) or f"timber pr create failed (exit {created.returncode})"
	)
	if re.search(r"already exists", message, re.IGNORECASE):
		branch = branch_of(cwd)
		origin = origin_repo(cwd)
		args = ["gh", "pr", "view"]
		if branch is not None:
			args.append(branch)
			if origin is not None:
				args.extend(["--repo", origin])
		args.extend(["--json", "number,url,state"])
		viewed = run(args, cwd)
		opened = parse_pr_view(viewed.stdout) if viewed.returncode == 0 else None
		if opened is not None:
			return PrCreated(url=opened.url, number=opened.number, created=False)
	raise HTTPException(502, message)


def todo_args(repo: str, name: str, scope: Literal["worktree", "repo"]) -> list[str]:
	check_repo_name(repo)
	valid_name(name)
	argv = ["timber", "todo", f"{name}@{repo}"]
	if scope == "repo":
		argv.append("--repo")
	return argv


def cli_message(result: subprocess.CompletedProcess[str], fallback: str) -> str:
	text = " ".join(part.strip() for part in (result.stderr, result.stdout) if part.strip())
	one = " ".join(line.strip() for line in text.splitlines() if line.strip())
	return (one or fallback)[:400]


def parse_todo_list(scope: Literal["worktree", "repo"], stdout: str) -> TodoList:
	try:
		parsed = json.loads(stdout)
	except (TypeError, ValueError) as exc:
		raise HTTPException(502, "timber todo --json printed no JSON") from exc
	if not isinstance(parsed, dict) or not isinstance(parsed.get("todos"), list):
		raise HTTPException(502, "timber todo --json returned an unexpected shape")
	counts_value = parsed.get("summary")
	counts = counts_value if isinstance(counts_value, dict) else {}
	incomplete_value = counts.get("incomplete")
	complete_value = counts.get("complete")
	summary = TodoSummary(
		incomplete=incomplete_value if isinstance(incomplete_value, int) else 0,
		complete=complete_value if isinstance(complete_value, int) else 0,
	)
	depths: dict[int, int] = {}
	todos: list[TodoItem] = []
	for entry in parsed["todos"]:
		if not isinstance(entry, dict):
			continue
		todo_id = entry.get("id")
		title = entry.get("title")
		if not isinstance(todo_id, int) or not isinstance(title, str):
			continue
		parent = entry.get("depends_on")
		depth = min(depths.get(parent, 0) + 1, 8) if isinstance(parent, int) else 0
		depths[todo_id] = depth
		todos.append(
			TodoItem(id=todo_id, title=title, complete=entry.get("complete") is True, depth=depth)
		)
	return TodoList(scope=scope, summary=summary, todos=todos)


def read_todo_list(repo: str, name: str, scope: Literal["worktree", "repo"]) -> TodoList:
	result = run([*todo_args(repo, name, scope), "--json"])
	if result.returncode != 0:
		message = cli_message(result, f"timber todo failed (exit {result.returncode})")
		if re.search(r"unknown flag", message, re.IGNORECASE) and re.search(
			r"repo", message, re.IGNORECASE
		):
			raise HTTPException(
				422,
				"Repository TODOs need timber 0.22.0 or newer; upgrade timber, then refresh.",
			)
		raise HTTPException(502, message)
	return parse_todo_list(scope, result.stdout)


def check_todo_title(value: str) -> str:
	title = value.strip()
	if not title:
		raise HTTPException(422, "Invalid TODO: the text is empty.")
	if len(title) > 500:
		raise HTTPException(422, "Invalid TODO: the text is longer than 500 characters.")
	if any(ord(char) < 32 or ord(char) == 127 for char in title):
		raise HTTPException(422, "Invalid TODO: the text has control characters.")
	return title


def parse_checkbox_line(line: str) -> tuple[bool, str] | None:
	item = line.strip()
	if not item.startswith("- "):
		return None
	rest = item[2:]
	if rest.startswith("[ ]"):
		return False, rest[3:].strip()
	if rest.startswith(("[x]", "[X]")):
		return True, rest[3:].strip()
	return None


def todo_line_at(lines: list[str], todo_id: int, title: str) -> int:
	at = todo_id - 1
	line = lines[at] if 0 <= at < len(lines) else None
	parsed = parse_checkbox_line(line) if line is not None else None
	if parsed is None or parsed[1] != title:
		raise HTTPException(409, "The TODO list changed; it is refreshed, so try again.")
	return at


def todo_path(repo: str, name: str, scope: Literal["worktree", "repo"]) -> Path:
	result = run([*todo_args(repo, name, scope), "--path"])
	path = result.stdout.strip()
	if result.returncode != 0 or not path:
		raise HTTPException(
			502, cli_message(result, f"timber todo --path failed (exit {result.returncode})")
		)
	return Path(path)


def edit_todo_file(path: Path, edit: Callable[[list[str]], None]) -> None:
	try:
		lines = path.read_text(encoding="utf-8").split("\n")
		edit(lines)
		path.write_text("\n".join(lines), encoding="utf-8")
	except OSError as exc:
		raise HTTPException(502, f"Cannot edit {path}: {exc}") from exc


def add_todo_line(path: Path, title: str) -> None:
	def edit(lines: list[str]) -> None:
		at = len(lines)
		while at > 0 and not lines[at - 1].strip():
			at -= 1
		lines.insert(at, f"- [ ] {title}")

	edit_todo_file(path, edit)


def toggle_todo_line(path: Path, todo_id: int, title: str, complete: bool) -> None:
	def edit(lines: list[str]) -> None:
		at = todo_line_at(lines, todo_id, title)
		lines[at] = re.sub(
			r"^(\s*-\s+)\[[ xX]\]",
			lambda match: f"{match.group(1)}[{'x' if complete else ' '}]",
			lines[at],
		)

	edit_todo_file(path, edit)


def remove_todo_line(path: Path, todo_id: int, title: str) -> None:
	def edit(lines: list[str]) -> None:
		del lines[todo_line_at(lines, todo_id, title)]

	edit_todo_file(path, edit)


def edit_todo_list(
	repo: str,
	name: str,
	scope: Literal["worktree", "repo"],
	edit: Callable[[Path], None],
) -> TodoList:
	path = todo_path(repo, name, scope)
	edit(path)
	return read_todo_list(repo, name, scope)


def state_db_path() -> Path:
	return home() / "state.db"


def list_sessions(path: str) -> SessionList:
	db_path = state_db_path()
	if not db_path.exists():
		return SessionList(sessions=[])
	with contextlib.closing(sqlite3.connect(f"{db_path.as_uri()}?mode=ro", uri=True)) as db:
		rows = db.execute(
			"SELECT id,title,last_activity_at FROM sessions"
			" WHERE cwd=? AND archived=0 AND hidden=0"
			" ORDER BY last_activity_at DESC LIMIT 50",
			(path,),
		).fetchall()
	return SessionList(
		sessions=[
			SessionEntry(
				id=str(row[0]),
				title=str(row[1] or ""),
				updated=float(row[2]) if isinstance(row[2], (int, float)) else None,
			)
			for row in rows
		]
	)


def archive_sessions(path: str) -> Archived:
	db_path = state_db_path()
	if not db_path.exists():
		return Archived(archived=0, total=0)
	with contextlib.closing(sqlite3.connect(db_path)) as db:
		rows = db.execute("SELECT id FROM sessions WHERE cwd=? AND archived=0", (path,)).fetchall()
		db.execute("UPDATE sessions SET archived=1 WHERE cwd=? AND archived=0", (path,))
		db.commit()
	return Archived(archived=len(rows), total=len(rows))


def valid_name(value: str) -> None:
	if (
		not value
		or value.startswith(("-", "@"))
		or "@" in value
		or any(ord(c) < 32 or ord(c) == 127 for c in value)
	):
		raise HTTPException(422, "Invalid branch or worktree name")
	if run(["git", "check-ref-format", "--branch", value]).returncode:
		raise HTTPException(422, "Invalid Git branch name")


@functools.lru_cache(maxsize=1)
def worktree_adapter() -> TypeAdapter[list[Worktree]]:
	return TypeAdapter(list[Worktree])


def listing() -> Listing:
	repos_result = run(["timber", "repo", "list", "-q"])
	if repos_result.returncode:
		raise HTTPException(502, f"Repository listing failed: {repos_result.stderr.strip()}")
	repos = repos_result.stdout.splitlines()
	if len(set(repos)) != len(repos) or any(
		not r
		or r.startswith(("-", "@"))
		or "@" in r
		or any(ord(c) < 32 or ord(c) == 127 for c in r)
		for r in repos
	):
		raise HTTPException(502, "Invalid repository listing")
	result = run(["timber", "list", "--json", "--sort", "recency"])
	if result.returncode:
		raise HTTPException(502, f"Worktree listing failed: {result.stderr.strip()}")
	try:
		worktrees = worktree_adapter().validate_json(
			"[]" if result.stdout.strip() == "null" else result.stdout
		)
	except ValidationError as exc:
		raise HTTPException(502, "Invalid worktree listing; no reconciliation performed") from exc
	seen: set[tuple[str, str]] = set()
	paths: set[str] = set()
	for wt in worktrees:
		key = (wt.repo, wt.name)
		if (
			wt.repo not in repos
			or not Path(wt.path).is_absolute()
			or key in seen
			or wt.path in paths
		):
			raise HTTPException(502, "Inconsistent worktree listing")
		seen.add(key)
		paths.add(wt.path)
	warnings = [text.strip() for text in (repos_result.stderr, result.stderr) if text.strip()]
	return Listing(repos, worktrees, warnings)


def target(items: Listing, repo: str, name: str) -> Worktree:
	valid_name(name)
	if items.warnings:
		raise HTTPException(502, "Listing reported diagnostics; refusing a destructive operation")
	if repo not in items.repositories:
		raise HTTPException(422, "Repository is not registered")
	matches = [wt for wt in items.worktrees if wt.repo == repo and wt.name == name]
	if len(matches) != 1:
		raise HTTPException(404, "Worktree not found")
	return matches[0]


def mappings() -> dict[str, str]:
	path = data_dir() / "state.sqlite3"
	if not path.exists():
		return {}
	with contextlib.closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
		return {
			str(repo): str(project)
			for repo, project in db.execute("SELECT repo,project FROM mappings")
		}


def state(items: Listing, projects: dict[str, str], warnings: list[str]) -> State:
	return State(
		host=socket.gethostname(),
		hermes_home=str(home()),
		repositories=items.repositories,
		worktrees=items.worktrees,
		projects=projects,
		warnings=[*items.warnings, *warnings],
	)


@router.get("/state")
def get_state() -> State:
	items = listing()
	trigger_pr_refresh()
	ensure_background_tasks()
	prs, prs_at = pr_cache_snapshot()
	with _fetch_lock:
		fetched_at = _fetch_at
		fetch_error = _fetch_error
	return State(
		host=socket.gethostname(),
		hermes_home=str(home()),
		repositories=items.repositories,
		worktrees=items.worktrees,
		projects=mappings(),
		warnings=items.warnings,
		at=time.time() * 1000,
		fetchedAt=fetched_at * 1000 if fetched_at is not None else None,
		fetchError=fetch_error,
		prs=prs,
		prsAt=prs_at * 1000 if prs_at is not None else None,
	)


def _worktree_base_path(repo: str) -> Path:
	root = os.environ.get("TIMBER_WORKTREE_ROOT") or str(Path.home() / "worktrees")
	return Path(root) / repo


def fingerprint(path: str, label: str | None, primary: bool, added: int) -> str:
	return json.dumps([path, label, primary, added])


def reconcile(
	db: sqlite3.Connection,
	items: Listing,
	*,
	prune_only: bool = False,
	repository: str | None = None,
) -> tuple[dict[str, str], list[str]]:
	from hermes_cli import projects_db as projects

	warnings: list[str] = []
	if items.warnings:
		raise HTTPException(502, "Listing reported diagnostics; no reconciliation performed")
	with contextlib.closing(projects.connect()) as conn:
		all_projects = projects.list_projects(conn, include_archived=True)
		mapping = {
			str(repo): str(pid) for repo, pid in db.execute("SELECT repo,project FROM mappings")
		}
		for repo in items.repositories:
			if repository is not None and repo != repository:
				continue
			base = _worktree_base_path(repo)
			paths = {wt.path for wt in items.worktrees if wt.repo == repo}
			paths.add(str(base))
			pid = mapping.get(repo)
			if pid is None and not prune_only:
				candidates = [p for p in all_projects if any(f.path in paths for f in p.folders)]
				other_paths = {wt.path for wt in items.worktrees if wt.repo != repo}
				if len(candidates) > 1 or any(
					p.archived
					or any(f.path in other_paths for f in p.folders)
					or any(mapped == p.id and key != repo for key, mapped in mapping.items())
					for p in candidates
				):
					warnings.append(f"{repo}: ambiguous or archived existing Projects; skipped")
					continue
				pid = candidates[0].id if candidates else projects.create_project(conn, name=repo)
				db.execute("INSERT INTO mappings VALUES (?,?)", (repo, pid))
				mapping[repo] = pid
			if pid is None:
				continue
			project = projects.get_project(conn, pid)
			if project is None or project.archived:
				warnings.append(f"{repo}: mapped Project deleted or archived; left unchanged")
				continue
			folders = {f.path: f for f in project.folders}
			owned = {
				str(path): str(fp)
				for path, fp in db.execute(
					"SELECT path,fingerprint FROM owned WHERE project=?", (pid,)
				)
			}
			for path, fp in owned.items():
				folder = folders.get(path)
				if path not in paths:
					# Timber excludes detached worktrees. Missing from its list does
					# not prove that the checkout disappeared. lstat also preserves
					# symlinks and refuses to infer absence from permission errors.
					try:
						Path(path).lstat()
					except FileNotFoundError:
						pass
					except OSError:
						warnings.append(
							f"{repo}: cannot verify missing checkout; folder preserved: {path}"
						)
						continue
					else:
						warnings.append(
							f"{repo}: checkout still exists outside Timber listing; folder preserved: {path}"
						)
						continue
					if (
						folder is not None
						and fingerprint(
							folder.path, folder.label, folder.is_primary, folder.added_at
						)
						== fp
					):
						projects.remove_folder(conn, pid, path)
					db.execute("DELETE FROM owned WHERE project=? AND path=?", (pid, path))
				elif folder is None:
					warnings.append(f"{repo}: user-removed folder left absent: {path}")
			# Removing a primary folder promotes another folder through the public API.
			# Record only those plugin-caused changes, never a user's preexisting edits.
			updated_project = projects.get_project(conn, pid)
			if updated_project is not None:
				for folder in updated_project.folders:
					original = folders.get(folder.path)
					if (
						original is not None
						and folder.path in paths
						and owned.get(folder.path)
						== fingerprint(
							original.path, original.label, original.is_primary, original.added_at
						)
					):
						db.execute(
							"UPDATE owned SET fingerprint=? WHERE project=? AND path=?",
							(
								fingerprint(
									folder.path, folder.label, folder.is_primary, folder.added_at
								),
								pid,
								folder.path,
							),
						)
			if prune_only:
				continue
			for path in sorted(
				paths - folders.keys() - owned.keys(),
				key=lambda candidate: (candidate == str(base), candidate),
			):
				# Do not attach a folder that the user assigned elsewhere after mapping.
				if any(
					p.id != pid and any(f.path == path for f in p.folders)
					for p in projects.list_projects(conn, include_archived=True)
				):
					warnings.append(f"{repo}: folder belongs to another Project: {path}")
					continue
				projects.add_folder(conn, pid, path)
				updated = projects.get_project(conn, pid)
				if updated is None:
					raise HTTPException(409, "Project changed during reconciliation")
				folder = next(f for f in updated.folders if f.path == path)
				db.execute(
					"INSERT INTO owned VALUES (?,?,?)",
					(
						pid,
						path,
						fingerprint(path, folder.label, folder.is_primary, folder.added_at),
					),
				)
		db.commit()
	return mapping, warnings


@router.post("/sync")
def sync(_body: Empty) -> State:
	with locked() as db:
		items = listing()
		mapping, warnings = reconcile(db, items)
		return state(items, mapping, warnings)


@router.post("/repositories")
def add_repository(body: RepositoryAdd) -> RepositoryAdded:
	for value in (body.source, body.name, body.alias):
		if value.startswith("-") or any(ord(c) < 32 or ord(c) == 127 for c in value):
			raise HTTPException(422, "Invalid repository input")
	if not body.source or body.source != body.source.strip():
		raise HTTPException(422, "Invalid repository source")
	try:
		parsed = urlsplit(body.source)
		if parsed.netloc and (parsed.username is not None or parsed.password is not None):
			raise HTTPException(422, "Credentials in repository URLs are not allowed")
	except ValueError as exc:
		raise HTTPException(422, "Invalid repository source") from exc
	with locked() as db:
		before = listing()
		if before.warnings:
			raise HTTPException(502, "Listing reported diagnostics; repository addition refused")
		argv = ["timber", "repo", "add", body.source]
		if body.name:
			argv.extend(["--name", body.name])
		if body.alias:
			argv.extend(["--alias", body.alias])
		failed = False
		stderr = ""
		try:
			result = run(argv)
			stderr = result.stderr
			failed = result.returncode != 0
		except HTTPException:
			failed = True
		try:
			after = listing()
		except HTTPException as exc:
			raise HTTPException(
				502, "Repository addition outcome unknown; refresh before retrying"
			) from exc
		added = set(after.repositories) - set(before.repositories)
		if failed or after.warnings or len(added) != 1 or (body.name and body.name not in added):
			raise HTTPException(
				502,
				"Repository addition not confirmed cleanly; refresh and inspect before retrying",
			)
		diagnostics = re.sub(r"\x1b\[[0-9;]*m", "", stderr)
		warnings = (
			["Timber reported diagnostics; inspect the repository before continuing."]
			if any(
				line.strip() and not line.strip().startswith("added repository ")
				for line in diagnostics.splitlines()
			)
			else []
		)
		repository = added.pop()
		try:
			_, sync_warnings = reconcile(db, after, repository=repository)
			warnings.extend(sync_warnings)
		except (HTTPException, sqlite3.Error, ValueError, OSError) as exc:
			warnings.append(
				f"Repository added, but Project sync failed; use Sync Projects to retry: {exc}"
			)
		return RepositoryAdded(repository=repository, warnings=warnings)


@router.post("/create")
def create(body: Create) -> Created:
	with locked() as db:
		before = listing()
		if before.warnings:
			raise HTTPException(502, "Listing reported diagnostics; creation refused")
		if body.repo not in before.repositories:
			raise HTTPException(422, "Repository is not registered")
		if body.name:
			valid_name(body.name)
			if any(w.repo == body.repo and w.name == body.name for w in before.worktrees):
				raise HTTPException(409, "Worktree already exists; refresh instead of retrying")
		if body.upstream:
			valid_name(body.upstream)
		argv = ["timber", "create", f"{body.name}@{body.repo}", "--no-herdr"]
		if body.upstream:
			argv.extend(["--upstream", body.upstream])
		failure: str | None = None
		try:
			result = run(argv)
			failure = command_warning(result)
		except HTTPException as exc:
			failure = str(exc.detail)
		# A nonzero exit or timeout can still have created a checkout. Never retry blindly.
		try:
			after = listing()
		except HTTPException as exc:
			raise HTTPException(
				502,
				f"Creation outcome unknown; refresh before retrying. {failure or ''} {exc.detail}",
			) from exc
		old = {(w.repo, w.path) for w in before.worktrees}
		created = [
			w
			for w in after.worktrees
			if w.repo == body.repo
			and (w.repo, w.path) not in old
			and (not body.name or w.name == body.name)
		]
		if len(created) != 1:
			raise HTTPException(
				502, f"Creation not verified; refresh before retrying. {failure or ''}"
			)
		try:
			_, warnings = reconcile(db, after)
		except (HTTPException, sqlite3.Error, ValueError, OSError) as exc:
			warnings = [f"Checkout created, but Project sync failed; use Sync to retry: {exc}"]
		if failure is not None:
			warnings.append(f"Checkout exists; command reported: {failure}")
		return Created(worktree=created[0], warnings=[*after.warnings, *warnings])


def snapshot(wt: Worktree) -> Snapshot:
	synced = (wt.ahead or 0) == 0 and (wt.behind or 0) == 0
	if wt.statusError or not wt.clean or not (wt.merged or synced):
		raise HTTPException(
			409,
			"Removal requires a known clean worktree that is merged or fully in sync; unmerged or unknown status is unsafe",
		)
	path = Path(wt.path)
	if home().is_relative_to(path.resolve()):
		raise HTTPException(409, "Worktree contains the active Hermes profile; removal refused")
	git = functools.partial(checked, cwd=path)
	status = git(["git", "status", "--porcelain=v1", "--untracked-files=all", "--ignored"])
	branch = git(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]).strip()
	commit = git(["git", "rev-parse", "HEAD"]).strip()
	git_dir = git(["git", "rev-parse", "--absolute-git-dir"]).strip()
	if status:
		raise HTTPException(409, "Worktree has modified, untracked, or ignored files")
	if commit != wt.commit:
		raise HTTPException(409, "Commit changed during inspection; refresh and retry")
	common_dir = git(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]).strip()
	todo = Path(git_dir) / "TODO.md"
	try:
		todo_digest = hashlib.sha256(todo.read_bytes()).hexdigest() if todo.exists() else "absent"
	except OSError as exc:
		raise HTTPException(409, "Cannot inspect worktree TODO notes") from exc
	valid_name(branch)
	return Snapshot(wt, branch, commit, status, git_dir, common_dir, todo_digest)


@router.post("/remove/preview")
def preview(body: Target) -> Preview:
	with locked() as db:
		wt = target(listing(), body.repo, body.name)
		snap = snapshot(wt)
		stack = worktree_stack(wt)
		if stack is not None and any(pr.state == "OPEN" for pr in stack.prs):
			raise HTTPException(
				409, "Removal requires every pull request in the worktree's stack to be merged"
			)
		token = secrets.token_urlsafe(32)
		db.execute("DELETE FROM tokens WHERE expires < ?", (time.time(),))
		db.execute(
			"INSERT INTO tokens VALUES (?,?,?,?,?,?)",
			(token, str(home()), time.time() + TOKEN_LIFETIME, body.repo, body.name, snap.encode()),
		)
		return Preview(
			token=token,
			worktree=wt,
			branch=snap.branch,
			warning="Removes the checkout AND its local branch. Worktree-local TODO.md notes are deleted with Git-directory metadata. Save those notes first. Approval expires in 120 seconds; only clean, merged worktrees can be removed.",
		)


@router.post("/remove")
def remove(body: Removal) -> Removed:
	with locked() as db:
		row = db.execute(
			"SELECT home,expires,repo,name,snapshot FROM tokens WHERE token=?", (body.token,)
		).fetchone()
		if row is None:
			raise HTTPException(409, "Unknown or already used approval token")
		db.execute("DELETE FROM tokens WHERE token=?", (body.token,))
		db.commit()  # Consume even when validation or the command fails.
		scope, expires, repo, name, expected = row
		if scope != str(home()) or float(expires) < time.time():
			raise HTTPException(409, "Approval expired or belongs to another profile")
		wt = target(listing(), str(repo), str(name))
		snap = snapshot(wt)
		if snap.encode() != expected:
			raise HTTPException(409, "Worktree changed since preview; request new approval")
		stack = worktree_stack(wt)
		if stack is not None and any(pr.state == "OPEN" for pr in stack.prs):
			raise HTTPException(
				409, "Removal requires every pull request in the worktree's stack to be merged"
			)
		failure: str | None = None
		try:
			result = run(["timber", "remove", f"{wt.name}@{wt.repo}"])
			failure = command_warning(result)
		except HTTPException as exc:
			failure = str(exc.detail)
		after = listing()
		if any(
			w.path == wt.path or (w.repo == wt.repo and w.name == wt.name) for w in after.worktrees
		):
			raise HTTPException(502, f"Removal not verified; no force retry. {failure or ''}")
		try:
			_, warnings = reconcile(db, after, prune_only=True)
		except (HTTPException, sqlite3.Error, ValueError, OSError) as exc:
			warnings = [f"Checkout removed, but Project sync failed; use Sync to retry: {exc}"]
		branch_check = run(
			[
				"git",
				f"--git-dir={snap.common_dir}",
				"show-ref",
				"--verify",
				"--quiet",
				f"refs/heads/{snap.branch}",
			]
		)
		if branch_check.returncode != 1:
			warnings.append(
				"Checkout removed, but local branch deletion was not verified; inspect the repository before retrying"
			)
		if failure is not None:
			warnings.append(failure)
		return Removed(removed=f"{wt.name}@{wt.repo}", warnings=[*after.warnings, *warnings])


@router.post("/fetch")
def fetch() -> dict[str, object]:
	fetched_at, errors = fetch_all_repos()
	with _pr_lock:
		_pr_cache_stale = True
	refresh_pr_cache()
	return {"fetchedAt": fetched_at * 1000, "errors": errors}


@router.post("/repo-rename")
def repo_rename(body: RepoRename) -> RepositoryRenamed:
	return rename_repository(body.repo, body.to)


@router.post("/repo-remove")
def repo_remove(body: RepositoryTarget) -> dict[str, str]:
	return {"removed": remove_repository(body.repo)}


@router.post("/pr")
def create_pull_request(body: PrCreate) -> PrCreated:
	result = open_or_create_pr(
		body.repo,
		body.name,
		body.title,
		body.body,
		base=body.base,
		draft=body.draft,
	)
	refresh_worktree_state(body.repo, body.name)
	return result


@router.post("/push")
def push(body: Target) -> Pushed:
	items = listing()
	found = next(
		(
			worktree
			for worktree in items.worktrees
			if worktree.repo == body.repo and worktree.name == body.name
		),
		None,
	)
	if found is None:
		raise HTTPException(404, f"Worktree not found: {body.name}@{body.repo}")
	if found.statusError:
		raise HTTPException(409, "Git status unknown; refresh and inspect first")
	if not push_branch(found):
		raise HTTPException(409, f"Nothing to push for {body.name}@{body.repo}")
	state = refresh_worktree_state(body.repo, body.name)
	return Pushed(pushed=True, state=state)


@router.post("/rebase")
def rebase(body: Target) -> Rebased:
	items = listing()
	found = next(
		(
			worktree
			for worktree in items.worktrees
			if worktree.repo == body.repo and worktree.name == body.name
		),
		None,
	)
	if found is None:
		raise HTTPException(404, f"Worktree not found: {body.name}@{body.repo}")
	return rebase_worktree(found)


@router.post("/merge")
def merge(body: MergeRequest) -> Merged:
	items = listing()
	found = next(
		(
			worktree
			for worktree in items.worktrees
			if worktree.repo == body.repo and worktree.name == body.name
		),
		None,
	)
	if found is None:
		raise HTTPException(404, f"Worktree not found: {body.name}@{body.repo}")
	if found.statusError:
		raise HTTPException(409, "Git status unknown; refresh and inspect first")
	if items.warnings:
		raise HTTPException(409, "Listing reported diagnostics; no merge performed")
	path = Path(found.path)
	branch = current_branch(path)
	target_repo, _base, _remote = pr_target(path, body.name)
	viewed = run(
		["gh", "pr", "view", branch, "--repo", target_repo, "--json", PR_VIEW_FIELDS], path
	)
	pr = parse_pr_view(viewed.stdout) if viewed.returncode == 0 else None
	head = parse_pr_head(viewed.stdout) if viewed.returncode == 0 else None
	if head is None:
		raise HTTPException(409, f"No PR for {body.name}@{body.repo}")
	if pr is None and body.number is None:
		raise HTTPException(409, f"No open PR for {body.name}@{body.repo}")
	push = push_info(path, body.name)
	stack = read_pr_stack(target_repo, head[0], head[1] or body.name, push, path)

	if stack is not None:
		selected = next(
			(entry for entry in stack.prs if entry.number == (body.number or head[0])), None
		)
		if selected is None:
			raise HTTPException(
				409,
				f"PR #{body.number or head[0]} is not in the stack of {body.name}@{body.repo}",
			)
		if selected.state != "OPEN":
			raise HTTPException(409, f"PR #{selected.number} is {selected.state.lower()}")
		if selected.blocker is not None:
			refresh_worktree_state(body.repo, body.name)
			raise HTTPException(409, f"Cannot merge PR #{selected.number}: {selected.blocker}")
		merged = run(
			["gh", "stack", "merge", str(selected.number), "--yes", "--merge"],
			path,
			timeout=180,
		)
		if merged.returncode != 0:
			raise HTTPException(
				502,
				merged.stderr.strip() or f"gh stack merge failed (exit {merged.returncode})",
			)
		run(["timber", "git", f"@{body.repo}", "--", "fetch"], timeout=120)
		state = refresh_worktree_state(body.repo, body.name)
		whole = stack.prs and selected.position == stack.prs[-1].position
		return Merged(
			merged=selected.number,
			url=selected.url,
			state=state,
			stack=True,
			whole=bool(whole),
		)

	if body.number is not None:
		raise HTTPException(409, f"PR #{body.number} is not in a stack for {body.name}@{body.repo}")
	if pr is None:
		raise HTTPException(409, f"No open PR for {body.name}@{body.repo}")
	blocker = merge_blocker(pr, push)
	if blocker is not None:
		refresh_worktree_state(body.repo, body.name)
		raise HTTPException(409, f"Cannot merge {body.name}@{body.repo}: {blocker}")
	head_commit = checked(["git", "rev-parse", "HEAD"], path).strip()
	merged = run(
		[
			"gh",
			"pr",
			"merge",
			str(pr.number),
			"--repo",
			target_repo,
			"--merge",
			"--match-head-commit",
			head_commit,
		],
		path,
		timeout=180,
	)
	if merged.returncode != 0:
		raise HTTPException(
			502, merged.stderr.strip() or f"gh pr merge failed (exit {merged.returncode})"
		)
	run(["timber", "git", f"@{body.repo}", "--", "fetch"], timeout=120)
	state = refresh_worktree_state(body.repo, body.name)
	return Merged(merged=pr.number, url=pr.url, state=state)


@router.get("/todo")
def todo(repo: str, name: str, scope: Literal["worktree", "repo"] = "worktree") -> TodoList:
	return read_todo_list(repo, name, scope)


@router.post("/todo-add")
def todo_add(body: TodoAdd) -> TodoList:
	title = check_todo_title(body.text)
	return edit_todo_list(body.repo, body.name, body.scope, lambda path: add_todo_line(path, title))


@router.post("/todo-toggle")
def todo_toggle(body: TodoToggle) -> TodoList:
	return edit_todo_list(
		body.repo,
		body.name,
		body.scope,
		lambda path: toggle_todo_line(path, body.id, body.title, body.complete),
	)


@router.post("/todo-remove")
def todo_remove(body: TodoRemove) -> TodoList:
	return edit_todo_list(
		body.repo,
		body.name,
		body.scope,
		lambda path: remove_todo_line(path, body.id, body.title),
	)


@router.get("/sessions")
def sessions(path: str) -> SessionList:
	return list_sessions(path)


@router.post("/sessions/archive")
def archive(body: ArchiveRequest) -> Archived:
	return archive_sessions(body.path)
