"""
Accord lié à l'action exacte pour les gestes SORTANTS du navigateur (accord de la trinité du 19/10/2026,
« ameliorations-outils », priorité 1), commun au serveur MCP et à la CLI.

Avant un clic, une touche Entrée / Ctrl+Entrée / Espace, une frappe qui contient un saut de ligne ou un glisser, le
déclencheur visé est lu SANS geste par le chemin qui existe déjà dans le pont et l'extension : l'action find (cible par
localisateur) et un script en lecture seule (trigger_probe.js) évalué dans le monde isolé de l'onglet par cdp-send
(Runtime.evaluate). Aucune action nouvelle d'extension : marche avec l'extension déjà chargée. Lu : libellé de
l'élément cliquable, boutons d'envoi du formulaire de l'élément actif, champs de ce formulaire (jamais la valeur d'un
champ sensible), destinataires et pièces jointes reconnaissables, URL et titre de l'onglet. Si la politique commune
(garde_fous.outward_word) y voit un geste sortant (envoyer, payer, publier, commander, appeler, transférer...), le geste
exige confirm=true ET accord=<jeton> lié à CETTE action exacte (garde_fous.Accords.check) ; sinon il reste libre.

Échec fermé seulement quand la lecture échoue vraiment (réponse inattendue, script en erreur, focus dans un cadre d'une
autre origine, formulaire d'un champ visé par Entrée illisible). Textes rendus au modèle en anglais. Copie embarquée de
la politique : garde_fous.py et garde-fous.json à côté de ce module, identiques à NexusHarness/shared
(test_outward_accord.py le vérifie quand ce dossier existe).
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

try:
    from . import garde_fous
except ImportError:
    import garde_fous

TOOL = "browser"
MASKED = "[masked value]"

# Touches qui déclenchent (dernier élément d'une combinaison) et noms canoniques des modificateurs.
TRIGGER_KEYS = {"enter": "Enter", "numpadenter": "Enter", "return": "Enter", "space": "Space", "spacebar": "Space"}
MODIFIERS = {
    "control": "Control",
    "ctrl": "Control",
    "meta": "Meta",
    "cmd": "Meta",
    "command": "Meta",
    "shift": "Shift",
    "alt": "Alt",
    "option": "Alt",
}

Reader = Callable[[str, dict, float], Any]


def key_gesture(combo: Any) -> str:
    """« Control+Enter » -> « Control+Enter » (geste canonique) si la touche déclenche (Entrée, Espace), « » sinon."""
    text = str(combo or "")
    if text == " ":
        return "Space"
    parts = [part.strip() for part in text.split("+")]
    kind = TRIGGER_KEYS.get(parts[-1].lower()) if parts and parts[-1] else None
    if not kind:
        return ""
    modifiers = sorted({MODIFIERS.get(part.lower(), part) for part in parts[:-1] if part})
    return "+".join([*modifiers, kind])


def typed_gestures(text: Any = "", keys: Iterable[Any] | None = None) -> list[str]:
    """Gestes déclencheurs d'une frappe : saut de ligne du texte (Entrée), espace (Espace sur un bouton actif), puis
    chaque touche envoyée ensuite."""
    found: list[str] = []
    value = str(text or "")
    if "\n" in value or "\r" in value:
        found.append("Enter")
    if " " in value:
        found.append("Space")
    for combo in keys or []:
        if (gesture := key_gesture(combo)) and gesture not in found:
            found.append(gesture)
    return found


def _context(data: dict) -> str:
    """Origine + chemin de l'onglet (jamais la requête ni le fragment : jetons, identifiants de session)."""
    url = str(data.get("tabUrl") or data.get("url") or "")
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    if parts.netloc:
        return f"{parts.scheme}://{parts.netloc}{parts.path}"[:300]
    return f"{parts.scheme}:" if parts.scheme else ""


def _content(data: dict) -> str:
    lines = []
    for field in data.get("fields") or []:
        if not isinstance(field, dict):
            continue
        label = str(field.get("label") or field.get("type") or "field")
        value = MASKED if field.get("masked") else str(field.get("value") or "")
        if value:
            lines.append(f"{label}: {value}")
    return " | ".join(lines)


def triggers(data: dict, gestures: Iterable[str]) -> list[str]:
    """Libellés que le geste déclencherait : clic = l'élément cliqué (sauf un champ de saisie, qui ne fait que prendre
    le focus) ; Espace = l'élément actif s'il est un bouton ; Entrée = l'élément actif s'il est un bouton, sinon les
    boutons d'envoi du formulaire du champ actif."""
    label = str(data.get("label") or "")
    clickable = bool(data.get("clickable"))
    field = bool(data.get("field"))
    found: list[str] = []
    for gesture in gestures:
        kind = gesture.rsplit("+", 1)[-1]
        if kind in ("click", "drag"):
            candidates = [label] if clickable or not field else []
        elif kind == "Space":
            candidates = [label] if clickable else []
        elif clickable:
            candidates = [label]
        elif field:
            candidates = [str(s) for s in data.get("submits") or []]
        else:
            candidates = []
        found += [c for c in candidates if c and c not in found]
    return found


