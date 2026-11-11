"""Smoke-test the plugin through Hermes's runtime imports with a temp HERMES_HOME.

Run with the Hermes environment Python (``uv run invoke smoke`` finds it),
because the routes import Hermes's plugin storage and Projects APIs.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

REPO = Path(__file__).resolve().parents[1]
HERMES_SOURCE = Path(os.environ.get("HERMES_SOURCE", Path.home() / ".hermes" / "hermes-agent"))
sys.path.insert(0, str(HERMES_SOURCE))

home = Path(tempfile.mkdtemp(prefix="hermes-timber-smoke-")).resolve()
os.environ["HERMES_HOME"] = str(home)

# The backend shells out to Timber. An empty listing keeps the smoke test
# independent of the developer's registered repositories and worktrees.
bin_dir = home / "bin"
bin_dir.mkdir()
timber = bin_dir / "timber"
timber.write_text(
	"#!/bin/sh\ncase $1 in\n  repo) exit 0 ;;\n  list) printf '[]' ;;\n  *) exit 1 ;;\nesac\n"
)
timber.chmod(0o755)
os.environ["PATH"] = f"{bin_dir}:{os.environ['PATH']}"


def load(name: str, path: Path) -> types.ModuleType:
	spec = importlib.util.spec_from_file_location(name, path)
	if spec is None or spec.loader is None:
		raise SystemExit(f"could not load {path}")
	module = importlib.util.module_from_spec(spec)
	sys.modules[name] = module
	spec.loader.exec_module(module)
	return module


plugin = load("hermes_timber", REPO / "__init__.py")
plugin.register(None)

api = load("hermes_timber_api", REPO / "dashboard" / "plugin_api.py")

paths = {route.path for route in api.router.routes}
assert {
	"/state",
	"/sync",
	"/fetch",
	"/create",
	"/pr",
	"/push",
	"/rebase",
	"/merge",
	"/remove",
	"/todo",
	"/sessions",
} <= paths, sorted(paths)

app = FastAPI()
app.include_router(api.router, prefix="/plugins/hermes-timber")
response = TestClient(app).get("/plugins/hermes-timber/state")
assert response.status_code == 200, response.text
state = response.json()
assert state["repositories"] == [], state
assert state["worktrees"] == [], state
assert state["warnings"] == [], state
assert Path(state["hermes_home"]) == home, state

print("smoke ok")
