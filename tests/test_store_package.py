"""Paquet du Chrome Web Store (scripts/store_package.py) : l'extension telle que Chrome la charge, sans la clé
publique du manifest (la boutique signe avec la sienne), et la fiche qui le décrit tenue à jour avec le manifest."""

import importlib.util
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("store_package", ROOT / "scripts" / "store_package.py")
assert SPEC and SPEC.loader
store = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(store)


def test_zip_is_the_extension_without_key(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "ROOT", tmp_path)
    target = store.build_zip()
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(p.relative_to(ROOT / "extension").as_posix() for p in (ROOT / "extension").rglob("*") if p.is_file())
    with zipfile.ZipFile(target) as archive:
        assert sorted(archive.namelist()) == files
        packaged = json.loads(archive.read("manifest.json"))
    assert "key" in manifest and "key" not in packaged
    assert {k: v for k, v in manifest.items() if k != "key"} == packaged
    assert target.name == f"nexus-browser-extension-{manifest['version']}.zip"


def test_listing_matches_the_manifest():
    """Chaque permission du manifest a sa justification dans store/README.md ; nom et résumé recopiés tels quels."""
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    listing = (ROOT / "store" / "README.md").read_text(encoding="utf-8")
    justified = set(re.findall(r"^\| `([a-zA-Z]+)` \|", listing, re.M))
    assert set(manifest["permissions"]) == justified
    assert len(manifest["description"]) <= 132
    assert manifest["name"] in listing and " ".join(manifest["description"].split()) in " ".join(listing.split())