def describe_action(data: dict, gesture: str, label: str, typed: str = "") -> dict[str, Any]:
    """Action canonique : le texte frappé avec le geste (frappe puis Entrée) fait partie du contenu."""
    content = _content(data)
    if typed:
        content = f"{content} | typed: {typed}" if content else f"typed: {typed}"
    return garde_fous.action(
        TOOL,
        gesture,
        target=label,
        recipients=[str(r) for r in data.get("recipients") or []],
        content=content,
        attachments=[str(a) for a in data.get("attachments") or []],
        context=_context(data),
    )


class AccordRequired(Exception):
    """Geste sortant sans l'accord lié à cette action exacte : rien n'a été fait (message pour l'agent, en anglais)."""


PROBE_JS = (Path(__file__).resolve().with_name("trigger_probe.js")).read_text(encoding="utf-8").strip()
ACTIVE_ROLES = {
    "button",
    "link",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "option",
    "switch",
    "treeitem",
}
FIELD_ROLES = {"textbox", "searchbox", "combobox"}
POLL_S = 0.1


def _unreadable(why: str) -> RuntimeError:
    return RuntimeError(f"Outward-action check: the trigger could not be read ({why}). Nothing was done.")


def _probe(call: Reader, tab_id: Any, spec: dict, timeout: float) -> dict:
    """Script en lecture seule (trigger_probe.js) dans le monde isolé de l'onglet, par cdp-send (Runtime.evaluate)."""
    expression = f"{PROBE_JS}({json.dumps(spec, ensure_ascii=False)})"
    params = {
        "method": "Runtime.evaluate",
        "commandParams": {"expression": expression, "returnByValue": True, "awaitPromise": False},
        "tab_id": tab_id,
    }
    # Le registre de l'extension connaît le cadre du marqueur. Même cible que
    # le geste, sans lecture du mauvais document et sans élargir son accord.
    if spec.get("mark") is not None:
        params["mark"] = int(spec["mark"])
    data = call("cdp-send", params, timeout)
    if isinstance(data, dict) and data.get("dialogOpened"):
        return data
    if not isinstance(data, dict) or data.get("exceptionDetails"):
        details = data.get("exceptionDetails") if isinstance(data, dict) else None
        text = (details or {}).get("text") if isinstance(details, dict) else None
        raise _unreadable(str(text or "script error"))
    value = (data.get("result") or {}).get("value") if isinstance(data.get("result"), dict) else None
    if not isinstance(value, dict) or not any(
        value.get(k) for k in ("success", "notFound", "unreachable", "crossOriginFocus")
    ):
        raise _unreadable("unexpected answer")
    return value


def _found(call: Reader, tab_id: Any, target: dict, timeout: float) -> list[dict]:
    """Cible par localisateur : l'action find, en lecture seule, comme le geste (strict, nth, tous les cadres) ; puis
    le formulaire de l'élément trouvé lu par le script (cadre principal)."""
    locator = dict(target["locator"])
    found = call("find", {"locator": locator, "limit": 100, "tab_id": tab_id}, timeout)
    if isinstance(found, dict) and found.get("dialogOpened"):
        return [found]
    if not isinstance(found, dict) or not isinstance(found.get("candidates"), list):
        raise _unreadable("unexpected answer to find")
    candidates = [c for c in found["candidates"] if isinstance(c, dict)]
    if not candidates:
        return [{"notFound": True, "reason": f"No element matches the locator {json.dumps(locator)}"}]
    nth = locator.get("nth")
    if nth is None:
        if len(candidates) > 1:
            return [{"success": True, "ambiguous": True}]  # le geste strict refusera lui-même, sans rien faire
        chosen = candidates
    else:
        try:
            chosen = [candidates[int(nth)]]
        except (ValueError, IndexError):
            return [{"success": True, "ambiguous": True}]
    out = []
    for candidate in chosen:
        role = str(candidate.get("role") or "").lower()
        tag = str(candidate.get("tag") or "").lower()
        clickable = role in ACTIVE_ROLES or tag in ("button", "a", "summary")
        data: dict = {
            "success": True,
            "label": str(candidate.get("name") or ""),
            "clickable": clickable,
            "field": not clickable and (role in FIELD_ROLES or tag in ("input", "textarea", "select")),
            "formUnknown": True,
        }
        box = candidate.get("box") if isinstance(candidate.get("box"), dict) else None
        if not candidate.get("crossOriginFrame") and (box or candidate.get("id")):
            spec: dict = {"tag": tag}
            if candidate.get("id"):
                spec["id"] = candidate["id"]
            if box:
                spec["point"] = {"x": box["x"] + box["width"] / 2, "y": box["y"] + box["height"] / 2}
            form = _probe(call, tab_id, spec, timeout)
            if form.get("dialogOpened"):
                return [form]
            if form.get("success"):
                data.update(
                    {k: form[k] for k in ("submits", "fields", "recipients", "attachments", "tabUrl", "tabTitle")}
                )
                data["formUnknown"] = False
        if data["formUnknown"]:
            page = _probe(call, tab_id, {"page": True}, timeout)  # page seule : URL et titre
            data.update({k: page.get(k, "") for k in ("tabUrl", "tabTitle")})
        out.append(data)
    return out


