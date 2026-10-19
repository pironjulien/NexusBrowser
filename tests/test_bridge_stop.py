"""Arrêt d'urgence tenu par le pont lui-même (handle_http et sa surveillance), pour tout client HTTP : actions refusées,
lectures permises, et commandes DÉJÀ en cours annulées dès que l'arrêt est posé (extension prévenue). Vrai pont servi
sur un port éphémère avec un jeton jetable (conftest.isolated_bridge)."""

import asyncio
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from websockets import connect

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))
sys.path.insert(0, str(REPO_ROOT / "client"))
sys.path.insert(0, str(REPO_ROOT / "tests"))

import emergency_stop  # noqa: E402  (même module que celui du pont, redirigé par conftest)
from bridge_security import AGENT_HEADER, CLIENT_HEADER, TOKEN_HEADER, token_path  # noqa: E402
from test_bridge_auth import ORIGIN, Extension  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""
IDENTITY = {AGENT_HEADER: "Claude", CLIENT_HEADER: "claude-test-stop"}


def post(action: str, timeout: float = 1.0, params: dict | None = None) -> tuple[int, dict]:
    request = urllib.request.Request(
        COMMAND_URL,
        data=json.dumps({"action": action, "params": params or {"tab_id": 1}, "timeout": timeout}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            TOKEN_HEADER: token_path().read_text(encoding="ascii").strip(),
            **IDENTITY,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout + 10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        with error:
            return error.code, json.loads(error.read().decode("utf-8"))


def test_bridge_refuses_actions_during_emergency_stop():
    emergency_stop.pressed()
    for action in ("click", "fill", "eval", "get-cookies", "cdp-send", "upload", "navigate", "adopt-tab"):
        status, payload = post(action)
        assert status == 423, action
        assert payload["emergency_stop"] is True and "Emergency stop" in payload["error"]
    # Une lecture n'est pas bloquée par l'arrêt : elle va jusqu'à l'extension (absente ici).
    status, payload = post("list-tabs")
    assert status == 400 and "No Chrome browser extension connected" in payload["error"]


def test_bridge_forwards_actions_without_emergency_stop():
    status, payload = post("click")
    assert status == 400 and "No Chrome browser extension connected" in payload["error"]


def test_stop_cancels_the_command_already_running_and_warns_the_extension():
    """Revue C4 : avant, une frappe longue déjà lancée continuait jusqu'à son délai (ici 30 s) malgré l'arrêt."""
    result: dict = {}

    def long_typing():
        started = time.monotonic()
        result["status"], result["payload"] = post("type-keys", timeout=30.0, params={"tab_id": 1, "text": "x" * 500})
        result["elapsed"] = time.monotonic() - started

    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            extension = Extension(websocket)
            await extension.authenticate()
            thread = threading.Thread(target=long_typing, daemon=True)
            thread.start()
            command = await asyncio.wait_for(extension.receive(), 5)
            assert command["action"] == "type_keys"
            assert command["client"] == {"agent": "Claude", "id": "claude-test-stop"}
            emergency_stop.pressed()  # Ctrl+Alt+Maj+Échap ou STOP d'un autre agent : ~/.nexus/stop
            notice = await asyncio.wait_for(extension.receive(), 5)
            assert notice["action"] == "emergency_stop" and notice["params"]["hold_s"] > 100
            await extension.send({"requestId": notice["requestId"], "success": True, "data": {"stopped": True}})
            await asyncio.to_thread(thread.join, 10)

    asyncio.run(asyncio.wait_for(scenario(), 30))
    assert result["status"] == 423
    assert result["payload"]["emergency_stop"] is True
    assert "cancelled while running" in result["payload"]["error"]
    assert result["elapsed"] < 5


def test_identity_is_required_and_reserved_actions_refused():
    token = token_path().read_text(encoding="ascii").strip()

    def raw(action: str, headers: dict) -> tuple[int, dict]:
        request = urllib.request.Request(
            COMMAND_URL,
            data=json.dumps({"action": action, "params": {"tab_id": 1}, "timeout": 1}).encode("utf-8"),
            headers={"Content-Type": "application/json", TOKEN_HEADER: token, **headers},
        )
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            with error:
                return error.code, json.loads(error.read().decode("utf-8"))

    for headers in ({}, {AGENT_HEADER: "Claude"}, {AGENT_HEADER: "Claude", CLIENT_HEADER: "x"}):
        status, payload = raw("click", headers)
        assert status == 400 and "Missing or invalid client identity" in payload["error"], headers
    status, payload = raw("emergency-stop", IDENTITY)
    assert status == 403 and "reserved to the bridge" in payload["error"]
    status, payload = raw("ping", {})  # contrôle de vie (verify.ps1) : seul permis sans identité
    assert "client identity" not in payload.get("error", "")
