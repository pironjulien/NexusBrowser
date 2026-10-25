// Liaison offscreen au pont local : garde une connexion quand le service worker est suspendu et relaie les commandes
// authentifiées au service worker. Même protocole que le service worker (bridge_link.js) ; la poignée de main est
// prouvée par l'hôte natif via le service worker (un document offscreen n'a pas accès à la messagerie native).
const BRIDGE_WS_URL = "ws://127.0.0.1:9224";
let link = null;
let reconnectTimeout = null;

function toBackground(message) {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ target: "background", ...message }, (response) => {
                const lastErr = chrome.runtime.lastError;
                resolve(lastErr ? { error: lastErr.message } : response);
            });
        } catch (error) {
            resolve({ error: error.message || String(error) });
        }
    });
}

function reportState(current) {
    toBackground({ bridgeState: current.describe() });
}

function scheduleReconnect(delayMs = 2000) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(connectWS, delayMs);
}

let connecting = false;
let askAuth = false; // dernière tentative refusée : demander la méthode au service worker

function connectWS() {
    if ((link && link.alive) || connecting) return;
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }
    if (!askAuth) {
        openLink("native");
        return;
    }
    // Même méthode que le service worker (hôte natif, ou clé d'appairage s'il manque) : c'est lui qui prouve.
    connecting = true;
    toBackground({ bridgeAuth: true }).then((answer) => {
        connecting = false;
        if (!(link && link.alive)) openLink(answer === "paired" ? "paired" : "native");
    });
}

function openLink(auth) {
    try {
        link = new globalThis.AgyBridgeLink({
            url: BRIDGE_WS_URL,
            role: "offscreen",
            extensionId: chrome.runtime.id,
            auth,
            prove: async (args) => (await toBackground({ bridgeProve: args })) || { ok: false, error: "service worker injoignable" },
            onRequest: async (request) => {
                const response = await toBackground({ request });
                return response && (response.data !== undefined || response.error)
                    ? response
                    : { error: (response && response.error) || "No response from background" };
            },
            onStateChange: (current) => {
                if (current === link) reportState(current);
                if (current.state === "ready") current.send({ event: "bridge_connected", timestamp: Date.now() });
            },
            onClose: (current) => {
                if (current !== link) return;
                link = null;
                // Refus (hôte natif absent ou injoignable, clé d'appairage...) : le service worker redit la méthode.
                askAuth = !!current.error;
                scheduleReconnect(current.error ? 5000 : 2000);
            }
        });
    } catch (e) {
        link = null;
        scheduleReconnect(3000);
    }
}

connectWS();
// Health check guard every 10s to recover from suspended PC sleep states
setInterval(() => {
    if (!link || !link.alive) {
        connectWS();
    } else {
        reportState(link);  // le service worker a pu redémarrer et oublier l'état de cette liaison
    }
}, 10000);
