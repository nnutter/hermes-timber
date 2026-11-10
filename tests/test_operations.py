"""Unit tests for the PR, TODO, and session operations behind the worktree UI."""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

HERMES_SOURCE = Path(os.environ.get("HERMES_SOURCE", Path.home() / ".hermes/hermes-agent"))
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERMES_SOURCE))
sys.path.insert(0, str(ROOT))

from dashboard import plugin_api as api  # noqa: E402


def test_repo_from_remote_url() -> None:
	assert api.repo_from_remote_url("https://github.com/nnutter/timber.git") == "nnutter/timber"
	assert api.repo_from_remote_url("ssh://git@github.com/nnutter/timber.git") == "nnutter/timber"
	assert api.repo_from_remote_url("git@github.com:nnutter/timber.git") == "nnutter/timber"
	assert api.repo_from_remote_url("/home/nnutter/src/timber") is None


def test_checks_state() -> None:
	assert (
		api.checks_state(
			[
				{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"},
				{"__typename": "StatusContext", "state": "SUCCESS"},
			]
		)
		== "passed"
	)
	assert (
		api.checks_state(
			[
				{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "FAILURE"},
				{"__typename": "StatusContext", "state": "SUCCESS"},
			]
		)
		== "failed"
	)
	assert api.checks_state([{"__typename": "CheckRun", "status": "IN_PROGRESS"}]) == "pending"
	assert api.checks_state([]) == "none"


def test_parse_pr_view_and_merge_blocker() -> None:
	pr = api.parse_pr_view(
		json.dumps(
			{
				"number": 12,
				"url": "https://github.com/o/r/pull/12",
				"title": "A change",
				"state": "OPEN",
				"isDraft": False,
				"mergeStateStatus": "CLEAN",
				"headRefName": "feature",
				"statusCheckRollup": [
					{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}
				],
			}
		)
	)
	assert pr is not None
	assert pr.number == 12
	assert pr.checks == "passed"
	assert pr.branch == "feature"
	push = api.PushInfo(destExists=True, unpushed=0, ff=True)
	assert api.merge_blocker(pr, push) is None
	assert api.merge_blocker(pr, api.PushInfo(destExists=False, unpushed=0, ff=True)) == (
		"Branch is not pushed"
	)
	assert api.parse_pr_view("not json") is None


def test_parse_pr_stack_orders_prs_and_marks_the_current_branch() -> None:
	def pull_request(number: int) -> dict[str, object]:
		return {
			"number": number,
			"url": f"https://github.com/o/r/pull/{number}",
			"title": f"PR {number}",
			"state": "OPEN",
			"isDraft": False,
			"headRefName": f"branch-{number}",
			"mergeStateStatus": "CLEAN",
			"statusCheckRollup": {
				"contexts": {
					"nodes": [
						{
							"__typename": "CheckRun",
							"status": "COMPLETED",
							"conclusion": "SUCCESS",
						}
					]
				}
			},
		}

	payload = {
		"data": {
			"repository": {
				"pullRequest": {
					"stack": {
						"number": 42,
						"size": 2,
						"baseRefName": "main",
						"entries": {
							"nodes": [
								{"position": 2, "pullRequest": pull_request(8)},
								{"position": 1, "pullRequest": pull_request(7)},
							]
						},
					}
				}
			}
		}
	}
	stack = api.parse_pr_stack(
		json.dumps(payload),
		"branch-7",
		api.PushInfo(destExists=True, unpushed=2, ff=True),
	)
	assert stack is not None
	assert stack.number == 42
	assert [entry.number for entry in stack.prs] == [7, 8]
	assert stack.prs[0].current is True
	assert stack.prs[0].blocker == "Local has unpushed commits"
	assert stack.prs[1].current is False
	assert stack.prs[1].blocker is None
	assert api.parse_pr_stack("not json", "branch-7", api.PushInfo(False, 0, True)) is None


def test_parse_todo_list_resolves_nesting() -> None:
	result = api.parse_todo_list(
		"worktree",
		json.dumps(
			{
				"summary": {"incomplete": 2, "complete": 1},
				"todos": [
					{"id": 1, "title": "Parent", "complete": False},
					{"id": 2, "title": "Child", "complete": True, "depends_on": 1},
					{"id": 3, "title": "Grandchild", "complete": False, "depends_on": 2},
				],
			}
		),
	)
	assert result.summary.incomplete == 2
	assert [item.depth for item in result.todos] == [0, 1, 2]


def test_todo_file_edits_one_line(tmp_path: Path) -> None:
	path = tmp_path / "TODO.md"
	path.write_text("# TODO\n\n- [ ] One\n  - [x] Child\ntext\n\n", encoding="utf-8")
	api.add_todo_line(path, "Two")
	assert path.read_text(encoding="utf-8") == (
		"# TODO\n\n- [ ] One\n  - [x] Child\ntext\n- [ ] Two\n\n"
	)
	api.toggle_todo_line(path, 3, "One", True)
	assert "- [x] One" in path.read_text(encoding="utf-8")
	api.remove_todo_line(path, 4, "Child")
	text = path.read_text(encoding="utf-8")
	assert "Child" not in text
	with pytest.raises(HTTPException) as stale:
		api.toggle_todo_line(path, 3, "Wrong", True)
	assert stale.value.status_code == 409


def test_rebase_aborts_and_restores_on_conflict(monkeypatch: pytest.MonkeyPatch) -> None:
	calls: list[list[str]] = []

	def fake_run(
		argv: list[str], cwd: Path | None = None, timeout: int = api.COMMAND_TIMEOUT
	) -> subprocess.CompletedProcess[str]:
		calls.append(argv)
		if argv == ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]:
			return subprocess.CompletedProcess(argv, 0, "origin/main\n", "")
		if argv[:3] == ["git", "rev-parse", "--git-path"]:
			return subprocess.CompletedProcess(argv, 0, f"/missing/{argv[3]}", "")
		if argv == ["git", "rebase", "@{u}"]:
			return subprocess.CompletedProcess(
				argv,
				1,
				"CONFLICT (content): Merge conflict in src/x.py\n",
				"error: could not apply abc",
			)
		if argv == ["git", "rebase", "--abort"]:
			return subprocess.CompletedProcess(argv, 0, "", "")
		raise AssertionError(f"Unexpected command: {argv}")

	monkeypatch.setattr(api, "run", fake_run)
	worktree = api.Worktree(
		name="feature",
		repo="example/demo",
		path="/tmp/worktree",
		clean=True,
		merged=False,
		statusError=False,
		commit="abc",
		ahead=1,
		behind=1,
	)
	with pytest.raises(HTTPException) as failure:
		api.rebase_worktree(worktree)
	assert failure.value.status_code == 409
	assert "Rebase aborted" in str(failure.value.detail)
	assert ["git", "rebase", "--abort"] in calls


