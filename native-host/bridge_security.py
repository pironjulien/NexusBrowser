"""Shared authentication primitives for the local NexusAGY bridge."""

from __future__ import annotations

import csv
import os
import secrets
import subprocess
import sys
from pathlib import Path

VERSION = "2.1.0"
TOKEN_HEADER = "X-NexusAGY-Token"


def harden_token_permissions(path: Path) -> None:
    """Restrict the Windows token ACL to the user, SYSTEM and administrators."""
    if sys.platform != "win32":
        path.chmod(0o600)
        return

    no_window = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
    identity = subprocess.run(
        ["whoami", "/user", "/fo", "csv", "/nh"],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        creationflags=no_window,
    ).stdout.strip()
    user_sid = next(csv.reader([identity]))[1]
    result = subprocess.run(
        [
            "icacls",
            str(path),
            "/inheritance:r",
            "/grant:r",
            f"*{user_sid}:(F)",
            "*S-1-5-18:(F)",
            "*S-1-5-32-544:(F)",
        ],
        check=False,
        capture_output=True,
        text=True,
        creationflags=no_window,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Unable to restrict NexusAGY bridge token permissions: {result.stderr.strip()}")


def token_path() -> Path:
    """Return the per-user token path, overridable for tests."""
    override = os.environ.get("NEXUSAGY_BRIDGE_TOKEN_FILE")
    if override:
        return Path(override).expanduser().resolve()

    return Path.home() / ".nexusagy" / "bridge-token"


def load_or_create_token(path: Path | None = None) -> str:
    """Load a strong per-user token, creating it atomically when necessary."""
    path = path or token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    return _load_or_create_file_token(path)


def rotate_token(path: Path | None = None) -> str:
    """Replace the token atomically and return the new value."""
    path = path or token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(48)
    temporary = path.with_name(f".{path.name}-{secrets.token_hex(8)}.tmp")
    try:
        temporary.write_text(token + "\n", encoding="ascii", newline="\n")
        harden_token_permissions(temporary)
        os.replace(temporary, path)
        harden_token_permissions(path)
    finally:
        temporary.unlink(missing_ok=True)
    return token


def _load_or_create_file_token(path: Path) -> str:
    """Portable fallback for non-Windows systems."""

    try:
        file_descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        token = secrets.token_urlsafe(48)
        with os.fdopen(file_descriptor, "w", encoding="ascii", newline="\n") as token_file:
            token_file.write(token + "\n")

    token = path.read_text(encoding="ascii").strip()
    if len(token) < 43:
        raise RuntimeError(f"Invalid NexusAGY bridge token in {path}")
    harden_token_permissions(path)
    return token


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Manage the local NexusAGY bridge credential")
    parser.add_argument("--rotate", action="store_true", help="replace the current token")
    parser.add_argument("--token-file", type=Path, help="explicit token path")
    arguments = parser.parse_args()
    if not arguments.rotate:
        parser.error("--rotate is required")
    rotate_token(arguments.token_file)
