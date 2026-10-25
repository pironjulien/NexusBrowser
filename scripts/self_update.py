"""Lance scripts/self-update.ps1 sans fenêtre : action de la tâche « Nexus Browser Update » (pythonw.exe)."""

import subprocess
import sys
from pathlib import Path

script = Path(__file__).with_name("self-update.ps1")
command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)]
sys.exit(subprocess.run(command, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).returncode)