def read_trigger(call: Reader, target: dict, timeout: float, wait_s: float = 0.0) -> list[dict]:
    """Déclencheur(s) d'une cible, lus sans geste par le chemin existant du pont (find, cdp-send). Attend jusqu'à
    wait_s qu'un élément introuvable apparaisse, comme le geste. Lève RuntimeError si la lecture échoue vraiment."""
    tab_id = target.get("tab_id")
    target = {k: v for k, v in target.items() if k not in ("tab_id", "timeoutMs")}
    deadline = time.monotonic() + max(0.0, wait_s)
    while True:
        if target.get("locator"):
            result = _found(call, tab_id, target, timeout)
        else:
            spec = {k: target[k] for k in ("mark", "selector", "index", "text") if target.get(k) is not None}
            selector = str(spec.get("selector") or "")
            if selector.startswith("#") and selector[1:].isdigit():
                spec = {"mark": int(selector[1:])}
            result = [_probe(call, tab_id, spec, timeout)]
        if not (len(result) == 1 and result[0].get("notFound")) or time.monotonic() >= deadline:
            return result
        time.sleep(POLL_S)


def check(
    accords: garde_fous.Accords,
    read: Reader,
    targets: Sequence[dict],
    gestures: list[str],
    *,
    confirm: Any = False,
    accord: Any = "",
    timeout: float = 20.0,
    focus_ok: bool = False,
    typed: str = "",
) -> None:
    """Contrôle avant le geste. targets : éléments du geste (glisser : source puis destination), chacun donné par ses
    paramètres de ciblage (tab_id compris : locator, mark, selector, text, ou rien = élément actif).
    gestures : « click », « drag », « Enter », « Control+Enter », « Space »... focus_ok : aucun élément actif = la touche
    part sur la page, libre ; sinon une cible introuvable refuse (jamais un clic non lu). typed : texte frappé avec le
    geste. Lève AccordRequired si un accord manque, RuntimeError/ValueError/OSError si la lecture échoue."""
    if not gestures:
        return
    keys = any(g.rsplit("+", 1)[-1] in ("Enter", "Space") for g in gestures)
    found: tuple[dict, str] | None = None
    for params in targets:
        wait_s = 0.0 if focus_ok else float(params.get("timeoutMs") or 0) / 1000
        for data in read_trigger(read, params, timeout, wait_s):
            if data.get("dialogOpened") or data.get("ambiguous"):
                return  # le geste lui-même rapportera la boîte de dialogue ou l'ambiguïté, sans rien déclencher
            if data.get("notFound"):
                if focus_ok:
                    continue
                raise RuntimeError(f"{data.get('reason') or 'Element not found'}. Nothing was done.")
            if data.get("crossOriginFocus"):
                raise _unreadable("the focus is in a cross-origin frame: target the field with a locator")
            if keys and data.get("field") and not data.get("clickable") and data.get("formUnknown"):
                raise _unreadable("the form of the targeted field is outside the viewport or in a cross-origin frame")
            labels = [*triggers(data, gestures)]
            if any(g in ("click", "drag") for g in gestures):
                labels += [str(x) for x in data.get("alsoLabels") or [] if x]
            title = str(data.get("tabTitle") or "")
            label = next((lab for lab in labels if garde_fous.outward_word(lab, title)), "")
            if label:
                found = (data, label)
                break
        if found:
            break
    if found is None:
        return
    data, label = found
    gesture = ("key " if gestures[0] not in ("click", "drag") else "") + ",".join(gestures)
    act = describe_action(data, gesture, label, typed)
    if refusal := accords.check(act, confirm, accord):
        raise AccordRequired(refusal)


def page_note(accords: garde_fous.Accords, data: Any, source: str) -> str:
    """Texte de page rendu au modèle : noté (provenance d'un destinataire, Accords.read) et avertissement d'injection
    éventuel (signal seulement, rien n'est bloqué)."""
    text = "\n".join(_strings(data))
    return accords.read(source, text) if text.strip() else ""


def _strings(value: Any, limit: int = 400_000) -> list[str]:
    out: list[str] = []
    size = 0
    stack = [value]
    while stack and size < limit:
        item = stack.pop()
        if isinstance(item, str):
            out.append(item)
            size += len(item)
        elif isinstance(item, dict):
            stack.extend(reversed(list(item.values())))
        elif isinstance(item, (list, tuple)):
            stack.extend(reversed(list(item)))
    return out


def page_source(data: Any, fallback: str) -> str:
    """URL de la page lue (origine + chemin), sinon le repli (« tab 12 »)."""
    if isinstance(data, dict):
        for key in ("url", "tabUrl", "canonical"):
            if isinstance(data.get(key), str) and data[key]:
                return _context({"url": data[key]}) or fallback
        metadata = data.get("metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("canonical"), str) and metadata["canonical"]:
            return _context({"url": metadata["canonical"]}) or fallback
    return fallback