def test_rebase_reports_the_upstream(monkeypatch: pytest.MonkeyPatch) -> None:
	def fake_run(
		argv: list[str], cwd: Path | None = None, timeout: int = api.COMMAND_TIMEOUT
	) -> subprocess.CompletedProcess[str]:
		if argv == ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]:
			return subprocess.CompletedProcess(argv, 0, "origin/main\n", "")
		if argv[:3] == ["git", "rev-parse", "--git-path"]:
			return subprocess.CompletedProcess(argv, 0, f"/missing/{argv[3]}", "")
		if argv == ["git", "rebase", "@{u}"]:
			return subprocess.CompletedProcess(argv, 0, "Successfully rebased\n", "")
		raise AssertionError(f"Unexpected command: {argv}")

	monkeypatch.setattr(api, "run", fake_run)
	monkeypatch.setattr(api, "refresh_worktree_state", lambda repo, name: None)
	result = api.rebase_worktree(
		api.Worktree(
			name="feature",
			repo="example/demo",
			path="/tmp/worktree",
			clean=True,
			merged=False,
			statusError=False,
			commit="abc",
			ahead=1,
			behind=1,
		)
	)
	assert result.rebased is True
	assert result.upstream == "origin/main"
	assert result.state is None


def test_session_list_and_archive_read_the_profile_store(
	tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
	monkeypatch.setattr(api, "home", lambda: tmp_path)
	db = sqlite3.connect(tmp_path / "state.db")
	try:
		db.execute(
			"CREATE TABLE sessions (id TEXT, title TEXT, cwd TEXT,"
			" last_activity_at REAL, archived INTEGER, hidden INTEGER)"
		)
		db.executemany(
			"INSERT INTO sessions VALUES (?,?,?,?,?,?)",
			[
				("s1", "Worktree", "/tree/a", 30.0, 0, 0),
				("s2", "Archived", "/tree/a", 20.0, 1, 0),
				("s3", "Other", "/tree/b", 10.0, 0, 0),
			],
		)
		db.commit()
	finally:
		db.close()
	assert [entry.id for entry in api.list_sessions("/tree/a").sessions] == ["s1"]
	archived = api.archive_sessions("/tree/a")
	assert archived.archived == 1
	assert archived.total == 1
	assert api.list_sessions("/tree/a").sessions == []
	db = sqlite3.connect(tmp_path / "state.db")
	try:
		assert db.execute("SELECT archived FROM sessions WHERE id='s1'").fetchone()[0] == 1
	finally:
		db.close()
