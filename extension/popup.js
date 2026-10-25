/**
 * Fenêtre de l'icône NexusBrowser : état du pont (relu au service worker) et nombre d'onglets de chaque agent (ses
 * groupes d'onglets). Aucune action sur les pages ni sur les agents n'en part. Seul réglage : la case du compteur de
 * mails non lus de Gmail pour le pad MX Keypad AI Agents (facultatif, décoché par défaut).
 */
const AGENTS = ["Claude", "Codex", "Antigravity"];

function text(id, value) {
    document.getElementById(id).textContent = value;
}

async function showBridge() {
    const state = document.getElementById("bridge");
    const detail = document.getElementById("bridge-detail");
    let status = null;
    try {
        status = await chrome.runtime.sendMessage({ target: "background", getStatus: true });
    } catch (_) {}
    const ok = !!(status && status.connected);
    state.className = `state ${ok ? "ok" : "off"}`;
    state.textContent = ok ? "Pont connecté" : "Pont en attente";
    const reason = ok ? "" : (status && status.authError) || "Il démarre à la première commande d'un agent.";
    detail.hidden = !reason;
    detail.textContent = reason;
    // Sans hôte natif (application du Microsoft Store) : appairage par un code donné par l'application.
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
    } catch (_) {}
    const list = document.getElementById("agents");
    list.replaceChildren(...AGENTS.map(name => {
        const item = document.createElement("li");
        const label = document.createElement("span");
        label.textContent = name;
        const n = document.createElement("span");
        const count = counts.get(name);
        n.className = count ? "count active" : "count";
        n.textContent = count ? `${count} onglet${count > 1 ? "s" : ""}` : "aucun";
        item.append(label, n);
        return item;
    }));
}

async function showCompteur() {
    const caseGmail = document.getElementById("compteur-gmail");
    try {
        caseGmail.checked = !!(await chrome.storage.local.get("compteurGmail")).compteurGmail;
    } catch (_) {}
    caseGmail.addEventListener("change", () => chrome.storage.local.set({ compteurGmail: caseGmail.checked }));
}

text("version", `v${chrome.runtime.getManifest().version}`);
showCompteur();
showBridge();
showAgents();
