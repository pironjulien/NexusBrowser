/**
 * Nexus Browser Bridge - exports de contenu (inspirés de tab.content.export, exportGsuite et
 * exportYouTubeTranscript de l'extension Chrome de Codex).
 *
 * Vraie fonction autonome, comme agyLocatorKit : sérialisée pour Runtime.evaluate (côté page) et appelée telle quelle
 * dans le service worker (plan des URL d'export Google, repli fetch). Aucune dépendance, aucune bibliothèque tierce.
 *
 * - pageExport(spec, locatorKit) : contenu principal de la page (algorithme maison inspiré de Readability : score
 *   des paragraphes remonté aux parents, pénalité des liens, classes et rôles « bruit »), rendu en Markdown, texte
 *   ou HTML nettoyé, avec métadonnées (titre, auteur, dates, langue...). Jamais la valeur d'un champ de formulaire.
 * - gsuitePlan(url, format, gid) / gsuiteVerdict(plan, fetched) : URL d'export officielle d'un Docs, Sheets ou
 *   Slides et lecture honnête de la réponse (droits, page de connexion, taille).
 * - fetchResource(url, opts) : fetch avec les cookies de la session (credentials: "include"), borné en temps et en
 *   taille ; ne renvoie jamais d'en-tête hors type et nom de fichier.
 * - youtubeTranscript(spec) : pistes de sous-titres de la vidéo ouverte, choix par langue, json3 ou vtt.
 */
