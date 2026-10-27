"""Real HTTP, Timber, Git, and Hermes Projects boundaries with isolated stores."""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

HERMES_SOURCE = Path(os.environ.get("HERMES_SOURCE", Path.home() / ".hermes/hermes-agent"))
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERMES_SOURCE))
sys.path.insert(0, str(ROOT))

from hermes_cli import projects_db  # noqa: E402

from dashboard import plugin_api as api  # noqa: E402


def command(*argv: str, cwd: Path) -> str:
	result = subprocess.run(
		argv,
		cwd=cwd,
		text=True,
		capture_output=True,
		check=False,
		stdin=subprocess.DEVNULL,
		timeout=60,
	)
	assert result.returncode == 0, f"{argv}: {result.stderr}"
	return result.stdout.strip()


@dataclass(frozen=True)
class Sandbox:
	root: Path
	profile: Path
	client: TestClient

	def create(self, name: str) -> api.Worktree:
		response = self.client.post("/create", json={"repo": "example/demo", "name": name})
		assert response.status_code == 200, response.text
		return api.Created.model_validate(response.json()).worktree

	def preview(self, name: str) -> str:
		response = self.client.post("/remove/preview", json={"repo": "example/demo", "name": name})
		assert response.status_code == 200, response.text
		return api.Preview.model_validate(response.json()).token

	def state(self) -> api.State:
		response = self.client.get("/state")
		assert response.status_code == 200, response.text
		return api.State.model_validate(response.json())


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Generator[Sandbox]:
	assert shutil.which("timber") is not None, "Install Timber for real boundary tests"
	assert HERMES_SOURCE.is_dir(), "Set HERMES_SOURCE to a Hermes checkout"
	home = tmp_path / "home"
	home.mkdir()
	profile = home / "profile"
	profile.mkdir()
	for name, value in {
		"HOME": home,
		"HERMES_HOME": profile,
		"TIMBER_WORKTREE_ROOT": home / "worktrees",
		"XDG_CONFIG_HOME": home / "config",
		"XDG_DATA_HOME": home / "data",
		"XDG_CACHE_HOME": home / "cache",
		"GIT_CONFIG_GLOBAL": home / "gitconfig",
		"GIT_CONFIG_SYSTEM": home / "system-gitconfig",
	}.items():
		monkeypatch.setenv(name, str(value))
	for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
		monkeypatch.delenv(name, raising=False)
	monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
	origin = tmp_path / "origin"
	origin.mkdir()
	command("git", "init", "--initial-branch=main", cwd=origin)
	command(
		"git",
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"--allow-empty",
		"-m",
		"Initial",
		cwd=origin,
	)
	command("timber", "repo", "add", str(origin), "--name", "example/demo", cwd=tmp_path)
	app = FastAPI()
	app.include_router(api.router)
	with TestClient(app) as client:
		yield Sandbox(tmp_path, profile, client)


