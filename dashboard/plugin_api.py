"""Host-side Timber routes. Importable directly by the Hermes plugin loader."""

from __future__ import annotations

import contextlib
import fcntl
import functools
import hashlib
import json
import re
import secrets
import socket
import sqlite3
import subprocess
import time
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path
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


def run(argv: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
	try:
		return subprocess.run(
			argv,
			cwd=cwd or Path("/"),
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=COMMAND_TIMEOUT,
			check=False,
		)
	except (OSError, subprocess.TimeoutExpired) as exc:
		raise HTTPException(502, f"Command failed: {argv[0]}: {exc}") from exc


def checked(argv: list[str], cwd: Path | None = None) -> str:
	result = run(argv, cwd)
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
	return state(listing(), mappings(), [])


def fingerprint(path: str, label: str | None, primary: bool, added: int) -> str:
	return json.dumps([path, label, primary, added])


def reconcile(
	db: sqlite3.Connection, items: Listing, *, prune_only: bool = False
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
			paths = {wt.path for wt in items.worktrees if wt.repo == repo}
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
			for path in sorted(paths - folders.keys() - owned.keys()):
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
		try:
			_, sync_warnings = reconcile(db, after)
			warnings.extend(sync_warnings)
		except (HTTPException, sqlite3.Error, ValueError, OSError) as exc:
			warnings.append(
				f"Repository added, but Project sync failed; use Sync Projects to retry: {exc}"
			)
		return RepositoryAdded(repository=added.pop(), warnings=warnings)


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
	if wt.statusError or not wt.clean or wt.merged is not True:
		raise HTTPException(
			409,
			"Removal requires a known clean, merged worktree; unmerged or unknown status is unsafe",
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
