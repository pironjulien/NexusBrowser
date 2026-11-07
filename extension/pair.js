/**
 * Pairing of the extension with the local bridge, without a native host (native/BridgePairing.cs). The pairing secret
 * arrives in the address fragment (pair.html#<secret>, never sent over the network, cleared from the address as soon as
 * it is read) or pasted in the field. "pair" handshake proven both ways with that secret, then a lasting key derived
 * from the secret and that handshake, kept non-extractable (bridge_link.js, AgyPairing). Text from Chrome's catalogs
 * (i18n.js, _locales).
 */
const BRIDGE_WS_URL = "ws://127.0.0.1:9224";

function show(message, state = "") {
    document.getElementById("detail").textContent = message;
    document.getElementById("state").className = `state ${state}`;
}

async function pair(secret) {
    if (!globalThis.AgyPairing.isSecret(secret)) {
        show(chrome.i18n.getMessage("pairInvalidCode"), "off");
        return;
    }
    const secretKey = await globalThis.AgyPairing.secretKey(secret);
    let handshake = null;
    let done = false;
    show(chrome.i18n.getMessage("pairInProgress"));
    new globalThis.AgyBridgeLink({
        url: BRIDGE_WS_URL,
        role: "pairing",
        extensionId: chrome.runtime.id,
        auth: "pair",
        prove: async (args) => {
            handshake = args;
            return globalThis.AgyPairing.prove(secretKey, args);
        },
        onRequest: async () => ({ error: "pairing connection: no command" }),
        onStateChange: async (link) => {
            if (link.state !== "ready" || done) return;
            done = true; // the bridge confirmed (signed auth_ok) and closes the connection
            try {
                const key = await globalThis.AgyPairing.derive(secretKey, handshake.client_nonce, handshake.server_nonce, handshake.extension_id);
                await globalThis.AgyPairing.save(key);
            } catch (error) {
                show(chrome.i18n.getMessage("pairKeyNotSaved", [String(error.message || error)]), "off");
                return;
            }
            link.close();
            try {
                await chrome.runtime.sendMessage({ target: "background", bridgePaired: true });
            } catch (error) {
                // Key already saved: the service worker reads it at its next start, the message is only a shortcut.
                console.debug(`[NexusBrowser] pairing notice to the service worker: ${error?.message || error}`);
            }
            show(chrome.i18n.getMessage("pairDone"), "ok");
        },
        onClose: (link) => {
            if (!done) show(chrome.i18n.getMessage("pairRefused", [link.error || chrome.i18n.getMessage("pairRefusedDefault")]), "off");
        }
    });
}

const fromAddress = location.hash.slice(1);
if (fromAddress) {
    history.replaceState(null, "", location.pathname); // the secret stays neither in the address nor in the page history
    pair(fromAddress);
}

document.getElementById("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const field = document.getElementById("code");
    const secret = field.value.trim();
    field.value = "";
    pair(secret);
});
