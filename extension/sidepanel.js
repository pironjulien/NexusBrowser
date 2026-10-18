/**
 * Poste de contrôle NexusBrowser (panneau latéral). Il n'agit sur aucune page :
 * - liste des onglets pilotés par chaque agent (propriétaire, titre, état du débogueur), relue au service worker ;
 * - STOP : arrêt d'urgence immédiat dans Chrome, puis arrêt commun ~/.nexus/stop posé par le pont pour tous les
 *   agents (commandes en cours annulées, débogueurs détachés) ;
 * - « Rendre l'onglet » : propriété retirée et débogueur détaché, l'onglet reste ouvert pour Julien ;
 * - état du pont local.
 */

document.addEventListener("DOMContentLoaded", () => {
    const view = globalThis.AgySidepanelView;
    const $ = (id) => document.getElementById(id);
    const tabsList = $("tabs-list");
    const bridgeState = $("bridge-state");
    const stopState = $("stop-state");
    const stopButton = $("btn-stop");
    const versionLine = $("version-line");
    const toast = $("toast");
    let toastTimer = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);  // jamais d'HTML injecté
        return node;
    }

    function showToast(text, ms = 2600) {
        toast.textContent = text;
        toast.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("show"), ms);
    }

    function toBackground(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ target: "background", ...message }, (res) => {
                if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                else resolve(res || {});
            });
        });
    }

    function renderTabs(tabs) {
        const groups = view.groupByAgent(tabs);
        tabsList.replaceChildren();
        if (!groups.length) {
            tabsList.appendChild(el("p", "muted", "Aucun onglet piloté par un agent."));
            return;
        }
        for (const group of groups) {
            const box = el("div", "agent-group");
            box.appendChild(el("div", "agent-name", `${group.agent} (${group.tabs.length})`));
            for (const tab of group.tabs) {
                const info = view.describeTab(tab);
                const card = el("div", "tab-card");
                const title = el("div", "tab-title", info.title);
                title.title = info.title;
                card.append(title, el("div", "tab-sub", info.subtitle));
                const badges = el("div", "badges");
                for (const badge of info.badges) badges.appendChild(el("span", "badge", badge));
                card.appendChild(badges);
                const release = el("button", "release-button", "Rendre l'onglet");
                release.type = "button";
                release.title = "Retire l'onglet à l'agent et détache le débogueur (l'onglet reste ouvert)";
                release.addEventListener("click", async () => {
                    release.disabled = true;
                    const res = await toBackground({ panelRelease: tab.tabId });
                    showToast(res.error ? `Erreur : ${res.error}` : `Onglet #${tab.tabId} rendu à Julien`);
                    refresh();
                });
                card.appendChild(release);
                box.appendChild(card);
            }
            tabsList.appendChild(box);
        }
    }

    async function refresh() {
        const state = await toBackground({ getControlState: true });
        if (state.error) {
            bridgeState.textContent = "Extension injoignable";
            bridgeState.className = "state-pill off";
            return;
        }
        versionLine.textContent = `NexusBrowser ${state.version || ""}`.trim();
        const bridge = view.bridgeLabel(state.bridge);
        bridgeState.textContent = bridge.text;
        bridgeState.className = `state-pill ${bridge.ok ? "ok" : "off"}`;
        const stop = view.stopLabel(state.stoppedUntil);
        stopState.textContent = stop || "Arrête toutes les actions de tous les agents pendant 2 minutes et détache tous les débogueurs.";
        stopState.className = stop ? "stop-state active" : "muted";
        renderTabs(state.tabs || []);
    }

    stopButton.addEventListener("click", async () => {
        stopButton.disabled = true;
        const res = await toBackground({ panelStop: true });
        stopButton.disabled = false;
        if (res.error) showToast(`Erreur : ${res.error}`, 4000);
        else showToast(res.warning || "Arrêt d'urgence posé pour tous les agents (2 minutes).", 4000);
        refresh();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "session") refresh();
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.title || changeInfo.url) refresh();
    });
    chrome.tabs.onRemoved.addListener(() => refresh());

    refresh();
    setInterval(refresh, 1618);
});
