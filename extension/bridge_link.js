/**
 * Liaison authentifiée au pont local NexusBrowser (protocole « nexus-browser/1 », voir native-host/bridge_auth.py).
 *
 * Partagée par le service worker (importScripts) et le document offscreen (<script>). Le serveur du port 9224 doit
 * prouver qu'il connaît le jeton ~/.nexus/nexus-browser/bridge-token (HMAC sur les deux nonces de la connexion) AVANT que
 * l'extension ne prouve le sien ; la vérification et la preuve sont faites par l'hôte natif
 * com.nexus.browser_auth (prove), qui ne livre jamais le jeton, seulement une clé de session propre à la
 * connexion. Ensuite chaque message est signé (HMAC-SHA256, numéro d'ordre strict par sens).
 *
 * Règle : rien venant du serveur n'est exécuté avant la fin de la poignée de main (auth_ok signé), et tout message
 * non signé, mal signé, rejoué ou hors d'ordre ferme la connexion sans être exécuté.
 */
(function (scope) {
    const PROTOCOL = "nexus-browser/1";
    const HANDSHAKE_TIMEOUT_MS = 10000;
    const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
    const encoder = new TextEncoder();

    function b64url(bytes) {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }

    function fromB64url(text) {
        const binary = atob(String(text).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }

    function newNonce() {
        const bytes = new Uint8Array(32);
        crypto.getRandomValues(bytes);
        return b64url(bytes);
    }

    class BridgeLink {
        /**
         * url : ws://127.0.0.1:9224 ; role : "service_worker" | "offscreen" ; extensionId : chrome.runtime.id ;
         * prove(args) -> {ok, client_proof, session_key} | {ok: false, error} (hôte natif) ;
         * onRequest(request) -> réponse {data | error} d'une commande authentifiée ;
         * onStateChange(link) à chaque changement d'état ; onClose(link) une seule fois à la fermeture.
         */
        constructor({ url, role, extensionId, auth, prove, onRequest, onStateChange, onClose, WebSocketImpl }) {
            this.url = url;
            this.role = role;
            this.auth = auth || "native"; // "native" (hôte natif), "paired" (clé d'appairage) ou "pair" (appairage)
            this.extensionId = extensionId;
            this.prove = prove;
            this.onRequest = onRequest;
            this.onStateChange = onStateChange || (() => {});
            this.onClose = onClose || (() => {});
            this.state = "connecting"; // connecting -> handshake -> proven -> ready | closed
            this.error = null;
            this.clientNonce = null;
            this.key = null;
            this.sent = 0;
            this.received = 0;
            this.receiving = Promise.resolve();
            this.sending = Promise.resolve();
            this.handshakeTimer = null;
            this.closed = false;
            const Impl = WebSocketImpl || WebSocket;
            this.ws = new Impl(url);
            this.ws.onopen = () => this._open();
            this.ws.onmessage = (event) => {
                // Vérifications dans l'ordre d'arrivée ; l'exécution des commandes, elle, n'attend pas.
                this.receiving = this.receiving.then(() => this._receive(event.data)).catch((error) => this.fail(error.message || String(error)));
            };
            this.ws.onclose = () => this._closed();
            this.ws.onerror = () => {};
        }

        get ready() {
            return this.state === "ready" && this.ws.readyState === 1;
        }

        get alive() {
            return !this.closed && (this.ws.readyState === 0 || this.ws.readyState === 1);
        }

        _setState(state) {
            this.state = state;
            try { this.onStateChange(this); } catch (_) {}
        }

        _open() {
            this.clientNonce = newNonce();
            this._setState("handshake");
            this.handshakeTimer = setTimeout(() => this.fail("poignée de main trop lente"), HANDSHAKE_TIMEOUT_MS);
            this.ws.send(JSON.stringify({
                type: "auth_hello",
                protocol: PROTOCOL,
                client_nonce: this.clientNonce,
                role: this.role,
                extension_id: this.extensionId,
                // Champ absent pour l'hôte natif : un pont antérieur à l'appairage reste compatible.
                ...(this.auth === "native" ? {} : { auth: this.auth })
            }));
        }

        async _mac(direction, seq, body) {
            const signature = await crypto.subtle.sign("HMAC", this.key, encoder.encode([PROTOCOL, direction, String(seq), body].join("\n")));
            return b64url(new Uint8Array(signature));
        }

        async _receive(raw) {
            if (this.closed) return;
            let message;
            try { message = JSON.parse(raw); } catch (_) { return this.fail("message illisible du serveur"); }
            if (!message || typeof message !== "object" || Array.isArray(message)) return this.fail("message invalide du serveur");

            if (this.state === "handshake") {
                if (message.type !== "auth_challenge" || !NONCE_RE.test(message.server_nonce || "") || typeof message.server_proof !== "string") {
                    return this.fail("le serveur n'a pas ouvert la poignée de main NexusBrowser : aucune commande acceptée");
                }
                let proof;
                try {
                    proof = await this.prove({
                        op: "handshake",
                        client_nonce: this.clientNonce,
                        server_nonce: message.server_nonce,
                        server_proof: message.server_proof,
                        role: this.role,
                        extension_id: this.extensionId,
                        auth: this.auth
                    });
                } catch (error) {
                    proof = { ok: false, error: error.message || String(error) };
                }
                if (this.closed) return;
                if (!proof || proof.ok !== true || typeof proof.client_proof !== "string" || typeof proof.session_key !== "string") {
                    return this.fail((proof && proof.error) || "serveur non authentifié");
                }
                this.key = await crypto.subtle.importKey("raw", fromB64url(proof.session_key), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
                this._setState("proven");
                this.ws.send(JSON.stringify({ type: "auth_proof", client_proof: proof.client_proof }));
                return;
            }

            if (this.state !== "proven" && this.state !== "ready") return this.fail("message hors poignée de main");
            const keys = Object.keys(message).sort().join(",");
            if (keys !== "body,mac,seq" || !Number.isInteger(message.seq) || typeof message.body !== "string" || typeof message.mac !== "string") {
                return this.fail("message non signé du serveur : refusé");
            }
            if (message.seq !== this.received + 1) {
                return this.fail(`numéro d'ordre ${message.seq} inattendu (attendu ${this.received + 1}) : rejeu ou perte`);
            }
            const ok = await crypto.subtle.verify("HMAC", this.key, fromB64url(message.mac), encoder.encode([PROTOCOL, "s2c", String(message.seq), message.body].join("\n")));
            if (!ok) return this.fail("signature fausse : message refusé");
            this.received = message.seq;
            let body;
            try { body = JSON.parse(message.body); } catch (_) { return this.fail("message signé illisible"); }

            if (this.state === "proven") {
                if (!body || body.type !== "auth_ok") return this.fail("auth_ok attendu");
                clearTimeout(this.handshakeTimer);
                this.handshakeTimer = null;
                this.error = null;
                this._setState("ready");
                return;
            }
            if (!body || typeof body !== "object" || typeof body.action !== "string") return;
            const requestId = body.requestId || body.id;
            Promise.resolve()
                .then(() => this.onRequest(body))
                .catch((error) => ({ error: error.message || String(error) }))
                .then((response) => this.send({
                    requestId,
                    success: response ? !response.error : false,
                    data: response ? response.data : null,
                    error: response ? response.error : "Unknown error in background handler"
                }));
        }

        /** Message signé vers le serveur ; faux si la liaison n'est pas authentifiée (rien n'est envoyé). */
        send(payload) {
            if (!this.ready) return false;
            const seq = ++this.sent;
            const body = JSON.stringify(payload);
            this.sending = this.sending
                .then(async () => {
                    const mac = await this._mac("c2s", seq, body);
                    if (this.ws.readyState === 1) this.ws.send(JSON.stringify({ seq, body, mac }));
                })
                .catch(() => {});
            return true;
        }

        fail(reason) {
            if (this.closed) return;
            this.error = reason;
            console.warn(`[NexusBrowser] Pont local refusé (${this.role}) : ${reason}`);
            // Code 4008 : un navigateur refuse 1008 à un client (seuls 1000 et 3000-4999), la socket restait ouverte.
            try { this.ws.close(4008, "NexusBrowser authentication failed"); } catch (_) {}
            this._closed();
        }

        close() {
            try { this.ws.close(); } catch (_) {}
            this._closed();
        }

        _closed() {
            if (this.closed) return;
            this.closed = true;
            if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
            this.handshakeTimer = null;
            this.key = null;
            this._setState("closed");
            try { this.onClose(this); } catch (_) {}
        }

        describe() {
            return { role: this.role, state: this.state, ready: this.ready, error: this.error };
        }
    }

    // Appairage sans hôte natif (native-host/bridge_pairing.py) ---------------------------------------------------
    // La clé d'appairage est une clé WebCrypto NON extractible, gardée dans l'IndexedDB de l'origine de l'extension
    // (jamais dans chrome.storage, lisible par les content scripts) : aucun script, pas même celui de l'extension, ne
    // peut en relire les octets ; elle sert seulement à signer.
    const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
    const DB_NAME = "nexus-browser";
    const DB_STORE = "keys";
    const PAIRED_KEY = "paired";

    function hmacKey(text) {
        return crypto.subtle.importKey("raw", encoder.encode(text), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
    }

    async function digest(key, ...parts) {
        return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode([PROTOCOL, ...parts].join("\n"))));
    }

    function withStore(mode, action) {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                const db = request.result;
                const transaction = db.transaction(DB_STORE, mode);
                const result = action(transaction.objectStore(DB_STORE));
                transaction.oncomplete = () => { db.close(); resolve(result.result); };
                transaction.onerror = () => { db.close(); reject(transaction.error); };
            };
        });
    }

    const Pairing = {
        isSecret: (text) => SECRET_RE.test(String(text || "")),
        secretKey: (secret) => hmacKey(secret),
        load: () => withStore("readonly", (store) => store.get(PAIRED_KEY)).then((key) => key || null),
        save: (key) => withStore("readwrite", (store) => store.put(key, PAIRED_KEY)),
        clear: () => withStore("readwrite", (store) => store.delete(PAIRED_KEY)),

        /** Preuves de la poignée de main avec une clé (même forme que la réponse de l'hôte natif). */
        async prove(key, args) {
            const parts = [args.client_nonce, args.server_nonce, args.role, args.extension_id];
            const expected = await crypto.subtle.verify("HMAC", key, fromB64url(String(args.server_proof || "")),
                encoder.encode([PROTOCOL, "server", ...parts].join("\n")));
            if (!expected) {
                return { ok: false, error: "le serveur du port 9224 ne prouve pas qu'il connaît la clé d'appairage : connexion refusée" };
            }
            return {
                ok: true,
                client_proof: b64url(await digest(key, "client", ...parts)),
                session_key: b64url(await digest(key, "session", ...parts))
            };
        },

        /** Clé durable dérivée du secret consommé et de sa poignée de main (comme bridge_pairing.paired_key). */
        async derive(secretKey, clientNonce, serverNonce, extensionId) {
            return hmacKey(b64url(await digest(secretKey, "paired", clientNonce, serverNonce, extensionId)));
        }
    };

    scope.AgyBridgeLink = BridgeLink;
    scope.AgyPairing = Pairing;
})(typeof globalThis !== "undefined" ? globalThis : self);
