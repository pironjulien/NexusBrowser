#!/usr/bin/env python3
"""
CLI du pont NexusBrowser : les onglets Chrome de Julien par l'extension Nexus Browser Bridge (même pont, mêmes
garde-fous que le serveur MCP nexus-browser).

Identité : agent « CLI », session « cli » (stable d'un appel à l'autre, NEXUS_BROWSER_CLIENT pour en changer) :
les onglets ouverts par `new-tab` restent pilotables par les appels suivants ; ceux de Julien et des agents, jamais.
Chaque commande de page exige --tab-id (l'id renvoyé par new-tab).
"""

import argparse
import base64
import json
import sys

# Aucun __pycache__ à côté des sources (OneDrive), quel que soit le lanceur.
sys.dont_write_bytecode = True

try:  # noqa: E402
    from .bridge_client import call_bridge
except ImportError:
    from bridge_client import call_bridge

from bridge_security import VERSION  # noqa: E402  (chemin ajouté par bridge_client)


def execute_command(action, params=None, timeout=15.0, retry=True):
    """Backward-compatible CLI entry point backed by the shared transport."""
    return call_bridge(action, params, timeout, retry=retry)


def parse_locator(raw):
    """--locator '{"role": "button", "name": "Valider"}' -> dict (None si absent)."""
    if not raw:
        return None
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("--locator doit être un objet JSON")
    return value


def with_locator(params, args):
    locator = parse_locator(getattr(args, "locator", None))
    if locator:
        params["locator"] = locator
    return params


TAB_HELP = "Onglet ouvert par new-tab (obligatoire)"


