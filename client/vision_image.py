"""
Image envoyée à une IA (règle commune des produits Nexus) : côté long ≤ 1568 px et ≤ 1,15 Mpx (limite standard de
Claude, acceptée telle quelle par GPT-5.x et Gemini 3 : le modèle ne la réduit pas lui-même, les coordonnées lues sur
l'image restent exactes), WebP sans perte ; au-delà de 200 Ko, WebP qualité 85 ; jamais plus de 500 Ko (au-delà,
Antigravity répond 400 et la conversation casse). Le fichier écrit sur disque, lui, garde la pleine résolution.
"""

from __future__ import annotations

import io
import math
from typing import Any

from PIL import Image

MAX_SIDE = 1568
MAX_PIXELS = 1_150_000
LOSSLESS_MAX_BYTES = 200_000
MAX_BYTES = 500_000
LOSSY_QUALITY = 85
# Au-delà de 500 Ko en qualité 85 : qualités plus basses, puis réduction de la taille (×0,8 à chaque tour).
FALLBACK_QUALITIES = (70, 55, 40)
SHRINK = 0.8
# Image source décodée en mémoire : au-delà (un élément géant capturé en entier), refus clair avant tout décodage ;
# le fichier sur disque reste possible (aucun décodage côté serveur).
MAX_SOURCE_PIXELS = 40_000_000


def fitted_scale(width: int, height: int) -> float:
    """Facteur le plus grand, mêmes proportions, qui tient dans les deux limites (jamais d'agrandissement)."""
    return min(1.0, MAX_SIDE / max(width, height), math.sqrt(MAX_PIXELS / (width * height)))


def _scaled(width: int, height: int, scale: float) -> tuple[int, int]:
    return max(1, math.floor(width * scale)), max(1, math.floor(height * scale))


def _webp(image: Image.Image, quality: int | None) -> bytes:
    out = io.BytesIO()
    if quality is None:
        image.save(out, "WEBP", lossless=True, quality=100, method=4)
    else:
        image.save(out, "WEBP", quality=quality, method=4)
    return out.getvalue()


def for_model(data: bytes) -> tuple[bytes, dict[str, Any]]:
    """Image (PNG, JPEG...) -> WebP pour une IA, et ce qu'il faut pour relire ses coordonnées : taille envoyée,
    taille d'origine et scale, le facteur appliqué aux deux axes (pixel de l'image = pixel d'origine × scale, à moins
    d'un pixel près : les tailles sont arrondies vers le bas)."""
    with Image.open(io.BytesIO(data)) as source:
        if source.width * source.height > MAX_SOURCE_PIXELS:
            raise ValueError(
                f"Capture too large to attach ({source.width}x{source.height} px): write it to a file (inline=False)."
            )
        source.load()
        image = source.convert("RGBA" if "A" in source.getbands() else "RGB")
    source_width, source_height = image.size
    scale = fitted_scale(source_width, source_height)
    if scale < 1:
        image = image.resize(_scaled(source_width, source_height, scale), Image.Resampling.LANCZOS)
    encoded, encoding = _webp(image, None), "lossless"
    if len(encoded) > LOSSLESS_MAX_BYTES:
        encoded, encoding = _webp(image, LOSSY_QUALITY), f"quality {LOSSY_QUALITY}"
    for quality in FALLBACK_QUALITIES:
        if len(encoded) <= MAX_BYTES:
            break
        encoded, encoding = _webp(image, quality), f"quality {quality}"
    while len(encoded) > MAX_BYTES and min(image.size) > 1:
        scale *= SHRINK
        image = image.resize(_scaled(source_width, source_height, scale), Image.Resampling.LANCZOS)
        encoded = _webp(image, FALLBACK_QUALITIES[-1])
        encoding = f"quality {FALLBACK_QUALITIES[-1]}"
    info = {
        "format": "webp",
        "encoding": encoding,
        "bytes": len(encoded),
        "width": image.width,
        "height": image.height,
        "source_width": source_width,
        "source_height": source_height,
        "scale": round(scale, 6),
    }
    return encoded, info
