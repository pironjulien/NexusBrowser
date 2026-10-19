"""Panneau Antigravity : le pont dépose la demande dans Nexus Relay et remet la réponse au panneau (faux relais)."""

import asyncio
import json
import sys
from pathlib import Path

import agy_panel
import bridge_server
import pytest

LID = "a1b2c3d4-0000-4000-8000-000000000001"
INSTANCE = "b1b2c3d4-0000-4000-8000-000000000001"
FAKE_PANEL = """
import json, sys
from pathlib import Path
state = Path(r"{state}")
box = state / "inbox" / "julien"
box.mkdir(parents=True, exist_ok=True)
command = sys.argv[1]
data = json.loads(sys.stdin.read() or "{{}}")
if command == "post":
    if data["text"] == "casse":
        print(json.dumps({{"error": "texte refusé"}}))
        sys.exit(2)
    (state / "posted.json").write_text(json.dumps(data), encoding="utf-8")
    print(json.dumps({{"id": "20261018T180000000-aaaaaa", "thread": "panneau-chrome", "sidecar_active": True}}))
elif command == "collect":
    print(json.dumps({{"messages": [json.loads(p.read_text(encoding="utf-8")) for p in sorted(box.glob("*.json"))]}}))
elif command == "ack":
    n = 0
    for i in data["ids"]:
        p = box / (i + ".json")
        if p.exists():
            p.unlink()
            n += 1
    print(json.dumps({{"acked": n}}))
"""


@pytest.fixture
def relay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Faux Nexus Relay : un paquet nexus_relay.panel jetable, lancé par le vrai Python des tests."""
    state = tmp_path / "relay"
    package = tmp_path / "fake" / "nexus_relay"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "panel.py").write_text(FAKE_PANEL.format(state=state), encoding="utf-8")
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", sys.executable)
    monkeypatch.setenv("NEXUS_RELAY_HOME", str(state))
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "fake"))
    return state


def test_check_ask_valide_et_borne():
    local_id, text, tab = agy_panel.check_ask(
        {"localId": LID, "text": "  Remplis  ", "tab": {"id": 4, "title": "T" * 400, "url": "https://a.invalid/"}}
    )
    assert (local_id, text) == (LID, "Remplis") and tab is not None
    assert tab["id"] == 4 and len(tab["title"]) == 300
    assert agy_panel.check_ask({"localId": LID, "text": "x", "tab": {"id": True}})[2] == {
        "id": None,
        "title": "",
        "url": "",
    }
    for bad in ({"localId": "", "text": "x"}, {"localId": "L", "text": " "}, {"localId": "L", "text": "x" * 6001}):
        with pytest.raises(ValueError):
            agy_panel.check_ask(bad)


def test_relais_absent_message_clair(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", str(tmp_path / "absent" / "python.exe"))
    with pytest.raises(agy_panel.RelayNotLaunched, match="install.ps1"):
        asyncio.run(agy_panel.post("x", None, LID))


def test_demande_deposee_puis_reponse_remise_et_passee_en_lu(relay: Path, monkeypatch: pytest.MonkeyPatch):
    sent: list[tuple[str, dict]] = []

    async def fake_send(action, params=None, timeout=15.0, client=None, target=None, gone=None, strict=False):
        sent.append((action, params or {}))
        return {"entries": 1}

    monkeypatch.setattr(bridge_server, "send_command_to_chrome", fake_send)
    monkeypatch.setattr(bridge_server, "active_connections", [object()])
    client = object()

    ask = {
        "event": "agy_ask",
        "localId": LID,
        "text": "Remplis le formulaire",
        "tab": {"id": 7, "title": "F", "url": "u"},
    }
    asyncio.run(bridge_server.handle_agy_ask(client, ask))  # type: ignore[arg-type]
    assert json.loads((relay / "posted.json").read_text(encoding="utf-8"))["tab"]["id"] == 7
    assert sent[-1] == (
        "agy_panel_update",
        {"localId": LID, "relayId": "20261018T180000000-aaaaaa", "status": "sent", "sidecarActive": True},
    )
    assert json.loads((relay / "posted.json").read_text(encoding="utf-8"))["request_id"] == LID  # dépôt idempotent

    asyncio.run(bridge_server.handle_agy_ask(client, {**ask, "text": "casse"}))  # type: ignore[arg-type]
    assert sent[-1][1]["status"] == "error" and sent[-1][1]["error"] == "texte refusé"  # refus explicite : définitif

    assert asyncio.run(bridge_server.deliver_agy_replies()) == 0  # boîte vide : le relais n'est même pas appelé
    reply = {"id": "R9", "from": "antigravity", "reply_to": "20261018T180000000-aaaaaa", "text": "Fait."}
    (relay / "inbox" / "julien" / "R9.json").write_text(json.dumps(reply), encoding="utf-8")
    assert asyncio.run(bridge_server.deliver_agy_replies()) == 1
    assert sent[-1] == ("agy_panel_update", {"reply": reply})
    assert not agy_panel.has_mail()  # remise à l'extension, puis passée en lu


def test_reponse_gardee_si_l_extension_ne_la_recoit_pas(relay: Path, monkeypatch: pytest.MonkeyPatch):
    async def failing_send(*args, **kwargs):
        raise ConnectionResetError("extension partie")

    monkeypatch.setattr(bridge_server, "send_command_to_chrome", failing_send)
    monkeypatch.setattr(bridge_server, "active_connections", [object()])
    (relay / "inbox" / "julien").mkdir(parents=True)
    (relay / "inbox" / "julien" / "R1.json").write_text(json.dumps({"id": "R1", "text": "x"}), encoding="utf-8")
    assert asyncio.run(bridge_server.deliver_agy_replies()) == 0
    assert agy_panel.has_mail()  # nouvel essai au prochain tour


def test_agy_panel_update_reservee_au_pont():
    assert "agy_panel_update" in bridge_server.RESERVED_ACTIONS


def test_relais_arrete_sans_reponse_retente_une_fois_puis_dit_la_vraie_erreur(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """18/10 : environnement du relais en cours de réinstallation, module absent, aucune sortie : l'erreur était
    masquée (« identifiant de message absent ») ; désormais une nouvelle tentative, puis l'erreur réelle."""
    package = tmp_path / "fake" / "nexus_relay"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    counter = tmp_path / "calls"
    (package / "panel.py").write_text(
        "import sys, pathlib\n"
        f"c = pathlib.Path(r'{counter}')\n"
        "n = int(c.read_text()) + 1 if c.exists() else 1\n"
        "c.write_text(str(n))\n"
        "if n == 1 or sys.argv[1] == 'collect':\n"
        "    sys.stderr.write('ModuleNotFoundError: No module named nexus_relay.panel\\n')\n"
        "    sys.exit(1)\n"
        "sys.stdin.read()\n"
        'print(\'{"id": "20261018T183000000-bbbbbb"}\')\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", sys.executable)
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "fake"))
    monkeypatch.setattr(agy_panel, "RETRY_AFTER_S", 0.01)
    assert asyncio.run(agy_panel.post("x", None, LID)) == ("20261018T183000000-bbbbbb", False)
    assert counter.read_text() == "2"
    with pytest.raises(agy_panel.RelayUnavailable, match="code 1.*ModuleNotFoundError"):
        asyncio.run(agy_panel.collect())


