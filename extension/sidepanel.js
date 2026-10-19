/**
 * Panneau Antigravity de NexusBrowser (accord Claude-Antigravity du 18/10/2026).
 *
 * Discussion : Julien tape une demande ; elle part au service worker (agyAsk) avec l'onglet actif de cette fenêtre,
 * puis au pont, qui la dépose dans la boîte de Nexus Relay : Antigravity est réveillé, agit sur l'onglet avec ses
 * outils nexus-browser et répond ; la réponse arrive dans chrome.storage.local (fil « agyChat ») et s'affiche ici.
 * Ce panneau n'agit lui-même sur aucune page.
 *
 * Poste de contrôle (onglet « Contrôle ») : onglets pilotés par chaque agent, « Rendre l'onglet », état du pont ;
 * STOP (en-tête, toujours visible) : arrêt d'urgence de tous les agents pendant 2 minutes.
 */

document.addEventListener("DOMContentLoaded", () => {
    const view = globalThis.AgySidepanelView;
    const chat = globalThis.AgyChat;
    const $ = (id) => document.getElementById(id);
    const tabsList = $("tabs-list");
    const bridgeState = $("bridge-state");
    const stopState = $("stop-state");
    const stopBanner = $("stop-banner");
    const stopButton = $("btn-stop");
    const versionLine = $("version-line");
    const pilotedCount = $("piloted-count");
    const toast = $("toast");
    const chatLog = $("chat-log");
    const welcome = $("welcome");
    const working = $("working");
    const workingText = $("working-text");
    const prompt = $("prompt");
    const sendButton = $("btn-send");
    const tabContext = $("tab-context");
    let toastTimer = null;
    let activeTab = null;
    let targetTab = null;  // onglet figé dès la première frappe : la demande part pour l'onglet affiché pendant la frappe
    let targetMoved = false;  // l'onglet figé a changé de page depuis : la cible n'est jamais réécrite sans un clic de Julien
    let entries = [];
    let lastControl = null;
    let sending = false;  // verrou du compositeur : Entrée et le bouton ne déposent jamais deux fois la même frappe

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

    // --- Vues
    function showView(name) {
        const isChat = name === "chat";
        $("view-chat").hidden = !isChat;
        $("view-control").hidden = isChat;
        for (const [id, on] of [["tab-chat", isChat], ["tab-control", !isChat]]) {
            $(id).classList.toggle("active", on);
            $(id).setAttribute("aria-pressed", String(on));
        }
        if (isChat) prompt.focus();
    }
    $("tab-chat").addEventListener("click", () => showView("chat"));
    $("tab-control").addEventListener("click", () => showView("control"));

    // --- Onglet visé : l'onglet actif de la fenêtre de ce panneau, figé dès que Julien commence à écrire (un autre
    // agent ou un clic peut changer l'onglet actif pendant la frappe : vu au banc du 18/10, la demande partait ailleurs).
    function showTarget() {
        const tab = targetTab || activeTab;
        const name = tab ? tab.title || view.hostOf(tab.url) : "aucun";
        tabContext.textContent = `Onglet : ${name}${targetTab ? (targetMoved ? " (figé, page changée depuis)" : " (figé)") : ""}`;
        tabContext.title = targetTab
            ? targetMoved
                ? "L'onglet visé a changé de page depuis la frappe : la demande serait refusée. Cliquer pour viser la page affichée maintenant."
                : "Onglet visé, figé pendant la frappe. Cliquer pour viser l'onglet affiché maintenant."
            : "Onglet sur lequel Antigravity agira (figé dès la première frappe).";
    }

    async function readActiveTab() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            activeTab = tab && Number.isInteger(tab.id) ? tab : null;
        } catch (_) {
            activeTab = null;
        }
        showTarget();
    }

    // Instantané : l'identité visée (onglet + page) ne suit plus les mises à jour de l'onglet.
    function setTarget(tab) {
        targetTab = tab ? { id: tab.id, url: tab.url || "", title: tab.title || "" } : null;
        targetMoved = false;
    }

    function freezeTarget() {
        if (!prompt.value.trim()) setTarget(null);
        else if (!targetTab) setTarget(activeTab);
        showTarget();
    }

    // --- Fil de discussion
    function starIcon() {
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("fill", "url(#star-ink)");
        path.setAttribute("d", "M12 1.5c.7 5.6 4.9 9.8 10.5 10.5-5.6.7-9.8 4.9-10.5 10.5C11.3 16.9 7.1 12.7 1.5 12 7.1 11.3 11.3 7.1 12 1.5z");
        svg.appendChild(path);
        return svg;
    }

    function renderChat() {
        for (const node of [...chatLog.querySelectorAll(".msg")]) node.remove();
        welcome.hidden = entries.length > 0;
        for (const entry of entries) {
            if (entry.kind === "ask") {
                const box = el("div", "msg ask");
                box.appendChild(el("div", "bubble", entry.text));
                const status = chat.askStatus(entry);
                const where = entry.tab && entry.tab.title ? `Sur « ${entry.tab.title} »` : "";
                const meta = [where, status].filter(Boolean).join(" · ");
                if (meta) box.appendChild(el("div", `meta${entry.status === "error" ? " error" : ""}`, meta));
                if (entry.status === "sending" || entry.status === "sent") {
                    const stop = el("button", "ghost", "Abandonner");
                    stop.type = "button";
                    stop.title = "Libère le panneau pour une autre demande (Antigravity peut encore finir celle-ci)";
                    stop.addEventListener("click", () => toBackground({ agyAbandon: entry.localId }));
                    box.appendChild(stop);
                }
                chatLog.appendChild(box);
            } else if (entry.kind === "reply") {
                const box = el("div", "msg reply");
                const who = el("div", "who");
                who.append(starIcon(), el("span", "", entry.from === "antigravity" ? "Antigravity" : entry.from));
                box.append(who, el("div", "bubble", entry.text));
                chatLog.appendChild(box);
            }
        }
        renderWorking();
        chatLog.scrollTop = chatLog.scrollHeight;
    }

    function renderWorking() {
        const pending = chat.pendingAsk(entries);
        working.hidden = !pending;
        if (!pending) return;
        const acting = (lastControl && lastControl.tabs || []).find((t) => /antigravity/i.test(t.agent) && t.commandsInFlight > 0);
        workingText.textContent = acting
            ? `Antigravity agit sur « ${acting.title || view.hostOf(acting.url)} »…`
            : "En attente d'Antigravity…";
    }

    async function loadChat() {
        try {
            const stored = await chrome.storage.local.get("agyChat");
            entries = Array.isArray(stored.agyChat) ? stored.agyChat : [];
        } catch (_) {
            entries = [];
        }
        renderChat();
    }

    async function send(text) {
        const checked = chat.checkText(text);
        if (checked.error) {
            showToast(checked.error);
            return;
        }
        if (sending) return;
        sending = true;
        sendButton.disabled = true;
        const tab = targetTab || activeTab;
        // La page vue pendant la frappe part avec la demande : le service worker refuse si l'onglet en a changé.
        const res = await toBackground({ agyAsk: { text: checked.text, tabId: tab ? tab.id : null, expectUrl: tab ? tab.url || "" : "" } });
        sending = false;
        sendButton.disabled = false;
        if (res.error) {
            showToast(`Erreur : ${res.error}`, 4000);
            return;
        }
        prompt.value = "";
        autosize();
        freezeTarget();
    }

    function autosize() {
        prompt.style.height = "auto";
        prompt.style.height = `${Math.min(prompt.scrollHeight, 160)}px`;
    }

    $("composer").addEventListener("submit", (event) => {
        event.preventDefault();
        send(prompt.value);
    });
    prompt.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            send(prompt.value);
        }
    });
    prompt.addEventListener("input", () => {
        autosize();
        freezeTarget();
    });
    tabContext.addEventListener("click", async () => {
        await readActiveTab();
        setTarget(prompt.value.trim() ? activeTab : null);
        showTarget();
    });
    for (const chip of document.querySelectorAll(".chip")) {
        chip.addEventListener("click", () => {
            prompt.value = chip.dataset.prompt || "";
            autosize();
            freezeTarget();
            prompt.focus();
            prompt.setSelectionRange(prompt.value.length, prompt.value.length);
        });
    }
    $("btn-new").addEventListener("click", async () => {
        await toBackground({ agyClear: true });
        showToast("Affichage effacé (sauf la demande en cours). Antigravity garde le contexte de sa conversation.");
    });

    // --- Poste de contrôle
    function renderTabs(tabs) {
        const groups = view.groupByAgent(tabs);
        tabsList.replaceChildren();
        pilotedCount.hidden = !tabs.length;
        pilotedCount.textContent = String(tabs.length);
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
                    showToast(res.error ? `Erreur : ${res.error}` : `Onglet #${tab.tabId} rendu à l'utilisateur`);
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
        lastControl = state;
        versionLine.textContent = `NexusBrowser ${state.version || ""}`.trim();
        const bridge = view.bridgeLabel(state.bridge);
        bridgeState.textContent = bridge.text;
        bridgeState.className = `state-pill ${bridge.ok ? "ok" : "off"}`;
        const stop = view.stopLabel(state.stoppedUntil);
        stopState.textContent = stop || "STOP arrête toutes les actions de tous les agents pendant 2 minutes et détache tous les débogueurs.";
        stopState.className = stop ? "stop-state active" : "muted";
        stopBanner.hidden = !stop;
        stopBanner.textContent = stop || "";
        renderTabs(state.tabs || []);
        renderWorking();
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
        if (area === "local" && changes.agyChat) {
            entries = Array.isArray(changes.agyChat.newValue) ? changes.agyChat.newValue : [];
            renderChat();
        } else if (area === "session") {
            refresh();
        }
    });
    chrome.tabs.onActivated.addListener(() => readActiveTab());
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (activeTab && tabId === activeTab.id && (changeInfo.title || changeInfo.url)) readActiveTab();
        if (targetTab && tabId === targetTab.id && (changeInfo.title || changeInfo.url)) {
            // Signalé seulement : l'URL attendue reste celle de la frappe (le worker refusera une autre page).
            chrome.tabs.get(tabId).then((tab) => {
                if (targetTab && targetTab.id === tab.id && (tab.url || "") !== targetTab.url) targetMoved = true;
                showTarget();
            }, () => {});
        }
        if (changeInfo.title || changeInfo.url) refresh();
    });
    chrome.tabs.onRemoved.addListener(() => refresh());

    readActiveTab();
    loadChat();
    refresh();
    setInterval(refresh, 1618);
    prompt.focus();
});
