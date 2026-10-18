"""Real bridge handlers served on ephemeral ports with a disposable credential."""

import asyncio
import importlib
import sys
import threading
from pathlib import Path

import pytest

# Aucun __pycache__ dans le dépôt (OneDrive), même lancé sans scripts\runtime.ps1.
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "native-host"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "client"))

import bridge_server  # noqa: E402
from bridge_security import load_or_create_token  # noqa: E402

# Les tests importent le client sous deux noms (« emergency_stop » et « client.emergency_stop ») : deux copies du
# module, chacune redirigée.
_STOP_MODULES = ("emergency_stop", "client.emergency_stop")


@pytest.fixture(autouse=True)
def isolated_emergency_stop(tmp_path_factory, monkeypatch):
    """Aucun test n'écrit ni ne lit le vrai ~/.nexus/stop (il figerait les autres agents de Julien), et chaque test
    part d'un arrêt levé."""
    directory = tmp_path_factory.mktemp("nexus-stop")
    for name in _STOP_MODULES:
        module = importlib.import_module(name)
        monkeypatch.setattr(module, "STOP_FILE", directory / "stop")
        monkeypatch.setattr(module, "OWNER_FILE", directory / "stop.owner")
        monkeypatch.setattr(module, "_latched_until", 0.0)
        monkeypatch.setattr(module, "_seen_version", None)
    monkeypatch.setattr(bridge_server, "_stop_seen_until", 0.0)  # chaque test part d'un arrêt jamais vu par le pont
    yield directory


@pytest.fixture(autouse=True)
def disposable_bridge_token(request, tmp_path_factory, monkeypatch):
    """Aucun test ne lit le vrai jeton ~/.nexus/nexus-browser/bridge-token : jeton jetable, sauf dans les modules qui servent un
    vrai pont (isolated_bridge y installe le sien, partagé avec le pont de test)."""
    if hasattr(request.module, "HTTP_PORT"):
        yield
        return
    token_file = tmp_path_factory.mktemp("token") / "bridge-token"
    load_or_create_token(token_file)
    monkeypatch.setenv("NEXUS_BROWSER_TOKEN_FILE", str(token_file))
    yield


@pytest.fixture(scope="module", autouse=True)
def isolated_bridge(request, tmp_path_factory):
    if not hasattr(request.module, "HTTP_PORT"):
        yield
        return
    token_file = tmp_path_factory.mktemp("bridge") / "token"
    load_or_create_token(token_file)
    patch = pytest.MonkeyPatch()
    patch.setenv("NEXUS_BROWSER_TOKEN_FILE", str(token_file))
    patch.setattr(bridge_server, "BRIDGE_TOKEN_PATH", token_file)
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()

    async def start():
        http = await asyncio.start_server(
            bridge_server.handle_http, "127.0.0.1", 0, limit=bridge_server.MAX_HEADER_BYTES + 4
        )
        ws = await bridge_server.serve(bridge_server.ws_handler, "127.0.0.1", 0)
        # Surveillance de l'arrêt d'urgence, comme le vrai pont : commandes en cours annulées dès qu'il est posé.
        watcher = asyncio.ensure_future(bridge_server.watch_emergency_stop())
        return http, ws, watcher

    http_server, ws_server, watcher = asyncio.run_coroutine_threadsafe(start(), loop).result(timeout=5)
    servers = (http_server, ws_server)
    port = servers[0].sockets[0].getsockname()[1]
    patch.setattr(request.module, "HTTP_PORT", port, raising=False)
    patch.setattr(request.module, "STATUS_URL", f"http://127.0.0.1:{port}/api/status", raising=False)
    patch.setattr(request.module, "COMMAND_URL", f"http://127.0.0.1:{port}/api/command", raising=False)
    patch.setattr(request.module, "WS_URL", f"ws://127.0.0.1:{servers[1].sockets[0].getsockname()[1]}", raising=False)
    try:
        yield
    finally:

        async def stop():
            watcher.cancel()
            for server in servers:
                server.close()
                await server.wait_closed()

        asyncio.run_coroutine_threadsafe(stop(), loop).result(timeout=5)
        loop.call_soon_threadsafe(loop.stop)
        thread.join(timeout=5)
        loop.close()
        patch.undo()
