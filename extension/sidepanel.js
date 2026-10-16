/**
 * Panneau latéral Antigravity : tout ce qui y est affiché fait réellement ce qu'il annonce.
 *
 * - Les quatre boutons agissent tout de suite sur l'onglet visé, par le service worker (aucun aller-retour réseau) :
 *   carte des éléments cliquables (chaque numéro se clique), champs de formulaire (libellé, type, requis, rempli ;
 *   jamais de valeur), cookies (nombre, domaines et noms ; jamais de valeur : includeValues false), capture.
 * - Le panneau ne contient pas de modèle d'IA : une demande écrite est transmise à Antigravity par le pont local
 *   authentifié (événement signé sidepanel_request). L'agent la lit avec l'outil MCP browser_sidepanel_requests et
 *   répond avec browser_sidepanel_reply ; le fil (demandes, état, réponses) vit dans chrome.storage.session.
 * - L'onglet visé suit l'onglet actif, ou celui choisi avec + / @ (✕ revient à l'onglet actif).
 */

document.addEventListener("DOMContentLoaded", () => {
    const view = globalThis.AgySidepanelView;
    const THREAD_KEY = "nexusagySidepanelThread";
    const $ = (id) => document.getElementById(id);

    const bridgeStatusIndicator = $("bridge-status-indicator");
    const optionsDropdownMenu = $("options-dropdown-menu");
    const welcomeBox = $("welcome-box");
    const feedMessages = $("feed-messages");
    const feedContainer = $("feed-container");
    const tabsDropdownMenu = $("tabs-dropdown-menu");
    const tabsDropdownList = $("tabs-dropdown-list");
    const tabChipTitle = $("tab-chip-title");
    const btnDetachTab = $("btn-detach-tab");
    const promptInput = $("prompt-input");
    const btnSend = $("btn-send");
    const destinationLabel = $("destination-label");
    const geminiToast = $("gemini-toast");

    let targetTab = null; // onglet visé : {id, title, url}
    let pinned = false; // vrai : choisi avec + / @ (ne suit plus l'onglet actif)
    let bridgeConnected = false;
    let toastTimeout = null;
    const threadNodes = new Map(); // id d'une entrée du fil -> élément affiché

    // -------------------------------------------------------------------------
    // Outils d'affichage (texte toujours inséré par textContent : aucune injection HTML)
    // -------------------------------------------------------------------------
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function showToast(text, durationMs = 2400) {
        if (!geminiToast) return;
        geminiToast.textContent = text;
        geminiToast.classList.add("show");
        if (toastTimeout) clearTimeout(toastTimeout);
        toastTimeout = setTimeout(() => geminiToast.classList.remove("show"), durationMs);
    }

    function scrollToEnd() {
        feedContainer.scrollTop = feedContainer.scrollHeight;
    }

    function hideWelcome() {
        if (welcomeBox) welcomeBox.style.display = "none";
    }

    function addMessage(role, text) {
        hideWelcome();
        const bubble = el("div", `message-bubble ${role}`, text);
        bubble.style.whiteSpace = "pre-wrap";
        feedMessages.appendChild(bubble);
        scrollToEnd();
        return bubble;
    }

    function addResultCard(title, build) {
        hideWelcome();
        const card = el("div", "result-card");
        const header = el("div", "result-header");
        header.appendChild(el("span", null, title));
        const body = el("div", "result-body");
        build(body);
        card.append(header, body);
        feedMessages.appendChild(card);
        scrollToEnd();
        return card;
    }

    function addError(title, message) {
        return addResultCard(title, (body) => body.appendChild(el("p", "error", message)));
    }

    function addThinkingIndicator(label) {
        hideWelcome();
        const bubble = el("div", "message-bubble assistant thinking-bubble");
        const indicator = el("div", "thinking-indicator");
        indicator.appendChild(el("span", null, label));
        const dots = el("span", "thinking-dots-wrap");
        for (let i = 0; i < 3; i++) dots.appendChild(el("span", "thinking-dot"));
        indicator.appendChild(dots);
        bubble.appendChild(indicator);
        feedMessages.appendChild(bubble);
        scrollToEnd();
        return bubble;
    }

    function hideAllDropdowns() {
        optionsDropdownMenu.style.display = "none";
        tabsDropdownMenu.style.display = "none";
    }

    document.addEventListener("click", (e) => {
        if (!e.target.closest(".gemini-floating-menu") && !e.target.closest("#btn-options") && !e.target.closest("#btn-add-context")) {
            hideAllDropdowns();
        }
    });

    function toBackground(message) {
        return new Promise((resolve) => {
            chrome.runtime.sendMessage({ target: "background", ...message }, (res) => {
                if (chrome.runtime.lastError) resolve({ error: chrome.runtime.lastError.message });
                else resolve(res || {});
            });
        });
    }

    function executeBridgeAction(action, params = {}) {
        const withTab = targetTab && params.tab_id === undefined && params.tabId === undefined
            ? { ...params, tab_id: targetTab.id }
            : params;
        return toBackground({ executeAction: true, action, params: withTab });
    }

    // -------------------------------------------------------------------------
    // État réel du pont (liaisons authentifiées du service worker et de l'offscreen)
    // -------------------------------------------------------------------------
    async function updateBridgeStatus() {
        const res = await toBackground({ getStatus: true });
        bridgeConnected = !!res.connected;
        bridgeStatusIndicator.className = `gemini-status-dot ${bridgeConnected ? "online" : "offline"}`;
        bridgeStatusIndicator.title = bridgeConnected
            ? "Pont local authentifié (127.0.0.1:9224)"
            : `Pont local non authentifié${res.authError ? ` : ${res.authError}` : res.error ? ` : ${res.error}` : ""}`;
        destinationLabel.textContent = bridgeConnected
            ? "Transmis à Antigravity par le pont local"
            : "Pont local non authentifié : rien ne peut être transmis";
        updateSendButtonState();
        return res;
    }

    bridgeStatusIndicator.addEventListener("click", () => updateBridgeStatus().then(() => showToast(bridgeStatusIndicator.title)));

    // -------------------------------------------------------------------------
    // Menu Options
    // -------------------------------------------------------------------------
    $("btn-options").addEventListener("click", (e) => {
        e.stopPropagation();
        const isShowing = optionsDropdownMenu.style.display === "block";
        hideAllDropdowns();
        if (!isShowing) optionsDropdownMenu.style.display = "block";
    });

    $("btn-close-panel").addEventListener("click", () => window.close());

    $("opt-reload-tab").addEventListener("click", async () => {
        hideAllDropdowns();
        if (!targetTab) return showToast("Aucun onglet visé");
        const res = await executeBridgeAction("reload");
        showToast(res.error ? `Erreur : ${res.error}` : "Onglet rechargé");
    });

    $("opt-ping-bridge").addEventListener("click", async () => {
        hideAllDropdowns();
        const t0 = performance.now();
        const res = await updateBridgeStatus();
        const latency = Math.round(performance.now() - t0);
        addResultCard("État du pont local (127.0.0.1:9224)", (body) => {
            body.appendChild(el("p", bridgeConnected ? null : "error", bridgeConnected
                ? "Pont authentifié : Antigravity peut piloter Chrome et lire les demandes du panneau."
                : "Pont non authentifié : aucune commande n'est acceptée."));
            for (const link of Object.values(res.links || {})) {
                const role = link.role === "offscreen" ? "Document offscreen" : "Service worker";
                body.appendChild(el("p", "muted", `${role} : ${link.ready ? "authentifié" : link.state || "fermé"}${link.error ? ` (${link.error})` : ""}`));
            }
            body.appendChild(el("p", "muted", `Réponse du service worker en ${latency} ms`));
        });
    });

    $("opt-open-extensions").addEventListener("click", () => {
        hideAllDropdowns();
        chrome.tabs.create({ url: "chrome://extensions" });
    });

    $("opt-clear-chat").addEventListener("click", async () => {
        hideAllDropdowns();
        await chrome.storage.session.remove(THREAD_KEY);
        feedMessages.replaceChildren();
        threadNodes.clear();
        welcomeBox.style.display = "flex";
        showToast("Fil du panneau effacé");
    });

    // -------------------------------------------------------------------------
    // Onglet visé (suit l'onglet actif, sauf choix explicite)
    // -------------------------------------------------------------------------
    function showTargetTab() {
        tabChipTitle.textContent = targetTab ? (targetTab.title || "Nouvel onglet") : "Aucun onglet";
        tabChipTitle.title = targetTab ? (targetTab.url || targetTab.title || "") : "";
        btnDetachTab.style.display = pinned ? "" : "none";
    }

    async function followActiveTab() {
        if (pinned) return;
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            targetTab = tab ? { id: tab.id, title: tab.title || "", url: tab.url || "" } : null;
        } catch (_) {
            targetTab = null;
        }
        showTargetTab();
    }

    function pinTab(tab) {
        pinned = true;
        targetTab = { id: tab.id, title: tab.title || "", url: tab.url || "" };
        if (promptInput.value.endsWith("@")) promptInput.value = promptInput.value.slice(0, -1);
        promptInput.focus();
        showTargetTab();
        showToast(`Onglet visé : ${(tab.title || tab.url || "").slice(0, 40)}`);
    }

    async function openTabsDropdown() {
        hideAllDropdowns();
        tabsDropdownList.replaceChildren(el("div", "muted", "Chargement des onglets..."));
        tabsDropdownMenu.style.display = "block";
        try {
            const tabs = await chrome.tabs.query({});
            tabsDropdownList.replaceChildren();
            if (!tabs.length) tabsDropdownList.appendChild(el("div", "muted", "Aucun onglet ouvert."));
            for (const tab of tabs) {
                const item = el("div", `tab-select-item${targetTab && tab.id === targetTab.id ? " active" : ""}`);
                if (tab.favIconUrl) {
                    const icon = document.createElement("img");
                    icon.src = tab.favIconUrl;
                    icon.alt = "";
                    icon.addEventListener("error", () => icon.replaceWith(el("span", null, "🌐")));
                    item.appendChild(icon);
                } else {
                    item.appendChild(el("span", null, "🌐"));
                }
                const title = el("span", "tab-select-title", tab.title || tab.url || "Onglet sans titre");
                title.title = tab.url || "";
                item.appendChild(title);
                item.addEventListener("click", () => {
                    pinTab(tab);
                    hideAllDropdowns();
                });
                tabsDropdownList.appendChild(item);
            }
        } catch (err) {
            tabsDropdownList.replaceChildren(el("div", "error", `Erreur : ${err.message}`));
        }
    }

    $("btn-add-context").addEventListener("click", (e) => {
        e.stopPropagation();
        if (tabsDropdownMenu.style.display === "block") tabsDropdownMenu.style.display = "none";
        else openTabsDropdown();
    });

    btnDetachTab.addEventListener("click", () => {
        pinned = false;
        followActiveTab();
        showToast("Onglet visé : l'onglet actif");
    });

    chrome.tabs.onActivated.addListener(() => followActiveTab());
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (pinned && targetTab && tabId === targetTab.id && (changeInfo.title || changeInfo.url)) {
            targetTab = { id: tab.id, title: tab.title || "", url: tab.url || "" };
            showTargetTab();
        } else if (!pinned && (changeInfo.status === "complete" || changeInfo.title || changeInfo.url)) {
            followActiveTab();
        }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
        if (pinned && targetTab && tabId === targetTab.id) {
            pinned = false;
            followActiveTab();
        }
    });

    // -------------------------------------------------------------------------
    // Actions immédiates (boutons)
    // -------------------------------------------------------------------------
    async function runAction(userLabel, waitLabel, action, params) {
        addMessage("user", userLabel);
        if (!targetTab) {
            addError(userLabel, "Aucun onglet visé.");
            return null;
        }
        const thinking = addThinkingIndicator(waitLabel);
        const res = await executeBridgeAction(action, params);
        thinking.remove();
        if (res.error) {
            addError(userLabel, res.error);
            return null;
        }
        return res.data || {};
    }

    async function triggerInteractiveMap() {
        const data = await runAction("Cartographier les boutons cliquables", "Lecture de la page", "interactive_map", { viewportOnly: true });
        if (!data) return;
        const elements = view.clickableElements(data.elements);
        addResultCard(`Éléments cliquables visibles (${elements.length})`, (body) => {
            if (!elements.length) return body.appendChild(el("p", "muted", "Aucun élément cliquable dans la zone visible."));
            const list = el("div", "elements-list");
            for (const item of elements) {
                const pill = el("div", "element-pill-action");
                pill.title = `Cliquer sur #${item.mark} (${item.selector || item.tag})`;
                pill.append(el("span", "element-badge", `#${item.mark}`), el("span", "muted", item.tag), el("span", null, item.label || item.selector || item.tag));
                pill.addEventListener("click", async () => {
                    addMessage("user", `Clic sur #${item.mark}`);
                    const res = await executeBridgeAction("click_mark", { mark: item.mark });
                    if (res.error) addError(`Clic #${item.mark}`, res.error);
                    else addMessage("assistant", res.data?.warning ? `Clic #${item.mark} envoyé : ${res.data.warning}` : `Clic #${item.mark} exécuté.`);
                });
                list.appendChild(pill);
            }
            body.appendChild(list);
            body.appendChild(el("p", "muted", "Un numéro cliqué est un vrai clic dans la page."));
        });
    }

    async function triggerInspect() {
        const data = await runAction("Inspecter les champs du formulaire", "Lecture des champs", "form_fields", {});
        if (!data) return;
        const fields = Array.isArray(data.fields) ? data.fields : [];
        addResultCard(`Champs de formulaire visibles (${data.count || 0})`, (body) => {
            if (!fields.length) return body.appendChild(el("p", "muted", "Aucun champ de saisie visible."));
            for (const field of fields) body.appendChild(el("div", "field-row", view.describeField(field)));
            if (data.truncated) body.appendChild(el("p", "muted", `… et ${data.count - fields.length} autre(s)`));
            body.appendChild(el("p", "muted", "Aucune valeur saisie n'est lue : seulement « rempli » ou « vide »."));
        });
    }

    async function triggerCookies() {
        // includeValues false : les valeurs ne quittent jamais le service worker.
        const data = await runAction("Extraire les cookies de session", "Lecture des cookies", "get_cookies", { includeValues: false });
        if (!data) return;
        const summary = view.summarizeCookies(data.cookies);
        addResultCard(`Cookies de l'onglet (${summary.count})`, (body) => {
            if (!summary.count) return body.appendChild(el("p", "muted", "Aucun cookie pour cette page."));
            for (const domain of summary.domains) {
                body.appendChild(el("div", "cookie-domain", `${domain.domain} : ${domain.count}`));
                body.appendChild(el("div", "cookie-names", domain.names.join(", ")));
            }
            body.appendChild(el("p", "muted", "Noms et domaines seulement : aucune valeur n'est affichée ni transmise au panneau."));
        });
    }

    async function triggerScreenshot() {
        const data = await runAction("Capturer la vue actuelle", "Capture", "screenshot", {});
        if (!data) return;
        if (!data.dataUrl) return addError("Capture", "Chrome n'a renvoyé aucune image.");
        addResultCard("Capture de l'onglet visé", (body) => {
            const image = document.createElement("img");
            image.className = "capture-image";
            image.alt = "Capture";
            image.src = data.dataUrl;
            body.appendChild(image);
        });
    }

    const ACTIONS = { map: triggerInteractiveMap, inspect: triggerInspect, cookies: triggerCookies, screenshot: triggerScreenshot };
    document.querySelectorAll(".gemini-pill-btn[data-action]").forEach((btn) => {
        btn.addEventListener("click", () => ACTIONS[btn.getAttribute("data-action")]?.());
    });

    // -------------------------------------------------------------------------
    // Demandes transmises à Antigravity et fil des réponses
    // -------------------------------------------------------------------------
    function updateSendButtonState() {
        btnSend.disabled = !promptInput.value.trim() || !bridgeConnected;
        btnSend.classList.toggle("has-text", !btnSend.disabled);
    }

    function renderThreadEntry(entry) {
        let node = threadNodes.get(entry.id);
        if (!node) {
            hideWelcome();
            node = el("div", `message-bubble ${entry.kind === "reply" ? "assistant" : "user"}`);
            const text = el("div", null, entry.text);
            text.style.whiteSpace = "pre-wrap";
            node.appendChild(text);
            if (entry.kind === "request") {
                if (entry.tab?.title) node.appendChild(el("span", "request-status", `Onglet joint : ${entry.tab.title}`));
                node.appendChild(el("span", "request-status state"));
            } else {
                node.prepend(el("span", "request-status", "Antigravity"));
            }
            feedMessages.appendChild(node);
            threadNodes.set(entry.id, node);
            scrollToEnd();
        }
        const state = node.querySelector(".state");
        if (state) {
            state.textContent = view.requestStatusLabel(entry.status);
            state.className = `request-status state ${entry.status}`;
        }
    }

    async function renderThread() {
        const stored = await chrome.storage.session.get(THREAD_KEY);
        const thread = Array.isArray(stored?.[THREAD_KEY]) ? stored[THREAD_KEY] : [];
        thread.forEach(renderThreadEntry);
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "session" && changes[THREAD_KEY]) renderThread();
    });

    async function handleSend() {
        const text = promptInput.value.trim();
        if (!text) return;
        if (!bridgeConnected) {
            showToast("Pont local non authentifié : demande non transmise");
            return;
        }
        promptInput.value = "";
        promptInput.style.height = "auto";
        updateSendButtonState();
        const res = await toBackground({ sidepanelSubmit: { text, tab: targetTab } });
        if (res.error) showToast(res.error, 4000);
        await renderThread();
    }

    promptInput.addEventListener("input", () => {
        updateSendButtonState();
        promptInput.style.height = "auto";
        promptInput.style.height = Math.min(promptInput.scrollHeight, 120) + "px";
    });
    promptInput.addEventListener("keyup", (e) => {
        if (e.key === "@") openTabsDropdown();
        else if (e.key === "Escape") hideAllDropdowns();
    });
    promptInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    });
    btnSend.addEventListener("click", handleSend);

    // -------------------------------------------------------------------------
    // Démarrage
    // -------------------------------------------------------------------------
    updateBridgeStatus();
    followActiveTab();
    renderThread();
    setInterval(updateBridgeStatus, 8000);
});
