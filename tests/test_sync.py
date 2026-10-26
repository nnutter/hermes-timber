"""Exercise the sync script with real files and a sandbox SSH transport."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/sync-desktop"


@dataclass(frozen=True)
class SyncSandbox:
	root: Path
	destination: Path
	artifact: bytes
	env: dict[str, str]

	def run(self, **overrides: str) -> subprocess.CompletedProcess[str]:
		return subprocess.run(
			["bash", str(SCRIPT)],
			env={**self.env, **overrides},
			text=True,
			capture_output=True,
			check=False,
			timeout=30,
		)


@pytest.fixture
def sync_sandbox(tmp_path: Path) -> SyncSandbox:
	remote = tmp_path / "frame's checkout; not a command"
	(remote / "desktop").mkdir(parents=True)
	artifact = (ROOT / "desktop/plugin.js").read_bytes()
	(remote / "desktop/plugin.js").write_bytes(artifact)
	bin_dir = tmp_path / "bin"
	bin_dir.mkdir()
	(bin_dir / "ssh").write_text(
		'#!/bin/sh\nset -eu\nwhile [ "$#" -gt 2 ]; do shift; done\n'
		'printf \'%s\\n\' "$1" > "$SYNC_HOST_LOG"\n'
		"case ${SYNC_FAILURE:-} in\n"
		"  transfer) printf partial; exit 23;;\n"
		"  empty) exit 0;;\n"
		'esac\nexec /bin/sh -c "$2"\n'
	)
	for command in ("mise", "uv"):
		(bin_dir / command).write_text(
			'#!/bin/sh\nprintf \'%s\\n\' "$0 $*" >> "$SYNC_BUILD_LOG"\n'
			"printf 'build output that must not enter plugin.js\\n'\n"
			'if [ "${SYNC_FAILURE:-}" = build ]; then exit 24; fi\n'
		)
	for entry in bin_dir.iterdir():
		entry.chmod(0o755)
	destination = tmp_path / "Mac home/plugins/hermes-timber"
	env = {
		**os.environ,
		"PATH": f"{bin_dir}:{os.environ['PATH']}",
		"HOME": str(tmp_path / "home"),
		"TIMBER_SYNC_HOST": "frame",
		"TIMBER_SYNC_BUILD": "1",
		"TIMBER_SYNC_REPO": str(remote),
		"TIMBER_DESKTOP_PLUGIN_DIR": str(destination),
		"SYNC_HOST_LOG": str(tmp_path / "host.log"),
		"SYNC_BUILD_LOG": str(tmp_path / "build.log"),
		"SYNC_FAILURE": "",
	}
	return SyncSandbox(tmp_path, destination, artifact, env)


def test_sync_builds_and_transfers_exact_artifact(sync_sandbox: SyncSandbox) -> None:
	case = sync_sandbox
	result = case.run()
	assert result.returncode == 0, result.stderr
	assert (case.destination / "plugin.js").read_bytes() == case.artifact
	assert (case.root / "host.log").read_text().strip() == "frame"
	assert "tsc" in (case.root / "build.log").read_text()
	assert "invoke build" in (case.root / "build.log").read_text()
	assert not list(case.destination.glob(".plugin.js.*"))
	mtime = (case.destination / "plugin.js").stat().st_mtime_ns
	result = case.run()
	assert result.returncode == 0, result.stderr
	assert (case.destination / "plugin.js").stat().st_mtime_ns == mtime
	assert "unchanged" in result.stdout.lower()


@pytest.mark.parametrize("failure", ["transfer", "empty", "build"])
def test_sync_failure_preserves_installed_plugin(sync_sandbox: SyncSandbox, failure: str) -> None:
	case = sync_sandbox
	case.destination.mkdir(parents=True)
	target = case.destination / "plugin.js"
	target.write_bytes(b"keep installed version\n")
	result = case.run(SYNC_FAILURE=failure)
	assert result.returncode != 0
	assert target.read_bytes() == b"keep installed version\n"
	assert not list(case.destination.glob(".plugin.js.*"))


@pytest.mark.parametrize("link", ["directory", "file"])
def test_sync_refuses_to_replace_development_symlink(sync_sandbox: SyncSandbox, link: str) -> None:
	case = sync_sandbox
	actual = case.root / "development"
	actual.mkdir()
	(actual / "plugin.js").write_bytes(b"keep development checkout\n")
	case.destination.parent.mkdir(parents=True)
	if link == "directory":
		case.destination.symlink_to(actual, target_is_directory=True)
	else:
		case.destination.mkdir()
		(case.destination / "plugin.js").symlink_to(actual / "plugin.js")
	result = case.run()
	assert result.returncode != 0
	assert "symlink" in result.stderr
	assert (actual / "plugin.js").read_bytes() == b"keep development checkout\n"
	assert not (case.root / "host.log").exists()


def test_sync_can_pull_already_built_plugin_from_custom_host(sync_sandbox: SyncSandbox) -> None:
	case = sync_sandbox
	result = case.run(TIMBER_SYNC_BUILD="0", TIMBER_SYNC_HOST="nnutter@frame.tail98ced6.ts.net")
	assert result.returncode == 0, result.stderr
	assert (case.destination / "plugin.js").read_bytes() == case.artifact
	assert (case.root / "host.log").read_text().strip() == "nnutter@frame.tail98ced6.ts.net"
	assert not (case.root / "build.log").exists()


def test_sync_defaults_to_client_home_not_gateway_home(sync_sandbox: SyncSandbox) -> None:
	case = sync_sandbox
	case.env.pop("TIMBER_DESKTOP_PLUGIN_DIR")
	result = case.run(HERMES_HOME="/some/remote/profile")
	assert result.returncode == 0, result.stderr
	target = case.root / "home/.hermes/desktop-plugins/hermes-timber/plugin.js"
	assert target.read_bytes() == case.artifact