def test_reponse_remise_a_la_liaison_qui_a_envoye_la_demande(relay: Path, monkeypatch: pytest.MonkeyPatch):
    """Codex (P2) : deux profils Chrome reliés au pont ; la réponse va à celui qui a demandé, pas au plus récent."""
    targets: list[object] = []

    async def fake_send(action, params=None, timeout=15.0, client=None, target=None, gone=None, strict=False):
        targets.append((target, strict))
        return {}

    first, second, first_again = object(), object(), object()
    monkeypatch.setattr(bridge_server, "send_command_to_chrome", fake_send)
    monkeypatch.setattr(bridge_server, "active_connections", [first, second])
    monkeypatch.setattr(bridge_server, "agy_instances", {})
    ask = {"localId": LID, "instance": INSTANCE, "text": "x", "tab": None}
    asyncio.run(bridge_server.handle_agy_ask(first, ask))  # type: ignore[arg-type]
    assert json.loads((relay / "posted.json").read_text(encoding="utf-8"))["instance"] == INSTANCE
    reply = {
        "id": "R2",
        "from": "antigravity",
        "reply_to": "20261018T180000000-aaaaaa",
        "instance": INSTANCE,
        "text": "ok",
    }
    (relay / "inbox" / "julien" / "R2.json").write_text(json.dumps(reply), encoding="utf-8")
    # L'instance s'est reconnectée (nouvelle liaison) mais n'est pas encore annoncée : la réponse attend, jamais à B.
    monkeypatch.setattr(bridge_server, "active_connections", [second, first_again])
    assert asyncio.run(bridge_server.deliver_agy_replies()) == 0 and agy_panel.has_mail()
    bridge_server.agy_instances[INSTANCE] = first_again  # type: ignore[assignment]  # « agy_hello » reçu
    assert asyncio.run(bridge_server.deliver_agy_replies()) == 1
    assert targets[-1] == (first_again, True)