def page_command(subparsers, name, help_text):
    """Sous-commande de page : --tab-id obligatoire (aucun onglet courant, jamais l'onglet actif de Julien)."""
    parser = subparsers.add_parser(name, help=help_text)
    parser.add_argument("--tab-id", required=True, type=int, help=TAB_HELP)
    return parser


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=f"Pont Chrome NexusBrowser {VERSION} (CLI)")
    parser.add_argument("--version", action="version", version=f"NexusBrowser {VERSION}")
    subparsers = parser.add_subparsers(dest="subcommand", help="Commande")

    subparsers.add_parser("list-tabs", help="Onglets ouverts, avec l'agent qui pilote chacun")
    subparsers.add_parser("active-tab", help="Identité de l'onglet actif de Julien (lecture seule)")
    page_command(subparsers, "select-tab", "Mettre au premier plan un onglet de cette session")

    p_new = subparsers.add_parser("new-tab", help="Ouvrir un onglet de fond (renvoie son id)")
    p_new.add_argument("--url", default="about:blank", help="URL (http, https, data: ou about:blank)")

    p_adopt = subparsers.add_parser("adopt-tab", help="Prendre un onglet de Julien, seulement s'il l'a demandé")
    p_adopt.add_argument("--tab-id", required=True, type=int, help="Onglet de Julien")
    p_adopt.add_argument("--julien-asked", action="store_true", help="Julien l'a demandé explicitement")
    page_command(subparsers, "release-tab", "Rendre l'onglet à Julien (sans le fermer)")
    page_command(subparsers, "close-tab", "Fermer un onglet de cette session")

    p_reload = page_command(subparsers, "reload", "Recharger l'onglet")
    p_reload.add_argument("--bypass-cache", action="store_true", help="Sans le cache")

    p_nav = page_command(subparsers, "navigate", "Naviguer vers une URL")
    p_nav.add_argument("--url", required=True, help="URL (http, https, data: ou about:blank)")

    p_hover = page_command(subparsers, "hover", "Survoler un élément (vraie souris CDP)")
    p_hover.add_argument("--selector", help="Sélecteur CSS")
    p_hover.add_argument("--text", help="Texte visible")
    p_hover.add_argument("--locator", help='Localisateur JSON, ex. {"role": "button", "name": "Menu"}')

    p_click = page_command(subparsers, "click", "Cliquer un élément (vraie souris CDP)")
    p_click.add_argument("--selector", help="Sélecteur CSS")
    p_click.add_argument("--text", help="Texte visible")
    p_click.add_argument("--button", choices=["left", "right", "middle"], default="left", help="Bouton")
    p_click.add_argument("--click-count", type=int, choices=[1, 2], default=1, help="2 pour un double clic")
    p_click.add_argument("--locator", help='Localisateur JSON, ex. {"role": "button", "name": "Valider"}')

    p_fill = page_command(subparsers, "fill", "Remplir un champ (frappe de confiance)")
    p_fill.add_argument("--selector", help="Sélecteur CSS")
    p_fill.add_argument("--value", required=True, help="Texte à saisir")
    p_fill.add_argument("--locator", help='Localisateur JSON, ex. {"label": "Email"}')
    p_fill.add_argument("--append", action="store_true", help="Ajouter au lieu de remplacer")
    p_fill.add_argument("--keys", nargs="+", help="Touches ensuite (Enter, Control+Enter)")
    p_fill.add_argument("--mode", choices=["auto", "trusted", "setter"], default="auto", help="Mode de saisie")

    p_find = page_command(subparsers, "find", "Lister les éléments d'un localisateur (sans agir)")
    p_find.add_argument("--locator", required=True, help='Localisateur JSON, ex. {"role": "button", "name": "Valider"}')
    p_find.add_argument("--limit", type=int, default=20)

    p_check = page_command(subparsers, "check", "Cocher (ou --uncheck) une case, un radio ou un interrupteur")
    p_check.add_argument("--locator", help='Localisateur JSON, ex. {"role": "checkbox", "name": "J\'accepte"}')
    p_check.add_argument("--selector", help="Sélecteur CSS")
    p_check.add_argument("--uncheck", action="store_true", help="Décocher")

    p_rec = page_command(subparsers, "network-record", "Garder l'enregistrement réseau pendant une durée bornée")
    p_rec.add_argument("--duration", type=int, default=120, help="Secondes (600 au plus)")
    page_command(subparsers, "network-stop", "Arrêter l'enregistrement réseau (débogueur détaché)")
    p_net = page_command(subparsers, "network-requests", "Requêtes réseau enregistrées (secrets masqués)")
    p_net.add_argument("--filter", help="Fragment d'URL ou /regex/")
    p_net.add_argument("--limit", type=int, default=50)
    p_net.add_argument("--headers", action="store_true", help="Avec les en-têtes (secrets masqués)")
    p_body = page_command(subparsers, "network-response", "Corps d'une réponse (champs secrets masqués)")
    p_body.add_argument("--request-id", required=True)
    p_body.add_argument("--max-bytes", type=int, default=65536)

    p_wdl = page_command(subparsers, "wait-download", "Attendre la fin d'un téléchargement de l'onglet")
    p_wdl.add_argument("--timeout", type=int, default=30000, help="Millisecondes")

    p_typekeys = page_command(subparsers, "type-keys", "Frappe touche par touche")
    p_typekeys.add_argument("--text", required=True, help="Texte")

    p_scroll = page_command(subparsers, "scroll", "Faire défiler la page")
    p_scroll.add_argument("--direction", choices=["up", "down"], default="down")
    p_scroll.add_argument("--y", type=int, help="Pixels")

    p_content = page_command(subparsers, "content", "Texte ou éléments interactifs de la page")
    p_content.add_argument("--mode", choices=["text", "interactive", "html"], default="interactive")

    page_command(subparsers, "axtree", "Arbre d'accessibilité")
    page_command(subparsers, "logs", "Console DevTools de l'onglet")

    p_dlg = page_command(subparsers, "dialog", "Répondre à une boîte alert/confirm/prompt")
    p_dlg.add_argument("--action", choices=["accept", "dismiss"], default="accept")
    p_dlg.add_argument("--prompt-text", default="", help="Texte d'une boîte prompt")

    p_eval = page_command(subparsers, "eval", "JavaScript dans le monde de la page")
    p_eval.add_argument("--code", required=True, help="Expression JavaScript")

    p_shot = page_command(subparsers, "screenshot", "Capture de l'onglet ou d'un élément")
    p_shot.add_argument("--selector", help="Sélecteur CSS de l'élément")
    p_shot.add_argument("--output", default="screenshot.png", help="Fichier PNG")

    p_pdf = page_command(subparsers, "pdf", "Export PDF de la page")
    p_pdf.add_argument("--output", default="page.pdf", help="Fichier PDF")

    p_upload = page_command(subparsers, "upload", "Téléverser des fichiers (jamais d'un dossier de secrets)")
    p_upload.add_argument("--files", required=True, nargs="+", help="Chemins absolus")
    p_upload.add_argument("--selector", help="input[type=file] ou bouton de téléversement")

    p_som = page_command(subparsers, "vision-inspect", "Badges numérotés et capture")
    p_som.add_argument("--output", default="vision_som.png", help="Fichier PNG")

    p_cmark = page_command(subparsers, "click-mark", "Cliquer un élément par son numéro de badge")
    p_cmark.add_argument("--mark", required=True, type=int, help="Numéro (vision-inspect, interactive-map)")

    p_sclick = page_command(subparsers, "semantic-click", "Clic par rôle et nom accessible")
    p_sclick.add_argument("--role", help="Rôle (button, link, tab...)")
    p_sclick.add_argument("--name", help="Nom accessible")
    p_sclick.add_argument("--text", help="Texte visible")

    p_sfill = page_command(subparsers, "semantic-fill", "Remplir un champ par son libellé ou son placeholder")
    p_sfill.add_argument("--label", required=True, help="Libellé ou placeholder")
    p_sfill.add_argument("--value", required=True, help="Texte")

    page_command(subparsers, "check-handoff", "Détecter CAPTCHA, Turnstile ou 2FA")
    subparsers.add_parser("download-status", help="Téléchargements récents")

    p_pkey = page_command(subparsers, "press-key", "Touche ou raccourci (Enter, Escape, Control+A...)")
    p_pkey.add_argument("--key", default="Enter", help="Touche")

    p_sopt = page_command(subparsers, "select-option", "Choisir une option d'un <select>")
    p_sopt.add_argument("--selector", default="select", help="Sélecteur du <select>")
    p_sopt.add_argument("--value", help="Valeur de l'option")
    p_sopt.add_argument("--text", help="Texte visible de l'option")

    p_wload = page_command(subparsers, "wait-load", "Attendre le document complet")
    p_wload.add_argument("--timeout", type=int, default=8000, help="Millisecondes")

    p_nwid = page_command(subparsers, "wait-network-idle", "Attendre la fin des requêtes")
    p_nwid.add_argument("--idle-ms", type=int, default=300, help="Millisecondes sans requête")
    p_nwid.add_argument("--timeout", type=int, default=8000, help="Millisecondes")

    p_cookies = page_command(subparsers, "get-cookies", "Noms et attributs des cookies (jamais leurs valeurs)")
    p_cookies.add_argument("--urls", nargs="+", help="URLs")

    p_cdp = page_command(subparsers, "cdp-send", "Commande CDP de la liste des commandes permises")
    p_cdp.add_argument("--method", required=True, help="Méthode CDP (ex. DOM.getDocument)")
    p_cdp.add_argument("--params", default="{}", help="Paramètres JSON")

    p_imap = page_command(subparsers, "interactive-map", "Carte compacte des éléments interactifs")
    p_imap.add_argument("--viewport-only", action="store_true", default=True, help="Vue visible seulement")
    p_imap.add_argument("--max-elements", type=int, default=60, help="Nombre maximal d'éléments")

    p_dnd = page_command(subparsers, "drag-and-drop", "Glisser-déposer (vraie souris CDP)")
    p_dnd.add_argument("--from-selector", help="Sélecteur de la source")
    p_dnd.add_argument("--to-selector", help="Sélecteur de la destination")
    p_dnd.add_argument("--from-mark", type=int, help="Badge de la source")
    p_dnd.add_argument("--to-mark", type=int, help="Badge de la destination")
    p_dnd.add_argument("--from-coords", help="Coordonnées de la source x,y")
    p_dnd.add_argument("--to-coords", help="Coordonnées de la destination x,y")
    p_dnd.add_argument("--steps", type=int, default=12, help="Étapes intermédiaires")
    return parser


