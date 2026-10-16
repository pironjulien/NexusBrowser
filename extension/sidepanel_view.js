/**
 * Mise en forme pure des résultats du panneau latéral (sans DOM ni chrome.*), testée dans tests/browser.test.cjs.
 */
(function (scope) {
    const CLICKABLE_ROLES = new Set(["button", "link", "tab", "menuitem", "checkbox", "radio", "switch", "option"]);
    const CLICKABLE_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image"]);

    /** Éléments de interactive_map qu'un clic actionne (pas les champs de saisie). */
    function clickableElements(elements) {
        return (Array.isArray(elements) ? elements : []).filter((el) => {
            const tag = String(el.tag || "").toLowerCase();
            const role = String(el.role || "").toLowerCase();
            if (tag === "button" || tag === "a" || tag === "summary" || CLICKABLE_ROLES.has(role)) return true;
            return tag === "input" && CLICKABLE_INPUTS.has(String(el.type || "").toLowerCase());
        });
    }

    /** Cookies résumés par domaine : nombre et noms seulement, jamais de valeur (même si elle est fournie). */
    function summarizeCookies(cookies) {
        const byDomain = new Map();
        for (const cookie of Array.isArray(cookies) ? cookies : []) {
            const domain = String(cookie.domain || "(sans domaine)");
            if (!byDomain.has(domain)) byDomain.set(domain, new Set());
            byDomain.get(domain).add(String(cookie.name || ""));
        }
        const domains = [...byDomain.entries()]
            .map(([domain, names]) => ({ domain, count: names.size, names: [...names].sort() }))
            .sort((a, b) => a.domain.localeCompare(b.domain));
        return { count: (Array.isArray(cookies) ? cookies : []).length, domains };
    }

    /** Une ligne lisible par champ de form_fields (libellé, type, nom ; « rempli » sans jamais la valeur). */
    function describeField(field) {
        const label = field.label || field.name || field.id || "champ sans libellé";
        const kind = field.type && field.type !== field.tag ? `${field.tag} ${field.type}` : field.tag;
        const flags = [field.required ? "requis" : "", field.filled ? "rempli" : "vide", field.disabled ? "désactivé" : ""]
            .filter(Boolean).join(", ");
        return `${label} — <${kind}> (${flags})`;
    }

    const STATUS_LABELS = {
        sent: "Transmise au pont : en attente de lecture par Antigravity",
        read: "Lue par Antigravity",
        answered: "Réponse d'Antigravity reçue",
        not_sent: "Non transmise : pont local non authentifié"
    };

    function requestStatusLabel(status) {
        return STATUS_LABELS[status] || String(status || "");
    }

    scope.AgySidepanelView = { clickableElements, summarizeCookies, describeField, requestStatusLabel };
})(typeof globalThis !== "undefined" ? globalThis : window);
