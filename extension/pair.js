/**
 * Appairage de l'extension au pont local, sans hôte natif (native/BridgePairing.cs). Le secret d'appairage
 * arrive dans le fragment de l'adresse (pair.html#<secret>, jamais envoyé sur le réseau, effacé de l'adresse dès la
 * lecture) ou collé dans le champ. Poignée de main « pair » prouvée dans les deux sens avec ce secret, puis clé durable
 * dérivée du secret et de cette poignée de main, gardée non extractible (bridge_link.js, AgyPairing).
 */
const BRIDGE_WS_URL = "ws://127.0.0.1:9224";

function show(message, state = "") {
    document.getElementById("detail").textContent = message;
    document.getElementById("state").className = `state ${state}`;
}

async function pair(secret) {
    if (!globalThis.AgyPairing.isSecret(secret)) {
        show("Code invalide : 43 caractères (lettres, chiffres, - et _) attendus.", "off");
        return;
    }
    const secretKey = await globalThis.AgyPairing.secretKey(secret);
    let handshake = null;
    let done = false;
    show("Appairage en cours…");
    new globalThis.AgyBridgeLink({
        url: BRIDGE_WS_URL,
        role: "pairing",
        extensionId: chrome.runtime.id,
        auth: "pair",
        prove: async (args) => {
            handshake = args;
            return globalThis.AgyPairing.prove(secretKey, args);
        },
        onRequest: async () => ({ error: "connexion d'appairage : aucune commande" }),
        onStateChange: async (link) => {
            if (link.state !== "ready" || done) return;
            done = true; // le pont a confirmé (auth_ok signé) et va fermer la connexion
            try {
                const key = await globalThis.AgyPairing.derive(secretKey, handshake.client_nonce, handshake.server_nonce, handshake.extension_id);
                await globalThis.AgyPairing.save(key);
            } catch (error) {
                show(`Appairage accepté par le pont mais clé non enregistrée (${error.message || error}) : recommencer.`, "off");
                return;
            }
            link.close();
            try {
                await chrome.runtime.sendMessage({ target: "background", bridgePaired: true });
            } catch (_) {}
            show("Extension appairée au pont NexusBrowser. Vous pouvez fermer cet onglet.", "ok");
        },
        onClose: (link) => {
            if (!done) show(`Appairage refusé : ${link.error || "connexion fermée par le pont (code expiré, déjà utilisé ou faux)"}.`, "off");
        }
    });
}

const fromAddress = location.hash.slice(1);
if (fromAddress) {
    history.replaceState(null, "", location.pathname); // le secret ne reste ni dans l'adresse ni dans l'historique de la page
    pair(fromAddress);
}

document.getElementById("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const field = document.getElementById("code");
    const secret = field.value.trim();
    field.value = "";
    pair(secret);
});
