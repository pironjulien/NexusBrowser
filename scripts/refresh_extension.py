"""Installer-only Chrome extension refresh; no user tab is driven or activated."""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "client"))
import bridge_client  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--wait-ready", type=float, default=0)
    args = parser.parse_args()
    if not 0 <= args.wait_ready <= 30:
        parser.error("--wait-ready must be between 0 and 30 seconds")
    bridge_client.set_identity("Codex")
    source = (ROOT / "extension/background.js").read_text(encoding="utf-8")
    declared = re.search(r"const AGY_FEATURES = \[(.*?)\];", source, re.S)
    assert declared, "Missing source feature declaration"
    wanted = sorted(re.findall(r'"([^\"]+)"', declared.group(1)))
    version = json.loads((ROOT / "extension/manifest.json").read_text(encoding="utf-8"))["version"]
    ready_deadline = time.monotonic() + args.wait_ready
    while True:
        try:
            ping = bridge_client.call_bridge("ping", {}, 3, retry=False)
            tabs = bridge_client.call_bridge("list-tabs", {}, 3, retry=False)
            break
        except (OSError, RuntimeError):
            if time.monotonic() >= ready_deadline:
                print(json.dumps({"connected": False, "verified": False}))
                return 2
            time.sleep(0.25)
    if any(tab.get("owner") for tab in tabs):
        print(json.dumps({"connected": True, "busy": True, "verified": False}))
        return 3

    def current(value: dict) -> bool:
        return value.get("version") == version and sorted(value.get("features", [])) == wanted

    if current(ping):
        print(json.dumps({"connected": True, "verified": True, "reloaded": False}))
        return 0
    if args.check_only:
        print(json.dumps({"connected": True, "verified": False, "stale": True}))
        return 1
    bridge_client.call_bridge("reload_extension", {}, 3, retry=False)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        time.sleep(0.25)
        try:
            if current(bridge_client.call_bridge("ping", {}, 2, retry=False)):
                print(json.dumps({"connected": True, "verified": True, "reloaded": True}))
                return 0
        except (OSError, RuntimeError):
            pass
    print(json.dumps({"connected": True, "verified": False, "error": "extension-refresh-unconfirmed"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
