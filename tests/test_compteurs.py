"""Compteur de mails non lus pour le pad MX Keypad : le pont n'écrit que le nombre, efface le fichier quand la case est
décochée, et ignore un nombre invalide."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "native-host"))

import bridge_server  # noqa: E402


def test_compteur_ecrit_puis_efface(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    bridge_server.ecrire_compteurs({"event": "compteurs", "actif": True, "gmail": 3, "objet": "ne doit pas sortir"})
    lu = json.loads((tmp_path / "compteurs.json").read_text(encoding="utf-8"))
    assert lu["gmail"] == 3 and lu["raison"] is None and set(lu) == {"gmail", "raison", "at"}
    bridge_server.ecrire_compteurs({"event": "compteurs", "actif": False, "gmail": None})
    assert not (tmp_path / "compteurs.json").exists()


def test_compteur_invalide(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    for valeur in ("7", -1, 10**9, True, 2.5):
        bridge_server.ecrire_compteurs({"event": "compteurs", "actif": True, "gmail": valeur})
        assert json.loads((tmp_path / "compteurs.json").read_text(encoding="utf-8"))["gmail"] is None


def test_raison_liste_fixe(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge_server, "fichier_compteurs", lambda: tmp_path / "compteurs.json")
    lire = lambda: json.loads((tmp_path / "compteurs.json").read_text(encoding="utf-8"))["raison"]  # noqa: E731
    bridge_server.ecrire_compteurs({"actif": True, "gmail": None, "raison": "http-401"})
    assert lire() == "http-401"
    bridge_server.ecrire_compteurs({"actif": True, "gmail": None, "raison": "objet du mail"})
    assert lire() is None
    bridge_server.ecrire_compteurs({"actif": True, "gmail": 2, "raison": "reseau"})
    assert lire() is None
