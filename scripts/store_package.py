"""Chrome Web Store package and listing images (store/README.md), built from the repository, nothing by hand.

- `dist/nexus-browser-extension-<version>.zip`: the `extension/` folder as Chrome loads it, with the manifest's
  `key` removed (the store signs the package with its own key and gives it its own ID; the `key` only fixes the ID of
  the unpacked extension).
- `store/assets/`: screenshots 1280x800 and the small promo tile 440x280, from `docs/assets/` (PNG, no alpha).

Usage: python -B scripts/store_package.py [--assets]
"""

from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
BACKGROUND = (16, 18, 28)  # dark backdrop of the site's NexusBrowser scenes


def build_zip() -> Path:
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    manifest.pop("key", None)
    target = ROOT / "dist" / f"nexus-browser-extension-{manifest['version']}.zip"
    target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(EXTENSION.rglob("*")):
            if path.is_file():
                name = path.relative_to(EXTENSION).as_posix()
                if name == "manifest.json":
                    archive.writestr(name, json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
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
    args = parser.parse_args()
    print(build_zip())
    if args.assets:
        for path in build_assets():
            print(path)


if __name__ == "__main__":
    main()
