/**
 * Fenêtre de l'icône NexusBrowser : lecture seule. État du pont (relu au service worker) et nombre d'onglets de
 * chaque agent (ses groupes d'onglets). Aucune action sur les pages ni sur les agents n'en part.
 */
const AGENTS = ["Claude", "Codex", "Antigravity"];

function text(id, value) {
    document.getElementById(id).textContent = value;
}

async function showBridge() {
    const pill = document.getElementById("bridge");
    const detail = document.getElementById("bridge-detail");
    let status = null;
    try {
        status = await chrome.runtime.sendMessage({ target: "background", getStatus: true });
    } catch (_) {}
    const ok = !!(status && status.connected);
    pill.className = `pill ${ok ? "ok" : "off"}`;
    pill.textContent = ok ? "Pont local connecté" : "Pont local injoignable";
    const reason = ok ? "" : (status && status.authError) || "Il démarre à la première commande d'un agent.";
    detail.hidden = !reason;
    detail.textContent = reason;
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
    } catch (_) {}
    const list = document.getElementById("agents");
    list.replaceChildren(...AGENTS.map(name => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = name;
        const n = document.createElement("span");
        const count = counts.get(name);
        n.className = "n";
        n.textContent = count ? `${count} onglet${count > 1 ? "s" : ""}` : "aucun";
        item.append(label, n);
        return item;
    }));
}

text("version", `v${chrome.runtime.getManifest().version}`);
showBridge();
showAgents();
