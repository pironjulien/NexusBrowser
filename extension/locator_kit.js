/**
 * Antigravity Browser Bridge - localisateurs par rôle et libellé (inspirés de Playwright getByRole, getByLabel,
 * getByText, getByPlaceholder, getByTestId), côté page.
 *
 * Vraie fonction autonome : sérialisée pour Runtime.evaluate (monde principal ou monde isolé d'un cadre), ou injectée
 * telle quelle par chrome.scripting. Aucune dépendance : elle ne fait que définir des fonctions.
 *
 * Localisateur : { role, name, label, text, placeholder, testId, altText, title, hasText, exact, nth, includeHidden,
 * checked, disabled, expanded, pressed, selected, level, testIdAttribute }. Plusieurs critères = ET. Comparaison
 * insensible à la casse et aux espaces multiples (inclusion), ou exacte et sensible à la casse avec exact:true ;
 * une chaîne "/motif/drapeaux" est une expression régulière.
 */
function agyLocatorKit(install) {
    const SKIP = new Set(["HEAD", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "TITLE", "BASE"]);
    // ARIA 1.2 : rôles dont le nom peut venir du contenu.
    const NAME_FROM_CONTENT = new Set(["button", "cell", "checkbox", "columnheader", "gridcell", "heading", "link",
        "menuitem", "menuitemcheckbox", "menuitemradio", "option", "radio", "row", "rowheader", "switch", "tab",
        "tooltip", "treeitem"]);
    const LABELABLE = new Set(["INPUT", "SELECT", "TEXTAREA", "BUTTON", "METER", "OUTPUT", "PROGRESS"]);
    const KNOWN_KEYS = ["role", "name", "label", "text", "placeholder", "testId", "altText", "title"];

    function tagOf(el) { return String((el && el.tagName) || "").toUpperCase(); }
    function attr(el, name) {
        try { return el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null; } catch (_) { return null; }
    }
    function has(el, name) { const v = attr(el, name); return v !== null && v !== undefined; }
    function norm(value) {
        return String(value === undefined || value === null ? "" : value).replace(/[\s ]+/g, " ").trim();
    }
    function viewOf(el) {
        const d = (el && el.ownerDocument) || (typeof document !== "undefined" ? document : null);
        return (d && d.defaultView) || (typeof window !== "undefined" ? window : null);
    }
    function style(el) {
        try {
            const v = viewOf(el);
            return v && typeof v.getComputedStyle === "function" ? v.getComputedStyle(el) : null;
        } catch (_) { return null; }
    }
    function up(node) {
        if (!node) return null;
        if (node.parentElement) return node.parentElement;
        const p = node.parentNode;
        if (p && p.host) return p.host;  // sortie d'un shadow root
        return p && p.tagName ? p : null;
    }

    // --- Correspondance de texte -------------------------------------------------------------------------------
    function pattern(value, exact) {
        if (value instanceof RegExp) return { re: value };
        const raw = String(value === undefined || value === null ? "" : value);
        const m = /^\/(.+)\/([dgimsuy]*)$/.exec(raw);
        if (m) {
            try { return { re: new RegExp(m[1], m[2].replace(/[gy]/g, "")) }; } catch (_) {}
        }
        return { text: norm(raw), exact: !!exact };
    }
    function matches(value, pat) {
        const v = norm(value);
        if (pat.re) { pat.re.lastIndex = 0; return pat.re.test(v); }
        if (pat.exact) return v === pat.text;
        return v.toLowerCase().includes(pat.text.toLowerCase());
    }

    // --- Visibilité ---------------------------------------------------------------------------------------------
    // Comme Playwright : boîte non vide et visibility différente de hidden/collapse (opacity 0 reste visible).
    function isVisible(el) {
        try {
            const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!r || !(r.width > 0) || !(r.height > 0)) return false;
            const st = style(el);
            if (st && (st.visibility === "hidden" || st.visibility === "collapse" || st.display === "none")) return false;
            return true;
        } catch (_) { return false; }
    }
    function ariaHidden(el) {
        for (let n = el, i = 0; n && i < 1000; n = up(n), i++) if (attr(n, "aria-hidden") === "true") return true;
        return false;
    }

    // --- Rôle -----------------------------------------------------------------------------------------------------
    function inputRole(el) {
        const t = String(attr(el, "type") || "text").toLowerCase();
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (t === "checkbox") return "checkbox";
        if (t === "radio") return "radio";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (["hidden", "file", "color", "password", "date", "datetime-local", "month", "time", "week"].includes(t)) return null;
        if (has(el, "list")) return "combobox";
        if (t === "search") return "searchbox";
        return "textbox";
    }
    function inSectioning(el) {
        for (let n = up(el); n; n = up(n)) {
            if (["ARTICLE", "ASIDE", "MAIN", "NAV", "SECTION"].includes(tagOf(n))) return true;
        }
        return false;
    }
    function isEditableRoot(el) {
        if (!el || !el.isContentEditable) return false;
        const p = el.parentElement;
        return !(p && p.isContentEditable);
    }
    function implicitRole(el) {
        const tag = tagOf(el);
        switch (tag) {
            case "A": case "AREA": return has(el, "href") ? "link" : null;
            case "BUTTON": return "button";
            case "INPUT": return inputRole(el);
            case "TEXTAREA": return "textbox";
            case "SELECT": return (el.multiple || Number(attr(el, "size")) > 1) ? "listbox" : "combobox";
            case "OPTION": return "option";
            case "OPTGROUP": return "group";
            case "DATALIST": return "listbox";
            case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
            case "UL": case "OL": case "MENU": return "list";
            case "LI": return "listitem";
            case "NAV": return "navigation";
            case "MAIN": return "main";
            case "ASIDE": return "complementary";
            case "HEADER": return inSectioning(el) ? null : "banner";
            case "FOOTER": return inSectioning(el) ? null : "contentinfo";
            case "FORM": return "form";
            case "SECTION": return (has(el, "aria-label") || has(el, "aria-labelledby")) ? "region" : null;
            case "ARTICLE": return "article";
            case "DIALOG": return "dialog";
            case "TABLE": return "table";
            case "THEAD": case "TBODY": case "TFOOT": return "rowgroup";
            case "TR": return "row";
            case "TD": return "cell";
            case "TH": return String(attr(el, "scope") || "").toLowerCase() === "row" ? "rowheader" : "columnheader";
            case "IMG": return attr(el, "alt") === "" ? "presentation" : "img";
            case "PROGRESS": return "progressbar";
            case "METER": return "meter";
            case "HR": return "separator";
            case "FIELDSET": case "DETAILS": return "group";
            case "OUTPUT": return "status";
            case "DT": return "term";
            case "DD": return "definition";
            case "FIGURE": return "figure";
        }
        // Éditeur riche (Gmail, Notion...) : racine contenteditable sans rôle explicite.
        if (isEditableRoot(el)) return "textbox";
        return null;
    }
    function roleOf(el) {
        const explicit = norm(attr(el, "role")).toLowerCase().split(" ")[0];
        if (explicit && explicit !== "none" && explicit !== "presentation") return explicit;
        if (explicit === "none" || explicit === "presentation") return null;
        return implicitRole(el);
    }

    // --- Nom accessible (sous-ensemble de accname 1.2) -----------------------------------------------------------
    function byIdIn(el, id) {
        try {
            const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
            if (root && typeof root.getElementById === "function") return root.getElementById(id);
            return el.ownerDocument ? el.ownerDocument.getElementById(id) : null;
        } catch (_) { return null; }
    }
    function labelledByText(el, skip) {
        const ids = norm(attr(el, "aria-labelledby"));
        if (!ids) return "";
        return norm(ids.split(" ").map(id => {
            const ref = byIdIn(el, id);
            return ref ? (norm(attr(ref, "aria-label")) || contentText(ref, skip, true)) : "";
        }).join(" "));
    }
    function hiddenForName(node, inLabelledBy) {
        if (attr(node, "aria-hidden") === "true") return true;
        if (inLabelledBy) return false;  // un élément référencé par aria-labelledby compte même masqué
        const st = style(node);
        return !!(st && (st.display === "none" || st.visibility === "hidden"));
    }
    function controlText(el) {
        const role = roleOf(el);
        if (role === "textbox" || role === "searchbox" || role === "spinbutton") {
            return el.isContentEditable ? norm(el.textContent) : norm(el.value);
        }
        if (role === "combobox" || role === "listbox") {
            if (tagOf(el) === "SELECT") {
                const opt = el.selectedOptions && el.selectedOptions[0];
                return opt ? norm(opt.textContent) : "";
            }
            return norm(el.value);
        }
        if (role === "slider" || role === "progressbar" || role === "meter") return norm(attr(el, "aria-valuetext") || attr(el, "aria-valuenow") || el.value);
        return null;
    }
    // Texte rendu d'un sous-arbre : alt des images, aria-label des descendants, valeur des contrôles imbriqués,
    // shadow roots et slots compris. Les éléments non « inline » sont séparés par une espace.
    function contentText(node, skip, inLabelledBy, depth) {
        depth = depth || 0;
        if (!node || depth > 60) return "";
        let out = "";
        const kids = (node.shadowRoot && node.shadowRoot.childNodes) ? node.shadowRoot.childNodes
            : (tagOf(node) === "SLOT" && typeof node.assignedNodes === "function" && node.assignedNodes({ flatten: true }).length)
                ? node.assignedNodes({ flatten: true }) : (node.childNodes || []);
        for (const child of Array.from(kids)) {
            if (child === skip) continue;
            if (child.nodeType === 3) { out += child.data || child.textContent || ""; continue; }
            if (child.nodeType !== 1 || SKIP.has(tagOf(child))) continue;
            if (hiddenForName(child, inLabelledBy)) continue;
            const st = style(child);
            const sep = st && st.display && !String(st.display).startsWith("inline") ? " " : "";
            let piece;
            const ctl = LABELABLE.has(tagOf(child)) || child.isContentEditable ? controlText(child) : null;
            if (ctl !== null && ctl !== undefined && child !== skip) piece = ctl;
            else if (norm(attr(child, "aria-label"))) piece = norm(attr(child, "aria-label"));
            else if (tagOf(child) === "IMG" || tagOf(child) === "AREA") piece = attr(child, "alt") || "";
            else if (tagOf(child) === "BR") piece = " ";
            else piece = contentText(child, skip, inLabelledBy, depth + 1);
            out += sep + piece + sep;
        }
        return norm(out);
    }
    function labelsOf(el) {
        const out = [];
        try {
            if (el.labels && el.labels.length !== undefined) for (const l of Array.from(el.labels)) out.push(l);
        } catch (_) {}
        if (!out.length) {
            // Repli (labels absent) : <label for=id> du même arbre, puis <label> englobant.
            const id = attr(el, "id");
            if (id) {
                try {
                    const root = el.getRootNode ? el.getRootNode() : el.ownerDocument;
                    const all = root && root.querySelectorAll ? Array.from(root.querySelectorAll("label")) : [];
                    for (const l of all) if (attr(l, "for") === id) out.push(l);
                } catch (_) {}
            }
            for (let n = up(el); n; n = up(n)) if (tagOf(n) === "LABEL") { if (!out.includes(n)) out.push(n); break; }
        }
        return out;
    }
    function labelText(el) {
        return norm(labelsOf(el).map(l => contentText(l, el, false)).join(" "));
    }
    function accessibleName(el) {
        const by = labelledByText(el, el);
        if (by) return by;
        const aria = norm(attr(el, "aria-label"));
        if (aria) return aria;
        const tag = tagOf(el);
        const role = roleOf(el);
        if (tag === "INPUT") {
            const t = String(attr(el, "type") || "text").toLowerCase();
            if (t === "submit" || t === "reset" || t === "button") {
                const v = norm(el.value !== undefined ? el.value : attr(el, "value"));
                if (v) return v;
                if (t === "submit") return "Submit";
                if (t === "reset") return "Reset";
            }
            if (t === "image") return norm(attr(el, "alt") || attr(el, "value") || attr(el, "title") || "Submit");
        }
        if (LABELABLE.has(tag)) {
            const lt = labelText(el);
            if (lt) return lt;
        }
        if (tag === "IMG" || tag === "AREA") {
            const alt = norm(attr(el, "alt"));
            if (alt) return alt;
        }
        if (tag === "FIELDSET") {
            const legend = Array.from(el.children || []).find(c => tagOf(c) === "LEGEND");
            if (legend) return contentText(legend);
        }
        if (tag === "FIGURE") {
            const cap = Array.from(el.children || []).find(c => tagOf(c) === "FIGCAPTION");
            if (cap) return contentText(cap);
        }
        if (tag === "TABLE" && el.caption) return contentText(el.caption);
        if (role && NAME_FROM_CONTENT.has(role)) {
            const t = contentText(el);
            if (t) return t;
        }
        return norm(attr(el, "title") || attr(el, "placeholder") || attr(el, "aria-placeholder"));
    }

    // --- États ----------------------------------------------------------------------------------------------------
    function checkedOf(el) {
        const a = attr(el, "aria-checked");
        if (a === "mixed") return "mixed";
        if (a === "true") return true;
        if (a === "false") return false;
        const t = String(attr(el, "type") || "").toLowerCase();
        if (tagOf(el) === "INPUT" && (t === "checkbox" || t === "radio")) return el.indeterminate ? "mixed" : !!el.checked;
        return null;
    }
    function disabledOf(el) {
        for (let n = el, i = 0; n && i < 1000; n = up(n), i++) {
            if (attr(n, "aria-disabled") === "true") return true;
            if (n === el && el.disabled === true) return true;
            if (tagOf(n) === "FIELDSET" && n.disabled === true && n !== el) {
                const legend = Array.from(n.children || []).find(c => tagOf(c) === "LEGEND");
                if (!legend || !(legend.contains && legend.contains(el))) return true;
            }
        }
        return false;
    }
    function boolAttr(el, name) {
        const v = attr(el, name);
        return v === "true" ? true : (v === "false" ? false : (v === "mixed" ? "mixed" : null));
    }
    function selectedOf(el) {
        const a = boolAttr(el, "aria-selected");
        if (a !== null) return a;
        return tagOf(el) === "OPTION" ? !!el.selected : null;
    }
    function levelOf(el) {
        const a = parseInt(attr(el, "aria-level"), 10);
        if (Number.isFinite(a)) return a;
        const m = /^H([1-6])$/.exec(tagOf(el));
        return m ? Number(m[1]) : null;
    }

    // --- Parcours : shadow roots ouverts et iframes same-origin -------------------------------------------------
    function frameLabel(fe) {
        const id = attr(fe, "id");
        const name = attr(fe, "name");
        return "iframe" + (id ? "#" + id : (name ? "[name=" + name + "]" : ""));
    }
    function walk(doc, visit) {
        const seen = new Set();
        function each(root, frame) {
            if (!root || !root.querySelectorAll || seen.has(root)) return;
            seen.add(root);
            let list = [];
            try { list = Array.from(root.querySelectorAll("*")); } catch (_) {}
            for (const el of list) {
                visit(el, frame);
                if (el.shadowRoot) each(el.shadowRoot, frame);
                if (tagOf(el) === "IFRAME" || tagOf(el) === "FRAME") {
                    let inner = null;
                    try { inner = el.contentDocument; } catch (_) {}
                    if (inner) each(inner, (frame ? frame + " > " : "") + frameLabel(el));
                }
            }
        }
        each(doc, "");
    }
    function frameOfEl(el) {
        const parts = [];
        let d = el.ownerDocument;
        for (let i = 0; d && i < 32; i++) {
            let fe = null;
            try { fe = d.defaultView && d.defaultView.frameElement; } catch (_) {}
            if (!fe) break;
            parts.unshift(frameLabel(fe));
            d = fe.ownerDocument;
        }
        return parts.join(" > ");
    }

    // --- Recherche par texte : l'élément le plus profond dont le texte correspond --------------------------------
    function ownText(el) {
        const tag = tagOf(el);
        if (tag === "INPUT") {
            const t = String(attr(el, "type") || "").toLowerCase();
            return (t === "button" || t === "submit" || t === "reset") ? norm(el.value) : null;
        }
        return norm(el.textContent);
    }
    function byText(doc, pat) {
        const out = [];
        const prune = pat.re ? null : pat.text.toLowerCase();
        function test(el) {
            const t = ownText(el);
            return t !== null && matches(t, pat);
        }
        function maybe(el) {
            if (prune === null) return true;
            const t = norm(el.textContent).toLowerCase();
            return t.includes(prune) || !!el.shadowRoot || tagOf(el) === "IFRAME";
        }
        function visit(el, frame) {
            if (SKIP.has(tagOf(el))) return false;
            let childHit = false;
            const kids = Array.from(el.children || []);
            for (const c of kids) if (maybe(c) && visit(c, frame)) childHit = true;
            if (el.shadowRoot) for (const c of Array.from(el.shadowRoot.children || [])) if (visit(c, frame)) childHit = true;
            if (tagOf(el) === "IFRAME" || tagOf(el) === "FRAME") {
                let inner = null;
                try { inner = el.contentDocument; } catch (_) {}
                if (inner && inner.body) visit(inner.body, (frame ? frame + " > " : "") + frameLabel(el));
                return false;
            }
            if (!childHit && test(el)) { out.push({ el, frame }); return true; }
            return childHit;
        }
        const body = doc.body || doc.documentElement;
        if (body) visit(body, "");
        return out;
    }

    // --- Moteur ----------------------------------------------------------------------------------------------------
    function normalize(locator) {
        if (!locator || typeof locator !== "object") throw new Error("Localisateur invalide : objet attendu, par ex. {\"role\":\"button\",\"name\":\"Valider\"}");
        const loc = Object.assign({}, locator);
        if (loc.testid !== undefined && loc.testId === undefined) loc.testId = loc.testid;
        if (loc.alt !== undefined && loc.altText === undefined) loc.altText = loc.alt;
        if (!KNOWN_KEYS.some(k => loc[k] !== undefined && loc[k] !== null && loc[k] !== "")) {
            throw new Error("Localisateur sans critère : role, label, text, placeholder, testId, altText ou title requis");
        }
        if (loc.name !== undefined && loc.name !== null && !loc.role) {
            // name sans rôle : tout élément dont le nom accessible correspond.
            loc.anyRole = true;
        }
        return loc;
    }
    function stateOk(el, loc) {
        if (loc.checked !== undefined && loc.checked !== null && checkedOf(el) !== loc.checked) return false;
        if (loc.disabled !== undefined && loc.disabled !== null && disabledOf(el) !== !!loc.disabled) return false;
        if (loc.expanded !== undefined && loc.expanded !== null && boolAttr(el, "aria-expanded") !== !!loc.expanded) return false;
        if (loc.pressed !== undefined && loc.pressed !== null && boolAttr(el, "aria-pressed") !== loc.pressed) return false;
        if (loc.selected !== undefined && loc.selected !== null && selectedOf(el) !== !!loc.selected) return false;
        if (loc.level !== undefined && loc.level !== null && levelOf(el) !== Number(loc.level)) return false;
        return true;
    }
    function labelTexts(el) {
        const out = [];
        const lt = LABELABLE.has(tagOf(el)) ? labelText(el) : "";
        if (lt) out.push(lt);
        const by = labelledByText(el, el);
        if (by) out.push(by);
        const aria = norm(attr(el, "aria-label"));
        if (aria) out.push(aria);
        return out;
    }
    /**
     * Toutes les correspondances (dans l'ordre du document), visibles ou non, avec leur nom.
     * axPool : éléments déjà trouvés par Accessibility.queryAXTree (rôle et nom calculés par Chrome).
     */
    function collect(doc, locator, axPool) {
        const loc = normalize(locator);
        const ex = !!loc.exact;
        const pats = {};
        for (const k of ["name", "label", "text", "placeholder", "altText", "title", "hasText"]) {
            if (loc[k] !== undefined && loc[k] !== null && loc[k] !== "") pats[k] = pattern(loc[k], ex);
        }
        const role = loc.role ? String(loc.role).toLowerCase() : null;
        const testIdAttr = loc.testIdAttribute || "data-testid";
        let pool;
        if (pats.text) {
            pool = byText(doc, pats.text);
        } else {
            // Arbre d'accessibilité de Chrome d'abord (rôle et nom calculés par Chrome), puis le DOM pour ce qu'il
            // ne couvre pas (ex. contenteditable sans rôle, que Chrome n'expose pas comme textbox).
            pool = axPool ? axPool.slice() : [];
            const known = new Set(pool.map(item => item.el));
            walk(doc, (el, frame) => { if (!SKIP.has(tagOf(el)) && !known.has(el)) pool.push({ el, frame }); });
        }
        const out = [];
        for (const item of pool) {
            const el = item.el;
            if (!el || SKIP.has(tagOf(el))) continue;
            let elRole = null;
            if (role) {
                elRole = item.role || roleOf(el);
                if (elRole !== role) continue;
            }
            if (loc.testId !== undefined && loc.testId !== null && loc.testId !== "") {
                const v = attr(el, testIdAttr);
                if (v === null || v === undefined || !matches(v, pattern(loc.testId, true))) continue;
            }
            if (pats.placeholder) {
                const ph = attr(el, "placeholder") !== null ? attr(el, "placeholder") : attr(el, "aria-placeholder");
                if (ph === null || ph === undefined || !matches(ph, pats.placeholder)) continue;
            }
            if (pats.altText) {
                const alt = attr(el, "alt");
                if (alt === null || !matches(alt, pats.altText)) continue;
            }
            if (pats.title) {
                const title = attr(el, "title");
                if (title === null || !matches(title, pats.title)) continue;
            }
            if (pats.label) {
                const texts = labelTexts(el);
                if (!texts.length || !texts.some(t => matches(t, pats.label))) continue;
            }
            let name = null;
            if (pats.name) {
                if (loc.anyRole && !role && !roleOf(el)) continue;  // name seul : seulement les éléments qui ont un rôle
                name = item.name !== undefined && item.name !== null ? item.name : accessibleName(el);
                if (!matches(name, pats.name)) continue;
            }
            if (pats.hasText && !matches(el.textContent, pats.hasText)) continue;
            if (!stateOk(el, loc)) continue;
            out.push({ el, frame: item.frame !== undefined ? item.frame : frameOfEl(el), role: elRole, name });
        }
        // Un même élément ne compte qu'une fois (pool AX + DOM, label englobant...).
        const seen = new Set();
        return out.filter(m => (seen.has(m.el) ? false : (seen.add(m.el), true)));
    }
    function round(v) { return Math.round(v * 10) / 10; }
    function describe(m) {
        const el = m.el;
        let box = null;
        try {
            const r = el.getBoundingClientRect();
            box = { x: round(r.left !== undefined ? r.left : r.x), y: round(r.top !== undefined ? r.top : r.y), width: round(r.width), height: round(r.height) };
        } catch (_) {}
        const role = m.role || roleOf(el);
        const name = m.name !== null && m.name !== undefined ? m.name : accessibleName(el);
        const out = {
            role: role || null,
            name: String(name || "").slice(0, 120),
            tag: tagOf(el).toLowerCase(),
            id: attr(el, "id") || null,
            frame: m.frame || "",
            visible: isVisible(el),
            enabled: !disabledOf(el),
            box
        };
        const checked = checkedOf(el);
        if (checked !== null) out.checked = checked;
        const expanded = boolAttr(el, "aria-expanded");
        if (expanded !== null) out.expanded = expanded;
        const selected = selectedOf(el);
        if (selected !== null) out.selected = selected;
        if (role === "heading") out.level = levelOf(el);
        if (typeof el.value === "string" && tagOf(el) !== "BUTTON" && tagOf(el) !== "OPTION") out.value = el.value.slice(0, 120);
        else if (el.isContentEditable) out.value = norm(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, 120);
        const testId = attr(el, "data-testid");
        if (testId) out.testId = testId;
        return out;
    }
    /**
     * Correspondances d'un document (ce cadre et ses cadres same-origin) : visibles seulement sauf includeHidden.
     */
    function query(doc, locator, axPool) {
        const all = collect(doc, locator, axPool);
        const includeHidden = !!(locator && locator.includeHidden);
        const visible = [];
        let hidden = 0;
        for (const m of all) {
            const shown = isVisible(m.el) && !(locator.role && ariaHidden(m.el));
            if (shown || includeHidden) visible.push(m);
            else hidden++;
        }
        return { matches: visible, hidden };
    }

    const api = { norm, pattern, matches, isVisible, roleOf, implicitRole, accessibleName, labelTexts, checkedOf, disabledOf,
        collect, query, describe, frameOfEl, walk, contentText };
    // install=true (repli chrome.scripting sans débogueur) : rangé dans la page, renvoie true (sérialisable).
    if (!install) return api;
    try { (typeof window !== "undefined" ? window : globalThis).__nexusagyLocatorKit = api; } catch (_) {}
    return true;
}