def test_envoi_strict_jamais_vers_une_autre_liaison(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(bridge_server, "active_connections", [object()])
    with pytest.raises(RuntimeError, match="instance déconnectée"):
        asyncio.run(bridge_server.send_command_to_chrome("agy_panel_update", {}, 1.0, target=object(), strict=True))


def test_issue_inconnue_du_relais_ni_erreur_ni_redepot(relay: Path, monkeypatch: pytest.MonkeyPatch):
    """Codex (2e passe) : un arrêt du relais après le dépôt ne doit pas afficher « non transmise » ; l'extension renvoie
    la même requête, que le relais retrouve."""
    sent: list[dict] = []

    async def fake_send(action, params=None, timeout=15.0, client=None, target=None, gone=None, strict=False):
        sent.append(params or {})
        return {}

    async def crashed(*_args: object, **_kwargs: object) -> tuple[str, bool]:
        raise agy_panel.RelayCrashed("code 9")

    monkeypatch.setattr(bridge_server, "send_command_to_chrome", fake_send)
    monkeypatch.setattr(agy_panel, "post", crashed)
    asyncio.run(bridge_server.handle_agy_ask(object(), {"localId": LID, "text": "x", "tab": None}))  # type: ignore[arg-type]
    assert sent == []


def test_code_de_sortie_controle_meme_avec_un_json_lisible(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    package = tmp_path / "fake" / "nexus_relay"
    package.mkdir(parents=True)
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "panel.py").write_text(
        "import sys\nsys.stdin.read()\nprint('{\"id\": \"looks-valid\"}')\nsys.stderr.write('panne\\n')\nsys.exit(9)\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", sys.executable)
    monkeypatch.setenv("PYTHONPATH", str(tmp_path / "fake"))
    monkeypatch.setattr(agy_panel, "RETRY_AFTER_S", 0.01)
    with pytest.raises(agy_panel.RelayCrashed, match="code 9.*panne"):
        asyncio.run(agy_panel.post("x", None, LID))


def test_deux_profils_relies_demande_retenue_jamais_non_transmise(relay: Path, monkeypatch: pytest.MonkeyPatch):
    """Codex (3e passe) : les commandes d'Antigravity iraient à la liaison prioritaire ; limite réelle et annoncée.
    Codex (4e passe) : une reprise a pu être déposée avant l'arrivée du second profil → « retenue », jamais « error »
    (l'extension garde la réservation et renvoie le même localId, que le relais retrouvera)."""
    sent: list[dict] = []

    async def fake_send(action, params=None, timeout=15.0, client=None, target=None, gone=None, strict=False):
        sent.append(params or {})
        return {}

    first, second = object(), object()
    monkeypatch.setattr(bridge_server, "send_command_to_chrome", fake_send)
    monkeypatch.setattr(bridge_server, "active_connections", [first, second])
    monkeypatch.setattr(bridge_server, "agy_instances", {"c1b2c3d4-0000-4000-8000-000000000009": second})
    asyncio.run(bridge_server.handle_agy_ask(first, {"localId": LID, "instance": INSTANCE, "text": "x", "tab": None}))  # type: ignore[arg-type]
    assert sent[-1]["status"] == "held" and "Plusieurs profils Chrome" in sent[-1]["error"]
    assert sent[-1]["localId"] == LID
    assert not (relay / "posted.json").exists()


def test_relais_impossible_a_lancer_pendant_une_reprise_demande_retenue(
    relay: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """Codex (5e passe) : dépôt réussi, confirmation perdue, relais impossible à lancer à la reprise → « held »
    (rien n'est su du dépôt antérieur), puis relais revenu → même request_id redonné au relais, qui retrouve son dépôt
    (idempotence testée dans NexusRelay)."""
    sent: list[dict] = []

    async def fake_send(action, params=None, timeout=15.0, client=None, target=None, gone=None, strict=False):
        sent.append(params or {})
        if len(sent) == 1:
            raise ConnectionResetError("confirmation perdue")
        return {}

    client = object()
    monkeypatch.setattr(bridge_server, "send_command_to_chrome", fake_send)
    monkeypatch.setattr(bridge_server, "active_connections", [client])
    monkeypatch.setattr(bridge_server, "agy_instances", {})
    ask = {"localId": LID, "instance": INSTANCE, "text": "x", "tab": None}
    asyncio.run(bridge_server.handle_agy_ask(client, ask))  # type: ignore[arg-type]
    assert sent[-1]["status"] == "sent" and (relay / "posted.json").exists()
    (relay / "posted.json").unlink()
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", str(tmp_path / "absent" / "python.exe"))
    asyncio.run(bridge_server.handle_agy_ask(client, ask))  # type: ignore[arg-type]
    assert sent[-1]["status"] == "held" and "install.ps1" in sent[-1]["error"] and sent[-1]["localId"] == LID
    monkeypatch.setenv("NEXUS_RELAY_PYTHON", sys.executable)
    asyncio.run(bridge_server.handle_agy_ask(client, ask))  # type: ignore[arg-type]
    assert sent[-1]["status"] == "sent" and sent[-1]["relayId"] == "20261018T180000000-aaaaaa"
    assert json.loads((relay / "posted.json").read_text(encoding="utf-8"))["request_id"] == LID
