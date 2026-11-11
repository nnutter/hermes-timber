"""Development entrypoints. Invoke owns task order and tool environments."""

from __future__ import annotations

import os
import shutil
import subprocess
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

from invoke import Context, task

ROOT = Path(__file__).resolve().parent
PLUGIN_NAME = "hermes-timber"


def run(*args: str) -> None:
	"""Run a command in the repository and preserve a failing exit status."""
	subprocess.run(args, cwd=ROOT, check=True)


def _hermes() -> str:
	"""Return the hermes launcher, preferring PATH."""
	found = shutil.which("hermes")
	if found is not None:
		return found
	raise SystemExit("hermes is not on PATH")


def _hermes_python() -> str:
	"""Return the Python interpreter of the selected Hermes environment."""
	override = os.environ.get("HERMES_PYTHON")
	if override is not None:
		return override
	launcher = Path.home() / ".hermes" / "hermes-agent"
	candidates = sorted((Path.home() / ".hermes" / "tools").glob("python-*/bin/python3"))
	if not candidates:
		raise SystemExit("no Hermes-managed Python found; set HERMES_PYTHON")
	probe = (
		"import sys; sys.path.insert(0, sys.argv[1]); "
		"from pathlib import Path; "
		"from pm.environments import selected_venv, venv_python; "
		"print(venv_python(selected_venv(Path(sys.argv[1]))))"
	)
	result = subprocess.run(
		[str(candidates[-1]), "-I", "-c", probe, str(launcher)],
		text=True,
		capture_output=True,
		check=False,
	)
	if result.returncode:
		raise SystemExit(f"could not locate the Hermes environment Python: {result.stderr.strip()}")
	return result.stdout.strip()


@task
def build(_context: Context) -> None:
	"""Compile strict TypeScript to the single ESM file Hermes loads."""
	run("mise", "exec", "--", "npm", "run", "build")


@task
def fix(_context: Context) -> None:
	"""Fix all files through hk (formatters and safe automatic repairs)."""
	run("mise", "exec", "--", "hk", "fix", "--all")


@task
def fmt(context: Context) -> None:
	"""Alias for fix."""
	fix(context)


@task
def check(_context: Context) -> None:
	"""Check all files through hk without writing fixes."""
	run("mise", "exec", "--", "hk", "check", "--all")


@task
def lint(context: Context) -> None:
	"""Alias for check."""
	check(context)


@task
def test(_context: Context) -> None:
	"""Run backend integration tests and Desktop component tests."""
	run("uv", "run", "pytest")
	run("mise", "exec", "--", "npm", "test")


@task
def doctor(_context: Context) -> None:
	"""Validate the unified plugin with Hermes's real runtime contracts."""
	run(_hermes(), "plugins", "doctor", str(ROOT), "--ci")


@task
def smoke(_context: Context) -> None:
	"""Exercise registration and routes through Hermes's own Python."""
	run(_hermes_python(), str(ROOT / "scripts" / "smoke.py"))


@task
def ci(_context: Context) -> None:
	"""Run every check that does not install the plugin."""
	build(_context)
	check(_context)
	test(_context)


@task
def install(context: Context, enable: bool = True) -> None:
	"""Install this checkout into the active profile."""
	flag = "--enable" if enable else "--no-enable"
	context.run(f'{_hermes()} plugins install "file://{ROOT}" {flag}', pty=True)


@task
def uninstall(context: Context) -> None:
	"""Remove the plugin from the active profile."""
	context.run(f"{_hermes()} plugins remove {PLUGIN_NAME}", pty=True)


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
