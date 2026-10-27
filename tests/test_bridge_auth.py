"""Authentification mutuelle du WebSocket du pont (nexus-browser/1) sur le vrai serveur, port éphémère."""

import asyncio
import json
import os
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from websockets import connect
from websockets.exceptions import ConnectionClosed
from websockets.typing import Origin

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import auth_host  # noqa: E402
import bridge_server  # noqa: E402
from bridge_auth import (  # noqa: E402
    PROTOCOL,
    Channel,
    client_proof,
    new_nonce,
    server_proof,
    session_key,
)
from bridge_security import TOKEN_HEADER, load_or_create_token  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""
EXTENSION_ID = "blcgddmjdkobmgakjffjpgiicjlflgjf"
ORIGIN = Origin(f"chrome-extension://{EXTENSION_ID}")


def token() -> str:
    return load_or_create_token()


def http(url: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {TOKEN_HEADER: token(), **({"Content-Type": "application/json"} if data else {})}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers), timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return json.loads(error.read().decode("utf-8"))
        finally:
            error.close()


def status() -> dict:
    return http(STATUS_URL)


def wait_clients(count: int) -> dict:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        current = status()
        if current["connected_clients"] == count:
            return current
        time.sleep(0.02)
    raise AssertionError(f"{count} client(s) attendu(s) : {status()}")


class Extension:
    """Extension simulée : poignée de main correcte (ou falsifiée) puis canal signé."""

    def __init__(self, websocket, role: str = "service_worker") -> None:
        self.websocket, self.role = websocket, role
        self.channel: Channel | None = None
        self.client_nonce = new_nonce()
        self.server_nonce = ""
        self.proof = ""

    async def hello(self) -> dict:
        await self.websocket.send(
            json.dumps(
                {
                    "type": "auth_hello",
                    "protocol": PROTOCOL,
                    "client_nonce": self.client_nonce,
                    "role": self.role,
                    "extension_id": EXTENSION_ID,
                }
            )
        )
        challenge = json.loads(await self.websocket.recv())
        assert challenge["type"] == "auth_challenge"
        self.server_nonce = challenge["server_nonce"]
        # L'extension vérifie le serveur AVANT de prouver quoi que ce soit.
        expected = server_proof(token(), self.client_nonce, self.server_nonce, self.role, EXTENSION_ID)
        assert challenge["server_proof"] == expected
        return challenge

    async def authenticate(self, proof: str | None = None) -> None:
        await self.hello()
        args = (token(), self.client_nonce, self.server_nonce, self.role, EXTENSION_ID)
        self.proof = proof or client_proof(*args)
        await self.websocket.send(json.dumps({"type": "auth_proof", "client_proof": self.proof}))
        self.channel = Channel(session_key(*args), "c2s", "s2c")
        answer = json.loads(self.channel.open(json.loads(await self.websocket.recv())))
        assert answer == {"type": "auth_ok"}

    async def receive(self) -> dict:
        assert self.channel is not None
        return json.loads(self.channel.open(json.loads(await self.websocket.recv())))

    async def send(self, payload: dict) -> dict:
        assert self.channel is not None
        frame = self.channel.seal(json.dumps(payload))
        await self.websocket.send(json.dumps(frame))
        return frame


def run(coroutine):
    return asyncio.run(asyncio.wait_for(coroutine, 60))  # garde contre un blocage, pas une borne de temps testée


async def closed_with_policy_violation(websocket) -> bool:
    try:
        while True:
            await asyncio.wait_for(websocket.recv(), 5)
    except ConnectionClosed as closed:
        return closed.rcvd is not None and closed.rcvd.code == 1008


def command_in_thread(action: str, params: dict | None = None, timeout: float = 5.0) -> tuple[threading.Thread, dict]:
    result: dict = {}

    def target():
        result.update(http(COMMAND_URL, {"action": action, "params": params or {}, "timeout": timeout}))

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    return thread, result


