"""Scripts d'installation et de contrôle (revue C9 et A1) éprouvés sur des configurations FACTICES : doublon
nexus-browser chez Antigravity, ancienne extension dans un profil Chrome (lu seulement),
résidus de l'ancien pont. Aucun vrai fichier de Julien n'est lu ni écrit."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
PWSH = shutil.which("pwsh")
pytestmark = pytest.mark.skipif(PWSH is None or sys.platform != "win32", reason="PowerShell 7 sous Windows")


def pwsh(script: str, *args: str) -> subprocess.CompletedProcess:
    assert PWSH is not None
    return subprocess.run(
        [PWSH, "-NoProfile", "-File", str(REPO_ROOT / "scripts" / script), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",  # console de pwsh dans sa page de code : seuls des mots ASCII sont vérifiés
        timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def test_antigravity_duplicate_is_removed_keeping_other_servers(tmp_path):
    config = tmp_path / "mcp_config.json"
    original = {
        "mcpServers": {
            "nexus-computer": {"command": "python.exe", "args": ["-B", "computer.py"]},
            "nexus-browser": {"command": "python.exe", "args": ["-B", "mcp_server.py"]},
        },
        "autre": {"garde": True},
    }
    config.write_text(json.dumps(original), encoding="utf-8")
    check = pwsh("doublon-antigravity.ps1", "-ConfigPath", str(config), "-CheckOnly")
    assert check.returncode == 1 and "Doublon" in check.stdout
    assert json.loads(config.read_text(encoding="utf-8")) == original  # -CheckOnly n'écrit rien
    backups = tmp_path / "sauvegardes"
    done = pwsh("doublon-antigravity.ps1", "-ConfigPath", str(config), "-BackupDir", str(backups))
    assert done.returncode == 0, done.stderr
    after = json.loads(config.read_text(encoding="utf-8"))
    assert after == {
        "mcpServers": {"nexus-computer": original["mcpServers"]["nexus-computer"]},
        "autre": {"garde": True},
    }
    saved = list(backups.iterdir())
    assert len(saved) == 1 and json.loads(saved[0].read_text(encoding="utf-8")) == original
    assert not list(tmp_path.glob("*.tmp"))  # écriture atomique : aucun reste
    assert pwsh("doublon-antigravity.ps1", "-ConfigPath", str(config), "-CheckOnly").returncode == 0
    assert pwsh("doublon-antigravity.ps1", "-ConfigPath", str(tmp_path / "absent.json"), "-CheckOnly").returncode == 0


def test_old_extension_is_reported_from_profile_preferences(tmp_path):
    user_data = tmp_path / "User Data"
    unpacked = tmp_path / "ancien-pont"
    unpacked.mkdir()
    (unpacked / "manifest.json").write_text(json.dumps({"name": "Antigravity Browser Bridge"}), encoding="utf-8")
    settings = {
        "aaaapppppppppppppppppppppppppppp": {"path": str(unpacked), "state": 1},
        "bbbbpppppppppppppppppppppppppppp": {
            "manifest": {"name": "Antigravity Browser Bridge"},
            "disable_reasons": [1],
        },
        "blcgddmjdkobmgakjffjpgiicjlflgjf": {"manifest": {"name": "Nexus Browser Bridge"}},
    }
    for profile in ("Default", "Profile 2", "System Profile"):
        (user_data / profile).mkdir(parents=True)
        (user_data / profile / "Secure Preferences").write_text(
            json.dumps({"extensions": {"settings": settings}}), encoding="utf-8"
        )
    before = {p: p.read_bytes() for p in user_data.rglob("*") if p.is_file()}
    found = pwsh("ancienne-extension.ps1", "-UserData", str(user_data))
    assert found.returncode == 0, found.stderr
    lines = sorted(found.stdout.strip().splitlines())
    assert lines == [
        "Default : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
        "Profile 2 : Antigravity Browser Bridge (aaaapppppppppppppppppppppppppppp)",
    ]
    assert {p: p.read_bytes() for p in user_data.rglob("*") if p.is_file()} == before  # lecture seule


def test_install_cleans_old_bridge_and_registers_skills_without_duplicate():
    script = (REPO_ROOT / "install.ps1").read_text(encoding="utf-8")
    for residue in ("'bridge-token'", "com.nexusagy.bridge_auth.json", "nexusagy_bridge_auth.cmd"):
        assert residue in script
    assert "Write-Journal" in script and "install.log" in script
    assert "Remove-Item -LiteralPath $old -Force" in script
    assert "installer-plugins-nexus.ps1" in script  # Codex : par son plugin perso (NexusCodex)
    # Claude Code : serveur et compétence par le plugin du catalogue « nexus » (NexusClaude), aucune CLI Claude.
    for forbidden in ("claude.exe", "mcp add", ".claude'", "[mcp_servers.nexus-browser]"):
        assert forbidden not in script, forbidden
    assert "doublon-antigravity.ps1" in script
    assert "$json.mcpServers.'nexus-browser' = $entry" not in script  # plus d'entrée globale chez Antigravity
    assert "PYTHONDONTWRITEBYTECODE = '1'" in script and "@('-B', $server)" in script
    verify = (REPO_ROOT / "verify.ps1").read_text(encoding="utf-8")
    assert "com.nexusagy.bridge_auth" in verify and "ancienne-extension.ps1" in verify
    assert "doublon-antigravity.ps1" in verify and "AGY_FEATURES" in verify


def test_no_cache_folders_in_the_repository():
    """Caches tenus hors OneDrive par la configuration elle-même (ruff, pytest) et par les modules (bytecode)."""
    project = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'cache-dir = "~/.nexus/nexus-browser/cache/ruff"' in project
    assert 'addopts = "-p no:cacheprovider"' in project
    for module in (
        "client/mcp_server.py",
        "client/bridge_client.py",
        "client/browser_cli.py",
        "native-host/bridge_server.py",
    ):
        assert "sys.dont_write_bytecode = True" in (REPO_ROOT / module).read_text(encoding="utf-8"), module
    for name in (".ruff_cache", ".pytest_cache"):
        assert not (REPO_ROOT / name).exists(), name
    assert not list(REPO_ROOT.glob("client/__pycache__")) and not list(REPO_ROOT.glob("native-host/__pycache__"))
