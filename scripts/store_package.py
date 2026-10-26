"""Chrome Web Store package and listing images (store/README.md), built from the repository, nothing by hand.

- `dist/nexus-browser-extension-<version>.zip`: the `extension/` folder as Chrome loads it, with the manifest's
  `key` removed (the store signs the package with its own key and gives it its own ID; the `key` only fixes the ID of
  the unpacked extension).
- `--without-gmail-counter`: the same package without the optional Gmail unread counter (no checkbox in the popup,
  never read, `https://mail.google.com` out of the CSP), ready in case the Chrome Web Store objects to it
  (store/SINGLE_PURPOSE.md). Not the default: the default package keeps the counter, off until the user ticks it.
- `store/assets/`: screenshots 1280x800 and the small promo tile 440x280, from `docs/assets/` (PNG, no alpha).

Usage: python -B scripts/store_package.py [--without-gmail-counter] [--assets]
"""

from __future__ import annotations

import argparse
import json
import re
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
BACKGROUND = (16, 18, 28)  # dark backdrop of the site's NexusBrowser scenes


GMAIL_LABEL = re.compile(
    r'\n[ \t]*<label class="option">\s*<input type="checkbox" id="compteur-gmail">.*?</label>', re.S
)


def without_gmail_counter(name: str, text: str) -> str:
    """The extension's files in the variant without the Gmail counter (each change checked: nothing silent)."""
    if name == "popup.html":
        changed = GMAIL_LABEL.sub("", text)
    elif name == "background.js":
        changed = text.replace("const COMPTEUR_GMAIL_DISPONIBLE = true;", "const COMPTEUR_GMAIL_DISPONIBLE = false;")
    else:
        return text
    if changed == text:
        raise RuntimeError(f"{name}: the Gmail counter was not found, variant not built")
    return changed


def build_zip(gmail_counter: bool = True, out_dir: Path | None = None) -> Path:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    manifest.pop("key", None)
    suffix = "" if gmail_counter else "-without-gmail-counter"
    if not gmail_counter:
        policy = manifest["content_security_policy"]["extension_pages"]
        manifest["content_security_policy"]["extension_pages"] = policy.replace(" https://mail.google.com", "")
        if manifest["content_security_policy"]["extension_pages"] == policy:
            raise RuntimeError("manifest.json: https://mail.google.com not found in the CSP, variant not built")
    target = (out_dir or ROOT / "dist") / f"nexus-browser-extension-{manifest['version']}{suffix}.zip"
    target.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if path.is_file():
                name = path.relative_to(EXTENSION).as_posix()
                if name == "manifest.json":
                    archive.writestr(name, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
                elif not gmail_counter and name in ("popup.html", "background.js"):
                    archive.writestr(name, without_gmail_counter(name, path.read_text(encoding="utf-8")))
                else:
                    archive.write(path, name)
    return target


def build_assets() -> list[Path]:
    from PIL import Image  # only for the listing images

    out = ROOT / "store" / "assets"
    out.mkdir(parents=True, exist_ok=True)

    def fit(source: str, size: tuple[int, int], name: str) -> Path:
        image = Image.open(ROOT / "docs" / "assets" / source).convert("RGB")
        image.thumbnail(size, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", size, BACKGROUND)
        canvas.paste(image, ((size[0] - image.width) // 2, (size[1] - image.height) // 2))
        path = out / name
        canvas.save(path, optimize=True)
        return path

    return [
        fit("banner.webp", (1280, 800), "screenshot-1-banner.png"),
        fit("demo.webp", (1280, 800), "screenshot-2-demo.png"),
        fit("banner.webp", (440, 280), "promo-small-440x280.png"),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--assets", action="store_true", help="also rebuild store/assets/")
    parser.add_argument("--without-gmail-counter", action="store_true", help="variant without the Gmail counter")
    args = parser.parse_args()
    print(build_zip(gmail_counter=not args.without_gmail_counter))
    if args.assets:
        for path in build_assets():
            print(path)


if __name__ == "__main__":
    main()
