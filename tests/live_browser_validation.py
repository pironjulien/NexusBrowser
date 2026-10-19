#!/usr/bin/env python3
r"""
Nexus Browser Bridge - Live Browser Validation Suite
Tests the browser automation capabilities against Julien's real Google Chrome (extension connected, bridge running).
Lancé par test.ps1 -Full seulement (--mouse puis --full-live), jamais par le contrôle hors ligne.

Lancement (depuis la racine du dépôt, runtime local hors OneDrive) :

    pwsh -NoProfile -File test.ps1 -Full
    pwsh -NoProfile -Command ". .\scripts\runtime.ps1; & $pythonExe tests\live_browser_validation.py --full-live"

Avant toute action : pont et extension connectés et à la version du dépôt, sinon échec clair (Chrome n'est jamais
lancé par ce script).

Options :
    (aucune)  suite historique des 31 capacités (elle met son onglet au premier plan avec browser_select_tab) ;
    --mouse   seulement les vraies actions de souris CDP, dans un NOUVEL onglet d'agent laissé en arrière-plan :
              bouton qui n'accepte que les clics isTrusted, bouton dans une iframe same-origin, élément couvert par
              une surcouche, menu au survol (CSS :hover), zone de glisser-déposer qui compte les dépôts, confirm(),
              double clic et clic droit. Aucun autre onglet n'est touché ; l'onglet de test est fermé à la fin ;
    --full-live  localisateurs par rôle et libellé (homonymes, nth, testId, label, placeholder), frappe de confiance
              (champ qui n'accepte que isTrusted, ajout touche par touche, contenteditable), case et <select>, deux
              iframes d'une autre origine (localhost : hors processus ; 127.0.0.1 sur un autre port : même
              processus), requête fetch dans le journal réseau (secrets masqués, corps lu), téléchargement attendu
              puis supprimé, export du contenu principal d'une page d'article avec bruit (menus, publicité,
              bandeau cookies, barre latérale, formulaire). Même discipline d'onglet que --mouse ;
    --exports-live  (jamais lancé par test.ps1 -Full) export d'un Google Docs/Sheets/Slides (AGY_TEST_GDOC_URL) et
              transcription d'une vidéo YouTube (AGY_TEST_YOUTUBE_URL), chacun dans un onglet d'agent en
              arrière-plan fermé à la fin ; sans ces variables, chaque vérification est sautée (jamais comptée
              réussie) ;
    --all     suite historique, --mouse puis --full-live ;
    --serve-fixture  sert seulement la page de --full-live (vérification à la main).
"""

from __future__ import annotations

import argparse
import http.server
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

# Aucun __pycache__ dans OneDrive, même lancé sans scripts\runtime.ps1.
sys.dont_write_bytecode = True

# Add project root to path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "client"))
sys.path.insert(0, str(ROOT / "native-host"))

import bridge_client  # noqa: E402
import mcp_server as mcp  # noqa: E402

HTML_TEST_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>NexusBrowser Live Test Fixture</title>
    <style>
        body { font-family: sans-serif; margin: 20px; line-height: 1.5; }
        .section { margin-bottom: 24px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; }
        #hover-target { display: none; background: #e0f2fe; padding: 8px; margin-top: 8px; border-radius: 4px; }
        #drag-source { width: 120px; height: 40px; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center; cursor: grab; border-radius: 4px; }
        #drag-target { width: 140px; height: 60px; border: 2px dashed #9ca3af; display: flex; align-items: center; justify-content: center; margin-top: 10px; border-radius: 4px; }
        .spacer { height: 2200px; background: linear-gradient(white, #f3f4f6); }
    </style>
</head>
<body>
    <h1>NexusBrowser Live Test Suite</h1>

    <div class="section" id="form-section">
        <h2>Formulaire & Entrées</h2>
        <p>
            <label for="username">Nom d'utilisateur</label><br>
            <input id="username" type="text" placeholder="Entrez votre nom">
        </p>
        <p>
            <label for="email">Adresse Email</label><br>
            <input id="email" type="email" placeholder="Entrez votre email">
        </p>
        <p>
            <label for="comments">Remarques & Notes</label><br>
            <textarea id="comments" placeholder="Laissez vos remarques"></textarea>
        </p>
        <p>
            <label for="plan-select">Formule d'abonnement</label><br>
            <select id="plan-select">
                <option value="free">Offre Découverte</option>
                <option value="pro">Offre Pro</option>
                <option value="enterprise">Offre Entreprise</option>
            </select>
        </p>
        <p>
            <label for="file-upload">Téléversement</label><br>
            <input id="file-upload" type="file">
            <span id="file-result"></span>
        </p>
        <p>
            <label for="key-input">Test Clavier</label><br>
            <input id="key-input" type="text" placeholder="Appuyez sur une touche">
            <span id="key-result"></span>
        </p>
        <p>
            <button id="normal-btn" onclick="document.getElementById('btn-result').textContent = 'Normal Clicked!'">Bouton Normal</button>
            <button id="semantic-btn" aria-label="Valider la commande" onclick="document.getElementById('btn-result').textContent = 'Order Validated!'">Valider la commande</button>
            <span id="btn-result"></span>
        </p>
    </div>

    <div class="section" id="hover-section">
        <h2>Hover & Info-bulles</h2>
        <button id="hover-btn">Survolez pour révéler</button>
        <div id="hover-target">Menu révéle avec succès !</div>
    </div>

    <div class="section" id="shadow-section">
        <h2>Web Component & Shadow DOM</h2>
        <custom-card id="custom-card-el"></custom-card>
    </div>

    <div class="section" id="dnd-section">
        <h2>Drag and Drop</h2>
        <div id="drag-source" draggable="true">Élément mobile</div>
        <div id="drag-target">Zone de dépôt</div>
    </div>

    <div class="spacer">
        <p>Zone de défilement (2200px)...</p>
    </div>
    <div id="bottom-marker" style="padding: 20px; background: #dcfce7;">Pied de page atteint !</div>

    <script>
        // Hover handling
        const hoverBtn = document.getElementById('hover-btn');
        const hoverTarget = document.getElementById('hover-target');
        hoverBtn.addEventListener('mouseenter', () => { hoverTarget.style.display = 'block'; });
        hoverBtn.addEventListener('mouseleave', () => { hoverTarget.style.display = 'none'; });

        // Key handling
        const keyInput = document.getElementById('key-input');
        const keyResult = document.getElementById('key-result');
        keyInput.addEventListener('keydown', (e) => {
            keyResult.textContent = 'Key: ' + e.key;
        });

        // File handling
        const fileInput = document.getElementById('file-upload');
        const fileResult = document.getElementById('file-result');
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                fileResult.textContent = 'Uploaded: ' + fileInput.files[0].name;
            }
        });

        // Drag & Drop handling
        const dragSource = document.getElementById('drag-source');
        const dragTarget = document.getElementById('drag-target');
        dragSource.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', 'dragged-data');
        });
        dragTarget.addEventListener('dragover', (e) => {
            e.preventDefault();
        });
        dragTarget.addEventListener('drop', (e) => {
            e.preventDefault();
            dragTarget.textContent = 'Dropped!';
            dragTarget.style.background = '#86efac';
        });

        // Custom Component with Shadow Root
        class CustomCard extends HTMLElement {
            constructor() {
                super();
                const shadow = this.attachShadow({ mode: 'open' });
                shadow.innerHTML = `
                    <style>
                        .card { padding: 10px; background: #fdf2f8; border: 1px solid #f472b6; border-radius: 4px; }
                        #shadow-result { color: #be185d; font-weight: bold; margin-top: 6px; }
                    </style>
                    <div class="card">
                        <h3>Composant Shadow DOM Encapsulé</h3>
                        <input id="shadow-input" type="text" placeholder="Entrée Shadow">
                        <button id="shadow-button">Action Shadow</button>
                        <div id="shadow-result">Initial</div>
                    </div>
                `;
                const btn = shadow.getElementById('shadow-button');
                btn.addEventListener('click', () => {
                    shadow.getElementById('shadow-result').textContent = 'Shadow Button Clicked!';
                });
            }
        }
        customElements.define('custom-card', CustomCard);

        // Console log test
        console.log('[NexusLiveTest] Page test initialisée avec succès.');
    </script>
</body>
</html>
"""


# Page des vraies actions de souris : chaque gestionnaire ne compte que les événements isTrusted.
MOUSE_TEST_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>NexusBrowser Souris Réelle</title>
    <style>
        body { font-family: sans-serif; margin: 20px; }
        .section { margin-bottom: 24px; padding: 12px; border: 1px solid #ccc; border-radius: 6px; position: relative; }
        .menu-wrap { display: inline-block; position: relative; }
        .menu { display: none; position: absolute; top: 100%; left: 0; background: #e0f2fe; padding: 8px; }
        .menu-wrap:hover .menu { display: block; }
        #covered-box { position: relative; width: 220px; height: 60px; }
        #covered-btn { width: 200px; height: 40px; }
        #overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.3); z-index: 10; }
        #dnd-src { width: 120px; height: 40px; background: #3b82f6; color: white; }
        #dnd-zone { width: 160px; height: 70px; border: 2px dashed #9ca3af; margin-top: 10px; }
        .spacer { height: 1600px; }
        #frame { width: 360px; height: 140px; border: 6px solid #f472b6; padding: 4px; }
    </style>
</head>
<body>
    <h1>Souris réelle NexusBrowser</h1>
    <div class="section">
        <button id="trusted-only">Clic de confiance seulement</button>
        <span id="trusted-result">aucun</span>
        <button id="dbl">Double clic</button>
        <button id="ctx">Clic droit</button>
        <button id="confirm-btn">Confirmer</button>
        <span id="confirm-result">en attente</span>
    </div>
    <div class="section">
        <div class="menu-wrap" id="menu-wrap">
            <button id="menu-trigger">Menu</button>
            <div class="menu" id="menu"><button id="menu-item">Élément du menu</button></div>
        </div>
    </div>
    <div class="section">
        <div id="covered-box">
            <button id="covered-btn">Bouton couvert</button>
            <div id="overlay"></div>
        </div>
    </div>
    <div class="section">
        <div id="dnd-src" draggable="true">Glisser moi</div>
        <div id="dnd-zone">Déposer ici</div>
    </div>
    <div class="spacer"></div>
    <iframe id="frame" srcdoc="<button id='frame-btn' style='margin: 30px 0 0 60px'>Dans le cadre</button>
        <script>document.getElementById('frame-btn').addEventListener('click', e => {
            if (e.isTrusted) parent.__agyLive.frame++; });</script>"></iframe>
    <script>
        window.__agyLive = { trusted: 0, untrusted: 0, dbl: 0, ctx: 0, covered: 0, overlay: 0, menuItem: 0,
            drops: 0, frame: 0, mouseenter: 0 };
        const L = window.__agyLive;
        document.getElementById('trusted-only').addEventListener('click', e => {
            if (e.isTrusted) { L.trusted++; document.getElementById('trusted-result').textContent = 'confiance'; }
            else L.untrusted++;
        });
        document.getElementById('dbl').addEventListener('dblclick', e => { if (e.isTrusted) L.dbl++; });
        document.getElementById('ctx').addEventListener('contextmenu', e => { e.preventDefault(); if (e.isTrusted) L.ctx++; });
        document.getElementById('confirm-btn').addEventListener('click', () => {
            const ok = confirm('Valider le test NexusBrowser ?');
            document.getElementById('confirm-result').textContent = ok ? 'accepte' : 'annule';
        });
        document.getElementById('menu-trigger').addEventListener('mouseenter', e => { if (e.isTrusted) L.mouseenter++; });
        document.getElementById('menu-item').addEventListener('click', e => { if (e.isTrusted) L.menuItem++; });
        document.getElementById('covered-btn').addEventListener('click', () => { L.covered++; });
        document.getElementById('overlay').addEventListener('click', () => { L.overlay++; });
        const zone = document.getElementById('dnd-zone');
        document.getElementById('dnd-src').addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'x'));
        zone.addEventListener('dragover', e => e.preventDefault());
        zone.addEventListener('drop', e => { e.preventDefault(); if (e.isTrusted) L.drops++; else L.syntheticDrops = (L.syntheticDrops || 0) + 1; });
    </script>
</body>
</html>
"""


class TestFixtureHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        page = MOUSE_TEST_PAGE if self.path.startswith("/mouse") else HTML_TEST_PAGE
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Set-Cookie", "live_test_cookie=nexus_verified_sota; Path=/; SameSite=Lax")
        self.end_headers()
        self.wfile.write(page.encode("utf-8"))

    def log_message(self, format, *args):
        # Silence HTTP server logging during test
        pass


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def parse_response(raw_json_or_dict: str | dict) -> dict:
    if isinstance(raw_json_or_dict, dict):
        return raw_json_or_dict
    return json.loads(raw_json_or_dict)


def get_eval_val(eval_res: str | dict):
    parsed = parse_response(eval_res)
    d = parsed.get("data")
    if isinstance(d, dict) and "result" in d:
        return d["result"]
    return d


def run_live_validation():
    port = get_free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), TestFixtureHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()

    test_url = f"http://127.0.0.1:{port}/test.html"
    print(f"[*] Serveur de test démarré sur {test_url}")

    results: dict[str, bool] = {}
    test_tab_id: int | None = None
    initial_tabs = []

    try:
        # Pre-check initial tabs
        initial_tabs_resp = parse_response(mcp.browser_list_tabs())
        initial_tabs = initial_tabs_resp.get("data", initial_tabs_resp)
        if isinstance(initial_tabs, str):
            initial_tabs = json.loads(initial_tabs)
        print(f"[*] Onglets initiaux préservés : {len(initial_tabs)} onglet(s)")

        # 1. browser_new_tab
        print("\n--- [1/31] Test: browser_new_tab ---")
        new_tab_res = parse_response(mcp.browser_new_tab(test_url))
        new_tab_data = new_tab_res.get("data", new_tab_res)
        test_tab_id = new_tab_data.get("id") or new_tab_data.get("tabId")
        assert test_tab_id, f"Failed to get new tab ID: {new_tab_res}"
        print(f"[OK] Nouvel onglet créé avec ID: {test_tab_id}")
        results["browser_new_tab"] = True

        # Wait load
        print("\n--- [2/31] Test: browser_wait_load ---")
        wload_res = parse_response(mcp.browser_wait_load(timeout_ms=10000, tab_id=test_tab_id))
        assert wload_res.get("status") == "success" or "complete" in str(wload_res), f"wait_load failed: {wload_res}"
        print("[OK] browser_wait_load validé.")
        results["browser_wait_load"] = True

        # 3. browser_list_tabs
        print("\n--- [3/31] Test: browser_list_tabs ---")
        list_res = parse_response(mcp.browser_list_tabs())
        tabs = list_res.get("data", list_res)
        if isinstance(tabs, str):
            tabs = json.loads(tabs)
        tab_ids = [t["id"] for t in tabs]
        assert test_tab_id in tab_ids, f"Test tab {test_tab_id} not in tab list: {tab_ids}"
        print(f"[OK] browser_list_tabs a retourné {len(tabs)} onglets incluant le nouvel onglet.")
        results["browser_list_tabs"] = True

        # 4. browser_active_tab & browser_select_tab
        print("\n--- [4/31] Test: browser_select_tab & browser_active_tab ---")
        mcp.browser_select_tab(test_tab_id)
        active_res = parse_response(mcp.browser_active_tab())
        active_data = active_res.get("data", active_res)
        assert active_data.get("id") == test_tab_id, f"Active tab mismatch: {active_data}"
        print(f"[OK] browser_select_tab / browser_active_tab validés (Actif: {test_tab_id}).")
        results["browser_select_tab"] = True
        results["browser_active_tab"] = True

        # 5. browser_wait_network_idle
        print("\n--- [5/31] Test: browser_wait_network_idle ---")
        nwid_res = parse_response(mcp.browser_wait_network_idle(idle_ms=200, timeout_ms=5000, tab_id=test_tab_id))
        assert nwid_res.get("status") == "success" or "idle" in str(nwid_res).lower()
        print("[OK] browser_wait_network_idle validé.")
        results["browser_wait_network_idle"] = True

        # 6. browser_content (text, interactive, html)
        print("\n--- [6/31] Test: browser_content ---")
        txt_res = parse_response(mcp.browser_content(mode="text", tab_id=test_tab_id))
        txt_data = txt_res.get("data")
        txt_content = txt_data if isinstance(txt_data, str) else str(txt_res)
        assert "NexusBrowser Live Test" in txt_content, f"Content text missing header: {txt_content[:200]}"

        inter_res = parse_response(mcp.browser_content(mode="interactive", tab_id=test_tab_id))
        inter_data = str(inter_res.get("data", inter_res))
        assert "username" in inter_data or "button" in inter_data

        html_res = parse_response(mcp.browser_content(mode="html", tab_id=test_tab_id))
        html_content = html_res.get("data")
        html_data = html_content if isinstance(html_content, str) else str(html_res)
        assert "<html" in html_data.lower()
        print("[OK] browser_content (text, interactive, html) validé.")
        results["browser_content"] = True

        # 7. browser_axtree
        print("\n--- [7/31] Test: browser_axtree ---")
        ax_res = parse_response(mcp.browser_axtree(tab_id=test_tab_id))
        ax_nodes = ax_res.get("data", {}).get("nodes", ax_res.get("data", []))
        assert len(ax_nodes) > 0, f"AXTree empty: {ax_res}"
        print(f"[OK] browser_axtree extrait {len(ax_nodes)} nœuds d'accessibilité.")
        results["browser_axtree"] = True

        # 8. browser_interactive_map
        print("\n--- [8/31] Test: browser_interactive_map ---")
        imap_res = parse_response(mcp.browser_interactive_map(viewport_only=True, max_elements=50, tab_id=test_tab_id))
        imap_data = imap_res.get("data", imap_res)
        elements = imap_data.get("elements", [])
        assert len(elements) > 0, f"Interactive map returned 0 elements: {imap_res}"
        # Check that numeric mark and box_2d are present
        has_mark = any(el.get("mark") for el in elements)
        has_box = any(el.get("box_2d") for el in elements)
        assert has_mark and has_box, f"Interactive map missing marks or box_2d: {elements[0]}"
        print(f"[OK] browser_interactive_map a cartographié {len(elements)} éléments avec marques et box_2d.")
        results["browser_interactive_map"] = True

        # 9. browser_fill (Standard input)
        print("\n--- [9/31] Test: browser_fill (Standard) ---")
        fill_res = parse_response(mcp.browser_fill(selector="#username", value="Julien SOTA", tab_id=test_tab_id))
        assert fill_res.get("status") == "success"
        val_res = mcp.browser_eval("document.getElementById('username').value", tab_id=test_tab_id)
        assert get_eval_val(val_res) == "Julien SOTA", f"Fill mismatch: {val_res}"
        print("[OK] browser_fill standard validé (valeur: 'Julien SOTA').")
        results["browser_fill_standard"] = True

        # 10. browser_fill (Piercing Shadow DOM)
        print("\n--- [10/31] Test: browser_fill (Shadow DOM Piercing) ---")
        shadow_fill_res = parse_response(
            mcp.browser_fill(selector="#shadow-input", value="Shadow Pierced SOTA", tab_id=test_tab_id)
        )
        assert shadow_fill_res.get("status") == "success", f"Shadow fill failed: {shadow_fill_res}"
        val_shadow = mcp.browser_eval(
            "document.querySelector('custom-card').shadowRoot.querySelector('#shadow-input').value",
            tab_id=test_tab_id,
        )
        assert get_eval_val(val_shadow) == "Shadow Pierced SOTA"
        print("[OK] browser_fill Shadow DOM piercing validé (valeur: 'Shadow Pierced SOTA').")
        results["browser_fill_shadow"] = True

        # 11. browser_semantic_fill
        print("\n--- [11/31] Test: browser_semantic_fill ---")
        sfill_res = parse_response(
            mcp.browser_semantic_fill(label="Adresse Email", value="julien@exemple.fr", tab_id=test_tab_id)
        )
        assert sfill_res.get("status") == "success", f"Semantic fill failed: {sfill_res}"
        email_val = mcp.browser_eval("document.getElementById('email').value", tab_id=test_tab_id)
        assert get_eval_val(email_val) == "julien@exemple.fr"

        sfill_text = parse_response(
            mcp.browser_semantic_fill(
                label="Remarques & Notes", value="Multi-line SOTA text\nLine 2", tab_id=test_tab_id
            )
        )
        assert sfill_text.get("status") == "success", f"Textarea semantic fill failed: {sfill_text}"
        comm_val = mcp.browser_eval("document.getElementById('comments').value", tab_id=test_tab_id)
        assert "Multi-line SOTA text" in str(get_eval_val(comm_val))
        print("[OK] browser_semantic_fill validé (input + textarea sans TypeError).")
        results["browser_semantic_fill"] = True

        # 12. browser_hover
        print("\n--- [12/31] Test: browser_hover ---")
        hover_res = parse_response(mcp.browser_hover(selector="#hover-btn", tab_id=test_tab_id))
        assert hover_res.get("status") == "success"
        hover_display = mcp.browser_eval("document.getElementById('hover-target').style.display", tab_id=test_tab_id)
        assert get_eval_val(hover_display) == "block", f"Hover did not display target: {hover_display}"
        print("[OK] browser_hover validé (infobulle révélée).")
        results["browser_hover"] = True

        # 13. browser_click (Standard button)
        print("\n--- [13/31] Test: browser_click (Standard) ---")
        click_res = parse_response(mcp.browser_click(selector="#normal-btn", tab_id=test_tab_id))
        assert click_res.get("status") == "success"
        btn_res = mcp.browser_eval("document.getElementById('btn-result').textContent", tab_id=test_tab_id)
        assert "Normal Clicked!" in str(get_eval_val(btn_res))
        print("[OK] browser_click standard validé.")
        results["browser_click"] = True

        # 14. browser_click (Shadow DOM Piercing)
        print("\n--- [14/31] Test: browser_click (Shadow DOM) ---")
        shadow_click_res = parse_response(mcp.browser_click(selector="#shadow-button", tab_id=test_tab_id))
        assert shadow_click_res.get("status") == "success"
        shadow_btn_res = mcp.browser_eval(
            "document.querySelector('custom-card').shadowRoot.querySelector('#shadow-result').textContent",
            tab_id=test_tab_id,
        )
        assert "Shadow Button Clicked!" in str(get_eval_val(shadow_btn_res))
        print("[OK] browser_click Shadow DOM piercing validé.")
        results["browser_click_shadow"] = True

        # 15. browser_semantic_click
        print("\n--- [15/31] Test: browser_semantic_click ---")
        sclick_res = parse_response(
            mcp.browser_semantic_click(role="button", name="Valider la commande", tab_id=test_tab_id)
        )
        assert sclick_res.get("status") == "success"
        order_res = mcp.browser_eval("document.getElementById('btn-result').textContent", tab_id=test_tab_id)
        assert "Order Validated!" in str(get_eval_val(order_res))
        print("[OK] browser_semantic_click validé.")
        results["browser_semantic_click"] = True

        # 16. browser_select_option
        print("\n--- [16/31] Test: browser_select_option ---")
        sopt_res = parse_response(mcp.browser_select_option(selector="#plan-select", value="pro", tab_id=test_tab_id))
        assert sopt_res.get("status") == "success"
        select_val = mcp.browser_eval("document.getElementById('plan-select').value", tab_id=test_tab_id)
        assert get_eval_val(select_val) == "pro"
        print("[OK] browser_select_option validé (option: 'pro').")
        results["browser_select_option"] = True

        # 17. browser_press_key
        print("\n--- [17/31] Test: browser_press_key ---")
        mcp.browser_click(selector="#key-input", tab_id=test_tab_id)
        pkey_res = parse_response(mcp.browser_press_key(key="Enter", tab_id=test_tab_id))
        assert pkey_res.get("status") == "success"
        key_logged = mcp.browser_eval("document.getElementById('key-result').textContent", tab_id=test_tab_id)
        assert "Enter" in str(get_eval_val(key_logged))
        print("[OK] browser_press_key validé (touche: 'Enter').")
        results["browser_press_key"] = True

        # 18. browser_drag_and_drop
        print("\n--- [18/31] Test: browser_drag_and_drop ---")
        dnd_res = parse_response(
            mcp.browser_drag_and_drop(
                from_selector="#drag-source",
                to_selector="#drag-target",
                steps=8,
                tab_id=test_tab_id,
            )
        )
        assert dnd_res.get("status") == "success", f"Drag and drop failed: {dnd_res}"
        dnd_text = mcp.browser_eval("document.getElementById('drag-target').textContent", tab_id=test_tab_id)
        assert "Dropped!" in str(get_eval_val(dnd_text)), f"Drop target text not updated: {dnd_text}"
        print("[OK] browser_drag_and_drop validé (élément déplacé et reçu dans la zone de dépôt).")
        results["browser_drag_and_drop"] = True

        # 19. browser_scroll
        print("\n--- [19/31] Test: browser_scroll ---")
        mcp.browser_eval("window.scrollTo(0, 0)", tab_id=test_tab_id)
        time.sleep(0.1)
        scroll_down = parse_response(mcp.browser_scroll(direction="down", y=600, tab_id=test_tab_id))
        assert scroll_down.get("status") == "success"
        time.sleep(0.2)
        y_pos = float(get_eval_val(mcp.browser_eval("window.scrollY", tab_id=test_tab_id)) or 0)  # pyright: ignore[reportArgumentType]
        assert y_pos >= 400, f"Scroll down failed: {y_pos}"

        scroll_up = parse_response(mcp.browser_scroll(direction="up", y=600, tab_id=test_tab_id))
        assert scroll_up.get("status") == "success"
        time.sleep(0.2)
        y_pos_up = float(get_eval_val(mcp.browser_eval("window.scrollY", tab_id=test_tab_id)) or 0)  # pyright: ignore[reportArgumentType]
        assert y_pos_up <= 100, f"Scroll up failed: {y_pos_up}"
        print("[OK] browser_scroll (haut et bas) validé.")
        results["browser_scroll"] = True

        # 20. browser_eval
        print("\n--- [20/31] Test: browser_eval ---")
        eval_res = mcp.browser_eval("Math.sqrt(144) * 2", tab_id=test_tab_id)
        assert get_eval_val(eval_res) == 24
        print("[OK] browser_eval validé (calcul JS: 24).")
        results["browser_eval"] = True

        # 21. browser_logs
        print("\n--- [21/31] Test: browser_logs ---")
        logs_res = parse_response(mcp.browser_logs(tab_id=test_tab_id))
        logs_data = logs_res.get("data", logs_res)
        logs_str = str(logs_data)
        assert "NexusLiveTest" in logs_str, f"Console log missing: {logs_str}"
        print("[OK] browser_logs validé (capture des logs console DevTools).")
        results["browser_logs"] = True

        # 22. browser_check_handoff
        print("\n--- [22/31] Test: browser_check_handoff ---")
        handoff_res = parse_response(mcp.browser_check_handoff(tab_id=test_tab_id))
        h_data = handoff_res.get("data", handoff_res)
        # On a regular clean test page, handoffRequired should be False
        assert h_data.get("handoffRequired") is False or h_data.get("is_handoff") is False
        print("[OK] browser_check_handoff validé (aucun CAPTCHA détecté).")
        results["browser_check_handoff"] = True

        # 23. browser_get_cookies
        print("\n--- [23/31] Test: browser_get_cookies ---")
        cookies_res = parse_response(mcp.browser_get_cookies(urls=[test_url], tab_id=test_tab_id))
        cookies_list = cookies_res.get("data", {}).get("cookies", cookies_res.get("data", []))
        found_cookie = any(c.get("name") == "live_test_cookie" for c in cookies_list)
        assert found_cookie, f"Cookie not found in: {cookies_list}"
        print("[OK] browser_get_cookies validé (cookie HTTP extrait).")
        results["browser_get_cookies"] = True

        # 24. browser_cdp_send
        print("\n--- [24/31] Test: browser_cdp_send ---")
        cdp_res = parse_response(
            mcp.browser_cdp_send(
                method="Runtime.evaluate",
                params={"expression": "window.location.protocol"},
                tab_id=test_tab_id,
            )
        )
        assert "http:" in str(cdp_res)
        print("[OK] browser_cdp_send validé (CDP direct Runtime.evaluate).")
        results["browser_cdp_send"] = True

        # 25. browser_screenshot
        print("\n--- [25/31] Test: browser_screenshot ---")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp_shot:
            shot_path = tmp_shot.name
        try:
            shot_res = parse_response(mcp.browser_screenshot(output_path=shot_path, tab_id=test_tab_id))
            assert shot_res.get("status") == "success", f"Screenshot failed: {shot_res}"
            assert os.path.exists(shot_path), "Screenshot file not created"
            file_size = os.path.getsize(shot_path)
            assert file_size > 1000, f"Screenshot file too small: {file_size}"
            with open(shot_path, "rb") as f:
                header = f.read(8)
                assert header.startswith(b"\x89PNG"), "Screenshot is not a valid PNG"
            print(f"[OK] browser_screenshot (plein écran) validé ({file_size} octets, PNG valide).")

            # Element selector screenshot
            elem_shot_res = parse_response(
                mcp.browser_screenshot(output_path=shot_path, selector="#semantic-btn", tab_id=test_tab_id)
            )
            assert elem_shot_res.get("status") == "success", f"Element screenshot failed: {elem_shot_res}"
            elem_size = os.path.getsize(shot_path)
            assert 100 < elem_size < file_size, f"Element screenshot size unexpected: {elem_size}"
            print(f"[OK] browser_screenshot (ciblé par sélecteur CSS) validé ({elem_size} octets).")
            results["browser_screenshot"] = True
        finally:
            if os.path.exists(shot_path):
                os.remove(shot_path)

        # 26. browser_pdf
        print("\n--- [26/31] Test: browser_pdf ---")
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp_pdf:
            pdf_path = tmp_pdf.name
        try:
            pdf_res = parse_response(mcp.browser_pdf(output_path=pdf_path, tab_id=test_tab_id))
            assert pdf_res.get("status") == "success", f"PDF generation failed: {pdf_res}"
            assert os.path.exists(pdf_path), "PDF file not created"
            pdf_size = os.path.getsize(pdf_path)
            assert pdf_size > 1000, f"PDF file too small: {pdf_size}"
            with open(pdf_path, "rb") as f:
                header = f.read(4)
                assert header.startswith(b"%PDF"), "File is not a valid PDF"
            print(f"[OK] browser_pdf validé ({pdf_size} octets, PDF vectoriel valide).")
            results["browser_pdf"] = True
        finally:
            if os.path.exists(pdf_path):
                os.remove(pdf_path)

        # 27. browser_vision_inspect & browser_click_mark
        print("\n--- [27/31] Test: browser_vision_inspect & [28/31] browser_click_mark ---")
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp_som:
            som_path = tmp_som.name
        try:
            som_res = parse_response(mcp.browser_vision_inspect(output_path=som_path, tab_id=test_tab_id))
            assert os.path.exists(som_path), "SoM image not created"
            som_data = som_res.get("data", som_res)
            markers = som_data.get("markers", [])
            marks_count = som_data.get("markerCount") or len(markers)
            assert marks_count > 0, f"Zero marks detected: {som_res}"
            print(f"[OK] browser_vision_inspect validé ({marks_count} badges SoM néon injectés).")
            results["browser_vision_inspect"] = True

            # Reset button result text
            mcp.browser_eval("document.getElementById('btn-result').textContent = 'Reset'", tab_id=test_tab_id)
            normal_btn_mark = next((m["mark"] for m in markers if "Bouton Normal" in str(m.get("text"))), None)
            if normal_btn_mark is None and markers:
                normal_btn_mark = markers[0]["mark"]
            assert normal_btn_mark is not None, f"No mark found to click: {markers}"

            cmark_res = parse_response(mcp.browser_click_mark(mark=normal_btn_mark, tab_id=test_tab_id))
            assert cmark_res.get("status") == "success", f"Click mark failed: {cmark_res}"
            mark_btn_txt = mcp.browser_eval("document.getElementById('btn-result').textContent", tab_id=test_tab_id)
            assert "Normal Clicked!" in str(get_eval_val(mark_btn_txt))
            print(f"[OK] browser_click_mark validé (clic sur le badge #{normal_btn_mark} avec succès).")
            results["browser_click_mark"] = True
        finally:
            if os.path.exists(som_path):
                os.remove(som_path)

        # 29. browser_upload
        print("\n--- [29/31] Test: browser_upload ---")
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as tmp_up:
            tmp_up.write(b"Contenu de test NexusBrowser Upload")
            tmp_up_path = tmp_up.name
        try:
            up_res = parse_response(
                mcp.browser_upload(files=[tmp_up_path], selector="#file-upload", tab_id=test_tab_id)
            )
            assert up_res.get("status") == "success", f"Upload failed: {up_res}"
            uploaded_name = mcp.browser_eval("document.getElementById('file-result').textContent", tab_id=test_tab_id)
            assert Path(tmp_up_path).name in str(get_eval_val(uploaded_name)), (
                f"Upload name not reflected: {uploaded_name}"
            )
            print(f"[OK] browser_upload validé (fichier {Path(tmp_up_path).name} intercepté via CDP).")
            results["browser_upload"] = True
        finally:
            if os.path.exists(tmp_up_path):
                os.remove(tmp_up_path)

        # 30. browser_reload & browser_navigate
        print("\n--- [30/31] Test: browser_reload & browser_navigate ---")
        nav_res = parse_response(mcp.browser_navigate(url=f"{test_url}?navigated=true", tab_id=test_tab_id))
        assert nav_res.get("status") == "success"
        mcp.browser_wait_load(timeout_ms=5000, tab_id=test_tab_id)
        nav_check = mcp.browser_eval("window.location.search", tab_id=test_tab_id)
        assert "?navigated=true" in str(get_eval_val(nav_check))

        reload_res = parse_response(mcp.browser_reload(tab_id=test_tab_id, bypass_cache=True))
        assert reload_res.get("status") == "success"
        mcp.browser_wait_load(timeout_ms=5000, tab_id=test_tab_id)
        print("[OK] browser_navigate & browser_reload validés.")
        results["browser_navigate"] = True
        results["browser_reload"] = True

        # 31. browser_close_tab
        print("\n--- [31/31] Test: browser_close_tab ---")
        close_res = parse_response(mcp.browser_close_tab(tab_id=test_tab_id))
        assert close_res.get("status") == "success"
        time.sleep(0.5)

        # Check tab is closed
        final_tabs_resp = parse_response(mcp.browser_list_tabs())
        final_tabs = final_tabs_resp.get("data", final_tabs_resp)
        if isinstance(final_tabs, str):
            final_tabs = json.loads(final_tabs)
        final_tab_ids = [t["id"] for t in final_tabs]
        assert test_tab_id not in final_tab_ids, f"Test tab {test_tab_id} was not closed: {final_tab_ids}"
        test_tab_id = None  # Cleanly marked as closed
        print("[OK] browser_close_tab validé (l'onglet de test a été fermé avec succès).")
        results["browser_close_tab"] = True

        # Guarantee user's tabs integrity
        print("\n[*] Vérification de l'intégrité des onglets utilisateurs...")
        initial_ids = {t["id"] for t in initial_tabs}
        remaining_ids = {t["id"] for t in final_tabs}
        assert initial_ids.issubset(remaining_ids), (
            f"User tabs were affected! Initial: {initial_ids}, Remaining: {remaining_ids}"
        )
        print(f"[SOTA] Intégrité 100% garantie : tous les onglets utilisateur ({len(initial_ids)}) sont intacts.")

    finally:
        # Safety cleanup: if test tab is still open, close it
        if test_tab_id is not None:
            try:
                mcp.browser_close_tab(tab_id=test_tab_id)
            except Exception:
                pass
        server.shutdown()
        server.server_close()

    print("\n" + "=" * 60)
    print(f"RÉSULTATS DE LA VALIDATION EN CONDITIONS RÉELLES : {len(results)}/31 CAPABILITÉS TESTÉES")
    for capability, success in results.items():
        status = "SUCCÈS [100%]" if success else "ÉCHEC"
        print(f"  - {capability:<30} : {status}")
    print("=" * 60)
    return results