def test_connection_without_proof_is_never_a_client():
    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            # Origine autorisée (falsifiable) mais aucune preuve : une commande « brute » ferme la connexion.
            await websocket.send(json.dumps({"requestId": "x", "success": True, "data": "faux"}))
            assert await closed_with_policy_violation(websocket)
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            # Poignée de main ouverte puis abandonnée : jamais compté comme client, aucune commande reçue.
            extension = Extension(websocket)
            await extension.hello()
            assert status()["connected_clients"] == 0
            reply = http(COMMAND_URL, {"action": "ping", "timeout": 1})
            assert reply["success"] is False and "No Chrome browser extension connected" in reply["error"]
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(websocket.recv(), 0.3)

    run(scenario())
    wait_clients(0)


def test_wrong_proof_is_refused():
    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            extension = Extension(websocket)
            await extension.hello()
            forged = client_proof(
                "x" * 64, extension.client_nonce, extension.server_nonce, "service_worker", EXTENSION_ID
            )
            await websocket.send(json.dumps({"type": "auth_proof", "client_proof": forged}))
            assert await closed_with_policy_violation(websocket)
        assert status()["connected_clients"] == 0

    run(scenario())


def test_replayed_handshake_and_replayed_frame_are_refused():
    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            first = Extension(websocket)
            await first.authenticate()
            frame = await first.send({"event": "keepalive"})
            await websocket.send(json.dumps(frame))  # même numéro d'ordre : rejeu
            assert await closed_with_policy_violation(websocket)
        wait_clients(0)
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            # Même nonce client et même preuve qu'une connexion réussie : le nonce serveur a changé, preuve fausse.
            replay = Extension(websocket)
            replay.client_nonce = first.client_nonce
            await replay.hello()
            assert replay.server_nonce != first.server_nonce
            await websocket.send(json.dumps({"type": "auth_proof", "client_proof": first.proof}))
            assert await closed_with_policy_violation(websocket)
        assert status()["connected_clients"] == 0

    run(scenario())


def test_unsigned_or_badly_signed_message_after_authentication_closes():
    async def scenario():
        for tamper in ("unsigned", "mac"):
            async with connect(WS_URL, origin=ORIGIN) as websocket:
                extension = Extension(websocket)
                await extension.authenticate()
                if tamper == "unsigned":
                    await websocket.send(json.dumps({"event": "keepalive"}))
                else:
                    assert extension.channel is not None
                    frame = extension.channel.seal(json.dumps({"event": "keepalive"}))
                    frame["body"] = json.dumps({"event": "autre"})
                    await websocket.send(json.dumps(frame))
                assert await closed_with_policy_violation(websocket)
            wait_clients(0)

    run(scenario())


def test_good_proof_is_accepted_and_receives_signed_commands():
    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            extension = Extension(websocket)
            await extension.authenticate()
            current = await asyncio.to_thread(wait_clients, 1)
            assert current["clients"][0]["role"] == "service_worker"
            assert current["target"]["extension_id"] == EXTENSION_ID
            thread, result = command_in_thread("ping")
            command = await extension.receive()
            assert command["action"] == "ping"
            await extension.send({"requestId": command["requestId"], "success": True, "data": {"status": "pong"}})
            await asyncio.to_thread(thread.join, 5)
            assert result == {"success": True, "data": {"status": "pong"}}

    run(scenario())
    wait_clients(0)


def test_target_is_deterministic_and_only_the_target_can_answer():
    async def scenario():
        async with (
            connect(WS_URL, origin=ORIGIN) as ws_offscreen,
            connect(WS_URL, origin=ORIGIN) as ws_worker,
            connect(WS_URL, origin=ORIGIN) as ws_offscreen_late,
        ):
            offscreen = Extension(ws_offscreen, "offscreen")
            worker = Extension(ws_worker, "service_worker")
            offscreen_late = Extension(ws_offscreen_late, "offscreen")
            for extension in (offscreen, worker, offscreen_late):
                await extension.authenticate()
            await asyncio.to_thread(wait_clients, 3)
            # Le service worker est choisi quel que soit l'ordre de connexion.
            thread, result = command_in_thread("ping", timeout=3)
            command = await worker.receive()
            # Réponse d'une AUTRE connexion authentifiée pour la même requête : ignorée.
            await offscreen.send({"requestId": command["requestId"], "success": True, "data": "usurpée"})
            await asyncio.sleep(0.1)
            assert thread.is_alive()
            await worker.send({"requestId": command["requestId"], "success": True, "data": "vraie"})
            await asyncio.to_thread(thread.join, 5)
            assert result["data"] == "vraie"
            await ws_worker.close()
            await asyncio.to_thread(wait_clients, 2)
            # Sans service worker : l'offscreen authentifié le plus récemment.
            thread, result = command_in_thread("ping", timeout=3)
            command = await offscreen_late.receive()
            await offscreen_late.send({"requestId": command["requestId"], "success": True, "data": "relais"})
            await asyncio.to_thread(thread.join, 5)
            assert result["data"] == "relais"

    run(scenario())
    wait_clients(0)


