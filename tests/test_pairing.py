"""Appairage sans hôte natif (bridge_pairing) sur le vrai pont, port éphémère : secret à usage unique, 5 minutes,
tentatives limitées, clé dérivée de la poignée de main, origine liée à l'identifiant, révocation."""

import asyncio
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest
from websockets import connect
from websockets.exceptions import ConnectionClosed
from websockets.typing import Origin

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "native-host"))

import bridge_pairing  # noqa: E402
import bridge_server  # noqa: E402
from bridge_auth import PROTOCOL, AuthError, Channel, client_proof, new_nonce, server_proof, session_key  # noqa: E402
from bridge_security import TOKEN_HEADER, token_path  # noqa: E402

HTTP_PORT = 0
STATUS_URL = ""
COMMAND_URL = ""
WS_URL = ""
EXTENSION_ID = "blcgddmjdkobmgakjffjpgiicjlflgjf"
ORIGIN = Origin(f"chrome-extension://{EXTENSION_ID}")


@pytest.fixture(autouse=True)
def fresh_pairing(monkeypatch):
    """Chaque test part d'un pont sans offre ni extension appairée (fichier à côté du jeton jetable)."""
    store = bridge_pairing.PairingStore(token_path().with_name("paired-extensions.json"))
    store.path.unlink(missing_ok=True)
    monkeypatch.setattr(bridge_server, "PAIRING", store)
    yield store


def http(path: str, payload: dict | None = None, token: str | None = None) -> tuple[int, dict]:
    data = json.dumps(payload).encode("utf-8") if payload is not None else b""
    headers = {TOKEN_HEADER: token if token is not None else token_path().read_text(encoding="ascii").strip()}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(f"http://127.0.0.1:{HTTP_PORT}{path}", data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read().decode("utf-8"))
        finally:
            error.close()


def offer() -> str:
    code, body = http("/api/pair")
    assert code == 200 and body["success"] and body["expires_in_s"] == 300 and body["page"] == "pair.html"
    assert len(body["secret"]) == 43  # 256 bits en base64url
    return body["secret"]


