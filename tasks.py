"""Development entrypoints. Invoke owns task order and tool environments."""

from __future__ import annotations

import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from invoke import Context, task

ROOT = Path(__file__).resolve().parent


def run(*args: str) -> None:
	"""Run a command in the repository and preserve a failing exit status."""
	subprocess.run(args, cwd=ROOT, check=True)


@task
def build(_context: Context) -> None:
	"""Compile strict TypeScript to the single ESM file Hermes loads."""
	run("mise", "exec", "--", "npm", "run", "build")


@task
def fix(_context: Context) -> None:
	"""Apply Python and TypeScript formatting and safe lint repairs."""
	run("uv", "run", "ruff", "check", "--fix", ".")
	run("uv", "run", "ruff", "format", ".")
	run("mise", "exec", "--", "npm", "run", "fix")


@task
def check(_context: Context) -> None:
	"""Check Python types/lint and strict TypeScript without changing source."""
	run("uv", "run", "ruff", "check", ".")
	run("uv", "run", "ruff", "format", "--check", ".")
	run("uv", "run", "ty", "check")
	run("mise", "exec", "--", "npm", "run", "check")
	run("mise", "exec", "--", "shellcheck", "-x", "scripts/sync-desktop")


@task
def test(_context: Context) -> None:
	"""Run backend integration tests and Desktop component tests."""
	run("uv", "run", "pytest")
	run("mise", "exec", "--", "npm", "test")


@task
def package(_context: Context) -> None:
	"""Produce a runtime-only unified plugin archive."""
	run("mise", "exec", "--", "npm", "run", "build")
	target = ROOT / "dist" / "hermes-timber.zip"
	target.parent.mkdir(exist_ok=True)
	files = [
		"__init__.py",
		"plugin.yaml",
		"dashboard/manifest.json",
		"dashboard/plugin_api.py",
		"desktop/plugin.js",
		"README.md",
	]
	with ZipFile(target, "w", compression=ZIP_DEFLATED) as archive:
		for name in files:
			archive.write(ROOT / name, f"hermes-timber/{name}")
	print(target)
