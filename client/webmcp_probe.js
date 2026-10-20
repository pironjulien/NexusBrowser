// WebMCP : outils qu'une page expose elle-même aux agents (document.modelContext, Chrome 149+ par essai d'origine).
// Évalué par cdp-send (Runtime.evaluate) dans le monde ISOLÉ de l'onglet : la page ne peut ni remplacer getTools ni
// executeTool, ni voir l'appel. spec.call absent : liste seule (aucun geste). spec.call présent : l'outil n'est
// exécuté que si sa définition est restée celle que le serveur a contrôlée (spec.key), sinon rien n'est fait.
(async (spec) => {
    const mc = document.modelContext || navigator.modelContext;
    const page = { url: location.href, title: document.title };
    if (!mc || typeof mc.getTools !== "function" || typeof mc.executeTool !== "function") {
        return { ...page, supported: false };
    }
    const text = (node) => (node ? (node.innerText || node.value || node.getAttribute("aria-label") || "").trim() : "");
    const hints = (a) => {
        if (!a || typeof a !== "object") return null;
        const out = {};
        for (const k of ["readOnlyHint", "consequentialHint", "untrustedContentHint", "debugging"]) {
            if (typeof a[k] === "boolean") out[k] = a[k];
        }
        return out;
    };
    const declarative = (tool) => {
        // Outil déclaratif : un formulaire <form toolname> de son document ; son envoi est le geste réel.
        let doc;
        try { doc = tool.window.document; } catch (_) { return null; }
        const form = [...doc.querySelectorAll("form[toolname]")].find(f => f.getAttribute("toolname") === tool.name);
        if (!form) return null;
        const submits = [...form.querySelectorAll("button, input[type=submit], input[type=image]")]
            .filter(b => (b.type || "submit") === "submit").map(text).filter(Boolean).slice(0, 5);
        let action = "";
        try { const u = new URL(form.action, doc.baseURI); action = u.origin + u.pathname; } catch (_) {}
        return { submits, action, method: (form.method || "get").toLowerCase(), autosubmit: form.hasAttribute("toolautosubmit") };
    };
    const frame = (tool) => {
        if (tool.window === window) return "top";
        try { return tool.window.location.href; } catch (_) { return "frame"; }
    };
    const describe = (tool) => ({
        name: String(tool.name || ""),
        title: String(tool.title || ""),
        description: String(tool.description || ""),
        inputSchema: tool.inputSchema === undefined ? null : JSON.parse(JSON.stringify(tool.inputSchema)),
        annotations: hints(tool.annotations),
        origin: String(tool.origin || ""),
        frame: frame(tool),
        declarative: declarative(tool),
    });
    const tools = await mc.getTools();
    const listed = tools.map(t => ({ tool: t, info: describe(t) }));
    listed.forEach(x => { x.info.key = JSON.stringify(x.info); });
    if (!spec || !spec.call) return { ...page, supported: true, tools: listed.map(x => x.info) };

    const matches = listed.filter(x => x.info.name === spec.call && (!spec.origin || x.info.origin === spec.origin));
    if (!matches.length) return { ...page, supported: true, notFound: true, names: listed.map(x => x.info.name) };
    if (matches.length > 1) return { ...page, supported: true, ambiguous: true, origins: matches.map(x => x.info.origin) };
    const { tool, info } = matches[0];
    if (spec.key === undefined) return { ...page, supported: true, tool: info };
    if (spec.key !== info.key) return { ...page, supported: true, changed: true, tool: info };
    const abort = new AbortController();
    let timer;
    const late = new Promise((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error(`no answer after ${spec.timeoutMs} ms (cancelled)`)); }, spec.timeoutMs);
    });
    try {
        const output = await Promise.race([mc.executeTool(tool, spec.input || {}, { signal: abort.signal }), late]);
        return { ...page, supported: true, success: true, output: output === undefined ? null : String(output) };
    } catch (error) {
        return { ...page, supported: true, failed: true, error: String((error && error.message) || error).slice(0, 2000) };
    } finally {
        clearTimeout(timer);
    }
})
