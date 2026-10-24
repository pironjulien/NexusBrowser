"""Image envoyée à une IA (règle commune des produits Nexus) : côté long ≤ 1568 px et ≤ 1,15 Mpx, WebP sans perte,
qualité 85 au-delà de 200 Ko, jamais plus de 500 Ko ; vrai bloc image MCP (pas un texte base64) ; échelle rendue pour
relire une position sur l'image en pixels CSS. Le fichier écrit sur disque garde la pleine résolution."""

import asyncio
import base64
import io
import json
import random
import sys
from pathlib import Path

import pytest
from mcp.types import ImageContent, TextContent
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "client"))

from client import mcp_server, vision_image  # noqa: E402


def _png(width: int, height: int, noise: bool = False) -> bytes:
    image = Image.new("RGB", (width, height), (240, 240, 240))
    if noise:  # photo-like : incompressible, pour éprouver les plafonds de taille
        rng = random.Random(7)
        image.putdata([(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(width * height)])
    else:
        for x in range(0, width, 40):  # page-like : texte simulé, très compressible
            for y in range(0, height, 18):
                image.paste((30, 30, 30), (x, y, min(width, x + 24), min(height, y + 3)))
    out = io.BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def _decoded(data: bytes) -> Image.Image:
    image = Image.open(io.BytesIO(data))
    image.load()
    return image


@pytest.mark.parametrize(
    ("width", "height"),
    [(2560, 1440), (1920, 1080), (1568, 400), (3000, 600), (800, 4000), (1000, 1000), (600, 400)],
)
def test_size_limits(width, height):
    webp, info = vision_image.for_model(_png(width, height))
    sent = _decoded(webp)
    assert sent.format == "WEBP" and sent.size == (info["width"], info["height"])
    assert max(sent.size) <= 1568 and sent.width * sent.height <= 1_150_000
    assert (info["source_width"], info["source_height"]) == (width, height)
    # Même facteur sur les deux axes, à moins d'un pixel près (tailles arrondies vers le bas).
    assert abs(sent.width - width * info["scale"]) < 1.01
    assert abs(sent.height - height * info["scale"]) < 1.01
    if width <= 1568 and height <= 1568 and width * height <= 1_150_000:
        assert sent.size == (width, height) and info["scale"] == 1  # jamais agrandie ni réduite sans raison


def test_lossless_then_quality_85_then_hard_cap():
    page, page_info = vision_image.for_model(_png(1920, 1080))
    assert page_info["encoding"] == "lossless" and len(page) <= 200_000
    photo, photo_info = vision_image.for_model(_png(1400, 800, noise=True))
    assert photo_info["encoding"] != "lossless" and len(photo) <= 500_000
    assert photo_info["bytes"] == len(photo)


def test_lossless_is_pixel_exact_below_200_kb():
    source = _png(900, 500)
    webp, info = vision_image.for_model(source)
    assert info["encoding"] == "lossless"
    assert _decoded(webp).convert("RGB").tobytes() == _decoded(source).convert("RGB").tobytes()


def _bridge(monkeypatch, key, png, **extra):
    calls = []

    def call(action, params, timeout=20.0):
        calls.append((action, params))
        return {key: "data:image/png;base64," + base64.b64encode(png).decode(), "mimeType": "image/png", **extra}

    monkeypatch.setattr(mcp_server, "call_bridge", call)
    return calls


def _json(result):
    """Toute réponse des outils de capture porte structured_content={"result": texte} (anciens clients)."""
    return json.loads(result.structured_content["result"])


def _call(tool, arguments):
    return asyncio.run(mcp_server.browser_mcp.call_tool(tool, arguments))


def _blocks(result):
    blocks = result[0] if isinstance(result, tuple) else result
    return list(getattr(blocks, "content", blocks))


@pytest.mark.parametrize(
    ("tool", "key"), [("browser_screenshot", "dataUrl"), ("browser_vision_inspect", "screenshotDataUrl")]
)
def test_inline_capture_is_an_mcp_webp_image_with_scale(monkeypatch, tmp_path, tool, key):
    monkeypatch.setattr(mcp_server, "_screenshot_dir", lambda: tmp_path)
    calls = _bridge(monkeypatch, key, _png(2560, 1440), devicePixelRatio=2.0, markers=[])
    blocks = _blocks(_call(tool, {"tab_id": 1, "inline": True}))
    texts = [b for b in blocks if isinstance(b, TextContent)]
    images = [b for b in blocks if isinstance(b, ImageContent)]
    assert len(texts) == 1 and len(images) == 1
    assert images[0].mime_type == "image/webp"
    sent = _decoded(base64.b64decode(images[0].data))
    data = json.loads(texts[0].text)["data"]
    assert key not in data and "base64" not in texts[0].text  # plus jamais l'image en texte
    assert data["image"]["width"] == sent.width == 1429 and max(sent.size) <= 1568
    # 2560 px de capture = 1280 px CSS (DPR 2) ; facteur nominal, le même sur X et Y : ≈ 1280 / 1429 px CSS par
    # pixel d'image, à moins d'un pixel d'image près sur toute la largeur.
    assert data["image"]["css_per_image_px"] == pytest.approx(1 / (2 * data["image"]["scale"]), rel=1e-5)
    assert abs(1429 * data["image"]["css_per_image_px"] - 1280) < data["image"]["css_per_image_px"]
    assert data["image"]["css_origin"] == {"x": 0, "y": 0}
    assert list(tmp_path.iterdir()) == []  # rien sur disque
    # Sessions ouvertes avant la 2.21 (ancien schéma {"result": texte} en cache) : la réponse leur reste valide.
    result = (
        mcp_server.browser_screenshot(tab_id=1, inline=True)
        if tool == "browser_screenshot"
        else (mcp_server.browser_vision_inspect(tab_id=1, inline=True))
    )
    assert result.structured_content == {"result": texts[0].text}
    assert "output" not in calls[0][1]


def test_inline_element_capture_maps_through_its_clip(monkeypatch):
    clip = {"x": 100, "y": 2000, "width": 900, "height": 300, "scale": 1}
    _bridge(monkeypatch, "dataUrl", _png(1800, 600), clip=clip)
    blocks = _blocks(_call("browser_screenshot", {"tab_id": 1, "selector": "#card", "inline": True}))
    image = json.loads(next(b for b in blocks if isinstance(b, TextContent)).text)["data"]["image"]
    assert image["width"] == 1568
    assert image["css_per_image_px"] == pytest.approx(900 / 1568, rel=1e-4)
    assert image["css_origin"] == {"x": 100, "y": 2000}


def test_file_on_disk_keeps_full_resolution_png(monkeypatch, tmp_path):
    source = _png(2560, 1440)
    _bridge(monkeypatch, "dataUrl", source)
    out = tmp_path / "shot.png"
    result = _json(mcp_server.browser_screenshot(tab_id=1, output_path=str(out)))
    assert result["status"] == "success" and out.read_bytes() == source


def test_inline_capture_error_stays_a_clean_json_error(monkeypatch):
    monkeypatch.setattr(
        mcp_server, "call_bridge", lambda action, params, timeout=20.0: {"dataUrl": "data:image/png;base64,!!"}
    )
    result = _json(mcp_server.browser_screenshot(tab_id=1, inline=True))
    assert result["status"] == "error"


def test_giant_capture_is_refused_cleanly(monkeypatch):
    # Élément géant capturé en entier (8000 × 6000 px) : refus clair, rien n'est décodé, l'outil ne plante pas.
    out = io.BytesIO()
    Image.new("1", (8000, 6000)).save(out, "PNG")
    with pytest.raises(ValueError, match="too large to attach"):
        vision_image.for_model(out.getvalue())
    _bridge(monkeypatch, "dataUrl", out.getvalue(), clip={"x": 0, "y": 0, "width": 8000, "height": 6000})
    result = _json(mcp_server.browser_screenshot(tab_id=1, selector="#giant", inline=True))
    assert result["status"] == "error" and "too large to attach" in result["error"]


def test_every_answer_of_the_capture_tools_keeps_the_old_result_schema(monkeypatch, tmp_path):
    # Relevé par Codex le 24/10 : une session ouverte avant la 2.21 a l'ancien schéma {"result": texte} en cache et
    # rejette toute réponse sans structured_content (fichier, refus, erreur), pas seulement l'image jointe.
    _bridge(monkeypatch, "dataUrl", _png(300, 200), markers=[])
    answers = [
        mcp_server.browser_screenshot(tab_id=1, output_path=str(tmp_path / "a.png")),
        mcp_server.browser_screenshot(tab_id=1, inline=True),
        mcp_server.browser_screenshot(tab_id=1, full_page=True, inline=True),  # refus
        mcp_server.browser_screenshot(tab_id=0, inline=True),  # onglet invalide
        mcp_server.browser_vision_inspect(tab_id=1, output_path=str(tmp_path / "b.png")),
        mcp_server.browser_vision_inspect(tab_id=1, inline=True),
    ]
    for answer in answers:
        assert set(answer.structured_content) == {"result"} and isinstance(answer.structured_content["result"], str)
        assert answer.content[0].text == answer.structured_content["result"]
        json.loads(answer.structured_content["result"])


def test_clip_with_page_zoom_maps_back_to_page_css_pixels(monkeypatch):
    # Chrome à 90 % : zone CSS (40, 1520, 200×100) -> clip CDP (36, 1368, 180×90) ; capture de 225 px de large.
    clip = {"x": 36, "y": 1368, "width": 180, "height": 90, "scale": 1}
    _bridge(monkeypatch, "dataUrl", _png(225, 113), clip=clip, zoom=0.9)
    image = _json(mcp_server.browser_screenshot(tab_id=1, selector="#zone", inline=True))["data"]["image"]
    assert image["css_origin"] == {"x": 40, "y": 1520}
    assert image["css_per_image_px"] == pytest.approx(200 / 225, rel=1e-5)
    assert 40 + 112.5 * image["css_per_image_px"] == pytest.approx(140, abs=0.5)  # centre X de la zone


def test_tall_narrow_capture_keeps_both_axes_right(monkeypatch):
    # Relevé par Codex : 20 × 12000 px réduits à 2 × 1567 ; le facteur doit valoir pour Y, pas la largeur arrondie.
    _bridge(monkeypatch, "dataUrl", _png(20, 12000), devicePixelRatio=1)
    image = _json(mcp_server.browser_screenshot(tab_id=1, inline=True))["data"]["image"]
    middle_y = image["height"] / 2 * image["css_per_image_px"]
    assert middle_y == pytest.approx(6000, abs=image["css_per_image_px"])  # à moins d'un pixel d'image près


def test_narrow_zone_uses_the_device_pixel_ratio_not_its_rounded_width(monkeypatch):
    # Relevé par Codex dans Chrome : #needle 2 × 12000 px CSS à DPR 1,25 -> capture 3 × 15000 (2,5 arrondi à 3).
    clip = {"x": 100, "y": 20, "width": 2, "height": 12000, "scale": 1}
    _bridge(monkeypatch, "dataUrl", _png(3, 15000), clip=clip, zoom=1, devicePixelRatio=1.25)
    image = _json(mcp_server.browser_screenshot(tab_id=1, selector="#needle", inline=True))["data"]["image"]
    middle_y = image["css_origin"]["y"] + image["height"] / 2 * image["css_per_image_px"]
    assert middle_y == pytest.approx(6020, abs=image["css_per_image_px"])


def test_dialog_during_capture_is_reported_never_accepted(monkeypatch):
    interruption = {
        "dialogOpened": True,
        "dialog": {"type": "alert", "message": "pause"},
        "message": "The command opened a dialog.",
    }
    monkeypatch.setattr(mcp_server, "call_bridge", lambda action, params, timeout=20.0: interruption)
    for inline in (True, False):  # image jointe ou fichier : même réponse claire, rien d'écrit
        result = _json(
            mcp_server.browser_screenshot(tab_id=1, selector="#card", inline=inline, output_path="unused.png")
        )
        assert result["status"] == "error" and result["dialogOpened"] is True, inline
        assert result["error"] == "The command opened a dialog." and result["data"]["dialog"]["message"] == "pause"
    assert not Path("unused.png").exists()