# --- Hôte natif ----------------------------------------------------------------------------------------------------
def native_message(nonce_c: str, nonce_s: str, proof: str, role: str = "offscreen") -> dict:
    return {
        "op": "handshake",
        "client_nonce": nonce_c,
        "server_nonce": nonce_s,
        "server_proof": proof,
        "role": role,
        "extension_id": EXTENSION_ID,
    }


def test_native_host_proves_only_for_an_authentic_server(tmp_path):
    token_file = tmp_path / "token"
    secret = load_or_create_token(token_file)
    cn, sn = new_nonce(), new_nonce()
    good = auth_host.answer(
        native_message(cn, sn, server_proof(secret, cn, sn, "offscreen", EXTENSION_ID)), EXTENSION_ID, token_file
    )
    assert good["ok"] is True
    assert good["client_proof"] == client_proof(secret, cn, sn, "offscreen", EXTENSION_ID)
    assert secret not in json.dumps(good)  # jamais le jeton lui-même
    forged = auth_host.answer(
        native_message(cn, sn, server_proof("y" * 64, cn, sn, "offscreen", EXTENSION_ID)), EXTENSION_ID, token_file
    )
    assert forged == {"ok": False, "error": forged["error"]} and "ne prouve pas" in forged["error"]
    other_caller = auth_host.answer(
        native_message(cn, sn, server_proof(secret, cn, sn, "offscreen", EXTENSION_ID)), "a" * 32, token_file
    )
    assert other_caller["ok"] is False
    assert auth_host.answer({"op": "token"}, EXTENSION_ID, token_file)["ok"] is False
    assert auth_host.answer(native_message("court", sn, "x"), EXTENSION_ID, token_file)["ok"] is False


@pytest.mark.skipif(sys.platform != "win32", reason="lanceur .cmd de Chrome sous Windows")
def test_native_host_process_through_cmd_launcher(tmp_path):
    """Comme Chrome : lanceur .cmd, origine de l'appelant en argument, messages natifs binaires sur stdin/stdout."""
    token_file = tmp_path / "token"
    secret = load_or_create_token(token_file)
    launcher = tmp_path / "host.cmd"
    launcher.write_text(f'@echo off\r\n"{sys.executable}" -I -B "{REPO_ROOT / "native-host" / "auth_host.py"}" %*\r\n')
    cn, sn = new_nonce(), new_nonce()
    payload = json.dumps(native_message(cn, sn, server_proof(secret, cn, sn, "offscreen", EXTENSION_ID))).encode()
    completed = subprocess.run(
        ["cmd.exe", "/d", "/c", str(launcher), f"chrome-extension://{EXTENSION_ID}/", "--parent-window=0"],
        input=struct.pack("<I", len(payload)) + payload,
        capture_output=True,
        timeout=20,
        env={**os.environ, "NEXUS_BROWSER_TOKEN_FILE": str(token_file)},
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    (length,) = struct.unpack("<I", completed.stdout[:4])
    reply = json.loads(completed.stdout[4 : 4 + length].decode("utf-8"))
    assert reply["ok"] is True, (reply, completed.stderr)
    assert reply["client_proof"] == client_proof(secret, cn, sn, "offscreen", EXTENSION_ID)


def test_status_only_counts_authenticated_clients():
    assert bridge_server.select_target() is None
    assert status()["connected_clients"] == 0