def _tab_ids(response, julien_only: bool = False) -> set[int]:
    """Onglets listés ; julien_only : ceux de Julien seulement (un autre agent peut fermer les siens pendant le test)."""
    tabs = parse_response(response).get("data", [])
    if isinstance(tabs, str):
        tabs = json.loads(tabs)
    return {t["id"] for t in tabs if not julien_only or t.get("state") == "user"}


def _live(tab_id: int) -> dict:
    return get_eval_val(mcp.browser_eval("JSON.parse(JSON.stringify(window.__agyLive))", tab_id=tab_id)) or {}


def run_mouse_validation() -> dict[str, bool]:
    """Vraies actions de souris CDP dans un nouvel onglet d'agent en arrière-plan ; chaque effet est relu dans la page."""
    port = get_free_port()
    server = http.server.HTTPServer(("127.0.0.1", port), TestFixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/mouse.html"
    results: dict[str, bool] = {}
    tab_id: int | None = None

    def check(name: str, condition: bool, detail) -> None:
        results[name] = bool(condition)
        print(f"[{'OK' if condition else 'ÉCHEC'}] {name} : {detail}")

    try:
        initial_ids = _tab_ids(mcp.browser_list_tabs(), julien_only=True)
        active_before = parse_response(mcp.browser_active_tab()).get("data", {}) or {}
        print(f"[*] Onglets de Julien préservés : {len(initial_ids)} ; onglet actif : {active_before.get('id')}")

        created = parse_response(mcp.browser_new_tab(url, background=True))
        tab_id = (created.get("data") or {}).get("id")
        assert tab_id, f"Onglet de test non créé : {created}"
        mcp.browser_wait_load(timeout_ms=10000, tab_id=tab_id)
        print(f"[*] Onglet d'agent {tab_id} ouvert en arrière-plan sur {url}")

        # 1. Bouton qui n'accepte que les clics isTrusted
        res = parse_response(mcp.browser_click(selector="#trusted-only", tab_id=tab_id))
        live = _live(tab_id)
        check(
            "clic_isTrusted",
            res.get("status") == "success"
            and res["data"].get("method") == "cdp"
            and res["data"].get("trusted_click") is True
            and live.get("trusted") == 1
            and live.get("untrusted") == 0,
            {"reponse": res.get("data") or res.get("error"), "page": live},
        )

        # 2. Double clic et clic droit de confiance
        res = parse_response(mcp.browser_click(selector="#dbl", click_count=2, tab_id=tab_id))
        check("double_clic", res.get("status") == "success" and _live(tab_id).get("dbl") == 1, res.get("data") or res)
        res = parse_response(mcp.browser_click(selector="#ctx", button="right", tab_id=tab_id))
        check("clic_droit", res.get("status") == "success" and _live(tab_id).get("ctx") == 1, res.get("data") or res)

        # 3. Menu au survol : la règle CSS :hover n'obéit qu'au vrai pointeur
        res = parse_response(mcp.browser_hover(selector="#menu-trigger", tab_id=tab_id))
        display = get_eval_val(
            mcp.browser_eval("getComputedStyle(document.getElementById('menu')).display", tab_id=tab_id)
        )
        check(
            "survol_menu_css_hover",
            res.get("status") == "success" and display == "block" and _live(tab_id).get("mouseenter", 0) >= 1,
            {"reponse": res.get("data") or res.get("error"), "display": display},
        )
        res = parse_response(mcp.browser_click(selector="#menu-item", tab_id=tab_id))
        check("clic_dans_menu_survole", res.get("status") == "success" and _live(tab_id).get("menuItem") == 1, res)

        # 4. Élément couvert par une surcouche : erreur, rien cliqué (ni le bouton, ni la surcouche)
        res = parse_response(mcp.browser_click(selector="#covered-btn", timeout_ms=300, tab_id=tab_id))
        live = _live(tab_id)
        check(
            "element_couvert_refuse",
            res.get("status") == "error"
            and "couvert" in res.get("error", "")
            and live.get("covered") == 0
            and live.get("overlay") == 0,
            {"reponse": res.get("error") or res.get("data"), "page": live},
        )

        # 5. Glisser-déposer : exactement un dépôt de confiance
        res = parse_response(
            mcp.browser_drag_and_drop(from_selector="#dnd-src", to_selector="#dnd-zone", steps=10, tab_id=tab_id)
        )
        live = _live(tab_id)
        check(
            "glisser_depot_unique",
            res.get("status") == "success"
            and live.get("drops") == 1
            and not live.get("syntheticDrops")
            and res["data"].get("html5_fallback") is False,
            {"reponse": res.get("data") or res.get("error"), "page": live},
        )

        # 6. Bouton dans une iframe same-origin, sous la ligne de flottaison (défilement + décalage du cadre)
        mcp.browser_eval("window.scrollTo(0, 0)", tab_id=tab_id)
        res = parse_response(mcp.browser_click(selector="#frame-btn", tab_id=tab_id))
        check(
            "clic_iframe_same_origin",
            res.get("status") == "success"
            and res["data"].get("frameDepth") == 1
            and res["data"].get("trusted_click") is True
            and _live(tab_id).get("frame") == 1,
            res.get("data") or res,
        )

        # 7. confirm() : la main revient avec dialogOpened, rien n'est accepté d'office
        res = parse_response(mcp.browser_click(selector="#confirm-btn", tab_id=tab_id))
        data = res.get("data") or {}
        opened = data.get("dialogOpened") is True and (data.get("dialog") or {}).get("type") == "confirm"
        handled = parse_response(mcp.browser_handle_dialog(accept=False, tab_id=tab_id))
        outcome = get_eval_val(mcp.browser_eval("document.getElementById('confirm-result').textContent", tab_id=tab_id))
        check(
            "confirm_signale_puis_annule",
            opened and handled.get("status") == "success" and outcome == "annule",
            {"reponse": data or res, "resultat": outcome},
        )

        # 8. Onglet resté en arrière-plan, onglet actif de Julien inchangé
        active_after = parse_response(mcp.browser_active_tab()).get("data", {}) or {}
        check(
            "onglet_reste_en_arriere_plan",
            active_after.get("id") == active_before.get("id") and active_after.get("id") != tab_id,
            {"actif_avant": active_before.get("id"), "actif_apres": active_after.get("id")},
        )
    finally:
        if tab_id is not None:
            try:
                mcp.browser_close_tab(tab_id=tab_id)
            except Exception as error:  # noqa: BLE001 - nettoyage au mieux, l'erreur est affichée
                print(f"[!] Fermeture de l'onglet {tab_id} impossible : {error}")
        server.shutdown()
        server.server_close()

    time.sleep(0.3)
    remaining = _tab_ids(mcp.browser_list_tabs())
    check("onglets_de_julien_intacts", initial_ids.issubset(remaining) and tab_id not in remaining, len(remaining))
    print("\n" + "=" * 60)
    print(f"SOURIS RÉELLE : {sum(results.values())}/{len(results)} vérifications réussies")
    print("=" * 60)
    return results


# =============================================================================
# Validation complète (--full-live) : localisateurs, frappe de confiance, iframes d'une autre origine, réseau,
# téléchargement. Page principale sur 127.0.0.1:P1 ; cadres servis par un second port P2, l'un par localhost
# (autre site : iframe hors processus), l'autre par 127.0.0.1 (même site, autre origine : même processus).
# =============================================================================
FULL_TEST_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>NexusBrowser Validation complète</title>
    <style>
        body { font-family: sans-serif; margin: 20px; }
        section { margin-bottom: 18px; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
        #editor { min-height: 40px; border: 1px solid #999; padding: 6px; }
        iframe { width: 420px; height: 150px; border: 5px solid #f472b6; padding: 3px; display: block; margin: 8px 0; }
        .spacer { height: 900px; }
    </style>
</head>
<body>
    <h1>Validation complète NexusBrowser</h1>
    <section aria-label="Boutons">
        <button id="v1">Valider</button>
        <button id="v2">Valider le panier</button>
        <button id="v-hidden" style="display: none">Valider</button>
        <ul>
            <li><button class="del" id="del-1">Supprimer</button></li>
            <li><button class="del" id="del-2">Supprimer</button></li>
        </ul>
        <button data-testid="submit-zone" id="send">Envoyer</button>
    </section>
    <section aria-label="Champs">
        <p><label for="email">Adresse e-mail</label> <input id="email" type="email"></p>
        <p><input id="search" placeholder="Rechercher un produit"></p>
        <p><label for="trusted">Champ de confiance</label> <input id="trusted" autocomplete="off"></p>
        <div id="editor" contenteditable="true" aria-label="Éditeur riche">Ancien texte</div>
        <p><label><input type="checkbox" id="accept"> J'accepte les conditions</label></p>
        <p><label for="plan">Formule</label>
            <select id="plan"><option value="free">Découverte</option><option value="pro">Pro</option></select></p>
        <p><button id="load">Charger les données</button> <span id="load-result"></span></p>
        <p><a id="dl" href="/download/__TOKEN__.txt">Télécharger le fichier de test</a></p>
    </section>
    <section aria-label="Connexion">
        <p><label for="pw">Mot de passe</label> <input id="pw" type="password" value="MotDePasse-Live-1"></p>
        <p><label for="card">Numéro de carte</label> <input id="card" autocomplete="cc-number" value="4970101234567890"></p>
        <p><label for="shown">Secret affiché</label>
            <input id="shown" name="password" type="text" value="AfficheLive3" style="font: 16px monospace; width: 220px"></p>
        <p><label for="cardname">Carte (nom seul)</label>
            <input id="cardname" name="cardNumber" value="5131420000001111" style="font: 16px monospace; width: 220px"></p>
    </section>
    <div class="spacer"></div>
    <iframe id="frame-a" title="Cadre A" src="http://localhost:__P2__/frame?name=A"></iframe>
    <iframe id="frame-b" title="Cadre B" src="http://127.0.0.1:__P2__/frame?name=B"></iframe>
    <script>
        const L = window.__agyFull = { clicks: {}, untrustedClicks: 0, trusted: { keydown: 0, input: 0, untrusted: 0 },
            editor: { input: 0, untrusted: 0 }, frames: {}, fetch: null };
        document.querySelectorAll('button').forEach(b => b.addEventListener('click', e => {
            if (!e.isTrusted) { L.untrustedClicks++; return; }
            L.clicks[b.id] = (L.clicks[b.id] || 0) + 1;
        }));
        // Champ qui n'accepte que la frappe de confiance : un input synthétique (setter + dispatchEvent) est annulé.
        const trusted = document.getElementById('trusted');
        trusted.addEventListener('keydown', e => { if (e.isTrusted) L.trusted.keydown++; });
        trusted.addEventListener('input', e => {
            if (e.isTrusted) L.trusted.input++;
            else { L.trusted.untrusted++; trusted.value = ''; }
        });
        document.getElementById('editor').addEventListener('input', e => {
            if (e.isTrusted) L.editor.input++; else L.editor.untrusted++;
        });
        document.getElementById('load').addEventListener('click', () => {
            fetch('/api/data?q=nexus', { headers: { 'Authorization': 'Bearer secret-nexus-token', 'X-Test': 'visible' } })
                .then(r => r.json()).then(d => { L.fetch = d; document.getElementById('load-result').textContent = d.message; });
        });
        window.addEventListener('message', e => { if (e.data && e.data.agyFrame) L.frames[e.data.agyFrame] = e.data; });
    </script>
</body>
</html>
"""

FRAME_PAGE = """<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Cadre __NAME__</title></head>
<body style="font-family: sans-serif; margin: 8px">
    <button id="act">Action __NAME__</button>
    <button id="common">Action commune</button>
    <p><label for="f">Saisie cadre __NAME__</label> <input id="f"></p>
    <p><label for="fcard">Carte du cadre __NAME__</label>
        <input id="fcard" name="cardNumber" value="6011000990139424" style="font: 16px monospace; width: 220px"></p>
    <script>
        const S = { agyFrame: '__NAME__', clicks: 0, common: 0, untrusted: 0, value: '', trustedInput: 0, card: '' };
        const report = () => { const c = document.getElementById('fcard'); S.card = c.name + ':' + c.value.length + ':' + c.value.slice(0, 2); parent.postMessage(S, '*'); };
        // Réglage du champ de carte par le parent (test du masquage dans les captures d'un cadre d'une autre origine).
        window.addEventListener('message', e => {
            const c = document.getElementById('fcard');
            if (e.data && e.data.setCard !== undefined) { c.value = e.data.setCard; c.name = e.data.name || 'cardNumber'; report(); }
        });
        document.getElementById('act').addEventListener('click', e => { if (e.isTrusted) S.clicks++; else S.untrusted++; report(); });
        document.getElementById('common').addEventListener('click', e => { if (e.isTrusted) S.common++; report(); });
        const f = document.getElementById('f');
        f.addEventListener('input', e => { if (e.isTrusted) S.trustedInput++; else S.untrusted++; S.value = f.value; report(); });
        report();
    </script>
</body></html>
"""

# Page d'article de --full-live : corps à exporter entouré de bruit (menu, publicité, bandeau cookies, barre latérale,
# lettre d'information, pied de page, script). Chaque phrase de bruit contient un marqueur unique « BRUIT-… ».
ARTICLE_TEST_PAGE = """<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <title>Le pont NexusBrowser expliqué — Carnet de test</title>
    <meta name="author" content="Julien Piron">
    <meta property="article:published_time" content="2026-10-16T08:30:00Z">
    <meta property="og:site_name" content="Carnet de test NexusBrowser">
    <meta name="description" content="Article de test de browser_export.">
</head>
<body>
    <header class="site-header">
        <nav><ul><li><a href="/">Accueil BRUIT-MENU</a></li><li><a href="/blog">Blog BRUIT-MENU</a></li>
            <li><a href="/contact">Contact BRUIT-MENU</a></li></ul></nav>
    </header>
    <div class="cookie-banner" role="dialog">Nous utilisons des cookies BRUIT-COOKIES <button>Tout accepter</button></div>
    <div class="layout">
        <main>
            <article id="article">
                <h1>Le pont NexusBrowser expliqué</h1>
                <p class="byline">Par Julien Piron</p>
                <p>Le pont local relie l'agent à Chrome avec une <strong>preuve HMAC</strong> dans les deux sens ;
                    chaque message est signé, numéroté puis vérifié avant d'être exécuté. CORPS-INTRO</p>
                <div class="ad-container"><p>Publicité BRUIT-PUB : montres connectées à moitié prix, offre limitée,
                    commandez vite.</p></div>
                <h2>Les trois étapes</h2>
                <ol><li>Nonce de l'extension</li><li>Preuve du pont</li><li>Preuve du client CORPS-LISTE</li></ol>
                <p>La documentation complète est sur <a href="/docs/pont">la page du pont</a>, avec des exemples,
                    des schémas et des mesures réelles. CORPS-LIEN</p>
                <table><thead><tr><th>Port</th><th>Rôle</th></tr></thead>
                    <tbody><tr><td>9224</td><td>WebSocket signé CORPS-TABLEAU</td></tr><tr><td>9225</td><td>API REST</td></tr></tbody></table>
                <pre><code class="language-python">print("CORPS-CODE")</code></pre>
                <form class="newsletter"><label>Votre e-mail BRUIT-FORMULAIRE <input type="email" value="valeur-champ-secrete"></label>
                    <button>S'abonner</button></form>
                <p>Conclusion : aucun programme local ne peut plus se faire passer pour le pont, ni rejouer une
                    commande déjà signée. CORPS-CONCLUSION</p>
            </article>
        </main>
        <aside class="sidebar"><h3>À lire aussi BRUIT-LATERAL</h3><ul><li><a href="/a">Un autre article</a></li>
            <li><a href="/b">Encore un</a></li><li><a href="/c">Et un dernier</a></li></ul></aside>
    </div>
    <footer><p>Mentions légales BRUIT-PIED, tous droits réservés.</p></footer>
    <script>window.__trace = "BRUIT-SCRIPT";</script>
</body>
</html>
"""
ARTICLE_BODY_MARKERS = (
    "# Le pont NexusBrowser expliqué",
    "**preuve HMAC**",
    "## Les trois étapes",
    "3. Preuve du client CORPS-LISTE",
    "CORPS-INTRO",
    "CORPS-LIEN",
    "| 9224 | WebSocket signé CORPS-TABLEAU |",
    '```python\nprint("CORPS-CODE")\n```',
    "CORPS-CONCLUSION",
)


class FullFixture:
    """Deux serveurs locaux (port principal, port des cadres) ; le cadre est aussi servi sur ::1 si possible."""

    def __init__(self) -> None:
        self.token = f"nexus-browser-test-{secrets.token_hex(4)}"
        self.download_content = f"NexusBrowser : fichier de test {self.token}\n"
        self.servers: list[http.server.ThreadingHTTPServer] = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - API de http.server
                path, _, query = self.path.partition("?")
                if path == "/full":
                    body = FULL_TEST_PAGE.replace("__P2__", str(fixture.frame_port)).replace("__TOKEN__", fixture.token)
                    self._send(200, "text/html; charset=utf-8", body.encode("utf-8"))
                elif path == "/article":
                    self._send(200, "text/html; charset=utf-8", ARTICLE_TEST_PAGE.encode("utf-8"))
                elif path == "/mouse":
                    self._send(200, "text/html; charset=utf-8", MOUSE_TEST_PAGE.encode("utf-8"))
                elif path == "/frame":
                    name = "A" if "name=A" in query else "B"
                    self._send(200, "text/html; charset=utf-8", FRAME_PAGE.replace("__NAME__", name).encode("utf-8"))
                elif path == "/api/data":
                    payload = json.dumps(
                        {"message": "Données chargées", "items": [1, 2, 3], "access_token": "secret-corps-jeton"},
                        ensure_ascii=False,
                    )
                    self._send(
                        200,
                        "application/json; charset=utf-8",
                        payload.encode("utf-8"),
                        {"Set-Cookie": "api_session=secret-cookie-value; Path=/; SameSite=Lax"},
                    )
                elif path == f"/download/{fixture.token}.txt":
                    self._send(
                        200,
                        "text/plain; charset=utf-8",
                        fixture.download_content.encode("utf-8"),
                        {"Content-Disposition": f'attachment; filename="{fixture.token}.txt"'},
                    )
                else:
                    self._send(404, "text/plain; charset=utf-8", b"introuvable")

            def _send(self, status, content_type, body, headers=None):
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, format, *args):
                pass

        main = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        frames = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.main_port = main.server_address[1]
        self.frame_port = frames.server_address[1]
        self.servers = [main, frames]

        class V6Server(http.server.ThreadingHTTPServer):
            address_family = socket.AF_INET6

        try:  # localhost peut se résoudre d'abord en ::1 : même port, boucle locale IPv6 seulement
            self.servers.append(V6Server(("::1", self.frame_port), Handler))
        except OSError:
            pass
        for server in self.servers:
            threading.Thread(target=server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.main_port}/full"
        self.article_url = f"http://127.0.0.1:{self.main_port}/article"

    def close(self) -> None:
        for server in self.servers:
            server.shutdown()
            server.server_close()


def preflight() -> None:
    """Pont et extension connectés et à jour, sans lancer Chrome : sinon échec clair (jamais de faux vert)."""
    expected = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]
    try:
        pong = bridge_client.call_bridge("ping", {}, 5.0, retry=False)
    except Exception as error:  # noqa: BLE001 - toute panne du pont est un échec de la validation réelle
        raise SystemExit(
            f"ÉCHEC : pont NexusBrowser ou extension Chrome injoignable ({error}). Ouvrir Chrome avec l'extension "
            "Nexus Browser Bridge chargée (chrome://extensions), puis relancer."
        ) from error
    version = (pong or {}).get("version")
    if version != expected:
        raise SystemExit(
            f"ÉCHEC : l'extension chargée dans Chrome est en version {version}, le dépôt en {expected}. "
            "Recharger l'extension dans chrome://extensions (bouton Recharger), puis relancer."
        )
    source = (ROOT / "extension" / "background.js").read_text(encoding="utf-8")
    match = re.search(r"const AGY_FEATURES = \[(.*?)\];", source, re.S)
    wanted = sorted(re.findall(r'"([^"]+)"', match.group(1))) if match else []
    loaded = sorted((pong or {}).get("features") or [])
    if loaded != wanted:
        raise SystemExit(
            f"ÉCHEC : le code chargé dans Chrome n'est pas celui du dépôt (fonctions annoncées {loaded}, attendues "
            f"{wanted}) : ancien service worker encore actif. Recharger l'extension (deux fois si besoin), puis relancer."
        )
    print(f"[*] Pont et extension connectés (version {version}, code à jour).")


def _data(response) -> dict:
    parsed = parse_response(response)
    data = parsed.get("data")
    return data if isinstance(data, dict) else {}


def _error(response) -> str:
    return str(parse_response(response).get("error") or "")


def run_full_validation() -> dict[str, bool]:
    """Points 1 à 4 dans un nouvel onglet d'agent en arrière-plan ; chaque effet est relu dans la page."""
    fixture = FullFixture()
    results: dict[str, bool] = {}
    tab_id: int | None = None
    download_path: str | None = None
    download_id: int | None = None

    def check(name: str, condition: bool, detail) -> None:
        results[name] = bool(condition)
        text = json.dumps(detail, ensure_ascii=False, default=str) if not isinstance(detail, str) else detail
        print(f"[{'OK' if condition else 'ÉCHEC'}] {name} : {text[:600]}")

    def page() -> dict:
        assert tab_id is not None
        return get_eval_val(mcp.browser_eval("JSON.parse(JSON.stringify(window.__agyFull))", tab_id=tab_id)) or {}

    def value_of(expression: str):
        assert tab_id is not None
        return get_eval_val(mcp.browser_eval(expression, tab_id=tab_id))

    initial_ids: set[int] = set()
    try:
        initial_ids = _tab_ids(mcp.browser_list_tabs(), julien_only=True)
        active_before = parse_response(mcp.browser_active_tab()).get("data", {}) or {}
        print(f"[*] Onglets de Julien préservés : {len(initial_ids)} ; onglet actif : {active_before.get('id')}")
        created = parse_response(mcp.browser_new_tab(fixture.url, background=True))
        tab_id = (created.get("data") or {}).get("id")
        assert tab_id, f"Onglet de test non créé : {created}"
        mcp.browser_wait_load(timeout_ms=10000, tab_id=tab_id)
        mcp.browser_wait_network_idle(idle_ms=300, timeout_ms=5000, tab_id=tab_id)
        print(f"[*] Onglet d'agent {tab_id} ouvert en arrière-plan sur {fixture.url}")

        # --- 0. Propriété (2.7.0) : l'onglet est à CETTE session, celui de Julien est refusé sans y toucher --------
        listed = parse_response(mcp.browser_list_tabs()).get("data") or []
        mine = [t for t in listed if t.get("id") == tab_id]
        check(
            "propriete_onglet_de_la_session",
            bool(mine) and mine[0].get("mine") is True and mine[0].get("state") == "mine",
            mine,
        )
        julien = active_before.get("id")
        if julien and julien != tab_id:
            refused = _error(mcp.browser_eval("1", tab_id=julien))
            check("propriete_onglet_de_julien_refuse", "user's tab" in refused or "driven by" in refused, refused)

        # --- 1. Localisateurs par rôle et libellé ---------------------------------------------------------------
        found = _data(mcp.browser_find({"role": "button", "name": "Valider"}, tab_id=tab_id))
        names = sorted(c.get("name") for c in found.get("candidates", []))
        check(
            "find_role_nom_deux_visibles",
            found.get("count") == 2 and found.get("unique") is False and names == ["Valider", "Valider le panier"],
            found,
        )
        res = mcp.browser_click(locator={"role": "button", "name": "Valider"}, tab_id=tab_id)
        check(
            "strict_homonymes_refuses",
            "ambigu" in _error(res) and "Valider le panier" in _error(res) and not page().get("clicks"),
            _error(res) or res,
        )
        res = parse_response(
            mcp.browser_click(locator={"role": "button", "name": "Valider", "exact": True}, tab_id=tab_id)
        )
        clicks = page().get("clicks", {})
        check(
            "clic_role_nom_exact",
            res.get("status") == "success" and res["data"].get("trusted_click") is True and clicks == {"v1": 1},
            {"reponse": res.get("data") or res.get("error"), "page": clicks},
        )
        res = parse_response(
            mcp.browser_click(locator={"role": "button", "name": "Supprimer", "nth": 1}, tab_id=tab_id)
        )
        check(
            "clic_nth",
            res.get("status") == "success"
            and page().get("clicks", {}).get("del-2") == 1
            and "del-1" not in page().get("clicks", {}),
            res.get("data") or res,
        )
        res = parse_response(mcp.browser_click(locator={"testId": "submit-zone"}, tab_id=tab_id))
        check("clic_test_id", res.get("status") == "success" and page().get("clicks", {}).get("send") == 1, res)
        res = mcp.browser_click(locator={"role": "button", "name": "Inexistant"}, timeout_ms=300, tab_id=tab_id)
        check("localisateur_introuvable_clair", "No element matches" in _error(res), _error(res) or res)

        # --- 2. Frappe de confiance ------------------------------------------------------------------------------
        res = parse_response(
            mcp.browser_fill(locator={"label": "Adresse e-mail"}, value="julien@example.com", tab_id=tab_id)
        )
        check(
            "fill_par_label",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and res["data"].get("method") == "cdp"
            and value_of("document.getElementById('email').value") == "julien@example.com",
            res.get("data") or res,
        )
        res = parse_response(mcp.browser_fill(locator={"placeholder": "Rechercher"}, value="clavier", tab_id=tab_id))
        check(
            "fill_par_placeholder",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and value_of("document.getElementById('search').value") == "clavier",
            res.get("data") or res,
        )
        res = parse_response(
            mcp.browser_fill(locator={"label": "Champ de confiance"}, value="Saisie de confiance", tab_id=tab_id)
        )
        state = page().get("trusted", {})
        check(
            "champ_frappe_de_confiance_seulement",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and res["data"].get("trusted_input") is True
            and state.get("input", 0) >= 1
            and state.get("untrusted") == 0
            and value_of("document.getElementById('trusted').value") == "Saisie de confiance",
            {"reponse": res.get("data") or res.get("error"), "page": state},
        )
        res = parse_response(
            mcp.browser_fill(
                locator={"label": "Champ de confiance"}, value=" !", replace=False, per_key=True, tab_id=tab_id
            )
        )
        state = page().get("trusted", {})
        check(
            "ajout_touche_par_touche",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and state.get("keydown", 0) >= 2
            and value_of("document.getElementById('trusted').value") == "Saisie de confiance !",
            {"reponse": res.get("data") or res.get("error"), "page": state},
        )
        res = parse_response(
            mcp.browser_fill(locator={"label": "Éditeur riche"}, value="Nouveau texte riche", tab_id=tab_id)
        )
        editor = page().get("editor", {})
        check(
            "contenteditable_remplace",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and editor.get("input", 0) >= 1
            and editor.get("untrusted") == 0
            and value_of("document.getElementById('editor').innerText.trim()") == "Nouveau texte riche",
            {"reponse": res.get("data") or res.get("error"), "page": editor},
        )
        res = parse_response(mcp.browser_check(locator={"role": "checkbox", "name": "J'accepte"}, tab_id=tab_id))
        check(
            "case_cochee",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and value_of("document.getElementById('accept').checked") is True,
            res.get("data") or res,
        )
        res = parse_response(mcp.browser_select_option(locator={"label": "Formule"}, value="pro", tab_id=tab_id))
        check(
            "select_par_label",
            res.get("status") == "success" and value_of("document.getElementById('plan').value") == "pro",
            res.get("data") or res,
        )

        # --- 3. Iframes d'une autre origine ----------------------------------------------------------------------
        found = _data(mcp.browser_find({"role": "button", "name": "Action commune"}, tab_id=tab_id))
        frames = {c.get("frame") for c in found.get("candidates", [])}
        check(
            "find_dans_les_cadres",
            found.get("count") == 2
            and len(frames) == 2
            and all(c.get("crossOriginFrame") for c in found.get("candidates", [])),
            found,
        )
        res = mcp.browser_click(locator={"role": "button", "name": "Action commune"}, tab_id=tab_id)
        check("strict_entre_cadres", "ambigu" in _error(res), _error(res) or res)
        for name in ("A", "B"):
            res = parse_response(mcp.browser_click(locator={"role": "button", "name": f"Action {name}"}, tab_id=tab_id))
            time.sleep(0.3)
            state = page().get("frames", {}).get(name, {})
            check(
                f"clic_cadre_{name}",
                res.get("status") == "success"
                and res["data"].get("trusted_click") is True
                and res["data"].get("crossOriginFrame") is True
                and state.get("clicks") == 1,
                {"reponse": res.get("data") or res.get("error"), "cadre": state},
            )
        res = parse_response(mcp.browser_fill(locator={"label": "Saisie cadre A"}, value="Bonjour A", tab_id=tab_id))
        time.sleep(0.3)
        state = page().get("frames", {}).get("A", {})
        check(
            "saisie_cadre_A",
            res.get("status") == "success"
            and res["data"].get("verified") is True
            and state.get("value") == "Bonjour A"
            and state.get("trustedInput", 0) >= 1
            and state.get("untrusted") == 0,
            {"reponse": res.get("data") or res.get("error"), "cadre": state},
        )
        content = _data(mcp.browser_content(mode="interactive", tab_id=tab_id))
        framed = [e for e in content.get("elements", []) if e.get("crossOriginFrame")]
        check(
            "content_indique_le_cadre",
            len({e.get("frame") for e in framed}) == 2 and any("Action A" in (e.get("text") or "") for e in framed),
            [(e.get("frame"), e.get("text")) for e in framed],
        )
        mapped = _data(mcp.browser_interactive_map(viewport_only=False, max_elements=80, tab_id=tab_id))
        target = next(
            (e for e in mapped.get("elements", []) if e.get("crossOriginFrame") and e.get("label") == "Action B"), None
        )
        res = (
            parse_response(mcp.browser_click(mark=target["mark"], tab_id=tab_id))
            if target
            else {"error": "marqueur absent"}
        )
        time.sleep(0.3)
        check(
            "marqueur_dans_cadre_B",
            target is not None
            and res.get("status") == "success"
            and page().get("frames", {}).get("B", {}).get("clicks") == 2,
            {"element": target, "reponse": res},
        )

        # --- 4. Réseau et téléchargement -------------------------------------------------------------------------
        recording = _data(mcp.browser_network_record(tab_id=tab_id, duration_s=60))
        check("reseau_enregistrement_demande", recording.get("recording") is True, recording)
        res = parse_response(
            mcp.browser_click(locator={"role": "button", "name": "Charger les données"}, tab_id=tab_id)
        )
        mcp.browser_wait_network_idle(idle_ms=300, timeout_ms=5000, tab_id=tab_id)
        raw = mcp.browser_network_requests(tab_id=tab_id, filter="/api/data", include_headers=True)
        net = _data(raw)
        request = (net.get("requests") or [None])[-1] or {}
        auth = (request.get("requestHeaders") or {}).get("Authorization", "")
        check(
            "reseau_requete_fetch",
            request.get("status") == 200
            and request.get("method") == "GET"
            and request.get("type") == "Fetch"
            and isinstance(request.get("duration_ms"), int)
            and str(auth).startswith("[masked")
            and "secret-nexus-token" not in raw
            and "secret-cookie-value" not in raw,
            request or {"journal": raw[:1500], "clic": res},  # échec : ce que le pont a vu, pour le diagnostic
        )
        body = _data(mcp.browser_network_response(request.get("request_id", ""), tab_id=tab_id))
        check(
            "reseau_corps_reponse",
            body.get("binary") is False
            and "Données chargées" in (body.get("body") or "")
            and "secret-corps-jeton" not in (body.get("body") or "")
            and (body.get("masked") or 0) >= 1,
            body,
        )
        stopped = _data(mcp.browser_network_stop(tab_id=tab_id))
        check("reseau_enregistrement_arrete", stopped.get("recording") is False, stopped)
        cookies = _data(mcp.browser_get_cookies(tab_id=tab_id))
        check(
            "cookies_sans_valeur",
            cookies.get("valuesIncluded") is False and all("value" not in c for c in cookies.get("cookies") or []),
            cookies,
        )
        # 2.7.1 : valeurs seulement pour une origine locale de développement (la page de test est sur 127.0.0.1).
        local = _data(mcp.browser_get_cookies(tab_id=tab_id, include_values=True))
        check(
            "cookies_valeurs_origine_locale",
            local.get("valuesIncluded") is True
            and any(c.get("value") == "secret-cookie-value" for c in local.get("cookies") or []),
            {
                "valuesIncluded": local.get("valuesIncluded"),
                "noms": [c.get("name") for c in local.get("cookies") or []],
            },
        )
        refused = _error(mcp.browser_get_cookies(tab_id=tab_id, urls=["https://www.google.com/"], include_values=True))
        check("cookies_valeurs_refusees_hors_local", "local development origin" in refused, refused)
        # 2.7.1 : Runtime.evaluate dans le monde isolé par défaut, dans celui de la page sur demande (world="page").
        value_of("window.__nexusEtatSpa = {pret: 42}; 1")
        probe = {
            "expression": "window.__nexusEtatSpa ? window.__nexusEtatSpa.pret : 'invisible'",
            "returnByValue": True,
        }
        isolated = _data(mcp.browser_cdp_send("Runtime.evaluate", probe, tab_id=tab_id))
        page_world = _data(mcp.browser_cdp_send("Runtime.evaluate", probe, tab_id=tab_id, world="page"))
        check(
            "cdp_runtime_monde_isole_puis_page",
            (isolated.get("result") or {}).get("value") == "invisible"
            and (page_world.get("result") or {}).get("value") == 42
            and page_world.get("world") == "page",
            {"isole": isolated, "page": page_world},
        )
        # 2.8 : valeurs des mots de passe et des cartes jamais renvoyées (lectures, relecture de la saisie) ; eval
        # garde son accès complet à la page ; Page.reload ne peut plus injecter de script.
        secrets_live = ("MotDePasse-Live-1", "4970101234567890", "NouveauSecret-Live-2")
        reads = {
            "content": mcp.browser_content(tab_id=tab_id),
            "html": mcp.browser_content(tab_id=tab_id, mode="html"),
            "find": mcp.browser_find({"label": "Mot de passe"}, tab_id=tab_id),
        }
        # Carte visuelle : vue seulement. Champ amené au centre, position relue stable avant la capture (un défilement
        # laissé par les clics dans les cadres peut encore courir).
        in_view = (
            "(() => { const r = document.getElementById('pw').getBoundingClientRect(); "
            "return r.top >= 0 && r.bottom <= innerHeight; })()"
        )
        for _ in range(10):
            value_of("document.getElementById('pw').scrollIntoView({block: 'center', behavior: 'instant'}); 1")
            time.sleep(0.2)
            if value_of(in_view) is True:
                break
        reads["vision"] = mcp.browser_vision_inspect(tab_id=tab_id)
        leaked = {name: [x for x in secrets_live if x in raw] for name, raw in reads.items()}
        check(
            "secrets_valeurs_masquees_en_lecture",
            not any(leaked.values())
            and all("[masked value]" in raw for raw in reads.values())
            and parse_response(reads["content"]).get("status") == "success",
            {
                "fuites": leaked,
                "marqueur": {name: "[masked value]" in raw for name, raw in reads.items()},
                "vision": [(m.get("type"), m.get("rect")) for m in _data(reads["vision"]).get("markers", [])]
                or reads["vision"][:600],
            },
        )
        filled = mcp.browser_fill(locator={"label": "Mot de passe"}, value="NouveauSecret-Live-2", tab_id=tab_id)
        check(
            "secrets_fill_mot_de_passe_masque",
            _data(filled).get("verified") is True
            and _data(filled).get("value") == "[masked value]"
            and "NouveauSecret-Live-2" not in filled
            and value_of("document.getElementById('pw').value") == "NouveauSecret-Live-2",
            filled,
        )
        axtree = mcp.browser_axtree(tab_id=tab_id)
        check(
            "secrets_axtree_sans_mot_de_passe",
            parse_response(axtree).get("status") == "success" and not [x for x in secrets_live if x in axtree],
            [x for x in secrets_live if x in axtree] or "aucune valeur",
        )
        capture_masking_checks(check, tab_id, value_of)
        reload_refused = _error(
            mcp.browser_cdp_send("Page.reload", {"scriptToEvaluateOnLoad": "window.__injecte = 1"}, tab_id=tab_id)
        )
        check(
            "cdp_reload_script_refuse",
            "scriptToEvaluateOnLoad" in reload_refused
            and value_of("window.__injecte === undefined && !!window.__agyFull") is True,
            reload_refused,
        )
        orphan_check(check, fixture.url)
        res = parse_response(
            mcp.browser_click(locator={"role": "link", "name": "Télécharger le fichier de test"}, tab_id=tab_id)
        )
        dl = _data(mcp.browser_wait_download(tab_id=tab_id, timeout_ms=20000))
        download_path = dl.get("path")
        download_id = dl.get("id")
        content_ok = (
            bool(download_path)
            and Path(download_path).is_file()
            and (Path(download_path).read_text(encoding="utf-8") == fixture.download_content)
        )
        check("telechargement_termine", res.get("status") == "success" and content_ok, dl or res)

        # --- 5. Export du contenu principal (page d'article avec bruit) ------------------------------------------
        mcp.browser_navigate(fixture.article_url, tab_id=tab_id)
        mcp.browser_wait_load(timeout_ms=10000, tab_id=tab_id)
        exported = _data(mcp.browser_export(tab_id=tab_id))
        markdown = exported.get("content") or ""
        meta = exported.get("metadata") or {}
        missing = [m for m in ARTICLE_BODY_MARKERS if m not in markdown]
        noise = sorted(set(re.findall(r"BRUIT-[A-Z]+", markdown)))
        check(
            "export_markdown_corps_sans_bruit",
            not missing
            and not noise
            and "valeur-champ-secrete" not in markdown
            and "[la page du pont](http://127.0.0.1:" in markdown
            and exported.get("truncated") is False
            and (exported.get("root") or {}).get("method") == "article",
            {"manquants": missing, "bruit": noise, "racine": exported.get("root"), "debut": markdown[:300]},
        )
        check(
            "export_metadonnees",
            meta.get("author") == "Julien Piron"
            and meta.get("published") == "2026-10-16T08:30:00Z"
            and meta.get("lang") == "fr"
            and meta.get("title") == "Le pont NexusBrowser expliqué",
            meta,
        )
        zone = _data(mcp.browser_export(tab_id=tab_id, format="text", selector="table", max_chars=40))
        check(
            "export_zone_texte_tronque",
            (zone.get("content") or "").startswith("Port\tRôle")
            and zone.get("truncated") is True
            and len(zone.get("content") or "") <= 40,
            zone,
        )

        # --- Onglets de Julien -----------------------------------------------------------------------------------
        active_after = parse_response(mcp.browser_active_tab()).get("data", {}) or {}
        check(
            "onglet_reste_en_arriere_plan",
            active_after.get("id") == active_before.get("id") != tab_id,
            {"actif_avant": active_before.get("id"), "actif_apres": active_after.get("id")},
        )
    finally:
        if download_path:
            try:
                Path(download_path).unlink(missing_ok=True)
            except OSError as error:
                print(f"[!] Fichier téléchargé non supprimé ({download_path}) : {error}")
        if download_id is not None:
            try:
                bridge_client.call_bridge("download-erase", {"id": download_id}, 5.0, retry=False)
            except Exception as error:  # noqa: BLE001 - nettoyage au mieux, l'erreur est affichée
                print(f"[!] Entrée d'historique du téléchargement non retirée : {error}")
        if tab_id is not None:
            try:
                mcp.browser_close_tab(tab_id=tab_id)
            except Exception as error:  # noqa: BLE001
                print(f"[!] Fermeture de l'onglet {tab_id} impossible : {error}")
        fixture.close()

    time.sleep(0.3)
    remaining = _tab_ids(mcp.browser_list_tabs())
    check(
        "onglets_de_julien_intacts",
        initial_ids.issubset(remaining) and tab_id not in remaining,
        {
            "restants": len(remaining),
            "disparus": sorted(initial_ids - remaining),
            "test_encore_ouvert": tab_id in remaining,
        },
    )
    check("fichier_telecharge_supprime", not download_path or not Path(download_path).exists(), download_path or "")
    print("\n" + "=" * 60)
    print(f"VALIDATION COMPLÈTE : {sum(results.values())}/{len(results)} vérifications réussies")
    print("=" * 60)
    return results


# =============================================================================
# Exports réels (--exports-live, jamais lancé par test.ps1 -Full) : Google Docs/Sheets/Slides et YouTube avec la
# session de Julien, à partir d'URL qu'il fournit. Sans variable, vérification sautée (jamais comptée réussie).
# =============================================================================
# Serveur MCP « redémarré » : un vrai processus client de CET agent ouvre un onglet puis se termine (comme un serveur MCP
# planté ou relancé). Le pont voit son processus disparu : l'onglet devient orphelin, et cette session le reprend.
ORPHAN_CHILD = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
import bridge_client
bridge_client.set_identity(sys.argv[2])
print(json.dumps(bridge_client.call_bridge("create-tab", {"url": sys.argv[3], "background": True, "active": False}, 20.0)))
"""


def _shot(tab_id: int, selector: str) -> bytes:
    """Capture PNG d'un élément (outil réel, fichier temporaire supprimé), en octets."""
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "capture.png"
        res = parse_response(mcp.browser_screenshot(tab_id=tab_id, selector=selector, output_path=str(out)))
        if res.get("status") != "success" or not out.is_file():
            raise AssertionError(f"Capture {selector} impossible : {res}")
        return out.read_bytes()


def _pdf(tab_id: int) -> bytes:
    """PDF réel de la page, sans les métadonnées qui changent d'un export à l'autre (dates, identifiant)."""
    with tempfile.TemporaryDirectory() as folder:
        out = Path(folder) / "page.pdf"
        res = parse_response(mcp.browser_pdf(str(out), tab_id=tab_id))
        if res.get("status") != "success" or not out.is_file():
            raise AssertionError(f"PDF impossible : {res}")
        data = out.read_bytes()
    return re.sub(rb"/(CreationDate|ModDate) *\([^)]*\)|/ID *\[[^\]]*\]", b"", data)


def capture_masking_checks(check, tab_id: int, value_of) -> None:
    """2.9 (audit du 18/10) : un mot de passe affiché, une carte ou un code n'apparaît dans aucune image.

    Sans OCR : deux valeurs différentes de même longueur donnent la MÊME image si le champ est rendu en disques ;
    témoin : le même champ rendu ordinaire (nom changé) donne une image différente, preuve que la comparaison voit
    bien le texte. Même chose dans un cadre d'une autre origine, et pour le PDF.
    """

    def set_field(field_id: str, value: str, name: str) -> None:
        value_of(
            f"(() => {{ const e = document.getElementById({json.dumps(field_id)}); e.value = {json.dumps(value)}; "
            f"e.name = {json.dumps(name)}; e.blur(); return 1; }})()"
        )

    def inline_style(field_id: str) -> str:
        return value_of(f"document.getElementById({json.dumps(field_id)}).style.cssText")

    original_style = {field_id: inline_style(field_id) for field_id in ("shown", "cardname")}

    for field_id, name, first, second in (
        ("shown", "password", "AfficheLive3", "ZzzzzzzLive9"),
        ("cardname", "cardNumber", "5131420000001111", "4000056655665556"),
    ):
        set_field(field_id, first, name)
        a = _shot(tab_id, f"#{field_id}")
        set_field(field_id, second, name)
        b = _shot(tab_id, f"#{field_id}")
        set_field(field_id, second, "note")
        control = _shot(tab_id, f"#{field_id}")
        set_field(field_id, first, name)
        check(
            f"capture_{field_id}_en_disques",
            a == b and control != b and inline_style(field_id) == original_style[field_id],
            {"identiques": a == b, "temoin_different": control != b, "style_apres": inline_style(field_id)},
        )

    # PDF : mêmes valeurs, même document ; témoin ordinaire : document différent. La pastille d'état de l'agent
    # (« Nexus · ... », animée) est retirée avant chaque export : elle seule changeait d'un PDF à l'autre.
    def pdf_without_pill() -> bytes:
        value_of("(() => { const p = document.getElementById('__nexus_status_pill'); if (p) p.remove(); return 1; })()")
        return _pdf(tab_id)

    set_field("cardname", "5131420000001111", "cardNumber")
    pdf_a = pdf_without_pill()
    set_field("cardname", "4000056655665556", "cardNumber")
    pdf_b = pdf_without_pill()
    set_field("cardname", "4000056655665556", "note")
    pdf_control = pdf_without_pill()
    set_field("cardname", "5131420000001111", "cardNumber")
    check(
        "pdf_carte_en_disques",
        pdf_a == pdf_b and pdf_control != pdf_b and inline_style("cardname") == original_style["cardname"],
        {"identiques": pdf_a == pdf_b, "temoin_different": pdf_control != pdf_b, "tailles": [len(pdf_a), len(pdf_b)]},
    )

    # Cadre d'une autre origine (localhost dans une page 127.0.0.1) : lectures et capture.
    def set_frame_card(value: str, name: str) -> None:
        expected = f"{name}:{len(value)}:{value[:2]}"
        value_of(
            "document.getElementById('frame-a').contentWindow.postMessage("
            f"{{setCard: {json.dumps(value)}, name: {json.dumps(name)}}}, '*'); 1"
        )
        for _ in range(25):
            if value_of("(window.__agyFull.frames.A || {}).card") == expected:
                return
            time.sleep(0.1)
        raise AssertionError(f"Cadre A non réglé ({expected})")

    frame_secrets = ("6011000990139424", "3530111333300000")
    set_frame_card(frame_secrets[0], "cardNumber")
    reads = {
        "content": mcp.browser_content(tab_id=tab_id),
        "find": mcp.browser_find({"label": "Carte du cadre A"}, tab_id=tab_id),
    }
    found = _data(reads["find"])
    check(
        "cadre_autre_origine_lecture_masquee",
        not [x for raw in reads.values() for x in frame_secrets if x in raw]
        and "[masked value]" in reads["find"]
        and found.get("count") == 1,
        {"fuites": {k: [x for x in frame_secrets if x in v] for k, v in reads.items()}, "find": found},
    )
    a = _shot(tab_id, "#frame-a")
    set_frame_card(frame_secrets[1], "cardNumber")
    b = _shot(tab_id, "#frame-a")
    set_frame_card(frame_secrets[1], "note")
    control = _shot(tab_id, "#frame-a")
    set_frame_card(frame_secrets[0], "cardNumber")
    check(
        "cadre_autre_origine_capture_en_disques",
        a == b and control != b,
        {"identiques": a == b, "temoin_different": control != b},
    )


def orphan_check(check, url: str) -> None:
    """2.7.1 : onglets orphelins après redémarrage d'un serveur MCP (repris, puis fermés)."""
    child = subprocess.run(
        [sys.executable, "-B", "-c", ORPHAN_CHILD, str(ROOT / "client"), mcp.AGENT_NAME, url],
        capture_output=True,
        text=True,
        timeout=60,
    )
    orphan = (json.loads(child.stdout or "{}") or {}).get("id") if child.returncode == 0 else None
    check(
        "orphelin_onglet_ouvert_par_un_processus_termine", isinstance(orphan, int), child.stderr[-600:] or child.stdout
    )
    if not isinstance(orphan, int):
        return
    try:
        listed = parse_response(mcp.browser_list_tabs()).get("data") or []
        state = next((t.get("state") for t in listed if t.get("id") == orphan), None)
        check("orphelin_vu_par_la_nouvelle_session", state == "orphan", state)
        refused = _error(mcp.browser_eval("1", tab_id=orphan))
        check("orphelin_refuse_avant_reprise", "orphaned" in refused, refused)
        adopted = _data(mcp.browser_adopt_tab(orphan))
        check("orphelin_repris_sans_julien_asked", adopted.get("reclaimed") is True, adopted)
        check("orphelin_pilotable_apres_reprise", get_eval_val(mcp.browser_eval("6 * 7", tab_id=orphan)) == 42, orphan)
    finally:
        closed = parse_response(mcp.browser_close_tab(tab_id=orphan))
        check("orphelin_ferme", closed.get("status") == "success", closed)


def run_exports_validation() -> tuple[dict[str, bool], list[str]]:
    results: dict[str, bool] = {}
    skipped: list[str] = []

    def check(name: str, condition: bool, detail) -> None:
        results[name] = bool(condition)
        text = json.dumps(detail, ensure_ascii=False, default=str) if not isinstance(detail, str) else detail
        print(f"[{'OK' if condition else 'ÉCHEC'}] {name} : {text[:600]}")

    def in_agent_tab(url: str, work) -> None:
        tab_id = None
        initial = _tab_ids(mcp.browser_list_tabs(), julien_only=True)
        active_before = (parse_response(mcp.browser_active_tab()).get("data") or {}).get("id")
        try:
            created = parse_response(mcp.browser_new_tab(url, background=True))
            tab_id = (created.get("data") or {}).get("id")
            assert tab_id, f"Onglet d'agent non créé : {created}"
            mcp.browser_wait_load(timeout_ms=20000, tab_id=tab_id)
            mcp.browser_wait_network_idle(idle_ms=500, timeout_ms=10000, tab_id=tab_id)
            try:
                work(tab_id)
            except Exception as error:  # noqa: BLE001 - une panne de l'export est un échec, jamais un arrêt muet
                check(f"{work.__name__}_sans_exception", False, repr(error))
            active_after = (parse_response(mcp.browser_active_tab()).get("data") or {}).get("id")
            check(f"{work.__name__}_onglet_en_arriere_plan", active_after == active_before != tab_id, active_after)
        finally:
            if tab_id is not None:
                mcp.browser_close_tab(tab_id=tab_id)
            time.sleep(0.3)
            remaining = _tab_ids(mcp.browser_list_tabs())
            check(
                f"{work.__name__}_onglet_ferme", initial.issubset(remaining) and tab_id not in remaining, len(remaining)
            )

    gdoc = os.environ.get("AGY_TEST_GDOC_URL", "").strip()
    if gdoc:

        def google(tab_id: int) -> None:
            text = _data(mcp.browser_export_gsuite(tab_id=tab_id))
            check(
                "gsuite_texte_non_vide",
                bool((text.get("text") or "").strip()) and text.get("binary") is False,
                {k: v for k, v in text.items() if k != "text"} | {"debut": (text.get("text") or "")[:200]},
            )
            pdf = _data(mcp.browser_export_gsuite(tab_id=tab_id, format="pdf"))
            path = Path(pdf.get("output_path") or "")
            try:
                ok = path.is_file() and path.stat().st_size > 100 and path.read_bytes()[:5] == b"%PDF-"
                check("gsuite_pdf_sur_disque", ok and "base64" not in pdf, pdf)
            finally:
                if pdf.get("output_path"):
                    path.unlink(missing_ok=True)

        in_agent_tab(gdoc, google)
    else:
        skipped.append("gsuite (AGY_TEST_GDOC_URL absente)")
    video = os.environ.get("AGY_TEST_YOUTUBE_URL", "").strip()
    if video:

        def youtube(tab_id: int) -> None:
            res = parse_response(mcp.browser_youtube_transcript(tab_id=tab_id))
            data = res.get("data") or {}
            check(
                "youtube_transcription_non_vide",
                res.get("status") == "success"
                and bool((data.get("text") or "").strip())
                and (data.get("timed_text") or "").startswith("["),
                {k: v for k, v in data.items() if k not in ("text", "timed_text")} | {"erreur": res.get("error")},
            )

        in_agent_tab(video, youtube)
    else:
        skipped.append("youtube (AGY_TEST_YOUTUBE_URL absente)")
    for name in skipped:
        print(f"[SAUTÉ] {name} : jamais comptée réussie")
    return results, skipped


def serve_fixture() -> None:
    """Sert seulement la page de --full-live (vérification à la main ou banc local), jusqu'à Ctrl+C."""
    fixture = FullFixture()
    print(
        json.dumps(
            {
                "url": fixture.url,
                "main_port": fixture.main_port,
                "frame_port": fixture.frame_port,
                "token": fixture.token,
            }
        ),
        flush=True,
    )
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        fixture.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Validation réelle du pont navigateur NexusBrowser sur le Chrome de Julien."
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--mouse", action="store_true", help="seulement les vraies actions de souris CDP (onglet en arrière-plan)"
    )
    mode.add_argument(
        "--full-live",
        action="store_true",
        help="localisateurs, frappe de confiance, iframes d'une autre origine, réseau et téléchargement",
    )
    mode.add_argument(
        "--exports-live",
        action="store_true",
        help="exports Google (AGY_TEST_GDOC_URL) et YouTube (AGY_TEST_YOUTUBE_URL) ; sautés sans ces variables",
    )
    mode.add_argument("--all", action="store_true", help="suite historique, souris puis validation complète")
    mode.add_argument("--serve-fixture", action="store_true", help="servir la page de --full-live sans rien lancer")
    args = parser.parse_args()
    if args.serve_fixture:
        serve_fixture()
        sys.exit(0)
    preflight()
    results: dict[str, bool] = {}
    if args.exports_live:
        exported, skipped = run_exports_validation()
        results.update({f"exports:{name}": ok for name, ok in exported.items()})
        failed = [name for name, ok in results.items() if not ok]
        if failed or not results:
            print(f"\n>>> ÉCHECS : {', '.join(failed) or 'aucune vérification exécutée (variables absentes)'}")
            sys.exit(1)
        print(f"\n>>> EXPORTS VALIDÉS SUR CHROME{' (sautés : ' + ', '.join(skipped) + ')' if skipped else ''} <<<")
        sys.exit(0)
    if not (args.mouse or args.full_live):
        results.update(run_live_validation())
    if args.mouse or args.all:
        results.update({f"souris:{name}": ok for name, ok in run_mouse_validation().items()})
    if args.full_live or args.all:
        results.update({f"complet:{name}": ok for name, ok in run_full_validation().items()})
    failed = [name for name, ok in results.items() if not ok]
    if failed or not results:
        print(f"\n>>> ÉCHECS : {', '.join(failed) or 'aucune vérification exécutée'}")
        sys.exit(1)
    print("\n>>> TOUTES LES VÉRIFICATIONS ONT ÉTÉ VALIDÉES EN CONDITIONS RÉELLES SUR CHROME <<<")
