/**
 * NexusBrowser's toolbar popup: bridge state (read from the service worker) and each agent's tab count (its tab
 * groups). Nothing is done to pages or agents from here. Only setting: the Gmail unread counter checkbox for the
 * MX Keypad AI Agents (optional, unchecked by default). Text from Chrome's catalogs (i18n.js, _locales).
 */
const AGENTS = ["Claude", "Codex", "Antigravity"];

// Expected failure with no effect on the display (default value kept), traced in the popup's console.
function swallowed(where, error) {
    console.debug(`[NexusBrowser] ${where}: ${error?.message || error}`);
}

function text(id, value) {
    document.getElementById(id).textContent = value;
}

async function showBridge() {
    const state = document.getElementById("bridge");
    const detail = document.getElementById("bridge-detail");
    let status = null;
    try {
        status = await chrome.runtime.sendMessage({ target: "background", getStatus: true });
    } catch (error) { swallowed("bridge status (service worker asleep or reloading)", error); }
    const ok = !!(status && status.connected);
    state.className = `state ${ok ? "ok" : "off"}`;
    state.textContent = chrome.i18n.getMessage(ok ? "popupBridgeConnected" : "popupBridgeWaiting");
    const reason = ok ? "" : (status && status.authError) || chrome.i18n.getMessage("popupBridgeStarts");
    detail.hidden = !reason;
    detail.textContent = reason;
    // Without a native host (Microsoft Store app): pairing with a code given by the app.
    document.getElementById("pair").hidden = ok;
}

async function showAgents() {
    const counts = new Map(AGENTS.map(name => [name, 0]));
    try {
        const groups = await chrome.tabGroups.query({});
        const tabs = await chrome.tabs.query({});
        for (const group of groups) {
            if (!counts.has(group.title)) continue;
            counts.set(group.title, counts.get(group.title) + tabs.filter(t => t.groupId === group.id).length);
        }
    } catch (error) { swallowed("agent tab groups", error); }
    const list = document.getElementById("agents");
    list.replaceChildren(...AGENTS.map(name => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = name;
        const n = document.createElement("span");
        const count = counts.get(name);
        n.className = count ? "count active" : "count";
        n.textContent = count > 1 ? chrome.i18n.getMessage("popupTabsMany", [String(count)])
            : chrome.i18n.getMessage(count ? "popupTabsOne" : "popupTabsNone");
        item.append(label, n);
        return item;
    }));
}

async function showCompteur() {
    const caseGmail = document.getElementById("compteur-gmail");
    if (!caseGmail) return; // Chrome Web Store variant without the Gmail counter
    try {
        caseGmail.checked = !!(await chrome.storage.local.get("compteurGmail")).compteurGmail;
    } catch (error) { swallowed("Gmail counter setting", error); }
    caseGmail.addEventListener("change", () => chrome.storage.local.set({ compteurGmail: caseGmail.checked }));
}

text("version", `v${chrome.runtime.getManifest().version}`);
showCompteur();
showBridge();
showAgents();
