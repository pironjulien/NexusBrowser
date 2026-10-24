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


@pytest.fixture(autouse=True)
def _fresh_image_memory():
    """Mémoire des images jointes (empreintes, échelle de la vue) vide pour chaque test."""
    mcp_server._SENT_PRINTS.clear()
    mcp_server._VIEW_SCALES.clear()
    yield
    mcp_server._SENT_PRINTS.clear()
    mcp_server._VIEW_SCALES.clear()


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
        mcp_server.browser_screenshot(tab_id=1, inline=True, force=True)
        if tool == "browser_screenshot"
        else (mcp_server.browser_vision_inspect(tab_id=1, inline=True, force=True))
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


def test_unchanged_view_is_not_attached_twice(monkeypatch):
    # Règle commune, point 3 : même onglet, même cible, écran inchangé -> texte seul « unchanged ».
    _bridge(monkeypatch, "dataUrl", _png(1600, 900), devicePixelRatio=1)
    first = mcp_server.browser_screenshot(tab_id=1, inline=True)
    again = mcp_server.browser_screenshot(tab_id=1, inline=True)
    assert any(isinstance(b, ImageContent) for b in first.content)
    assert not any(isinstance(b, ImageContent) for b in again.content)
    data = _json(again)["data"]
    assert data["image"]["unchanged"] is True and "force=True" in data["note"]
    forced = mcp_server.browser_screenshot(tab_id=1, inline=True, force=True)
    assert any(isinstance(b, ImageContent) for b in forced.content)
    other_tab = mcp_server.browser_screenshot(tab_id=2, inline=True)  # autre onglet : sa propre première image
    assert any(isinstance(b, ImageContent) for b in other_tab.content)
    _bridge(monkeypatch, "dataUrl", _png(1600, 900, noise=True), devicePixelRatio=1)  # l'écran a changé
    changed = mcp_server.browser_screenshot(tab_id=1, inline=True)
    assert any(isinstance(b, ImageContent) for b in changed.content)


def test_unchanged_is_per_session(monkeypatch):
    _bridge(monkeypatch, "dataUrl", _png(800, 600), devicePixelRatio=1)
    sessions = iter(["claude-aaa", "codex-bbb"])
    monkeypatch.setattr(mcp_server, "_session_key", lambda: current[0])
    current = [next(sessions)]
    assert any(isinstance(b, ImageContent) for b in mcp_server.browser_screenshot(tab_id=1, inline=True).content)
    current[0] = next(
        sessions
    )  # autre session du démon partagé : jamais « inchangée » pour une image qu'elle n'a pas vue
    assert any(isinstance(b, ImageContent) for b in mcp_server.browser_screenshot(tab_id=1, inline=True).content)


def test_region_zooms_in_pixels_of_the_last_view_image(monkeypatch):
    # Vue 2560 × 1440 px de capture à DPR 1,25 (2048 × 1152 CSS) envoyée en 1429 × 804 ; zone [100, 50, 300, 150]
    # de cette image = 200 × 100 px d'image = 358,4 × 179,2 px CSS, agrandie dans les plafonds (au plus ×4).
    calls = _bridge(monkeypatch, "dataUrl", _png(2560, 1440), devicePixelRatio=1.25)
    view = _json(mcp_server.browser_screenshot(tab_id=1, inline=True))["data"]["image"]
    factor = view["css_per_image_px"]
    clip = {"x": 100 * factor, "y": 50 * factor, "width": 200 * factor, "height": 100 * factor}
    zoomed_px = (round(clip["width"] * 1.25 * 3.5), round(clip["height"] * 1.25 * 3.5))
    calls.clear()
    zoom_calls = _bridge(monkeypatch, "dataUrl", _png(*zoomed_px), devicePixelRatio=1.25, clip={**clip, "scale": 3.5})
    result = mcp_server.browser_screenshot(tab_id=1, inline=True, region=[100, 50, 300, 150])
    data = _json(result)["data"]
    sent = zoom_calls[0][1]
    assert sent["region"] == pytest.approx(clip) and 1 < sent["scale"] <= 4 and "selector" not in sent
    image = data["image"]
    assert max(image["width"], image["height"]) <= 1568 and image["width"] * image["height"] <= 1_150_000
    assert image["css_origin"] == {"x": pytest.approx(clip["x"], abs=0.01), "y": pytest.approx(clip["y"], abs=0.01)}
    # Un pixel de la zone agrandie vaut bien moins qu'un pixel CSS (lecture d'un petit texte).
    assert image["css_per_image_px"] < factor / 2