def _coords(raw):
    if not raw:
        return None
    parts = [int(p.strip()) for p in raw.split(",") if p.strip().lstrip("-").isdigit()]
    return {"x": parts[0], "y": parts[1]} if len(parts) >= 2 else None


def _save(data_url_or_b64, output, is_data_url=True):
    payload = data_url_or_b64.split(",", 1)[1] if is_data_url and "," in data_url_or_b64 else data_url_or_b64
    with open(output, "wb") as stream:
        stream.write(base64.b64decode(payload))


def run(args) -> object:
    """Exécute la sous-commande ; renvoie le résultat brut du pont."""
    tab = getattr(args, "tab_id", None)
    command = args.subcommand
    simple = {
        "list-tabs": ("list_tabs", {}),
        "active-tab": ("get_active_tab", {}),
        "download-status": ("download_status", {}),
    }
    if command in simple:
        return execute_command(*simple[command])
    if command == "new-tab":
        return execute_command("create_tab", {"url": args.url})
    if command == "adopt-tab":
        return execute_command("adopt_tab", {"tabId": tab, "julienAsked": args.julien_asked})
    tab_only = {
        "select-tab": "select_tab",
        "release-tab": "release_tab",
        "close-tab": "close_tab",
        "network-stop": "network_stop",
        "axtree": "get_accessibility_tree",
        "logs": "get_logs",
        "check-handoff": "check_handoff",
    }
    if command in tab_only:
        return execute_command(tab_only[command], {"tabId": tab})
    if command == "reload":
        return execute_command("reload", {"tabId": tab, "bypassCache": args.bypass_cache})
    if command == "navigate":
        return execute_command("navigate", {"url": args.url, "tabId": tab})
    if command == "hover":
        return execute_command(
            "hover", with_locator({"selector": args.selector, "text": args.text, "tabId": tab}, args)
        )
    if command == "click":
        params = {
            "selector": args.selector,
            "text": args.text,
            "button": args.button,
            "clickCount": args.click_count,
            "tabId": tab,
        }
        return execute_command("click", with_locator(params, args))
    if command == "fill":
        params = {"selector": args.selector, "value": args.value, "tabId": tab, "replace": not args.append}
        params["mode"] = args.mode
        if args.keys:
            params["keys"] = args.keys
        return execute_command("fill", with_locator(params, args))
    if command == "find":
        return execute_command("find", {"locator": parse_locator(args.locator), "limit": args.limit, "tabId": tab})
    if command == "check":
        return execute_command(
            "check", with_locator({"selector": args.selector, "checked": not args.uncheck, "tabId": tab}, args)
        )
    if command == "network-record":
        return execute_command("network_record", {"tabId": tab, "durationS": args.duration})
    if command == "network-requests":
        params = {"filter": args.filter, "limit": args.limit, "includeHeaders": args.headers, "tabId": tab}
        return execute_command("network_requests", params)
    if command == "network-response":
        return execute_command(
            "network_response", {"request_id": args.request_id, "maxBytes": args.max_bytes, "tabId": tab}
        )
    if command == "wait-download":
        return execute_command(
            "wait_download", {"timeoutMs": args.timeout, "tabId": tab}, timeout=args.timeout / 1000 + 5
        )
    if command == "type-keys":
        return execute_command("type_keys", {"text": args.text, "tabId": tab})
    if command == "scroll":
        return execute_command("scroll", {"direction": args.direction, "y": args.y, "tabId": tab})
    if command == "content":
        return execute_command("get_content", {"mode": args.mode, "tabId": tab})
    if command == "dialog":
        params = {"accept": args.action == "accept", "promptText": args.prompt_text, "tabId": tab}
        return execute_command("handle_dialog", params)
    if command == "eval":
        return execute_command("evaluate", {"code": args.code, "tabId": tab})
    if command == "screenshot":
        res = execute_command("screenshot", {"selector": args.selector, "tabId": tab})
        _save(res.get("dataUrl", ""), args.output)
        return {"output": args.output}
    if command == "pdf":
        res = execute_command("print_pdf", {"tabId": tab})
        _save(res.get("pdfBase64", ""), args.output, is_data_url=False)
        return {"output": args.output}
    if command == "upload":
        params = {"files": args.files, "selector": args.selector, "tabId": tab}
        return execute_command("upload_file", params, timeout=30.0)
    if command == "vision-inspect":
        res = execute_command("vision_inspect", {"tabId": tab}, timeout=20.0)
        _save(res.get("screenshotDataUrl", ""), args.output)
        return {"output": args.output, "markers": res.get("markers", [])}
    if command == "click-mark":
        return execute_command("click_mark", {"mark": args.mark, "tabId": tab})
    if command == "semantic-click":
        return execute_command(
            "semantic_click", {"role": args.role, "name": args.name, "text": args.text, "tabId": tab}
        )
    if command == "semantic-fill":
        return execute_command("semantic_fill", {"label": args.label, "value": args.value, "tabId": tab})
    if command == "press-key":
        return execute_command("press_key", {"key": args.key, "tabId": tab})
    if command == "select-option":
        params = {"selector": args.selector, "value": args.value, "text": args.text, "tabId": tab}
        return execute_command("select_option", params)
    if command == "wait-load":
        return execute_command("wait_load", {"timeoutMs": args.timeout, "tabId": tab})
    if command == "wait-network-idle":
        params = {"idleMs": args.idle_ms, "timeoutMs": args.timeout, "tabId": tab}
        return execute_command("wait_network_idle", params)
    if command == "get-cookies":
        return execute_command("get_cookies", {"urls": args.urls, "tabId": tab})
    if command == "cdp-send":
        cdp_params = json.loads(args.params) if isinstance(args.params, str) else args.params
        return execute_command("cdp_send", {"method": args.method, "commandParams": cdp_params, "tabId": tab})
    if command == "interactive-map":
        params = {"viewportOnly": args.viewport_only, "maxElements": args.max_elements, "tabId": tab}
        return execute_command("interactive_map", params)
    if command == "drag-and-drop":
        params = {
            "from_selector": args.from_selector,
            "to_selector": args.to_selector,
            "from_mark": args.from_mark,
            "to_mark": args.to_mark,
            "from_coordinates": _coords(args.from_coords),
            "to_coordinates": _coords(args.to_coords),
            "steps": args.steps,
            "tabId": tab,
        }
        return execute_command("drag_and_drop", params)
    raise ValueError(f"Sous-commande inconnue : {command}")


def main():
    parser = build_parser()
    args = parser.parse_args()
    if not args.subcommand:
        parser.print_help()
        sys.exit(1)
    try:
        print(json.dumps(run(args), indent=2, ensure_ascii=False))
    except Exception as e:
        print(f"Erreur : {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
