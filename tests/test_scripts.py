"""Scripts d'installation et de contrôle (revue C9 et A1) éprouvés sur des configurations FACTICES : doublon
nexus-browser chez Antigravity, ancienne extension dans un profil Chrome (lu seulement),
résidus de l'ancien pont. Aucun vrai fichier de Julien n'est lu ni écrit."""

import json
import re
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
        "blcgddmjdkobmgakjffjpgiicjlflgjf": {"manifest": {"name": "NexusBrowser"}},
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


INSTALL_SCRIPTS = [
    "get.ps1",
    "install.ps1",
    "scripts/guide-extension.ps1",
    "scripts/installer-hote-natif.ps1",
    "scripts/pair-extension.ps1",
    "scripts/registre-reel.ps1",
    "scripts/runtime.ps1",
]


@pytest.mark.parametrize("script", INSTALL_SCRIPTS)
def test_install_scripts_read_by_windows_powershell_5(script):
    """L'installation publique tourne sous Windows PowerShell 5.1 (seul présent sur un Windows neuf) : il lit un .ps1
    sans BOM en page de code ANSI, où un caractère UTF-8 peut devenir un guillemet. Le dépôt n'a pas de BOM
    (test_no_utf8_bom_in_sources) : donc ASCII seul ; et le script s'analyse sans erreur sous 5.1."""
    assert (REPO_ROOT / script).read_bytes().isascii(), script
    shell = shutil.which("powershell")
    if shell is None:
        pytest.skip("Windows PowerShell 5.1 absent")
    command = (
        "$t = $null; $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile("
        f"'{REPO_ROOT / script}', [ref]$t, [ref]$e); $e.Count"
    )
    parsed = subprocess.run(
        [shell, "-NoProfile", "-Command", command],
        capture_output=True,
        text=True,
        timeout=60,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )
    assert parsed.stdout.strip() == "0", parsed.stdout + parsed.stderr


def test_get_reads_the_latest_tag_without_the_github_api(tmp_path):
    """get.ps1 lit la dernière version par la redirection de github.com/.../releases/latest (en-tête Location) : l'API
    GitHub sans jeton plafonne à 60 requêtes par heure et par IP (« API rate limit exceeded » sur une IP partagée ou en
    CI). L'API ne reste qu'en secours. Éprouvé pour de vrai sous Windows PowerShell 5.1 et PowerShell 7."""
    text = (REPO_ROOT / "get.ps1").read_text(encoding="ascii")
    api_lines = [line for line in text.splitlines() if "api.github.com" in line]
    assert len(api_lines) == 1 and "Invoke-RestMethod" in api_lines[0], api_lines  # le seul appel : le secours
    assert "$tag = Get-LatestTag" in text and "release.tag_name" not in text
    # Lancé par -File depuis un fichier : jamais de téléchargement passé en ligne de commande (-Command), que
    # l'antivirus peut prendre pour un chargeur.
    probe = tmp_path / "latest.ps1"
    probe.write_text(
        "$t = $null; $e = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile("
        f"'{REPO_ROOT / 'get.ps1'}', [ref]$t, [ref]$e)\n"
        "$f = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] "
        "-and $n.Name -eq 'Get-LatestTag' }, $true)[0]\n"
        ". ([scriptblock]::Create($f.Extent.Text))\n"
        "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor "
        "[Net.SecurityProtocolType]::Tls12\n"
        "Get-LatestTag 3>&1\n",
        encoding="ascii",
    )
    for shell in filter(None, (shutil.which("powershell"), PWSH)):
        run = subprocess.run(
            [shell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(probe)],
            capture_output=True,
            text=True,
            timeout=60,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        if run.returncode and "github.com" not in run.stdout + run.stderr:
            pytest.skip("github.com injoignable")
        lines = run.stdout.strip().splitlines()
        assert run.returncode == 0 and len(lines) == 1, (
            shell,
            run.stdout,
            run.stderr,
        )  # aucun avertissement de secours
        assert re.fullmatch(r"v\d+\.\d+\.\d+", lines[0]), (shell, lines)
