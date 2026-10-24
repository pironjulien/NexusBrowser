// Lecture SANS GESTE de ce qu'un clic ou une touche déclencherait (accord lié à l'action exacte, 2.12.0). Envoyée par
// le serveur MCP et la CLI dans le monde isolé de l'onglet par le chemin existant du pont (cdp-send, Runtime.evaluate) :
// aucune action nouvelle de l'extension. Ne modifie rien dans la page (ni focus, ni défilement, ni valeur).
// Rend : libellé de l'élément cliquable, boutons d'envoi de son formulaire, champs de ce formulaire (jamais la valeur
// d'un champ sensible), destinataires et pièces jointes reconnaissables, URL et titre.
// spec : {mark} | {selector, index} | {text} | {id, tag, point} (candidat de l'action find) | {} (élément actif).
(function (spec) {
    const win = typeof window !== "undefined" ? window : globalThis;
    const doc = typeof document !== "undefined" ? document : null;
    const clip = (v, n) => String(v === undefined || v === null ? "" : v).replace(/[\s ]+/g, " ").trim().slice(0, n || 200);
    const tag = (n) => String((n && n.tagName) || "").toUpperCase();
    const attr = (n, a) => (n && typeof n.getAttribute === "function" ? n.getAttribute(a) : null);
    const parentOf = (n) => n.parentElement || (n.parentNode && n.parentNode.host) || null;
    const docOf = (n) => (n && n.ownerDocument) || doc;
    const roleOf = (n) => String(attr(n, "role") || "").toLowerCase();
    const typeOf = (n) => String(attr(n, "type") || (n && n.type) || "").toLowerCase();
    const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
    const ACTIVE_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "checkbox", "radio", "treeitem"]);
    const BUTTON_TYPES = new Set(["submit", "button", "image", "reset", "checkbox", "radio"]);
    const isTextInput = (n) => tag(n) === "INPUT" && TEXT_TYPES.has(String(attr(n, "type") || "").toLowerCase());
    const activating = (n) => {
        const t = tag(n);
        if (t === "BUTTON" || t === "SUMMARY" || (t === "A" && attr(n, "href") !== null)) return true;
        if (t === "INPUT") return BUTTON_TYPES.has(typeOf(n));
        return ACTIVE_ROLES.has(roleOf(n));
    };
    const editable = (n) => isTextInput(n) || tag(n) === "TEXTAREA" || tag(n) === "SELECT" || !!(n && n.isContentEditable)
        || ["textbox", "searchbox", "combobox"].includes(roleOf(n));
    const isField = (n) => !!n && editable(n) && !activating(n);
    const sensitive = (n) => {
        const ac = String(attr(n, "autocomplete") || "").toLowerCase();
        return typeOf(n) === "password" || /one-time-code|cc-|password/.test(ac);
    };
    const nameOf = (n) => {
        const d = docOf(n);
        const byIds = String(attr(n, "aria-labelledby") || "").split(/\s+/).filter(Boolean)
            .map(id => d && d.getElementById ? d.getElementById(id) : null).filter(Boolean).map(x => x.textContent).join(" ");
        const labels = n.labels ? Array.from(n.labels).map(l => l.textContent).join(" ") : "";
        const buttonValue = tag(n) === "INPUT" && BUTTON_TYPES.has(typeOf(n)) ? n.value : "";
        let img = null;
        try { img = typeof n.querySelector === "function" ? n.querySelector("img") : null; } catch (_) {}
        const text = n.innerText !== undefined && n.innerText !== null ? n.innerText : n.textContent;
        const fieldName = isField(n) ? (clip(labels) || attr(n, "placeholder") || attr(n, "title") || attr(n, "name")) : "";
        return clip(clip(byIds) || attr(n, "aria-label") || fieldName || buttonValue || clip(text) || attr(n, "alt")
            || attr(n, "title") || (img ? attr(img, "alt") : "") || labels, 160);
    };
    const descendants = (root) => {
        try { return Array.from(root.querySelectorAll("*")); } catch (_) { return []; }
    };
    function findDeep(root, selector, index) {
        if (!root || !root.querySelectorAll) return null;
        try {
            const els = root.querySelectorAll(selector);
            if (els && els[index]) return els[index];
        } catch (_) {}
        for (const child of descendants(root)) {
            if (child.shadowRoot) {
                const res = findDeep(child.shadowRoot, selector, index);
                if (res) return res;
            }
            if (tag(child) === "IFRAME") {
                try { if (child.contentDocument) { const res = findDeep(child.contentDocument, selector, index); if (res) return res; } } catch (_) {}
            }
        }
        return null;
    }
    const notFound = (reason) => ({ success: false, notFound: true, reason });
    const pageOnly = () => {
        let href = "";
        try { href = String(win.location && win.location.href || ""); } catch (_) {}
        return { success: true, page: true, tabUrl: href, tabTitle: clip(doc && doc.title, 200) };
    };
    if (spec.page) return pageOnly();

    // --- Cible : même règle que les gestes (mark, sélecteur ou mark « #N », texte, candidat de find, élément actif).
    let el = null;
    let alsoLabels = [];
    const som = win.__nexus_som_elements;
    if (spec.mark !== undefined && spec.mark !== null) {
        el = som && typeof som.get === "function" ? (som.get(Number(spec.mark)) || null) : null;
        if (!el) return notFound("No element registered for mark #" + spec.mark + " in the main frame");
    } else if (spec.selector) {
        const sel = String(spec.selector);
        if (/^#[0-9]+$/.test(sel) && som && typeof som.has === "function" && som.has(Number(sel.slice(1)))) el = som.get(Number(sel.slice(1)));
        else el = findDeep(doc, sel, Number(spec.index) || 0);
        if (!el) return notFound("Element not found for selector " + JSON.stringify(sel));
    } else if (spec.text) {
        // Comme la recherche par texte du clic : éléments dont le libellé contient le texte, puis leur cible interactive.
        // Toutes les cibles possibles sont rendues (le serveur les contrôle toutes : prudence).
        const search = clip(spec.text).toLowerCase();
        const targets = [];
        for (const n of descendants(doc)) {
            if (["SCRIPT", "STYLE", "NOSCRIPT", "HTML", "BODY", "HEAD"].includes(tag(n))) continue;
            const own = [attr(n, "aria-label"), attr(n, "title"), attr(n, "placeholder"), attr(n, "alt"), n.innerText !== undefined ? n.innerText : n.textContent];
            if (!own.some(v => clip(v).toLowerCase().includes(search))) continue;
            let t = n;
            for (let i = 0; t && i < 8 && !activating(t) && !isField(t); i++) t = parentOf(t);
            const chosen = t && (activating(t) || isField(t)) ? t : n;
            if (!targets.includes(chosen)) targets.push(chosen);
        }
        const interactive = targets.filter(n => activating(n) || isField(n));
        const pool = interactive.length ? interactive : targets;
        pool.sort((a, b) => nameOf(a).length - nameOf(b).length);
        el = pool[0] || null;
        if (!el) return notFound("No element with text " + JSON.stringify(search));
        alsoLabels = pool.slice(1, 6).map(nameOf).filter(Boolean);
    } else if (spec.id || spec.point) {
        const wanted = String(spec.tag || "").toUpperCase();
        if (spec.id && doc.getElementById) {
            const byId = doc.getElementById(String(spec.id));
            if (byId && (!wanted || tag(byId) === wanted)) el = byId;
        }
        if (!el && spec.point && typeof doc.elementFromPoint === "function") {
            let hit = doc.elementFromPoint(Number(spec.point.x), Number(spec.point.y));
            for (let i = 0; hit && hit.shadowRoot && i < 32; i++) {
                const inner = typeof hit.shadowRoot.elementFromPoint === "function" ? hit.shadowRoot.elementFromPoint(Number(spec.point.x), Number(spec.point.y)) : null;
                if (!inner || inner === hit) break;
                hit = inner;
            }
            for (let i = 0; hit && i < 8; i++, hit = parentOf(hit)) if (!wanted || tag(hit) === wanted) { el = hit; break; }
        }
        if (!el) return { success: false, unreachable: true };
    } else {
        let a = doc ? doc.activeElement : null;
        for (let i = 0; a && i < 64; i++) {
            let inner = null;
            if (a.shadowRoot && a.shadowRoot.activeElement) inner = a.shadowRoot.activeElement;
            else if (tag(a) === "IFRAME") {
                try { inner = a.contentDocument && a.contentDocument.activeElement; } catch (_) {}
                if (!inner) return { success: false, crossOriginFocus: true };
            }
            if (!inner || inner === a) break;
            a = inner;
        }
        if (!a || tag(a) === "BODY" || tag(a) === "HTML") return notFound("No element has focus");
        el = a;
    }

    // --- Élément qui reçoit le clic (icône d'un bouton : le bouton), puis son formulaire.
    let clickable = null;
    for (let n = el, i = 0; n && n.nodeType === 1 && i < 8; n = parentOf(n), i++) {
        if (activating(n)) { clickable = n; break; }
    }
    const anchor = clickable || el;
    const fieldsIn = (root) => descendants(root).filter(n => isField(n) && !(n.isContentEditable && parentOf(n) && parentOf(n).isContentEditable));
    // Formulaire concerné : <form>, sinon boîte de dialogue ou role=form, sinon le plus proche ancêtre qui contient un
    // champ et un bouton, s'il a l'allure d'une zone de rédaction (3 champs au plus : messagerie). Une section plus large
    // (champs et boutons sans lien) n'est pas un formulaire.
    let container = (anchor.form && anchor.form.nodeType === 1 ? anchor.form : null)
        || (typeof anchor.closest === "function" ? anchor.closest("form") : null);
    const isForm = !!container;
    if (!container && typeof anchor.closest === "function") container = anchor.closest("[role='dialog'], dialog, [role='form']");
    if (!container) {
        for (let n = parentOf(anchor), i = 0; n && n.nodeType === 1 && i < 10; n = parentOf(n), i++) {
            if (tag(n) === "BODY" || tag(n) === "HTML") break;
            const inside = fieldsIn(n).length;
            if ((inside || isField(anchor)) && descendants(n).some(activating)) { container = inside <= 3 ? n : null; break; }
        }
    }
    const isSubmit = (n) => (tag(n) === "BUTTON" && ["", "submit"].includes(String(attr(n, "type") || "").toLowerCase()))
        || (tag(n) === "INPUT" && ["submit", "image"].includes(typeOf(n)));
    let submits = [];
    const fields = [];
    const recipients = [];
    const attachments = [];
    const RECIPIENT = /(^|[^a-z])(to|cc|bcc|recipients?|destinataires?|emails?|e-mail|mail|phone|tel|mobile|numero)([^a-z]|$)/i;
    if (container) {
        const buttons = descendants(container).filter(n => activating(n) && (tag(n) !== "A" || roleOf(n) === "button")
            && !["checkbox", "radio", "switch", "option", "tab"].includes(roleOf(n)));
        const preferred = isForm ? buttons.filter(isSubmit) : [];
        submits = (preferred.length ? preferred : buttons).slice(0, 20).map(nameOf).filter(Boolean);
        for (const f of fieldsIn(container).slice(0, 40)) {
            const type = typeOf(f) || (f.isContentEditable ? "contenteditable" : tag(f).toLowerCase());
            const label = nameOf(f) || clip(attr(f, "name") || attr(f, "id"), 80);
            if (sensitive(f)) { fields.push({ label, type, masked: true }); continue; }
            let value;
            if (tag(f) === "SELECT") {
                const opts = Array.from(f.options || []);
                const chosen = opts.filter(o => o.selected);
                value = (chosen.length ? chosen : opts.slice(0, 1)).map(o => clip(o.text !== undefined ? o.text : o.textContent, 120)).join(", ");
            } else if (f.isContentEditable || (typeof f.value !== "string")) {
                value = clip(f.innerText !== undefined && f.innerText !== null ? f.innerText : f.textContent, 131072);
            } else {
                value = clip(f.value, 131072);
            }
            const hints = [type, attr(f, "autocomplete"), attr(f, "name"), attr(f, "id"), attr(f, "aria-label"), label].map(v => clip(v, 80)).join(" ");
            if (type === "email" || type === "tel" || RECIPIENT.test(hints)) {
                for (const part of value.split(/[,;]+/)) if (clip(part)) recipients.push(clip(part, 200));
            } else {
                fields.push({ label, type, value });
            }
        }
        for (const n of descendants(container)) {
            const hover = String(attr(n, "data-hovercard-id") || "");
            const email = attr(n, "email") || (hover.includes("@") ? hover : null);
            if (email && clip(email)) recipients.push(clip(email, 200));
            if (tag(n) === "INPUT" && typeOf(n) === "file") {
                for (const file of Array.from(n.files || [])) if (file && file.name) attachments.push(clip(file.name, 200));
            }
        }
    }
    let url = "";
    try { url = String(win.location && win.location.href || ""); } catch (_) {}
    return {
        success: true,
        tagName: el.tagName || null,
        label: nameOf(anchor),
        alsoLabels,
        clickable: !!clickable,
        field: isField(el),
        form: !!container,
        submits,
        fields,
        recipients: Array.from(new Set(recipients)).slice(0, 50),
        attachments: Array.from(new Set(attachments)).slice(0, 50),
        tabTitle: clip(doc && doc.title, 200),
        tabUrl: url
    };
})