def test_repository_registration_reports_sync_failure(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
	def fail(*_args: object, **_kwargs: object) -> None:
		raise OSError("projects unavailable")

	monkeypatch.setattr(api, "reconcile", fail)
	response = sandbox.client.post(
		"/repositories", json={"source": str(sandbox.root / "origin"), "name": "example/other"}
	)
	assert response.status_code == 200, response.text
	assert response.json()["repository"] == "example/other"
	assert "Repository added, but Project sync failed" in response.json()["warnings"][0]
	assert "example/other" in sandbox.state().repositories


def test_direct_loader_import(sandbox: Sandbox) -> None:
	"""Hermes loads a standalone file, without installing our repository as a package."""
	spec = importlib.util.spec_from_file_location(
		"standalone_timber_backend", ROOT / "dashboard/plugin_api.py"
	)
	assert spec is not None and spec.loader is not None
	module = importlib.util.module_from_spec(spec)
	sys.modules[spec.name] = module
	try:
		spec.loader.exec_module(module)
		app = FastAPI()
		app.include_router(module.router)
		with TestClient(app) as client:
			response = client.get("/state")
			assert response.status_code == 200, response.text
			assert api.State.model_validate(response.json()).hermes_home == str(sandbox.profile)
	finally:
		sys.modules.pop(spec.name)


def test_read_only_state_and_idempotent_repo_projects(sandbox: Sandbox) -> None:
	empty = sandbox.state()
	assert empty.repositories == ["example/demo"]
	assert empty.worktrees == []  # Timber returns JSON null for no checkouts.
	assert empty.projects == {}
	assert empty.hermes_home == str(sandbox.profile)
	assert empty.host
	assert not (sandbox.profile / "projects.db").exists()
	wt = sandbox.create("feature/one")
	assert Path(wt.path).is_dir()
	second = sandbox.create("feature/two")
	response = sandbox.client.post("/sync", json={})
	assert response.status_code == 200, response.text
	mapping = api.State.model_validate(response.json()).projects
	assert list(mapping) == ["example/demo"]
	with contextlib.closing(projects_db.connect()) as db:
		projects = projects_db.list_projects(db)
		assert len(projects) == 1
		assert {f.path for f in projects[0].folders} == {wt.path, second.path}
		before = db.execute("SELECT * FROM project_folders ORDER BY path").fetchall()
	assert sandbox.client.post("/sync", json={}).status_code == 200
	assert sandbox.state().projects == mapping
	with contextlib.closing(projects_db.connect()) as db:
		assert db.execute("SELECT * FROM project_folders ORDER BY path").fetchall() == before


def test_approved_removal_keeps_project_and_rejects_replay(sandbox: Sandbox) -> None:
	wt = sandbox.create("cleanup")
	sandbox.create("cleanup-second")
	pid = sandbox.state().projects["example/demo"]
	token = sandbox.preview("cleanup")
	response = sandbox.client.post("/remove", json={"token": token})
	assert response.status_code == 200, response.text
	assert api.Removed.model_validate(response.json()).removed == "cleanup@example/demo"
	assert not Path(wt.path).exists()
	assert [w.name for w in sandbox.state().worktrees] == ["cleanup-second"]
	second_token = sandbox.preview("cleanup-second")
	second_removal = sandbox.client.post("/remove", json={"token": second_token})
	assert second_removal.status_code == 200, second_removal.text
	assert sandbox.state().worktrees == []
	assert sandbox.client.post("/remove", json={"token": token}).status_code == 409
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None and not project.archived
		assert project.folders == []
	# The real local branch, not only its checkout, must be gone.
	bare = sandbox.root / "home/worktrees/example/demo/.git"
	assert (
		command("git", f"--git-dir={bare}", "branch", "--list", "cleanup", cwd=sandbox.root) == ""
	)


@pytest.mark.parametrize(
	"change", ["untracked", "ignored", "commit", "branch", "notes", "expired", "profile"]
)
def test_approval_rechecks_real_snapshot(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch, change: str
) -> None:
	wt = sandbox.create("guarded")
	token = sandbox.preview("guarded")
	path = Path(wt.path)
	if change == "untracked":
		(path / "unsaved.txt").write_text("keep me")
	elif change == "ignored":
		exclude = Path(command("git", "rev-parse", "--git-path", "info/exclude", cwd=path))
		exclude.write_text("secret.env\n")
		(path / "secret.env").write_text("keep ignored data")
	elif change == "commit":
		command(
			"git",
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"--allow-empty",
			"-m",
			"Unique",
			cwd=path,
		)
	elif change == "branch":
		command("git", "checkout", "-b", "other", cwd=path)
	elif change == "notes":
		git_dir = Path(command("git", "rev-parse", "--absolute-git-dir", cwd=path))
		(git_dir / "TODO.md").write_text("Changed notes without checklist items")
	elif change == "expired":
		with sqlite3.connect(sandbox.profile / "plugin-data/hermes-timber/state.sqlite3") as db:
			db.execute("UPDATE tokens SET expires=0")
	else:
		other = sandbox.profile.parent / "other-profile"
		other.mkdir()
		monkeypatch.setenv("HERMES_HOME", str(other))
	response = sandbox.client.post("/remove", json={"token": token})
	assert response.status_code in (404, 409), response.text
	assert path.is_dir()


def test_ignored_files_block_cleanup_preview(sandbox: Sandbox) -> None:
	wt = sandbox.create("ignored-data")
	path = Path(wt.path)
	exclude = Path(command("git", "rev-parse", "--git-path", "info/exclude", cwd=path))
	exclude.write_text("secret.env\n")
	secret = path / "secret.env"
	secret.write_text("keep ignored data")
	response = sandbox.client.post("/remove/preview", json={"repo": wt.repo, "name": wt.name})
	assert response.status_code == 409, response.text
	assert secret.read_text() == "keep ignored data"


def test_sync_preserves_detached_worktree_folder(sandbox: Sandbox) -> None:
	wt = sandbox.create("detached")
	pid = sandbox.state().projects[wt.repo]
	path = Path(wt.path)
	command("git", "checkout", "--detach", cwd=path)
	assert sandbox.state().worktrees == []
	response = sandbox.client.post("/sync", json={})
	assert response.status_code == 200, response.text
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None and [folder.path for folder in project.folders] == [wt.path]
	assert path.is_dir()
	assert api.State.model_validate(response.json()).warnings


def test_dirty_and_unmerged_cleanup_refused(sandbox: Sandbox) -> None:
	wt = sandbox.create("unsafe")
	path = Path(wt.path)
	(path / "new").write_text("untracked")
	assert (
		sandbox.client.post("/remove/preview", json={"repo": wt.repo, "name": wt.name}).status_code
		== 409
	)
	command("git", "add", "new", cwd=path)
	command(
		"git",
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.invalid",
		"commit",
		"-m",
		"Unique",
		cwd=path,
	)
	assert (
		sandbox.client.post("/remove/preview", json={"repo": wt.repo, "name": wt.name}).status_code
		== 409
	)
	assert path.is_dir()


@pytest.mark.parametrize(
	"body",
	[
		{"repo": "not-registered", "name": "ok"},
		{"repo": "example/demo", "name": "-danger"},
		{"repo": "example/demo", "name": "@danger"},
		{"repo": "example/demo", "name": "a\nb"},
		{"repo": "example/demo", "name": "a..b"},
		{"repo": "example/demo", "upstream": "--help"},
		{"repo": "example/demo", "upstream": "bad@value"},
		{"repo": "example/demo", "unexpected": True},
	],
)
def test_invalid_input_never_creates(sandbox: Sandbox, body: dict[str, str | bool]) -> None:
	response = sandbox.client.post("/create", json=body)
	assert response.status_code == 422, response.text
	assert sandbox.state().worktrees == []


def test_ownership_preserves_existing_and_edited_folders(sandbox: Sandbox) -> None:
	# Create before sync, so an exact user Project can be reused without claiming it.
	command("timber", "create", "existing@example/demo", "--no-herdr", cwd=sandbox.root)
	wt = sandbox.state().worktrees[0]
	with contextlib.closing(projects_db.connect()) as db:
		pid = projects_db.create_project(db, name="User project", folders=[wt.path])
	assert sandbox.client.post("/sync", json={}).status_code == 200
	assert sandbox.state().projects[wt.repo] == pid
	added = sandbox.create("plugin-added")
	with contextlib.closing(projects_db.connect()) as db:
		projects_db.add_folder(db, pid, added.path, label="User label")
	command("timber", "remove", f"{wt.name}@{wt.repo}", cwd=sandbox.root)
	command("timber", "remove", f"{added.name}@{added.repo}", cwd=sandbox.root)
	assert sandbox.client.post("/sync", json={}).status_code == 200
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None
		assert {f.path for f in project.folders} == {wt.path, added.path}
		assert next(f.label for f in project.folders if f.path == added.path) == "User label"


def test_user_deleted_owned_folder_stays_deleted(sandbox: Sandbox) -> None:
	wt = sandbox.create("owned")
	pid = sandbox.state().projects[wt.repo]
	with contextlib.closing(projects_db.connect()) as db:
		projects_db.remove_folder(db, pid, wt.path)
	assert sandbox.client.post("/sync", json={}).status_code == 200
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None and project.folders == []


def test_ambiguous_existing_projects_are_not_adopted(sandbox: Sandbox) -> None:
	command("timber", "create", "one@example/demo", "--no-herdr", cwd=sandbox.root)
	command("timber", "create", "two@example/demo", "--no-herdr", cwd=sandbox.root)
	items = sandbox.state().worktrees
	with contextlib.closing(projects_db.connect()) as db:
		for wt in items:
			projects_db.create_project(db, name=wt.name, folders=[wt.path])
	response = sandbox.client.post("/sync", json={})
	assert response.status_code == 200
	state = api.State.model_validate(response.json())
	assert state.projects == {}
	assert any("ambiguous" in warning for warning in state.warnings)
	with contextlib.closing(projects_db.connect()) as db:
		assert len(projects_db.list_projects(db)) == 2


@pytest.mark.parametrize("failure", ["nonzero", "json", "timeout", "partial"])
def test_listing_failure_does_not_prune(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
	wt = sandbox.create("keep")
	pid = sandbox.state().projects[wt.repo]
	real_run = subprocess.run

	def broken(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
		cwd = kwargs.get("cwd")
		assert isinstance(cwd, Path)
		if argv[:2] == ["timber", "list"]:
			if failure == "timeout":
				raise subprocess.TimeoutExpired(argv, 60)
			return subprocess.CompletedProcess(
				argv,
				1 if failure == "nonzero" else 0,
				"[]" if failure == "partial" else "not json",
				"listing broken",
			)
		return real_run(
			argv,
			cwd=cwd,
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=60,
			check=False,
		)

	monkeypatch.setattr(subprocess, "run", broken)
	response = sandbox.client.post("/sync", json={})
	assert response.status_code == 502
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None and [f.path for f in project.folders] == [wt.path]


def test_partial_creation_is_reported_not_retried(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
	real_run = subprocess.run

	def partial(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
		cwd = kwargs.get("cwd")
		assert isinstance(cwd, Path)
		result = real_run(
			argv,
			cwd=cwd,
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=60,
			check=False,
		)
		if argv[:2] == ["timber", "create"]:
			return subprocess.CompletedProcess(argv, 1, result.stdout, "optional setup failed")
		return result

	monkeypatch.setattr(subprocess, "run", partial)
	response = sandbox.client.post("/create", json={"repo": "example/demo", "name": "partial"})
	assert response.status_code == 200, response.text
	created = api.Created.model_validate(response.json())
	assert Path(created.worktree.path).is_dir()
	assert any("optional setup failed" in warning for warning in created.warnings)
	assert (
		sandbox.client.post("/create", json={"repo": "example/demo", "name": "partial"}).status_code
		== 409
	)
	assert len(sandbox.state().worktrees) == 1


def test_generated_name_and_valid_upstream(sandbox: Sandbox) -> None:
	response = sandbox.client.post(
		"/create", json={"repo": "example/demo", "upstream": "origin/main"}
	)
	assert response.status_code == 200, response.text
	wt = api.Created.model_validate(response.json()).worktree
	assert wt.name and wt.upstream == "origin/main"
	assert Path(wt.path).is_dir()


def test_one_project_per_registered_repository(sandbox: Sandbox) -> None:
	command(
		"timber",
		"repo",
		"add",
		str(sandbox.root / "origin"),
		"--name",
		"other/demo",
		cwd=sandbox.root,
	)
	response = sandbox.client.post("/sync", json={})
	assert response.status_code == 200, response.text
	mapping = api.State.model_validate(response.json()).projects
	assert set(mapping) == {"example/demo", "other/demo"}
	assert mapping["example/demo"] != mapping["other/demo"]
	with contextlib.closing(projects_db.connect()) as db:
		assert len(projects_db.list_projects(db)) == 2


@pytest.mark.parametrize("failure", ["refused", "status-unknown"])
def test_remove_failure_preserves_checkout_and_membership(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
	wt = sandbox.create("retained")
	pid = sandbox.state().projects[wt.repo]
	token = sandbox.preview(wt.name)
	real_run = subprocess.run

	def broken(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
		cwd = kwargs.get("cwd")
		assert isinstance(cwd, Path)
		if argv[:2] == ["timber", "remove"]:
			return subprocess.CompletedProcess(argv, 1, "", "fetch refused")
		result = real_run(
			argv,
			cwd=cwd,
			stdin=subprocess.DEVNULL,
			capture_output=True,
			text=True,
			timeout=60,
			check=False,
		)
		if failure == "status-unknown" and argv[:2] == ["timber", "list"]:
			return subprocess.CompletedProcess(
				argv, 0, json.dumps([wt.model_copy(update={"statusError": True}).model_dump()]), ""
			)
		return result

	monkeypatch.setattr(subprocess, "run", broken)
	response = sandbox.client.post("/remove", json={"token": token})
	assert response.status_code == (409 if failure == "status-unknown" else 502), response.text
	assert Path(wt.path).is_dir()
	with contextlib.closing(projects_db.connect()) as db:
		project = projects_db.get_project(db, pid)
		assert project is not None and [folder.path for folder in project.folders] == [wt.path]
	assert sandbox.client.post("/remove", json={"token": token}).status_code == 409


def test_add_repository_real_timber(sandbox: Sandbox) -> None:
	response = sandbox.client.post(
		"/repositories",
		json={"source": str(sandbox.root / "origin"), "name": "other/repo", "alias": "short"},
	)
	assert response.status_code == 200, response.text
	assert response.json()["repository"] == "other/repo"
	assert "other/repo" in sandbox.state().repositories
	assert set(sandbox.state().projects) == {"example/demo", "other/repo"}


@pytest.mark.parametrize("source", ["-bad", "bad\npath", "https://user:secret@example.com/repo"])
def test_add_repository_rejects_unsafe_source(sandbox: Sandbox, source: str) -> None:
	response = sandbox.client.post("/repositories", json={"source": source})
	assert response.status_code == 422
	assert "secret" not in response.text
	assert sandbox.state().repositories == ["example/demo"]


def test_add_partial_failure_requires_inspection(
	sandbox: Sandbox, monkeypatch: pytest.MonkeyPatch
) -> None:
	real_run = api.run

	def failed_after_add(
		argv: list[str], cwd: Path | None = None
	) -> subprocess.CompletedProcess[str]:
		result = real_run(argv, cwd)
		if argv[:3] == ["timber", "repo", "add"]:
			return subprocess.CompletedProcess(argv, 1, result.stdout, "failed after registration")
		return result

	monkeypatch.setattr(api, "run", failed_after_add)
	response = sandbox.client.post(
		"/repositories", json={"source": str(sandbox.root / "origin"), "name": "partial/repo"}
	)
	assert response.status_code == 502
	assert "refresh" in response.text
	assert "partial/repo" in sandbox.state().repositories


def test_add_repository_rejects_unknown_field(sandbox: Sandbox) -> None:
	response = sandbox.client.post(
		"/repositories", json={"source": str(sandbox.root / "origin"), "force": True}
	)
	assert response.status_code == 422
	assert sandbox.state().repositories == ["example/demo"]