def test_region_params_fit_the_limits_and_need_a_view(monkeypatch):
    with pytest.raises(ValueError, match="whole-view image of this tab first"):
        mcp_server._region_params(9, [0, 0, 10, 10], None, None, False)
    mcp_server._VIEW_SCALES[(mcp_server._session_key(), 9)] = {"css_per_image_px": 1.25, "dpr": 1.25}
    params = mcp_server._region_params(9, [100, 50, 300, 150], None, None, False)
    region, scale = params["region"], params["scale"]
    assert region == {"x": 125.0, "y": 62.5, "width": 250.0, "height": 125.0}
    out_w, out_h = region["width"] * 1.25 * scale, region["height"] * 1.25 * scale
    assert max(out_w, out_h) <= 1568.5 and out_w * out_h <= 1_150_000 * 1.001 and scale <= 4
    for bad in ([0, 0, 0, 10], [1, 2, 3], "x", [0, 0, True, 5]):
        with pytest.raises(ValueError):
            mcp_server._region_params(9, bad, None, None, False)
    with pytest.raises(ValueError, match="cannot be combined"):
        mcp_server._region_params(9, [0, 0, 10, 10], "#a", None, False)


def test_vision_markers_get_boxes_in_image_pixels(monkeypatch):
    markers = [{"mark": 1, "rect": {"x": 948, "y": 17, "width": 70, "height": 32}, "box_2d": [18, 463, 52, 497]}]
    _bridge(monkeypatch, "screenshotDataUrl", _png(2560, 1182), devicePixelRatio=1.25, markers=markers)
    data = _json(mcp_server.browser_vision_inspect(tab_id=1, inline=True))["data"]
    factor = data["image"]["css_per_image_px"]
    box = data["markers"][0]["image_box"]
    assert box == [round(948 / factor), round(17 / factor), round((948 + 70) / factor), round((17 + 32) / factor)]
    assert data["markers"][0]["box_2d"] == [18, 463, 52, 497]  # gardé pour Gemini


def test_small_change_on_a_large_view_is_never_unchanged():
    # Une case cochée (16 × 16 px) sur une vue de 1568 × 882 : l'image doit repartir, jamais « inchangée ».
    base = Image.new("RGB", (1568, 882), (255, 255, 255))
    checked = base.copy()
    checked.paste((20, 20, 20), (700, 400, 716, 416))

    def webp(image):
        out = io.BytesIO()
        image.save(out, "WEBP", lossless=True)
        return out.getvalue()

    assert vision_image.same_image(vision_image.fingerprint(webp(base)), vision_image.fingerprint(webp(base)))
    assert not vision_image.same_image(vision_image.fingerprint(webp(base)), vision_image.fingerprint(webp(checked)))


def test_resized_view_is_never_unchanged_and_region_uses_the_last_sent_image(monkeypatch):
    # Relevé par Codex le 24/10 : vue blanche 800×600 puis 1600×1200 (même empreinte) ; la 2e doit être jointe, et
    # region se lit dans ses pixels à elle.
    def blank(width, height):
        out = io.BytesIO()
        Image.new("RGB", (width, height), (255, 255, 255)).save(out, "PNG")
        return out.getvalue()

    _bridge(monkeypatch, "dataUrl", blank(800, 600), devicePixelRatio=1)
    first = mcp_server.browser_screenshot(tab_id=1, inline=True)
    _bridge(monkeypatch, "dataUrl", blank(1600, 1200), devicePixelRatio=1)
    second = mcp_server.browser_screenshot(tab_id=1, inline=True)
    assert any(isinstance(b, ImageContent) for b in first.content)
    assert any(isinstance(b, ImageContent) for b in second.content)  # géométrie changée : jamais « inchangée »
    factor = _json(second)["data"]["image"]["css_per_image_px"]
    params = mcp_server._region_params(1, [100, 100, 200, 200], None, None, False)
    assert params["region"]["x"] == pytest.approx(100 * factor) and factor > 1.2


def test_device_pixel_ratio_change_is_a_new_view(monkeypatch):
    # Relevé par Codex : 3200×1800 à DPR 2 puis 1600×900 à DPR 1 donnent la même image envoyée ; la 2e doit repartir et
    # region doit utiliser le DPR courant (zoom pleine résolution).
    def blank(width, height):
        out = io.BytesIO()
        Image.new("RGB", (width, height), (255, 255, 255)).save(out, "PNG")
        return out.getvalue()

    _bridge(monkeypatch, "dataUrl", blank(3200, 1800), devicePixelRatio=2)
    mcp_server.browser_screenshot(tab_id=1, inline=True)
    _bridge(monkeypatch, "dataUrl", blank(1600, 900), devicePixelRatio=1)
    second = mcp_server.browser_screenshot(tab_id=1, inline=True)
    assert any(isinstance(b, ImageContent) for b in second.content)
    params = mcp_server._region_params(1, [0, 0, 400, 40], None, None, False)
    assert params["region"]["width"] * 1 * params["scale"] == pytest.approx(1568, rel=0.01)