function agyExportKit() {
    const DEFAULT_MAX_CHARS = 100000;
    const HARD_MAX_CHARS = 2000000;

    // --- Outils communs ------------------------------------------------------------------------------------------
    function tagOf(el) { return String((el && el.tagName) || "").toUpperCase(); }
    function attr(el, name) {
        try { return el && typeof el.getAttribute === "function" ? el.getAttribute(name) : null; } catch (_) { return null; }
    }
    function collapse(value) { return String(value === undefined || value === null ? "" : value).replace(/[\s ]+/g, " "); }
    function clean(value) { return collapse(value).trim(); }
    function kids(node) {
        try { return node && node.childNodes ? Array.from(node.childNodes) : []; } catch (_) { return []; }
    }
    function textData(node) {
        if (!node) return "";
        if (node.data !== undefined && node.data !== null) return String(node.data);
        if (node.nodeValue !== undefined && node.nodeValue !== null) return String(node.nodeValue);
        return String(node.textContent || "");
    }
    function rawText(node) {
        if (!node) return "";
        if (node.nodeType === 3) return textData(node);
        if (node.nodeType !== 1) return "";
        if (SKIP_ALWAYS.has(tagOf(node))) return "";
        return kids(node).map(rawText).join("");
    }
    function maxChars(value) {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_CHARS;
        return Math.min(n, HARD_MAX_CHARS);
    }
    /** Coupe à max caractères (au dernier saut de ligne s'il est proche) ; la troncature est toujours signalée. */
    function bound(text, max) {
        const s = String(text || "");
        if (s.length <= max) return { content: s, truncated: false, total_chars: s.length };
        let cut = s.slice(0, max);
        const nl = cut.lastIndexOf("\n");
        if (nl > max * 0.8) cut = cut.slice(0, nl);
        return { content: cut, truncated: true, total_chars: s.length };
    }
    function absolute(href, base) {
        const raw = String(href || "").trim();
        if (!raw) return "";
        try { if (typeof URL === "function") return new URL(raw, base || undefined).href; } catch (_) {}
        return raw;
    }
    function setQueryParam(url, key, value) {
        const s = String(url || "");
        const hashAt = s.indexOf("#");
        const head = hashAt >= 0 ? s.slice(0, hashAt) : s;
        const hash = hashAt >= 0 ? s.slice(hashAt) : "";
        const re = new RegExp("([?&])" + key + "=[^&]*", "g");
        let next = head.replace(re, "$1").replace(/[?&]&+/g, m => m[0]).replace(/[?&]$/, "");
        if (value !== null && value !== undefined) next += (next.indexOf("?") >= 0 ? "&" : "?") + key + "=" + encodeURIComponent(String(value));
        return next + hash;
    }
    function queryParam(url, key) {
        const m = new RegExp("[?&#]" + key + "=([^&#]*)").exec(String(url || ""));
        if (!m) return null;
        try { return decodeURIComponent(m[1].replace(/\+/g, " ")); } catch (_) { return m[1]; }
    }

    // --- Contenu principal (type Readability) --------------------------------------------------------------------
    // Jamais rendus : code, médias interactifs, contrôles de formulaire (aucune valeur saisie ne sort de la page).
    const SKIP_ALWAYS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "FRAME", "FRAMESET", "OBJECT",
        "EMBED", "SVG", "CANVAS", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "OPTGROUP", "DATALIST", "HEAD",
        "META", "LINK", "BASE", "TITLE", "AUDIO", "VIDEO", "SOURCE", "TRACK", "MAP", "AREA", "DIALOG", "MENU", "LABEL",
        "OUTPUT", "PROGRESS", "METER", "SLOT"]);
    // Blocs de navigation et de bordure : retirés du contenu principal (sauf s'ils sont la racine demandée).
    const SKIP_STRUCTURAL = new Set(["NAV", "ASIDE", "FOOTER"]);
    const SKIP_ROLES = new Set(["navigation", "banner", "complementary", "contentinfo", "search", "dialog",
        "alertdialog", "menu", "menubar", "toolbar", "tablist", "form"]);
    const UNLIKELY = /(^|[\s_-])(ad|ads|adv|adbox|advert|advertisement|advertising|banner|breadcrumbs?|combx|comment|comments|community|consent|cookie|cookies|disqus|extra|footer|gdpr|legends|header|masthead|menu|modal|navbar|nav|navigation|newsletter|outbrain|overlay|pager|pagination|paywall|popup|promo|promoted|related|remark|replies|rss|share|sharing|shoutbox|sidebar|skyscraper|social|sponsor|sponsored|subscribe|subscription|supplemental|taboola|toolbar|widget)([\s_-]|$)|adsbygoogle|google_ads|doubleclick|gpt-ad|dfp-ad/i;
    const MAYBE = /article|body|column|content|entry|main|post|story|text|prose|markdown/i;
    const POSITIVE = /article|body|content|entry|hentry|h-entry|main|page|post|text|blog|story|prose|markdown/i;
    const NEGATIVE = /(^|[\s_-])(ad|ads|banner|combx|comment|com-|contact|foot|footer|footnote|masthead|media|meta|outbrain|promo|related|scroll|share|shoutbox|sidebar|skyscraper|sponsor|shopping|tags|tool|widget|nav|menu|cookie|social|newsletter|popup|modal|breadcrumb)([\s_-]|$)/i;
    const BLOCK_TAGS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT",
        "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP",
        "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH",
        "THEAD", "TR", "UL", "CAPTION", "BODY", "HTML", "CENTER"]);

    function matchString(el) { return (attr(el, "class") || "") + " " + (attr(el, "id") || ""); }
    function isHidden(el) {
        if (attr(el, "hidden") !== null || attr(el, "aria-hidden") === "true") return true;
        try {
            const view = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== "undefined" ? window : null);
            const st = view && typeof view.getComputedStyle === "function" ? view.getComputedStyle(el) : null;
            if (st && (st.display === "none" || st.visibility === "hidden")) return true;
        } catch (_) {}
        return false;
    }
    // Mémo par export (score et bruit sont recalculés pour chaque ancêtre de chaque paragraphe sinon).
    let memo = null;
    function cache() { if (!memo) memo = { noise: new Map(), len: new Map(), links: new Map() }; return memo; }
    function textLen(el) {
        const c = cache().len;
        if (!c.has(el)) c.set(el, clean(rawText(el)).length);
        return c.get(el);
    }
    function linkDensity(el) {
        const c = cache().links;
        if (!c.has(el)) c.set(el, computeLinkDensity(el));
        return c.get(el);
    }
    function computeLinkDensity(el) {
        const total = textLen(el);
        if (!total) return 0;
        let links = 0;
        const stack = kids(el);
        while (stack.length) {
            const n = stack.pop();
            if (!n || n.nodeType !== 1) continue;
            if (tagOf(n) === "A") { links += textLen(n); continue; }
            stack.push(...kids(n));
        }
        return Math.min(1, links / total);
    }
    /** Bruit : retiré du contenu, sauf la racine choisie et ses ancêtres (protect). */
    function isNoise(el, protect) {
        if (protect && protect.has(el)) return false;
        const c = cache().noise;
        if (!c.has(el)) c.set(el, computeNoise(el));
        return c.get(el);
    }
    function computeNoise(el) {
        const tag = tagOf(el);
        if (SKIP_ALWAYS.has(tag)) return true;
        if (isHidden(el)) return true;
        if (SKIP_STRUCTURAL.has(tag)) return true;
        const role = String(attr(el, "role") || "").toLowerCase();
        if (SKIP_ROLES.has(role)) return true;
        if (attr(el, "aria-modal") === "true") return true;
        const ms = matchString(el);
        if (ms.trim() && UNLIKELY.test(ms) && !MAYBE.test(ms) && !holdsTitle(el)) return true;
        if (tag === "HEADER") {
            // En-tête de site (menu) retiré ; en-tête d'article (titre, chapeau, signature) gardé.
            const hasNav = descendants(el).some(d => tagOf(d) === "NAV" || String(attr(d, "role") || "").toLowerCase() === "navigation");
            if (hasNav || linkDensity(el) > 0.5) return true;
        }
        if (tag === "FORM") {
            const hasField = descendants(el).some(d => ["INPUT", "TEXTAREA", "SELECT"].includes(tagOf(d)));
            if (hasField && textLen(el) < 500) return true;
        }
        if (tag === "UL" || tag === "OL" || tag === "DIV" || tag === "SECTION") {
            // Liste ou bloc fait presque uniquement de liens (menu, « à lire aussi ») : retiré.
            const len = textLen(el);
            if (len > 0 && len < 1000 && linkDensity(el) > 0.8 && descendants(el).filter(d => tagOf(d) === "A").length >= 3) return true;
        }
        return false;
    }
    /** En-tête d'article (porte le <h1>, peu de liens) : jamais pris pour un en-tête de site. */
    function holdsTitle(el) {
        return descendants(el).some(d => tagOf(d) === "H1") && linkDensity(el) < 0.5;
    }
    function descendants(el) {
        const out = [];
        const stack = kids(el).slice().reverse();
        while (stack.length) {
            const n = stack.pop();
            if (!n || n.nodeType !== 1) continue;
            out.push(n);
            const k = kids(n);
            for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]);
        }
        return out;
    }
    function ancestors(el) {
        const out = [];
        for (let n = el && el.parentNode, i = 0; n && n.nodeType === 1 && i < 200; n = n.parentNode, i++) out.push(n);
        return out;
    }
    function insideNoise(el, stopAt) {
        for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
            if (n === stopAt) return false;
            const tag = tagOf(n);
            if (tag === "BODY" || tag === "HTML") return false;
            if (isNoise(n, null)) return true;
        }
        return false;
    }
    function classWeight(el) {
        const ms = matchString(el);
        let w = 0;
        if (NEGATIVE.test(ms)) w -= 25;
        if (POSITIVE.test(ms)) w += 25;
        return w;
    }
    function baseScore(el) {
        const tag = tagOf(el);
        let s = 0;
        if (tag === "ARTICLE" || tag === "MAIN") s = 10;
        else if (tag === "DIV" || tag === "SECTION") s = 5;
        else if (tag === "PRE" || tag === "TD" || tag === "BLOCKQUOTE") s = 3;
        else if (["ADDRESS", "OL", "UL", "DL", "DD", "DT", "LI", "FORM"].includes(tag)) s = -3;
        else if (/^H[1-6]$/.test(tag) || tag === "TH") s = -5;
        return s + classWeight(el);
    }
    /** Racine du contenu principal : article unique, sinon meilleur score (paragraphes remontés aux parents). */
    function findMainRoot(doc) {
        const body = doc.body || (doc.documentElement ? descendants(doc.documentElement).find(e => tagOf(e) === "BODY") : null) || doc.documentElement;
        const all = descendants(doc.documentElement || body);
        const articles = all.filter(e => tagOf(e) === "ARTICLE" && !insideNoise(e, null) && textLen(e) >= 200);
        const scores = new Map();
        const add = (el, v) => {
            if (!el || el.nodeType !== 1 || tagOf(el) === "HTML") return;
            if (!scores.has(el)) scores.set(el, baseScore(el));
            scores.set(el, scores.get(el) + v);
        };
        for (const p of all) {
            const tag = tagOf(p);
            if (!["P", "PRE", "TD", "BLOCKQUOTE", "LI", "H2", "H3", "SECTION", "DIV"].includes(tag)) continue;
            if (tag === "DIV" || tag === "SECTION") {
                // Un DIV sans bloc enfant compte comme un paragraphe (sites qui n'emploient pas <p>).
                if (kids(p).some(k => k.nodeType === 1 && BLOCK_TAGS.has(tagOf(k)))) continue;
            }
            const text = clean(rawText(p));
            if (text.length < 25) continue;
            if (insideNoise(p, null)) continue;
            const s = 1 + (text.split(/[,，、;]/).length - 1) + Math.min(3, Math.floor(text.length / 100));
            const up = ancestors(p);
            add(up[0], s);
            if (up[1]) add(up[1], s / 2);
            if (up[2]) add(up[2], s / 3);
        }
        let best = null;
        let bestScore = -Infinity;
        for (const [el, s] of scores) {
            const final = s * (1 - linkDensity(el));
            scores.set(el, final);
            if (final > bestScore) { best = el; bestScore = final; }
        }
        if (articles.length === 1 && (!best || articles[0] === best || articles[0].contains?.(best) || textLen(articles[0]) >= textLen(best) * 0.6)) {
            return { roots: [articles[0]], method: "article", main: articles[0] };
        }
        const mains = all.filter(e => (tagOf(e) === "MAIN" || String(attr(e, "role") || "").toLowerCase() === "main") && !isHidden(e));
        if (!best || bestScore < 5 || textLen(best) < 140) {
            if (mains.length === 1) return { roots: [mains[0]], method: "main", main: mains[0] };
            return { roots: [body], method: "body", main: body };
        }
        // Frères de la meilleure racine qui portent aussi du contenu (article coupé en plusieurs blocs).
        const parent = best.parentNode;
        const threshold = Math.max(10, bestScore * 0.2);
        const roots = [];
        for (const sib of parent && parent.nodeType === 1 ? kids(parent) : [best]) {
            if (!sib || sib.nodeType !== 1) continue;
            if (sib === best) { roots.push(sib); continue; }
            if (isNoise(sib, null)) continue;
            const s = scores.get(sib);
            const len = textLen(sib);
            if ((s !== undefined && s >= threshold) || (tagOf(sib) === "P" && len > 80 && linkDensity(sib) < 0.25) || holdsTitle(sib)) roots.push(sib);
        }
        return { roots: roots.length ? roots : [best], method: "scored", main: best };
    }

    // Représentation intermédiaire : blocs {t:h|p|list|pre|quote|table|hr} et éléments en ligne
    // {t:text|a|b|i|code|br|img}, rendue ensuite en Markdown, texte ou HTML.
    const INLINE_TAGS = new Set(["A", "ABBR", "B", "BDI", "BDO", "BR", "CITE", "CODE", "DATA", "DEL", "DFN", "EM",
        "FONT", "I", "IMG", "INS", "KBD", "MARK", "Q", "S", "SAMP", "SMALL", "SPAN", "STRIKE", "STRONG", "SUB", "SUP",
        "TIME", "TT", "U", "VAR", "WBR", "PICTURE", "NOBR"]);
    function isInline(node) {
        if (!node) return false;
        if (node.nodeType === 3) return true;
        if (node.nodeType !== 1) return false;
        if (!INLINE_TAGS.has(tagOf(node))) return false;
        return !descendants(node).some(d => BLOCK_TAGS.has(tagOf(d)));
    }
    function convert(roots, ctx) {
        const blocks = [];
        for (const root of roots) blocks.push(...blockOf(root, ctx, true));
        return blocks;
    }
    function blocksOf(nodes, ctx) {
        const out = [];
        let run = [];
        const flush = () => {
            if (run.length && inlineText(run).trim()) out.push({ t: "p", inl: run });
            run = [];
        };
        for (const n of nodes) {
            if (!n) continue;
            if (n.nodeType === 3) { run.push({ t: "text", v: collapse(textData(n)) }); continue; }
            if (n.nodeType !== 1) continue;
            if (isNoise(n, ctx.protect)) continue;
            if (isInline(n)) { run.push(...inlineOf(n, ctx)); continue; }
            flush();
            out.push(...blockOf(n, ctx, false));
        }
        flush();
        return out;
    }
    function inlineOf(node, ctx) {
        if (node.nodeType === 3) return [{ t: "text", v: collapse(textData(node)) }];
        if (node.nodeType !== 1 || isNoise(node, ctx.protect)) return [];
        const tag = tagOf(node);
        const inner = () => kids(node).flatMap(k => inlineOf(k, ctx));
        if (tag === "BR") return [{ t: "br" }];
        if (tag === "WBR") return [];
        if (tag === "IMG") {
            const src = absolute(attr(node, "src") || attr(node, "data-src") || "", ctx.base);
            if (!/^https?:/i.test(src)) return [];
            // Icônes et pixels de suivi (dimensions déclarées de 32 px au plus) : ignorés.
            const w = parseInt(attr(node, "width"), 10);
            const hgt = parseInt(attr(node, "height"), 10);
            if ((Number.isFinite(w) && w <= 32) || (Number.isFinite(hgt) && hgt <= 32)) return [];
            ctx.stats.images++;
            return [{ t: "img", src, alt: clean(attr(node, "alt") || "") }];
        }
        if (tag === "A") {
            const raw = String(attr(node, "href") || "").trim();
            const parts = inner();
            // Ancre de titre (« # », « ¶ », « § ») : retirée ; lien vers la même page : texte seul.
            if (/^[#¶§🔗\s]*$/u.test(inlineText(parts)) && !parts.some(p => p.t === "img")) return [];
            if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return parts;
            const href = absolute(raw, ctx.base);
            if (ctx.page && href.split("#")[0] === ctx.page && href.includes("#")) return parts;
            ctx.stats.links++;
            return [{ t: "a", href, kids: parts }];
        }
        if (tag === "STRONG" || tag === "B") return [{ t: "b", kids: inner() }];
        if (tag === "EM" || tag === "I" || tag === "CITE" || tag === "DFN") return [{ t: "i", kids: inner() }];
        if (tag === "CODE" || tag === "KBD" || tag === "SAMP" || tag === "TT" || tag === "VAR") return [{ t: "code", v: clean(rawText(node)) }];
        if (tag === "DEL" || tag === "S" || tag === "STRIKE") return [{ t: "del", kids: inner() }];
        return inner();
    }
    function codeLang(el) {
        const pool = [el, ...descendants(el).filter(d => tagOf(d) === "CODE").slice(0, 1)];
        for (const n of pool) {
            const m = /(?:^|\s)(?:language|lang)-([\w#+.-]+)/i.exec(attr(n, "class") || "") || /brush:\s*([\w#+.-]+)/i.exec(attr(n, "class") || "");
            if (m) return m[1];
        }
        return "";
    }
    function blockOf(el, ctx, isRoot) {
        if (!isRoot && isNoise(el, ctx.protect)) return [];
        const tag = tagOf(el);
        const m = /^H([1-6])$/.exec(tag);
        if (m) {
            const inl = kids(el).flatMap(k => inlineOf(k, ctx));
            if (!inlineText(inl).trim()) return [];
            ctx.stats.headings++;
            return [{ t: "h", level: parseInt(m[1], 10), inl }];
        }
        if (tag === "P") {
            const inner = kids(el);
            if (inner.some(k => k.nodeType === 1 && !isInline(k))) return blocksOf(inner, ctx);
            const inl = inner.flatMap(k => inlineOf(k, ctx));
            if (!inlineText(inl).trim() && !inl.some(x => x.t === "img")) return [];
            ctx.stats.paragraphs++;
            return [{ t: "p", inl }];
        }
        if (tag === "UL" || tag === "OL") {
            const items = kids(el).filter(k => k.nodeType === 1 && tagOf(k) === "LI" && !isNoise(k, ctx.protect))
                .map(li => blocksOf(kids(li), ctx)).filter(b => b.length);
            if (!items.length) return [];
            ctx.stats.lists++;
            const start = parseInt(attr(el, "start"), 10);
            return [{ t: "list", ordered: tag === "OL", start: Number.isFinite(start) ? start : 1, items }];
        }
        if (tag === "PRE") {
            const text = rawText(el).replace(/^\n+|\s+$/g, "");
            if (!text.trim()) return [];
            ctx.stats.code_blocks++;
            return [{ t: "pre", text, lang: codeLang(el) }];
        }
        if (tag === "BLOCKQUOTE") {
            const blocks = blocksOf(kids(el), ctx);
            return blocks.length ? [{ t: "quote", blocks }] : [];
        }
        if (tag === "HR") return [{ t: "hr" }];
        if (tag === "TABLE") return tableOf(el, ctx);
        if (tag === "DL") {
            const out = [];
            for (const k of kids(el)) {
                if (k.nodeType !== 1 || isNoise(k, ctx.protect)) continue;
                const inl = kids(k).flatMap(x => inlineOf(x, ctx));
                if (!inlineText(inl).trim()) continue;
                out.push(tagOf(k) === "DT" ? { t: "p", inl: [{ t: "b", kids: inl }] } : { t: "p", inl });
            }
            return out;
        }
        return blocksOf(kids(el), ctx);
    }
    function tableOf(table, ctx) {
        const rows = [];
        let nested = false;
        const visit = (node) => {
            for (const k of kids(node)) {
                if (!k || k.nodeType !== 1 || isNoise(k, ctx.protect)) continue;
                const tag = tagOf(k);
                if (tag === "TR") {
                    const cells = kids(k).filter(c => c.nodeType === 1 && (tagOf(c) === "TD" || tagOf(c) === "TH"));
                    if (cells.some(c => descendants(c).some(d => tagOf(d) === "TABLE"))) nested = true;
                    rows.push({ header: cells.length > 0 && cells.every(c => tagOf(c) === "TH") || tagOf(node) === "THEAD", cells: cells.map(c => kids(c).flatMap(x => inlineOf(x, ctx))) });
                } else if (tag === "THEAD" || tag === "TBODY" || tag === "TFOOT") visit(k);
            }
        };
        visit(table);
        const cols = Math.max(0, ...rows.map(r => r.cells.length));
        // Tableau de mise en page (une colonne, tableaux imbriqués) : rendu comme un conteneur.
        if (nested || cols < 2) return blocksOf(kids(table), ctx);
        const caption = kids(table).find(k => k.nodeType === 1 && tagOf(k) === "CAPTION");
        ctx.stats.tables++;
        const out = [];
        if (caption) {
            const inl = kids(caption).flatMap(x => inlineOf(x, ctx));
            if (inlineText(inl).trim()) out.push({ t: "p", inl: [{ t: "b", kids: inl }] });
        }
        out.push({ t: "table", cols, rows });
        return out;
    }

    // --- Rendus ----------------------------------------------------------------------------------------------------
    function inlineText(parts) { return parts.map(p => p.t === "text" ? p.v : p.t === "code" ? p.v : p.t === "br" ? "\n" : p.kids ? inlineText(p.kids) : p.t === "img" ? p.alt : "").join(""); }
    function tidyLine(s) { return s.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/[ \t]{2,}/g, " ").trim(); }
    function mdInline(parts) {
        let out = "";
        for (const p of parts) {
            if (p.t === "text") out += p.v;
            else if (p.t === "br") out += "  \n";
            else if (p.t === "code") { if (p.v) { const tick = p.v.includes("`") ? "``" : "`"; out += `${tick}${p.v}${tick}`; } }
            else if (p.t === "img") out += `![${p.alt.replace(/[\[\]]/g, "")}](${p.src})`;
            else if (p.t === "a") {
                const inner = mdInline(p.kids).trim();
                if (inner) out += `[${inner}](${p.href.replace(/\)/g, "%29").replace(/ /g, "%20")})`;
            } else if (p.t === "b" || p.t === "i" || p.t === "del") {
                const inner = mdInline(p.kids);
                const mark = p.t === "b" ? "**" : p.t === "i" ? "*" : "~~";
                const core = inner.trim();
                if (core) out += (/^\s/.test(inner) ? " " : "") + mark + core + mark + (/\s$/.test(inner) ? " " : "");
            }
        }
        return out;
    }
    function textInline(parts) {
        let out = "";
        for (const p of parts) {
            if (p.t === "text" || p.t === "code") out += p.v;
            else if (p.t === "br") out += "\n";
            else if (p.t === "img") out += p.alt ? p.alt : "";
            else if (p.kids) out += textInline(p.kids);
        }
        return out;
    }
    function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
    function htmlInline(parts) {
        let out = "";
        for (const p of parts) {
            if (p.t === "text") out += esc(p.v);
            else if (p.t === "br") out += "<br>";
            else if (p.t === "code") out += `<code>${esc(p.v)}</code>`;
            else if (p.t === "img") out += `<img src="${esc(p.src)}" alt="${esc(p.alt)}">`;
            else if (p.t === "a") out += `<a href="${esc(p.href)}">${htmlInline(p.kids)}</a>`;
            else if (p.t === "b") out += `<strong>${htmlInline(p.kids)}</strong>`;
            else if (p.t === "i") out += `<em>${htmlInline(p.kids)}</em>`;
            else if (p.t === "del") out += `<del>${htmlInline(p.kids)}</del>`;
        }
        return out;
    }
    function indent(text, pad) { return text.split("\n").map((l, i) => (i === 0 || !l ? l : pad + l)).join("\n"); }
    function renderMd(blocks) {
        return blocks.map(b => {
            if (b.t === "h") return "#".repeat(b.level) + " " + tidyLine(mdInline(b.inl)).replace(/\s*\n\s*/g, " ");
            if (b.t === "p") return tidyLine(mdInline(b.inl).replace(/ {2}\n/g, "\u0000")).replace(/\u0000/g, "  \n");
            if (b.t === "hr") return "---";
            if (b.t === "pre") {
                const fence = b.text.includes("```") ? "````" : "```";
                return `${fence}${b.lang}\n${b.text}\n${fence}`;
            }
            if (b.t === "quote") return renderMd(b.blocks).split("\n").map(l => (l ? "> " + l : ">")).join("\n");
            if (b.t === "list") {
                return b.items.map((item, i) => {
                    const marker = b.ordered ? `${b.start + i}. ` : "- ";
                    const body = renderMd(item);
                    return marker + indent(body, " ".repeat(marker.length)).replace(/\n\n/g, "\n");
                }).join("\n");
            }
            if (b.t === "table") {
                const cell = (c) => tidyLine(mdInline(c || [])).replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
                const rows = b.rows.map(r => Array.from({ length: b.cols }, (_, i) => cell(r.cells[i])));
                const head = rows[0];
                const sep = head.map(() => "---");
                return [head, sep, ...rows.slice(1)].map(r => `| ${r.join(" | ")} |`).join("\n");
            }
            return "";
        }).filter(s => s.trim()).join("\n\n");
    }
    function renderText(blocks) {
        return blocks.map(b => {
            if (b.t === "h" || b.t === "p") return tidyLine(textInline(b.inl));
            if (b.t === "hr") return "";
            if (b.t === "pre") return b.text;
            if (b.t === "quote") return renderText(b.blocks).split("\n").map(l => (l ? "  " + l : l)).join("\n");
            if (b.t === "list") return b.items.map((item, i) => {
                const marker = b.ordered ? `${b.start + i}. ` : "- ";
                return marker + indent(renderText(item), " ".repeat(marker.length)).replace(/\n\n/g, "\n");
            }).join("\n");
            if (b.t === "table") return b.rows.map(r => Array.from({ length: b.cols }, (_, i) => tidyLine(textInline(r.cells[i] || [])).replace(/\s+/g, " ")).join("\t")).join("\n");
            return "";
        }).filter(s => s.trim()).join("\n\n");
    }
    function renderHtml(blocks) {
        return blocks.map(b => {
            if (b.t === "h") return `<h${b.level}>${htmlInline(b.inl).trim()}</h${b.level}>`;
            if (b.t === "p") return `<p>${htmlInline(b.inl).trim()}</p>`;
            if (b.t === "hr") return "<hr>";
            if (b.t === "pre") return `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ""}>${esc(b.text)}</code></pre>`;
            if (b.t === "quote") return `<blockquote>\n${renderHtml(b.blocks)}\n</blockquote>`;
            if (b.t === "list") {
                const tag = b.ordered ? "ol" : "ul";
                const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
                return `<${tag}${start}>\n${b.items.map(item => `<li>${renderHtml(item)}</li>`).join("\n")}\n</${tag}>`;
            }
            if (b.t === "table") {
                const row = (r, head) => `<tr>${Array.from({ length: b.cols }, (_, i) => `<${head ? "th" : "td"}>${htmlInline(r.cells[i] || []).trim()}</${head ? "th" : "td"}>`).join("")}</tr>`;
                const [first, ...rest] = b.rows;
                return `<table>\n<thead>${row(first, true)}</thead>\n<tbody>\n${rest.map(r => row(r, false)).join("\n")}\n</tbody>\n</table>`;
            }
            return "";
        }).filter(Boolean).join("\n");
    }

    // --- Métadonnées -------------------------------------------------------------------------------------------------
    function jsonLd(doc) {
        const out = [];
        let scripts = [];
        try { scripts = Array.from(doc.querySelectorAll("script")); } catch (_) {}
        for (const s of scripts) {
            if (!/ld\+json/i.test(attr(s, "type") || "")) continue;
            try {
                const parsed = JSON.parse(rawTextAll(s));
                const stack = Array.isArray(parsed) ? parsed.slice() : [parsed];
                while (stack.length) {
                    const item = stack.shift();
                    if (!item || typeof item !== "object") continue;
                    if (Array.isArray(item["@graph"])) stack.push(...item["@graph"]);
                    out.push(item);
                }
            } catch (_) {}
        }
        return out;
    }
    function rawTextAll(node) {
        if (!node) return "";
        if (node.nodeType === 3) return textData(node);
        return kids(node).map(rawTextAll).join("") || String(node.textContent || "");
    }
    function personName(value) {
        if (!value) return "";
        if (typeof value === "string") return value;
        if (Array.isArray(value)) return value.map(personName).filter(Boolean).join(", ");
        if (typeof value === "object") return String(value.name || "");
        return "";
    }
    function metadata(doc, mainRoot) {
        const metas = {};
        let list = [];
        try { list = Array.from(doc.querySelectorAll("meta")); } catch (_) {}
        for (const m of list) {
            const key = String(attr(m, "property") || attr(m, "name") || attr(m, "itemprop") || attr(m, "http-equiv") || "").toLowerCase();
            const content = attr(m, "content");
            if (key && content && !(key in metas)) metas[key] = clean(content);
        }
        const ld = jsonLd(doc);
        const article = ld.find(x => /article|posting|report|newsarticle|webpage/i.test(String(x["@type"] || ""))) || ld[0] || {};
        let canonical = null;
        try {
            for (const l of Array.from(doc.querySelectorAll("link"))) {
                if (String(attr(l, "rel") || "").toLowerCase() === "canonical" && attr(l, "href")) { canonical = attr(l, "href"); break; }
            }
        } catch (_) {}
        const inRoot = mainRoot ? descendants(mainRoot) : [];
        const firstH1 = inRoot.find(e => tagOf(e) === "H1") || descendants(doc.documentElement || doc.body || mainRoot).find(e => tagOf(e) === "H1");
        let author = metas["author"] || metas["article:author"] || metas["parsely-author"] || metas["dc.creator"] || personName(article.author) || "";
        if (/^https?:\/\//i.test(author)) author = personName(article.author) || "";
        if (!author) {
            const node = inRoot.concat(descendants(doc.body || doc.documentElement)).find(e =>
                attr(e, "rel") === "author" || /(^|\s)author(\s|$)/i.test(attr(e, "itemprop") || "") || /(^|[\s_-])(byline|author)([\s_-]|$)/i.test(attr(e, "class") || ""));
            const t = node ? clean(rawText(node)).replace(/^(par|by|de)\s+/i, "") : "";
            if (t && t.length <= 100) author = t;
        }
        const timeEl = inRoot.find(e => tagOf(e) === "TIME" && attr(e, "datetime"));
        const published = metas["article:published_time"] || metas["datepublished"] || metas["og:published_time"] || metas["date"] || metas["dc.date"] || metas["pubdate"] || article.datePublished || (timeEl ? attr(timeEl, "datetime") : "") || "";
        const modified = metas["article:modified_time"] || metas["datemodified"] || metas["og:updated_time"] || article.dateModified || "";
        const docEl = doc.documentElement;
        const lang = attr(docEl, "lang") || attr(docEl, "xml:lang") || metas["content-language"] || metas["og:locale"] || "";
        // Titre : le <h1> quand le titre déclaré le contient (« Titre — Site »), sinon og:title, puis h1, puis <title>.
        const h1Text = firstH1 ? clean(rawText(firstH1)) : "";
        const declared = metas["og:title"] || metas["twitter:title"] || "";
        const pageTitle = clean(doc.title || "");
        const title = (h1Text && (!declared || declared.includes(h1Text)) && (!pageTitle || pageTitle.includes(h1Text) || declared.includes(h1Text)) ? h1Text : "")
            || declared || h1Text || clean(article.headline || "") || pageTitle;
        const out = {
            title: title || null,
            author: clean(author) || null,
            published: clean(published) || null,
            modified: clean(modified) || null,
            lang: clean(lang) || null,
            site_name: metas["og:site_name"] || personName(article.publisher) || null,
            description: metas["description"] || metas["og:description"] || null,
            canonical: canonical ? absolute(canonical, doc.baseURI) : null
        };
        return out;
    }

    function pageLocation() {
        try { return typeof location !== "undefined" && location ? String(location.href || "") : ""; } catch (_) { return ""; }
    }

    /**
     * Contenu principal en markdown (défaut), text ou html. spec : {format, selector, locator, maxChars}.
     * locatorKit : agyLocatorKit() quand spec.locator est donné.
     */
    function pageExport(spec, locatorKit) {
        memo = null;
        spec = spec || {};
        const format = String(spec.format || "markdown").toLowerCase();
        const fmt = format === "md" ? "markdown" : format === "txt" ? "text" : format;
        if (!["markdown", "text", "html"].includes(fmt)) return { error: `format inconnu « ${format} » : markdown, text ou html` };
        const doc = typeof document !== "undefined" ? document : null;
        if (!doc || !(doc.documentElement || doc.body)) return { error: "Document vide : rien à exporter" };
        const base = String(doc.baseURI || pageLocation() || "");
        let roots;
        let method;
        let main;
        if (spec.selector) {
            let el = null;
            try { el = doc.querySelector(spec.selector); } catch (e) { return { error: `Sélecteur invalide « ${spec.selector} » : ${e && e.message || e}` }; }
            if (!el) return { error: `Aucun élément ne correspond au sélecteur « ${spec.selector} »` };
            roots = [el]; method = "selector"; main = el;
        } else if (spec.locator) {
            if (!locatorKit) return { error: "Localisateur indisponible dans la page" };
            const found = locatorKit.query(doc, spec.locator);
            const matches = found.matches || [];
            const nth = spec.locator.nth;
            if (!matches.length) return { error: `Aucun élément ne correspond au localisateur ${JSON.stringify(spec.locator)}${found.hidden ? ` (${found.hidden} masqué(s))` : ""}` };
            if ((nth === undefined || nth === null) && matches.length > 1) {
                return { error: `Localisateur ambigu ${JSON.stringify(spec.locator)} : ${matches.length} éléments correspondent (préciser exact:true, nth ou un critère de plus)` };
            }
            let index = nth === undefined || nth === null ? 0 : parseInt(nth, 10);
            if (index < 0) index = matches.length + index;
            if (!matches[index]) return { error: `nth=${nth} hors limites : ${matches.length} élément(s)` };
            roots = [matches[index].el]; method = "locator"; main = roots[0];
        } else {
            const found = findMainRoot(doc);
            roots = found.roots; method = found.method; main = found.main;
        }
        const protect = new Set();
        for (const r of roots) { protect.add(r); for (const a of ancestors(r)) protect.add(a); }
        const stats = { headings: 0, paragraphs: 0, lists: 0, links: 0, images: 0, tables: 0, code_blocks: 0, words: 0 };
        const ctx = { protect, base, stats, page: String(pageLocation() || base).split("#")[0] };
        let blocks = convert(roots, ctx);
        const meta = metadata(doc, main);
        // Titre en tête quand le contenu n'en a pas (racine choisie sous le <h1>).
        const firstHeading = blocks.find(b => b.t === "h");
        const titled = firstHeading && blocks.indexOf(firstHeading) < 3 && clean(inlineText(firstHeading.inl)) === meta.title;
        if (meta.title && !spec.selector && !spec.locator && !titled) {
            blocks = [{ t: "h", level: 1, inl: [{ t: "text", v: meta.title }] }, ...blocks];
        }
        const text = renderText(blocks);
        stats.words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
        const full = fmt === "markdown" ? renderMd(blocks) : fmt === "text" ? text : renderHtml(blocks);
        const b = bound(full, maxChars(spec.maxChars));
        if (!b.total_chars) return { error: "Aucun contenu lisible trouvé dans la zone exportée" };
        const rootEl = main || roots[0];
        return {
            url: pageLocation() || base || null,
            title: meta.title,
            format: fmt,
            content: b.content,
            chars: b.content.length,
            total_chars: b.total_chars,
            truncated: b.truncated,
            metadata: meta,
            root: {
                method,
                tag: tagOf(rootEl).toLowerCase(),
                id: attr(rootEl, "id") || null,
                class: (attr(rootEl, "class") || "").slice(0, 120) || null,
                blocks: roots.length
            },
            stats
        };
    }

    // --- Google Docs / Sheets / Slides ---------------------------------------------------------------------------
    const GSUITE = {
        document: { label: "Google Docs", def: "md", formats: { md: false, txt: false, html: false, docx: true, pdf: true, odt: true, rtf: true, epub: true } },
        spreadsheets: { label: "Google Sheets", def: "csv", formats: { csv: false, tsv: false, xlsx: true, pdf: true, ods: true } },
        presentation: { label: "Google Slides", def: "txt", formats: { txt: false, pdf: true, pptx: true, odp: true } }
    };
    const MIME = {
        md: "text/markdown", txt: "text/plain", html: "text/html", csv: "text/csv", tsv: "text/tab-separated-values",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        pdf: "application/pdf", odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
        odp: "application/vnd.oasis.opendocument.presentation", rtf: "application/rtf", epub: "application/epub+zip"
    };
    function parseGoogleUrl(url) {
        const m = /^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)(\/u\/\d+)?\/d\/([A-Za-z0-9_-]{10,})(?:[/?#]|$)/.exec(String(url || ""));
        if (!m) return null;
        if (m[3] === "e") return null;
        const gid = queryParam(url, "gid");
        return { kind: m[1], account: m[2] || "", id: m[3], gid: gid && /^\d+$/.test(gid) ? gid : null };
    }
    function gsuitePlan(url, format, gid) {
        if (/^https:\/\/docs\.google\.com\/(document|spreadsheets|presentation)\/d\/e\//.test(String(url || ""))) {
            return { error: "Document Google publié sur le Web (/d/e/…) : pas d'URL d'export ; ouvrir le document source (lien /d/<id>/edit)." };
        }
        const info = parseGoogleUrl(url);
        if (!info) {
            return { error: `L'onglet n'est pas un Google Docs, Sheets ou Slides ouvert (attendu https://docs.google.com/document|spreadsheets|presentation/d/<id>/…, reçu ${String(url || "?").slice(0, 120)}).` };
        }
        const kind = GSUITE[info.kind];
        const raw = String(format || kind.def).toLowerCase().replace(/^\./, "");
        const fmt = raw === "markdown" ? "md" : raw === "text" ? "txt" : raw;
        if (!(fmt in kind.formats)) {
            return { error: `Format « ${raw} » non exportable pour ${kind.label} : ${Object.keys(kind.formats).join(", ")}.` };
        }
        const base = `https://docs.google.com/${info.kind}${info.account}/d/${info.id}`;
        let exportUrl;
        let sheet = null;
        if (info.kind === "presentation") exportUrl = `${base}/export/${fmt}`;
        else exportUrl = `${base}/export?format=${fmt}`;
        if (info.kind === "spreadsheets") {
            sheet = gid !== undefined && gid !== null && gid !== "" ? String(gid) : info.gid;
            if (sheet !== null && !/^\d+$/.test(sheet)) return { error: `gid invalide : ${gid}` };
            if (sheet !== null) exportUrl += `&gid=${sheet}`;
        }
        return {
            kind: info.kind, label: kind.label, document_id: info.id, format: fmt, extension: fmt,
            binary: kind.formats[fmt], mime: MIME[fmt] || "application/octet-stream", url: exportUrl,
            gid: sheet, whole_workbook: info.kind === "spreadsheets" && (fmt === "csv" || fmt === "tsv") ? false : info.kind === "spreadsheets" && sheet === null
        };
    }
    function filenameFrom(disposition) {
        const d = String(disposition || "");
        let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(d);
        if (m) { try { return decodeURIComponent(m[1].trim().replace(/^"|"$/g, "")); } catch (_) {} }
        m = /filename\s*=\s*"([^"]*)"/.exec(d) || /filename\s*=\s*([^;]+)/.exec(d);
        return m ? m[1].trim() : null;
    }
    function toBase64(bytes) {
        let s = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        return btoa(s);
    }
    /** fetch avec les cookies de la session ; seuls le statut, le type, le nom de fichier et le contenu sortent. */
    async function fetchResource(url, opts) {
        opts = opts || {};
        const maxBytes = Math.max(1, parseInt(opts.maxBytes, 10) || 8 * 1024 * 1024);
        const timeoutMs = Math.max(1000, parseInt(opts.timeoutMs, 10) || 30000);
        const ctrl = typeof AbortController === "function" ? new AbortController() : null;
        const timer = ctrl && typeof setTimeout === "function" ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        try {
            const r = await fetch(url, { credentials: "include", redirect: "follow", cache: "no-store", ...(ctrl ? { signal: ctrl.signal } : {}) });
            const header = (name) => { try { return r.headers && r.headers.get ? r.headers.get(name) : null; } catch (_) { return null; } };
            const out = {
                ok: !!r.ok, status: r.status, finalUrl: r.url || url, redirected: !!r.redirected,
                type: String(header("content-type") || ""), filename: filenameFrom(header("content-disposition"))
            };
            if (!r.ok) return out;
            const declared = parseInt(header("content-length"), 10);
            if (Number.isFinite(declared) && declared > maxBytes) return { ...out, tooLarge: true, bytes: declared };
            if (opts.binary) {
                const bytes = new Uint8Array(await r.arrayBuffer());
                if (bytes.length > maxBytes) return { ...out, tooLarge: true, bytes: bytes.length };
                return { ...out, bytes: bytes.length, base64: toBase64(bytes) };
            }
            const text = await r.text();
            if (text.length > maxBytes) return { ...out, tooLarge: true, bytes: text.length };
            return { ...out, bytes: text.length, text };
        } catch (e) {
            const aborted = e && (e.name === "AbortError");
            return { networkError: aborted ? `délai de ${timeoutMs} ms dépassé` : String((e && e.message) || e) };
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }
    function host(url) { const m = /^[a-z]+:\/\/([^/?#:]+)/i.exec(String(url || "")); return m ? m[1].toLowerCase() : ""; }
    /** Réponse lue honnêtement : droits, page de connexion, HTML au lieu du fichier, taille. */
    function gsuiteVerdict(plan, fetched) {
        const what = `${plan.label} (${plan.format})`;
        if (!fetched) return { error: `Export ${what} sans réponse.` };
        if (fetched.networkError) return { error: `Export ${what} impossible : requête refusée (${fetched.networkError}). Session Google expirée, réseau, ou téléchargement bloqué par le propriétaire.` };
        const finalHost = host(fetched.finalUrl);
        if (finalHost === "accounts.google.com" || /ServiceLogin|\/signin\//.test(String(fetched.finalUrl || ""))) {
            return { error: `Export ${what} refusé : Google demande une connexion. Le compte de cette session n'a pas accès au document (ou la session a expiré).` };
        }
        if (fetched.status === 401 || fetched.status === 403) {
            return { error: `Export ${what} refusé (HTTP ${fetched.status}) : droits insuffisants pour ce compte, ou téléchargement, impression et copie désactivés par le propriétaire.` };
        }
        if (fetched.status === 404) return { error: `Export ${what} introuvable (HTTP 404) : document supprimé, identifiant faux, ou format non disponible pour ce document.` };
        if (fetched.status === 429) return { error: `Export ${what} limité par Google (HTTP 429) : réessayer dans une minute.` };
        if (!fetched.ok) return { error: `Export ${what} en échec (HTTP ${fetched.status}).` };
        if (fetched.tooLarge) return { error: `Export ${what} trop volumineux (${Math.round(fetched.bytes / 1048576 * 10) / 10} Mo ; limite du pont 8 Mo) : le télécharger depuis Google (Fichier > Télécharger).` };
        if (plan.format !== "html" && /text\/html/i.test(fetched.type)) {
            return { error: `Export ${what} refusé : Google a renvoyé une page HTML au lieu du fichier (droits, téléchargement désactivé par le propriétaire, ou page de connexion).` };
        }
        if (!fetched.bytes) return { error: `Export ${what} vide : le document ne contient rien d'exportable dans ce format.` };
        return { ok: true };
    }

    // --- YouTube ---------------------------------------------------------------------------------------------------
    function isYoutubeUrl(url) { return /^https:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i.test(String(url || "")); }
    function videoIdFrom(url) {
        const s = String(url || "");
        const v = queryParam(s, "v");
        if (v && /^[\w-]{11}$/.test(v)) return v;
        const m = /youtube\.com\/(?:shorts|live|embed)\/([\w-]{11})/i.exec(s);
        return m ? m[1] : null;
    }
    /** Objet JSON qui suit « marqueur = » dans un script de page (accolades équilibrées, chaînes respectées). */
    function jsonAfter(text, marker) {
        const s = String(text || "");
        let at = s.indexOf(marker);
        while (at >= 0) {
            let i = s.indexOf("{", at + marker.length);
            if (i < 0) return null;
            if (!/^\s*=?\s*$/.test(s.slice(at + marker.length, i))) { at = s.indexOf(marker, at + 1); continue; }
            let depth = 0;
            let inStr = false;
            let quote = "";
            for (let j = i; j < s.length; j++) {
                const c = s[j];
                if (inStr) {
                    if (c === "\\") { j++; continue; }
                    if (c === quote) inStr = false;
                    continue;
                }
                if (c === "\"" || c === "'") { inStr = true; quote = c; continue; }
                if (c === "{") depth++;
                else if (c === "}") {
                    depth--;
                    if (depth === 0) {
                        try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
                    }
                }
            }
            return null;
        }
        return null;
    }
    function trackName(t) {
        const n = t && t.name;
        if (!n) return "";
        if (n.simpleText) return String(n.simpleText);
        if (Array.isArray(n.runs)) return n.runs.map(r => r.text || "").join("");
        return "";
    }
    function describeTrack(t) {
        return { lang: t.languageCode || null, name: trackName(t) || null, auto: t.kind === "asr", translatable: !!t.isTranslatable };
    }
    function baseLang(code) { return String(code || "").toLowerCase().split(/[-_]/)[0]; }
    /** Piste choisie : manuelle exacte, auto exacte, manuelle puis auto de même langue de base, sinon traduction. */
    function pickTrack(tracks, lang, defaultIndex) {
        if (!tracks.length) return null;
        const want = String(lang || "").toLowerCase();
        if (!want) {
            const def = Number.isInteger(defaultIndex) && tracks[defaultIndex] ? tracks[defaultIndex] : null;
            return { track: def || tracks.find(t => t.kind !== "asr") || tracks[0], translated: false };
        }
        const manual = tracks.filter(t => t.kind !== "asr");
        const auto = tracks.filter(t => t.kind === "asr");
        const exact = (t) => String(t.languageCode || "").toLowerCase() === want;
        const sameBase = (t) => baseLang(t.languageCode) === baseLang(want);
        const found = manual.find(exact) || auto.find(exact) || manual.find(sameBase) || auto.find(sameBase);
        if (found) return { track: found, translated: false };
        const source = manual.find(t => t.isTranslatable) || auto.find(t => t.isTranslatable);
        return source ? { track: source, translated: true, tlang: want } : null;
    }
    function decodeEntities(s) {
        return String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
    }
    function parseJson3(body) {
        let data;
        try { data = typeof body === "string" ? JSON.parse(body) : body; } catch (_) { return null; }
        if (!data || !Array.isArray(data.events)) return null;
        const out = [];
        for (const ev of data.events) {
            if (!ev || !Array.isArray(ev.segs)) continue;
            const text = clean(ev.segs.map(s => (s && s.utf8) || "").join(""));
            if (!text) continue;
            out.push({ start: (Number(ev.tStartMs) || 0) / 1000, duration: (Number(ev.dDurationMs) || 0) / 1000, text });
        }
        return out;
    }
    function vttTime(s) {
        const m = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/.exec(s);
        if (!m) return null;
        return (parseInt(m[1] || "0", 10) * 3600) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + parseInt(m[4].padEnd(3, "0"), 10) / 1000;
    }
    function parseVtt(body) {
        const text = String(body || "").replace(/\r/g, "");
        if (!/^﻿?WEBVTT/.test(text)) return null;
        const out = [];
        for (const block of text.split(/\n{2,}/)) {
            const lines = block.split("\n");
            const ti = lines.findIndex(l => l.includes("-->"));
            if (ti < 0) continue;
            const [a, b] = lines[ti].split("-->");
            const start = vttTime(a);
            const end = vttTime(b || "");
            const content = clean(decodeEntities(lines.slice(ti + 1).join(" ").replace(/<[^>]+>/g, "")));
            if (start === null || !content) continue;
            // Sous-titres automatiques en VTT : chaque repère répète la ligne précédente ; doublons retirés.
            if (out.length && out[out.length - 1].text === content) continue;
            out.push({ start, duration: end !== null ? Math.max(0, end - start) : 0, text: content });
        }
        return out;
    }
    function stamp(sec) {
        const s = Math.max(0, Math.floor(sec));
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const r = s % 60;
        const two = (n) => String(n).padStart(2, "0");
        return h ? `${h}:${two(m)}:${two(r)}` : `${two(m)}:${two(r)}`;
    }
    function sleep(ms) { return new Promise(resolve => (typeof setTimeout === "function" ? setTimeout(resolve, ms) : resolve())); }
    function timedTextEntries(videoId) {
        try {
            if (typeof performance === "undefined" || !performance.getEntriesByType) return [];
            return performance.getEntriesByType("resource").map(e => String(e.name || ""))
                .filter(n => n.includes("/api/timedtext") && queryParam(n, "v") === videoId && /[?&]pot=/.test(n));
        } catch (_) { return []; }
    }
    function playerResponse(videoId) {
        const candidates = [];
        try {
            const player = typeof document !== "undefined" && document.getElementById ? document.getElementById("movie_player") : null;
            if (player && typeof player.getPlayerResponse === "function") candidates.push(player.getPlayerResponse());
        } catch (_) {}
        try { if (typeof window !== "undefined" && window.ytInitialPlayerResponse) candidates.push(window.ytInitialPlayerResponse); } catch (_) {}
        return candidates.find(pr => pr && pr.videoDetails && pr.videoDetails.videoId === videoId) || null;
    }
    function trackUrl(baseUrl, fmt, track, tlang) {
        let url = String(baseUrl || "");
        if (url.startsWith("/")) url = "https://www.youtube.com" + url;
        url = setQueryParam(url, "fmt", fmt);
        if (tlang) url = setQueryParam(url, "tlang", tlang);
        if (track && track.languageCode) url = setQueryParam(url, "lang", track.languageCode);
        return url;
    }
    function parseCaptions(body, fmt) {
        const first = fmt === "vtt" ? parseVtt(body) : parseJson3(body);
        if (first && first.length) return { segments: first, format: fmt };
        const other = fmt === "vtt" ? parseJson3(body) : parseVtt(body);
        if (other && other.length) return { segments: other, format: fmt === "vtt" ? "json3" : "vtt" };
        return null;
    }
    /**
     * Transcription de la vidéo ouverte. spec : {lang, format (json3|vtt), maxChars, enableCaptions, timeoutMs}.
     * Si YouTube exige son jeton de preuve (« pot ») et que la piste brute revient vide, les sous-titres du lecteur
     * sont activés un instant (enableCaptions, défaut vrai) pour que le lecteur obtienne l'URL signée, puis remis.
     */
    async function youtubeTranscript(spec) {
        spec = spec || {};
        const href = pageLocation();
        if (!isYoutubeUrl(href)) return { error: `L'onglet n'est pas une page YouTube (${href.slice(0, 120) || "?"}).` };
        const videoId = videoIdFrom(href);
        if (!videoId) return { error: "Aucune vidéo YouTube ouverte dans l'onglet (attendu /watch?v=…, /shorts/…, /live/…)." };
        const fmt = String(spec.format || "json3").toLowerCase() === "vtt" ? "vtt" : "json3";
        const timeoutMs = Math.max(2000, parseInt(spec.timeoutMs, 10) || 20000);
        let pr = playerResponse(videoId);
        let source = "player";
        if (!pr) {
            const page = await fetchResource(href, { timeoutMs, maxBytes: 16 * 1024 * 1024 });
            pr = page && page.text ? jsonAfter(page.text, "ytInitialPlayerResponse") : null;
            if (pr && !(pr.videoDetails && pr.videoDetails.videoId === videoId)) pr = null;
            source = "page_html";
        }
        if (!pr) return { error: "Données du lecteur YouTube introuvables (ytInitialPlayerResponse) : attendre le chargement de la vidéo puis relancer." };
        const details = pr.videoDetails || {};
        const renderer = (pr.captions && pr.captions.playerCaptionsTracklistRenderer) || {};
        const tracks = Array.isArray(renderer.captionTracks) ? renderer.captionTracks.filter(t => t && t.baseUrl) : [];
        const available = tracks.map(describeTrack);
        if (!tracks.length) {
            const status = pr.playabilityStatus && pr.playabilityStatus.status;
            return { error: `Aucune piste de sous-titres pour cette vidéo (ni manuelle ni auto-générée)${status && status !== "OK" ? ` ; lecture : ${status}` : ""}.` };
        }
        const defaultIndex = renderer.audioTracks && renderer.audioTracks[0] ? renderer.audioTracks[0].defaultCaptionTrackIndex : undefined;
        const pick = pickTrack(tracks, spec.lang, defaultIndex);
        if (!pick) {
            return { error: `Aucune piste en « ${spec.lang} » ni traduisible : pistes disponibles ${available.map(t => `${t.lang}${t.auto ? " (auto)" : ""}`).join(", ")}.` };
        }
        const track = pick.track;
        let method = "direct";
        let fetched = await fetchResource(trackUrl(track.baseUrl, fmt, track, pick.tlang), { timeoutMs, maxBytes: 16 * 1024 * 1024 });
        let parsed = fetched && fetched.ok && fetched.text ? parseCaptions(fetched.text, fmt) : null;
        let captionsToggled = false;
        if (!parsed) {
            // Piste vide : YouTube exige le jeton du lecteur. URL signée déjà vue, sinon sous-titres activés un instant.
            let entries = timedTextEntries(videoId);
            const player = typeof document !== "undefined" && document.getElementById ? document.getElementById("movie_player") : null;
            if (!entries.length && spec.enableCaptions !== false && player && typeof player.setOption === "function") {
                let before = null;
                try { before = typeof player.getOption === "function" ? player.getOption("captions", "track") : null; } catch (_) {}
                try {
                    if (typeof player.loadModule === "function") player.loadModule("captions");
                    player.setOption("captions", "track", { languageCode: track.languageCode, ...(track.kind ? { kind: track.kind } : {}) });
                    captionsToggled = true;
                } catch (_) {}
                const deadline = Date.now() + Math.min(6000, timeoutMs);
                while (captionsToggled && !entries.length && Date.now() < deadline) {
                    await sleep(250);
                    entries = timedTextEntries(videoId);
                }
                try {
                    if (captionsToggled) {
                        if (before && before.languageCode) player.setOption("captions", "track", before);
                        else if (typeof player.unloadModule === "function") player.unloadModule("captions");
                    }
                } catch (_) {}
            }
            if (entries.length) {
                let signed = entries[entries.length - 1];
                signed = setQueryParam(signed, "kind", track.kind === "asr" ? "asr" : null);
                signed = setQueryParam(signed, "tlang", pick.tlang || null);
                fetched = await fetchResource(trackUrl(signed, fmt, track, pick.tlang), { timeoutMs, maxBytes: 16 * 1024 * 1024 });
                parsed = fetched && fetched.ok && fetched.text ? parseCaptions(fetched.text, fmt) : null;
                method = "player_token";
            }
        }
        if (!parsed) {
            const why = fetched && fetched.networkError ? fetched.networkError : fetched && !fetched.ok ? `HTTP ${fetched.status}` : "réponse vide";
            return { error: `Piste « ${track.languageCode} » illisible (${why}) : YouTube exige peut-être son jeton de lecture. Lancer la lecture de la vidéo avec les sous-titres (CC) une seconde, puis relancer.` };
        }
        const max = maxChars(spec.maxChars);
        const timed = bound(parsed.segments.map(s => `[${stamp(s.start)}] ${s.text}`).join("\n"), max);
        const plainText = bound(parsed.segments.map(s => s.text).join(" ").replace(/\s+/g, " ").trim(), max);
        return {
            video_id: videoId,
            url: href,
            title: details.title || null,
            channel: details.author || null,
            length_seconds: details.lengthSeconds ? parseInt(details.lengthSeconds, 10) : null,
            track: { ...describeTrack(track), translated: !!pick.translated, translated_to: pick.tlang || null, source_format: parsed.format },
            available_tracks: available,
            segments: parsed.segments.length,
            duration_covered_seconds: Math.round(parsed.segments[parsed.segments.length - 1].start + parsed.segments[parsed.segments.length - 1].duration),
            timed_text: timed.content,
            text: plainText.content,
            truncated: timed.truncated || plainText.truncated,
            total_chars: { timed_text: timed.total_chars, text: plainText.total_chars },
            method,
            player_source: source,
            captions_toggled: captionsToggled
        };
    }

    return {
        pageExport, findMainRoot, metadata, bound, renderMd, renderText, renderHtml,
        parseGoogleUrl, gsuitePlan, gsuiteVerdict, fetchResource, filenameFrom,
        isYoutubeUrl, videoIdFrom, jsonAfter, pickTrack, parseJson3, parseVtt, stamp, setQueryParam, youtubeTranscript
    };
}