def status() -> dict:
    request = urllib.request.Request(
        f"http://127.0.0.1:{HTTP_PORT}/api/status",
        headers={TOKEN_HEADER: token_path().read_text(encoding="ascii").strip()},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


async def handshake(websocket, key: str, auth: str, role: str, extension_id: str = EXTENSION_ID, proof: str = ""):
    """Poignée de main de l'extension avec une clé (secret d'appairage ou clé appairée) ; rend (nonces, canal)."""
    client_nonce = new_nonce()
    hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": client_nonce, "role": role}
    await websocket.send(json.dumps({**hello, "extension_id": extension_id, "auth": auth}))
    challenge = json.loads(await websocket.recv())
    server_nonce = challenge["server_nonce"]
    args = (key, client_nonce, server_nonce, role, extension_id)
    assert challenge["server_proof"] == server_proof(*args)  # le pont prouve d'abord qu'il connaît la clé
    await websocket.send(json.dumps({"type": "auth_proof", "client_proof": proof or client_proof(*args)}))
    channel = Channel(session_key(*args), "c2s", "s2c")
    assert json.loads(channel.open(json.loads(await websocket.recv()))) == {"type": "auth_ok"}
    return client_nonce, server_nonce, channel


async def refused(websocket) -> bool:
    try:
        while True:
            await asyncio.wait_for(websocket.recv(), 5)
    except ConnectionClosed as closed:
        return closed.rcvd is not None and closed.rcvd.code == 1008


def run(coroutine):
    return asyncio.run(asyncio.wait_for(coroutine, 60))


async def pair(secret: str) -> str:
    """Appairage complet ; rend la clé durable que l'extension aurait dérivée."""
    async with connect(WS_URL, origin=ORIGIN) as websocket:
        client_nonce, server_nonce, _ = await handshake(websocket, secret, "pair", "pairing")
        with pytest.raises(ConnectionClosed):  # connexion d'appairage : fermée par le pont, jamais un client
            await asyncio.wait_for(websocket.recv(), 5)
    return bridge_pairing.paired_key(secret, client_nonce, server_nonce, EXTENSION_ID)


def test_pairing_then_paired_connection_is_a_real_client():
    secret = offer()

    async def scenario():
        key = await pair(secret)
        assert status()["connected_clients"] == 0
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            await handshake(websocket, key, "paired", "service_worker")
            await asyncio.sleep(0.05)
            assert status()["clients"][0]["extension_id"] == EXTENSION_ID
        # Le secret seul (lu plus tard dans un presse-papiers ou un historique) n'est pas la clé : refusé.
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": "service_worker"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "paired"}))
            challenge = json.loads(await websocket.recv())
            assert challenge["server_proof"] != server_proof(
                secret, hello["client_nonce"], challenge["server_nonce"], "service_worker", EXTENSION_ID
            )

    run(scenario())


def test_secret_is_single_use():
    secret = offer()

    async def scenario():
        await pair(secret)
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": "pairing"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "pair"}))
            assert await refused(websocket)  # plus d'offre : aucune poignée de main

    run(scenario())


def test_expired_offer_is_refused(fresh_pairing, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(fresh_pairing, "clock", lambda: now[0])
    secret = offer()
    now[0] += bridge_pairing.OFFER_TTL_S
    with pytest.raises(AuthError, match="expiré"):
        fresh_pairing.pending_secret()
    assert secret and fresh_pairing._offer is None


def test_wrong_proofs_exhaust_the_offer(fresh_pairing):
    secret = offer()

    async def wrong_attempt():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            client_nonce = new_nonce()
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": client_nonce, "role": "pairing"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "pair"}))
            challenge = json.loads(await websocket.recv())
            forged = client_proof("y" * 43, client_nonce, challenge["server_nonce"], "pairing", EXTENSION_ID)
            await websocket.send(json.dumps({"type": "auth_proof", "client_proof": forged}))
            assert await refused(websocket)

    async def scenario():
        for _ in range(bridge_pairing.MAX_ATTEMPTS):
            await wrong_attempt()
        # Offre épuisée : même le bon secret ne sert plus.
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": "pairing"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "pair"}))
            assert await refused(websocket)

    run(scenario())
    assert secret and not fresh_pairing.path.exists()


def test_announced_id_must_be_the_origin():
    secret = offer()
    other = "a" * 32

    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": "pairing"}
            await websocket.send(json.dumps({**hello, "extension_id": other, "auth": "pair"}))
            assert await refused(websocket)

    run(scenario())
    assert secret


def test_unpaired_extension_and_pairing_role_are_refused():
    async def scenario():
        for auth, role in (
            ("paired", "service_worker"),
            ("paired", "pairing"),
            ("native", "pairing"),
            ("x", "offscreen"),
        ):
            async with connect(WS_URL, origin=ORIGIN) as websocket:
                hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": role}
                await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": auth}))
                assert await refused(websocket), (auth, role)

    run(scenario())


def test_offer_and_revoke_need_the_bridge_token(fresh_pairing):
    assert http("/api/pair", token="faux")[0] == 401
    secret = offer()

    async def scenario():
        key = await pair(secret)
        assert http("/api/pair/revoke", {"extension_id": EXTENSION_ID}) == (200, {"success": True, "revoked": 1})
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": new_nonce(), "role": "service_worker"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "paired"}))
            assert await refused(websocket)
        assert key

    run(scenario())
    assert http("/api/pair/revoke", {"extension_id": "nope"})[0] == 400


def test_new_offer_replaces_the_previous_one():
    first = offer()
    second = offer()
    assert first != second

    async def scenario():
        async with connect(WS_URL, origin=ORIGIN) as websocket:
            client_nonce = new_nonce()
            hello = {"type": "auth_hello", "protocol": PROTOCOL, "client_nonce": client_nonce, "role": "pairing"}
            await websocket.send(json.dumps({**hello, "extension_id": EXTENSION_ID, "auth": "pair"}))
            challenge = json.loads(await websocket.recv())
            # Le pont prouve le second secret, pas le premier.
            assert challenge["server_proof"] == server_proof(
                second, client_nonce, challenge["server_nonce"], "pairing", EXTENSION_ID
            )

    run(scenario())
