"""Paquet du Chrome Web Store (scripts/store_package.py) : l'extension telle que Chrome la charge, sans la clé
publique du manifest (la boutique signe avec la sienne), et la fiche qui le décrit tenue à jour avec le manifest."""

import importlib.util
import json
import re
import zipfile
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("store_package", ROOT / "scripts" / "store_package.py")
assert SPEC and SPEC.loader
store = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(store)


def remote_hosts(policy: str) -> list[str]:
    """Hôtes distants (https) autorisés par la directive connect-src d'une CSP."""
    connect = re.search(r"connect-src ([^;]+)", policy)
    sources = connect.group(1).split() if connect else []
    return [urlparse(s).hostname or "" for s in sources if s.startswith("https://")]


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


def test_variant_without_the_gmail_counter(tmp_path):
    """Variante prête au cas où le Chrome Web Store refuserait le compteur Gmail : ni case, ni lecture, ni
    mail.google.com dans la CSP ; tout le reste identique au paquet par défaut."""
    default = store.build_zip(out_dir=tmp_path)
    variant = store.build_zip(gmail_counter=False, out_dir=tmp_path)
    assert variant.name.endswith("-without-gmail-counter.zip")
    with zipfile.ZipFile(default) as a, zipfile.ZipFile(variant) as b:
        assert a.namelist() == b.namelist()
        changed = sorted(name for name in a.namelist() if a.read(name) != b.read(name))
        assert changed == ["background.js", "manifest.json", "popup.html"]
        csp = json.loads(b.read("manifest.json"))["content_security_policy"]["extension_pages"]
        assert remote_hosts(csp) == [] and "ws://127.0.0.1:*" in csp
        assert remote_hosts(json.loads(a.read("manifest.json"))["content_security_policy"]["extension_pages"]) == [
            "mail.google.com"
        ]
        popup = b.read("popup.html").decode("utf-8")
        assert "compteur-gmail" not in popup and "<label" not in popup and 'id="bridge"' in popup
        assert b"const COMPTEUR_GMAIL_DISPONIBLE = false;" in b.read("background.js")
        assert b"const COMPTEUR_GMAIL_DISPONIBLE = true;" in a.read("background.js")


def test_csp_reaches_only_the_bridge_and_the_documented_gmail_feed():
    """connect-src : le pont local, et une seule adresse distante, le flux Gmail du compteur facultatif, justifiée dans
    le README et dans store/SINGLE_PURPOSE.md (aucune entrée distante sans raison écrite)."""
    manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
    policy = manifest["content_security_policy"]["extension_pages"]
    connect = re.search(r"connect-src ([^;]+);", policy)
    assert connect
    remote = [
        s
        for s in connect.group(1).split()
        if s != "'self'" and not re.match(r"(ws|http)://(127\.0\.0\.1|localhost):\*$", s)
    ]
    assert remote == ["https://mail.google.com"]
    for doc in ("README.md", "store/SINGLE_PURPOSE.md"):
        urls = re.findall(r"https://[^\s)`'\"<>]+", (ROOT / doc).read_text(encoding="utf-8"))
        assert any(urlparse(url).hostname == "mail.google.com" for url in urls), doc
    assert "FLUX_GMAIL" in (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
