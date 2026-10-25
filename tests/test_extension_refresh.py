"""Installation must defer while agent tabs are live and never act on a user tab."""

import importlib.util
import json
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def refresh(monkeypatch):
    spec = importlib.util.spec_from_file_location("extension_refresh", ROOT / "scripts/refresh_extension.py")
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module.bridge_client, "set_identity", lambda name: None)
    monkeypatch.setattr(module.time, "sleep", lambda delay: None)
    source = (ROOT / "extension/background.js").read_text(encoding="utf-8")
    declared = re.search(r"const AGY_FEATURES = \[(.*?)\];", source, re.S)
    assert declared
    expected = {"version": json.loads((ROOT / "extension/manifest.json").read_text())["version"],
                "features": re.findall(r'"([^\"]+)"', declared.group(1))}  # fmt: skip
    return module, expected


def test_live_agent_tabs_prevent_every_refresh(refresh, monkeypatch):
    module, expected = refresh
    calls = []

    def bridge(action, params, timeout, retry=False):
        calls.append(action)
        return expected if action == "ping" else [{"owner": "Claude"}]

    monkeypatch.setattr(module.bridge_client, "call_bridge", bridge)
    monkeypatch.setattr(sys, "argv", ["refresh_extension"])
    assert module.main() == 3
    assert calls == ["ping", "list-tabs"]


@pytest.mark.parametrize("check_only", [False, True])
def test_current_user_tabs_are_only_read(refresh, monkeypatch, check_only):
    module, expected = refresh
    calls = []

    def bridge(action, params, timeout, retry=False):
        calls.append(action)
        return expected if action == "ping" else [{"owner": None}]

    monkeypatch.setattr(module.bridge_client, "call_bridge", bridge)
    monkeypatch.setattr(sys, "argv", ["refresh_extension"] + (["--check-only"] if check_only else []))
    assert module.main() == 0
    assert calls == ["ping", "list-tabs"]


def test_stale_extension_reload_is_rechecked(refresh, monkeypatch):
    module, expected = refresh
    calls = []

    def bridge(action, params, timeout, retry=False):
        calls.append(action)
        if action == "list-tabs":
            return [{"owner": None}]
        if action == "ping":
            return expected if "reload_extension" in calls else {"version": "old", "features": []}
        return {"reloading": True}

    monkeypatch.setattr(module.bridge_client, "call_bridge", bridge)
    monkeypatch.setattr(sys, "argv", ["refresh_extension"])
    assert module.main() == 0
    assert calls == ["ping", "list-tabs", "reload_extension", "ping"]


def test_disconnected_bridge_is_unverified(refresh, monkeypatch):
    module, _ = refresh

    def bridge(*args, **kwargs):
        raise OSError("disconnected")

    monkeypatch.setattr(module.bridge_client, "call_bridge", bridge)
    monkeypatch.setattr(sys, "argv", ["refresh_extension", "--check-only"])
    assert module.main() == 2


def test_installer_identity_is_the_only_one_the_extension_lets_reload(refresh, monkeypatch):
    """reload_extension est réservé par l'extension à l'agent « Installer » : le nom pris par ce script doit être
    exactement celui-là, et accepté par le pont (sinon install.ps1 ne pourrait plus actualiser l'extension)."""
    module, expected = refresh
    names = []
    monkeypatch.setattr(module.bridge_client, "set_identity", names.append)
    monkeypatch.setattr(
        module.bridge_client, "call_bridge", lambda action, *a, **k: expected if action == "ping" else []
    )
    monkeypatch.setattr(sys, "argv", ["refresh_extension", "--check-only"])
    assert module.main() == 0
    source = (ROOT / "extension/background.js").read_text(encoding="utf-8")
    reserved = re.search(r'const INSTALLER_AGENT = "([^"]+)";', source)
    assert reserved and names == [reserved.group(1)]
    sys.path.insert(0, str(ROOT / "native-host"))
    from bridge_security import check_identity

    assert check_identity(names[0], "installer-0123456789ab") is not None
