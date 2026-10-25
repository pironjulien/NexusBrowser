"""Compteur de mails non lus pour le pad MX Keypad : le pont n'écrit que le nombre, une entrée par profil Chrome, retire
l'entrée d'un profil décoché (fichier effacé quand il n'en reste aucune), et ignore un nombre invalide."""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "native-host"))

import bridge_server  # noqa: E402

A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"


def _lire(tmp_path):
    return json.loads((tmp_path / "compteurs.json").read_text(encoding="utf-8"))["sources"]


def test_compteur_ecrit_puis_efface(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    bridge_server.ecrire_compteurs(
        {"event": "compteurs", "source": A, "actif": True, "gmail": 3, "objet": "ne doit pas sortir"}
    )
    lu = _lire(tmp_path)
    assert (
        set(lu) == {A} and lu[A]["gmail"] == 3 and lu[A]["raison"] is None and set(lu[A]) == {"gmail", "raison", "at"}
    )
    bridge_server.ecrire_compteurs({"event": "compteurs", "source": A, "actif": False, "gmail": None})
    assert not (tmp_path / "compteurs.json").exists()


def test_plusieurs_profils(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    bridge_server.ecrire_compteurs({"source": A, "actif": True, "gmail": 2})
    bridge_server.ecrire_compteurs({"source": B, "actif": True, "gmail": 5})
    assert {k: v["gmail"] for k, v in _lire(tmp_path).items()} == {A: 2, B: 5}
    bridge_server.ecrire_compteurs({"source": A, "actif": False})
    assert set(_lire(tmp_path)) == {B}  # la décoche d'un profil ne touche pas l'autre


def test_source_invalide_et_entree_perimee(tmp_path, monkeypatch):
    fichier = tmp_path / "compteurs.json"
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: fichier)
    vieux = (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()
    fichier.write_text(json.dumps({"sources": {B: {"gmail": 9, "raison": None, "at": vieux}}}), encoding="utf-8")
    bridge_server.ecrire_compteurs({"source": "../../hors liste", "actif": True, "gmail": 1})
    assert set(_lire(tmp_path)) == {"defaut"}  # identifiant refusé, profil supprimé depuis 2 jours retiré


def test_compteur_invalide(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    for valeur in ("7", -1, 10**9, True, 2.5):
        bridge_server.ecrire_compteurs({"event": "compteurs", "source": A, "actif": True, "gmail": valeur})
        assert _lire(tmp_path)[A]["gmail"] is None


def test_raison_liste_fixe(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    lire = lambda: _lire(tmp_path)[A]["raison"]  # noqa: E731
    bridge_server.ecrire_compteurs({"source": A, "actif": True, "gmail": None, "raison": "http-401"})
    assert lire() == "http-401"
    bridge_server.ecrire_compteurs({"source": A, "actif": True, "gmail": None, "raison": "objet du mail"})
    assert lire() is None
    bridge_server.ecrire_compteurs({"source": A, "actif": True, "gmail": 2, "raison": "reseau"})
    assert lire() is None


def test_ancienne_extension_pas_comptee_deux_fois(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    bridge_server.ecrire_compteurs({"actif": True, "gmail": 7})  # extension 2.23.1 : sans identifiant
    bridge_server.ecrire_compteurs({"source": A, "actif": True, "gmail": 7})  # le même profil, passé en 2.23.2
    assert {k: v["gmail"] for k, v in _lire(tmp_path).items()} == {A: 7}
