/**
 * Mise en forme pure du poste de contrôle (sans DOM ni chrome.*), testée dans tests/browser.test.cjs.
 */
(function (scope) {
    /** Hôte lisible d'une URL (jamais ses paramètres). */
    function hostOf(url) {
        try {
            const parsed = new URL(String(url || ""));
            return parsed.protocol === "about:" ? String(url) : parsed.host || parsed.protocol.replace(/:$/, "");
        } catch (_) {
            return String(url || "").slice(0, 60);
        }
    }

    /** Onglets pilotés regroupés par agent, agents dans l'ordre alphabétique. */
    function groupByAgent(tabs) {
        const groups = new Map();
        for (const tab of Array.isArray(tabs) ? tabs : []) {
            const agent = String(tab.agent || "Inconnu");
            if (!groups.has(agent)) groups.set(agent, []);
            groups.get(agent).push(tab);
        }
        return [...groups.entries()]
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([agent, list]) => ({ agent, tabs: list.sort((a, b) => a.tabId - b.tabId) }));
    }

    /** Une ligne par onglet : titre, hôte, états (débogueur, commandes en cours, enregistrement réseau, adoption). */
    function describeTab(tab, now = Date.now()) {
        const badges = [];
        if (tab.adopted) badges.push("adopté");
        if (tab.orphan) badges.push("orphelin (session terminée)");
        if (!tab.exists) badges.push("fermé");
        badges.push(tab.debugger ? "débogueur attaché" : "débogueur détaché");
        if (tab.commandsInFlight > 0) badges.push(`${tab.commandsInFlight} commande(s) en cours`);
        if (tab.recordingUntil && tab.recordingUntil > now) {
            badges.push(`réseau enregistré ${Math.ceil((tab.recordingUntil - now) / 1000)} s`);
        }
        return {
            title: tab.title || "Onglet sans titre",
            subtitle: `#${tab.tabId} · ${hostOf(tab.url)} · session …${tab.session || "?"}`,
            badges
        };
    }

    /** Arrêt d'urgence : texte du bandeau (null s'il n'y a pas d'arrêt). */
    function stopLabel(stoppedUntil, now = Date.now()) {
        if (!stoppedUntil || stoppedUntil <= now) return null;
        return `Arrêt d'urgence actif : plus aucune action pendant ${Math.ceil((stoppedUntil - now) / 1000)} s`;
    }

    /** État du pont local, relu par le service worker. */
    function bridgeLabel(bridge) {
        if (bridge && bridge.connected) return { ok: true, text: "Pont local authentifié" };
        const reason = bridge && (bridge.authError || bridge.error);
        return { ok: false, text: `Pont local non joint${reason ? ` : ${reason}` : ""}` };
    }

    scope.AgySidepanelView = { hostOf, groupByAgent, describeTab, stopLabel, bridgeLabel };
})(typeof globalThis !== "undefined" ? globalThis : window);
