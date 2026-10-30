/**
 * Nexus Browser Bridge - Background Service Worker (Manifest V3)
 * Full automation engine with Chrome DevTools Protocol, AXTree, DOM, PDF Export & visual feedback.
 */

// Moteur de localisation par rôle et libellé (agyLocatorKit), partagé avec les scripts de page.
if (typeof importScripts === "function") importScripts("locator_kit.js");
// Exports de contenu (agyExportKit) : Markdown de la page, Google Docs/Sheets/Slides, transcriptions YouTube.
if (typeof importScripts === "function") importScripts("export_kit.js");

// Fonctions du code RÉELLEMENT chargé, annoncées par ping : la validation réelle les compare à cette même liste lue
// dans le fichier du dépôt (mesuré le 15/10 : un rechargement peut garder l'ancien service worker avec le nouveau
// numéro de version). Ajouter ici chaque nouvelle capacité visible.
const AGY_FEATURES = [
    "cdp-mouse", "focus-emulation", "focus-emulation-child-settle", "locator", "trusted-typing", "oopif",
    "network-log", "wait-download", "dialogs", "bridge-auth",
    "content-export", "gsuite-export", "youtube-transcript", "explicit-tab-id", "url-masking",
    "tab-ownership", "cdp-allowlist", "isolated-world", "body-masking", "cookie-names-only", "stop-cancel",
    "network-record", "page-coordinates-capture", "busy-indicator",
    "orphan-tabs", "cdp-page-world", "local-cookie-values", "body-masking-allowlist",
    "sensitive-field-masking", "cdp-reload-no-script", "ax-value-masking", "capture-screencast",
    "capture-field-masking", "console-masking", "capture-screencast-ack", "cdp-mark-world", "ax-full-tree",
    "history-navigation-cdp", "full-page-capture", "opener-tabs-webnav",
    "installer-reload", "tab-list-redaction", "download-ownership", "gmail-counter", "wait-load-navigation",
    "map-field-labels", "bridge-pairing"
];

let attachedDebuggers = new Set();
let tabConsoleLogs = new Map();
// tabId -> Set(requestId) : requêtes réseau en cours depuis l'attachement CDP (remis à zéro à chaque navigation).
let tabInFlightRequests = new Map();
// Aucun « onglet courant » ici : trois agents (Antigravity, Claude, Codex) partagent ce Chrome. Chaque commande de page
// porte son tab_id, et l'extension vérifie que cet onglet appartient au client qui la demande (voir « Propriété »).
// Débogueur détaché après cette inactivité (bandeau « en cours de débogage » retiré, onglet rendu à Julien).
const DEBUGGER_IDLE_MS = 30000;
const debuggerIdleTimers = new Map();
// tabId -> boîte de dialogue JavaScript ouverte ({type, message, ...}) : jamais acceptée d'office.
const pendingDialogs = new Map();
const dialogWaiters = new Map();
// windowId -> {current, previous, at} : onglet actif de chaque fenêtre et celui d'avant. Chrome active l'onglet d'une
// boîte beforeunload (mesuré le 26/10) : l'onglet de l'utilisateur d'avant lui est rendu, la boîte reste ouverte.
const activeTabs = new Map();
const DIALOG_ACTIVATION_MS = 3000;
// tabId -> commandes en cours sur CET onglet : seul ce compteur retient le détachement de son débogueur.
const tabCommandsInFlight = new Map();
// tabId -> échéance (ms) de l'enregistrement réseau demandé (browser_network_record) : débogueur gardé jusque-là.
const networkRecording = new Map();
const NETWORK_RECORD_MAX_S = 600;

// -----------------------------------------------------------------------------
// Propriété des onglets : chaque client du pont (agent + identifiant de session, posés par le pont dans le canal
// signé) possède les onglets qu'il a ouverts. Toute commande de page sur un autre onglet (Julien, autre agent, autre
// session du même agent) est refusée. Gardée dans chrome.storage.session : elle survit au redémarrage du service
// worker, et disparaît avec la fermeture de Chrome (comme les onglets).
//
// Sessions vivantes : chaque commande (et le battement « heartbeat » des serveurs MCP) date le dernier signe de vie
// de son client. Une session MORTE (silence de plus de SESSION_DEAD_MS, ou processus disparu, signalé par le pont dans
// « gone ») laisse des onglets ORPHELINS : un client du MÊME agent peut les reprendre (adopt_tab sans userAsked),
// les fermer ou les rendre. Une session vivante reste protégée, même contre une autre session de son agent.
// -----------------------------------------------------------------------------
const OWNERS_KEY = "nexusBrowserTabOwners";
const STOP_KEY = "nexusBrowserStopUntil";
const SEEN_KEY = "nexusBrowserClientSeen";
const DOWNLOADS_KEY = "nexusBrowserDownloadOwners";
// Seul client admis à recharger l'extension : l'installeur (NexusBrowser.exe --refresh-extension, lancé par install.ps1).
const INSTALLER_AGENT = "Installer";
const DOWNLOAD_OWNERS_MAX = 200;  // téléchargements attribués gardés en mémoire (les plus anciens oubliés)
// Silence au-delà duquel une session est morte : 1,618 x 60 s (battement des serveurs MCP : 60 / 1,618 s).
const SESSION_DEAD_MS = Math.round(1.618 * 60000);
const SEEN_SAVE_MS = 15000;  // date de vie écrite au plus toutes les 15 s par session (pas une écriture par commande)
const tabOwners = new Map();  // tabId -> { agent, client, adopted, since }
const clientSeen = new Map();  // clientKey -> dernier signe de vie (ms) ; 0 : session morte (processus disparu)
const seenSaved = new Map();  // clientKey -> date de vie déjà écrite dans chrome.storage.session
// downloadId -> { agent, client } : téléchargement attribué par wait_download à un onglet de ce client. Seul ce client
// peut en retirer l'entrée (download_erase) ; jamais un téléchargement de Julien ni d'un autre agent.
const downloadOwners = new Map();
let stoppedUntil = 0;  // échéance (ms) de l'arrêt d'urgence vu par l'extension
let stateChain = Promise.resolve();

function validClient(client) {
    return !!(client && typeof client === "object"
        && typeof client.agent === "string" && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,31}$/.test(client.agent)
        && typeof client.id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{3,63}$/.test(client.id));
}

function clientKey(client) {
    return `${client.agent}\u0000${client.id}`;
}

function ownedBy(owner, client) {
    return !!(owner && validClient(client) && owner.client === client.id && owner.agent === client.agent);
}

/** Vrai tant que la session qui possède l'onglet donne signe de vie (commande ou battement récent). */
function sessionAlive(owner, now = Date.now()) {
    if (!owner) return false;
    const key = clientKey({ agent: owner.agent, id: owner.client });
    const seen = clientSeen.has(key) ? clientSeen.get(key) : (Number(owner.since) || 0);
    return now - seen <= SESSION_DEAD_MS;
}

/** Onglet orphelin repris par ce client : même agent, autre session, et cette session-là est morte. */
function orphanFor(owner, client) {
    return !!(owner && validClient(client) && owner.agent === client.agent && owner.client !== client.id && !sessionAlive(owner));
}

/** Signe de vie du client qui commande, et sessions de son agent que le pont a vues mourir (processus disparu). */
async function noteClientAlive(client, gone) {
    const now = Date.now();
    const key = clientKey(client);
    // A command or heartbeat already in flight when the daemon closed this session cannot bring it back to life.
    // Session identities are never reused; only a new session can reclaim the orphaned tabs.
    if (clientSeen.get(key) !== 0) clientSeen.set(key, now);
    let save = now - (seenSaved.get(key) || 0) >= SEEN_SAVE_MS;
    for (const id of Array.isArray(gone) ? gone : []) {
        const dead = { agent: client.agent, id };
        if (!validClient(dead) || id === client.id) continue;
        const deadKey = clientKey(dead);
        if (clientSeen.get(deadKey) !== 0) { clientSeen.set(deadKey, 0); save = true; }
    }
    if (save) await saveExtensionState();
}

async function loadExtensionState() {
    try {
        const stored = await chrome.storage.session.get([OWNERS_KEY, STOP_KEY, SEEN_KEY, DOWNLOADS_KEY]);
        const owners = stored?.[OWNERS_KEY];
        if (owners && typeof owners === "object") {
            for (const [id, owner] of Object.entries(owners)) {
                const tabId = Number(id);
                if (Number.isInteger(tabId) && owner && typeof owner.agent === "string" && typeof owner.client === "string") {
                    tabOwners.set(tabId, owner);
                }
            }
        }
        if (Number.isFinite(stored?.[STOP_KEY])) stoppedUntil = Math.max(stoppedUntil, stored[STOP_KEY]);
        const seen = stored?.[SEEN_KEY];
        if (seen && typeof seen === "object") {
            for (const [key, at] of Object.entries(seen)) {
                if (Number.isFinite(at) && !clientSeen.has(key)) { clientSeen.set(key, at); seenSaved.set(key, at); }
            }
        }
        const downloads = stored?.[DOWNLOADS_KEY];
        if (downloads && typeof downloads === "object") {
            for (const [id, owner] of Object.entries(downloads)) {
                const downloadId = Number(id);
                if (Number.isInteger(downloadId) && owner && typeof owner.agent === "string" && typeof owner.client === "string"
                    && !downloadOwners.has(downloadId)) {
                    downloadOwners.set(downloadId, { agent: owner.agent, client: owner.client });
                }
            }
        }
        // Onglets fermés pendant que le service worker dormait : propriété oubliée.
        if (tabOwners.size && chrome.tabs?.query) {
            const alive = new Set((await chrome.tabs.query({})).map(t => t.id));
            let changed = false;
            for (const tabId of [...tabOwners.keys()]) {
                if (!alive.has(tabId)) { tabOwners.delete(tabId); changed = true; }
            }
            if (changed) await saveExtensionState();
        }
    } catch (error) {
        console.log("[NexusBrowser] État de session illisible :", error?.message || error);
    }
}

function saveExtensionState() {
    // Dates de vie gardées pour les sessions qui possèdent un onglet, ou vues dans l'heure.
    const now = Date.now();
    const owning = new Set([...tabOwners.values()].map(owner => clientKey({ agent: owner.agent, id: owner.client })));
    for (const [key, at] of [...clientSeen.entries()]) {
        if (!owning.has(key) && now - at > 3600000) { clientSeen.delete(key); seenSaved.delete(key); }
    }
    for (const [key, at] of clientSeen.entries()) seenSaved.set(key, at);
    const run = stateChain.then(() => chrome.storage.session.set({
        [OWNERS_KEY]: Object.fromEntries([...tabOwners.entries()].map(([id, owner]) => [String(id), owner])),
        [STOP_KEY]: stoppedUntil,
        [SEEN_KEY]: Object.fromEntries(clientSeen.entries()),
        [DOWNLOADS_KEY]: Object.fromEntries([...downloadOwners.entries()].map(([id, owner]) => [String(id), owner]))
    }));
    stateChain = run.catch(() => {});
    return run;
}

// Propriété relue avant la toute première commande (redémarrage du service worker compris).
const extensionStateReady = (typeof chrome !== "undefined" && chrome.storage?.session) ? loadExtensionState() : Promise.resolve();

async function rememberTabOwner(tabId, client, how = "created") {
    if (!Number.isInteger(tabId) || !validClient(client)) return;
    const owner = { agent: client.agent, client: client.id, adopted: how === "adopted", since: Date.now() };
    tabOwners.set(tabId, owner);
    await saveExtensionState();
    return owner;  // l'objet écrit par CET appel, même si la Map a changé pendant la sauvegarde
}

async function forgetTabOwner(tabId) {
    if (!tabOwners.delete(tabId)) return false;
    await saveExtensionState();
    return true;
}

/** Téléchargement attribué au client (wait_download sur un de ses onglets) : lui seul pourra en retirer l'entrée. */
async function rememberDownloadOwner(downloadId, client) {
    // Déjà attribué (à ce client ou à un autre) : jamais réattribué.
    if (!Number.isInteger(downloadId) || !validClient(client) || downloadOwners.has(downloadId)) return;
    downloadOwners.set(downloadId, { agent: client.agent, client: client.id });
    while (downloadOwners.size > DOWNLOAD_OWNERS_MAX) downloadOwners.delete(downloadOwners.keys().next().value);
    await saveExtensionState();
}

function ownerLabel(owner) {
    return owner ? `${owner.agent}${owner.adopted ? " (adopted)" : ""}` : "User";
}

// -----------------------------------------------------------------------------
// Arrêt d'urgence vu par l'extension (posé par le pont : Ctrl+Alt+Maj+Échap ou fichier ~/.nexus/stop) : toute action est
// refusée jusqu'à l'échéance, et les boucles en cours (frappe touche par touche, glisser, attentes) s'interrompent au
// prochain pas. Les lectures restent permises, comme au pont.
// -----------------------------------------------------------------------------
const STOP_HOLD_MS = 120000;
const stopWaiters = new Set();
// Lectures permises pendant l'arrêt : miroir de ReadOnlyActions (native/BridgeSecurity.cs), aux noms d'action
// reçus par l'extension (vérifié par tests/NexusBrowser.Tests). Un seul nom par action : celui du client, tirets
// remplacés par des soulignés (pont), sans alias à recopier dans chaque liste de garde-fous.
const STOP_ALLOWED_ACTIONS = new Set([
    "ping", "list_tabs", "active_tab", "content", "axtree", "logs", "screenshot", "pdf", "check_handoff",
    "download_status", "wait_load", "wait_network_idle", "interactive_map", "field_state", "vision_inspect", "find",
    "network_requests", "network_response", "wait_download", "export_content", "export_gsuite", "release_tab",
    "network_stop", "emergency_stop", "heartbeat"
]);

function stopActive() {
    return Date.now() < stoppedUntil;
}

function stopMessage() {
    const left = Math.max(0, Math.round((stoppedUntil - Date.now()) / 1000));
    return `Emergency stop requested by the user: no more actions for another ${left} s (running command interrupted). Wait for the user's instructions; do not work around it.`;
}

/** Point de contrôle des boucles et des envois d'entrées : lève une erreur pendant l'arrêt d'urgence. */
function assertNotStopped() {
    if (stopActive()) {
        const error = new Error(stopMessage());
        error.emergencyStop = true;
        throw error;
    }
}

async function emergencyStop({ holdMs = STOP_HOLD_MS, source = "pont" } = {}) {
    stoppedUntil = Math.max(stoppedUntil, Date.now() + Math.max(0, Math.min(Number(holdMs) || STOP_HOLD_MS, STOP_HOLD_MS)));
    for (const wake of [...stopWaiters]) wake();
    // Débogueurs détachés : plus aucune entrée possible, bandeau retiré. Aussi ceux attachés avant un redémarrage du
    // service worker (onglets pilotés que Chrome dit débogués).
    const toDetach = new Set(attachedDebuggers);
    try {
        if (chrome.debugger?.getTargets) {
            for (const target of await chrome.debugger.getTargets()) {
                if (target.attached && Number.isInteger(target.tabId) && tabOwners.has(target.tabId)) toDetach.add(target.tabId);
            }
        }
    } catch (_) {}
    for (const tabId of toDetach) await detachDebugger(tabId);
    for (const [tabId, pending] of [...pendingFileChoosers]) {
        pendingFileChoosers.delete(tabId);
        pending.reject(new Error(stopMessage()));
    }
    networkRecording.clear();
    await saveExtensionState();
    console.log(`[NexusBrowser] Arrêt d'urgence (${source}) jusqu'à ${new Date(stoppedUntil).toISOString()}`);
    return { stoppedUntil, source };
}

// Version lue d'une seule source : le manifeste chargé par Chrome.
function extensionVersion() {
    try {
        return chrome.runtime?.getManifest?.()?.version || null;
    } catch (_) {
        return null;
    }
}

console.log(`[NexusBrowser] Background Service Worker (v${extensionVersion() || "inconnue"}) active.`);

// -----------------------------------------------------------------------------
// Pont local authentifié (bridge_link.js) & keepalive Chrome 116+
// Deux liaisons : celle du service worker (ici, elle exécute les commandes elle-même) et celle du document
// offscreen (relais, garde une connexion quand le service worker est suspendu). Les deux prouvent le jeton par
// l'hôte natif com.nexus.browser_auth ; le pont choisit le service worker en priorité.
// -----------------------------------------------------------------------------
if (typeof importScripts === "function") importScripts("bridge_link.js");

const BRIDGE_WS_URL = "ws://127.0.0.1:9224";
const NATIVE_AUTH_HOST = "com.nexus.browser_auth";
let bridgeLink = null;
let offscreenLinkState = null;
let lastBridgeAuthError = null;
let reconnectTimer = null;
let keepaliveInterval = null;
let reconnectAttempts = 0;

// Méthode d'authentification : l'hôte natif d'abord (installé par install.ps1) ; s'il manque à Chrome (application
// du Microsoft Store, qui ne peut pas le déclarer) et que l'extension a été appairée (pair.html), la clé d'appairage.
let nativeHostMissing = !chrome.runtime?.sendNativeMessage;

async function bridgeAuthMethod() {
    if (!nativeHostMissing) return "native";
    try {
        return (await globalThis.AgyPairing.load()) ? "paired" : "native";
    } catch (_) {
        return "native";
    }
}

/** Preuves de la poignée de main : par l'hôte natif (« native ») ou par la clé d'appairage non extractible. */
async function proveBridge(args) {
    if (args.auth !== "paired") return proveWithNativeHost(args);
    const key = await globalThis.AgyPairing.load().catch(() => null);
    if (!key) return { ok: false, error: "extension non appairée : ouvrir l'appairage depuis l'application NexusBrowser" };
    return globalThis.AgyPairing.prove(key, args);
}

/** Preuves de la poignée de main calculées par l'hôte natif (il lit le jeton ; l'extension ne le voit jamais). */
function proveWithNativeHost(args) {
    return new Promise((resolve) => {
        if (!chrome.runtime?.sendNativeMessage) {
            resolve({ ok: false, error: "messagerie native indisponible (permission nativeMessaging)" });
            return;
        }
        try {
            chrome.runtime.sendNativeMessage(NATIVE_AUTH_HOST, args, (reply) => {
                const error = chrome.runtime.lastError;
                if (error || !reply) {
                    // Hôte absent de Chrome : la prochaine connexion passe par la clé d'appairage, si elle existe.
                    if (/not found|introuvable/i.test(error?.message || "")) nativeHostMissing = true;
                    resolve({ ok: false, error: `hôte natif ${NATIVE_AUTH_HOST} injoignable (${error?.message || "aucune réponse"}) : lancer install.ps1 de NexusBrowser` });
                } else {
                    resolve(reply);
                }
            });
        } catch (error) {
            resolve({ ok: false, error: `hôte natif ${NATIVE_AUTH_HOST} injoignable (${error.message || error})` });
        }
    });
}

// État de la liaison offscreen, rapporté par elle à chaque changement et toutes les 10 s : au-delà, inconnu.
const OFFSCREEN_STATE_TTL_MS = 25000;

function offscreenReady() {
    return !!(offscreenLinkState && offscreenLinkState.ready && Date.now() - offscreenLinkState.at < OFFSCREEN_STATE_TTL_MS);
}

function bridgeReady() {
    return !!(bridgeLink && bridgeLink.ready) || offscreenReady();
}

// Compteur pour le pad MX Keypad AI Agents (facultatif, coché dans la fenêtre de l'icône) : le nombre de mails non lus
// de Gmail, lu une fois par minute dans le flux officiel de Gmail avec la session de ce Chrome, comme une extension
// « Gmail Checker ». Seul ce nombre part au pont, en local : ni expéditeur, ni objet, ni contenu. Session fermée (Google
// redirige vers sa connexion, page sans <fullcount>) : nombre inconnu (null). Décoché : le pont efface le fichier du compteur.
// Chaque profil Chrome a sa propre source (identifiant aléatoire, sans rien de personnel) : le pont garde une entrée par
// profil et le pad en fait la somme. Une lecture lancée avant une décoche ne réécrit pas le nombre après elle : chaque
// envoi porte un numéro, et la case est relue après la lecture du flux.
const COMPTEUR_GMAIL = "compteurGmail";
// Faux dans la variante du Chrome Web Store sans compteur (scripts/store-package.ps1 -WithoutGmailCounter) : ni case,
// ni lecture de Gmail, ni mail.google.com dans la CSP.
const COMPTEUR_GMAIL_DISPONIBLE = true;
const SOURCE_COMPTEURS = "sourceCompteurs";
const FLUX_GMAIL = "https://mail.google.com/mail/feed/atom";
let generationCompteurs = 0;

async function sourceCompteurs() {
    const lu = (await chrome.storage.local.get(SOURCE_COMPTEURS))[SOURCE_COMPTEURS];
    if (typeof lu === "string" && /^[0-9a-f-]{36}$/.test(lu)) return lu;
    const source = crypto.randomUUID();
    await chrome.storage.local.set({ [SOURCE_COMPTEURS]: source });
    return source;
}

async function caseCompteur() {
    if (!COMPTEUR_GMAIL_DISPONIBLE) return false;
    try {
        return !!(await chrome.storage.local.get(COMPTEUR_GMAIL))[COMPTEUR_GMAIL];
    } catch (_) {
        return false;
    }
}

async function envoyerCompteurs() {
    if (!bridgeLink || !bridgeLink.ready) return;
    const generation = ++generationCompteurs;
    let source;
    try {
        source = await sourceCompteurs();
    } catch (_) {
        return;
    }
    let actif = await caseCompteur();
    let gmail = null;
    let raison = null; // nombre inconnu : pourquoi, en un mot d'une liste fixe (jamais de contenu)
    if (actif) {
        try {
            const reponse = await fetch(FLUX_GMAIL, { credentials: "include", cache: "no-store" });
            const nombre = reponse.ok ? (await reponse.text()).match(/<fullcount>(\d+)<\/fullcount>/i) : null;
            if (nombre) gmail = Number(nombre[1]);
            else raison = reponse.ok ? "deconnecte" : `http-${reponse.status}`;
        } catch (_) {
            raison = "reseau";
        }
    }
    if (generation !== generationCompteurs) return; // un envoi plus récent (case décochée entre-temps) fait foi
    if (actif && !(await caseCompteur())) {
        actif = false; // décochée pendant la lecture du flux : rien n'est écrit
        gmail = null;
        raison = null;
    }
    if (generation !== generationCompteurs) return;
    if (bridgeLink && bridgeLink.ready) bridgeLink.send({ event: "compteurs", source, actif, gmail, raison, timestamp: Date.now() });
}


let connectingBridge = false;

function connectBridgeWS() {
    if (typeof WebSocket === "undefined" || typeof globalThis.AgyBridgeLink !== "function") return;
    if ((bridgeLink && bridgeLink.alive) || connectingBridge) return;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (!nativeHostMissing) {
        openBridgeLink("native");
        return;
    }
    // Hôte natif absent : la clé d'appairage, si elle existe, est lue d'abord (IndexedDB, asynchrone).
    connectingBridge = true;
    bridgeAuthMethod().then((auth) => {
        connectingBridge = false;
        if (!(bridgeLink && bridgeLink.alive)) openBridgeLink(auth);
    });
}

function openBridgeLink(auth) {
    try {
        bridgeLink = new globalThis.AgyBridgeLink({
            url: BRIDGE_WS_URL,
            role: "service_worker",
            extensionId: chrome.runtime?.id,
            auth,
            prove: proveBridge,
            onRequest: (request) => handleCommand(request),
            onStateChange: (link) => {
                if (link.error) lastBridgeAuthError = link.error;
                if (link.state !== "ready") return;
                lastBridgeAuthError = null;
                reconnectAttempts = 0;
                console.log("[NexusBrowser] Service worker authentifié auprès du pont " + BRIDGE_WS_URL);
                link.send({ event: "bridge_connected", timestamp: Date.now() });
                envoyerCompteurs();
                if (keepaliveInterval) clearInterval(keepaliveInterval);
                let tours = 0;
                keepaliveInterval = setInterval(() => {
                    if (bridgeLink && bridgeLink.ready) bridgeLink.send({ event: "keepalive", timestamp: Date.now() });
                    if (++tours % 3 === 0) envoyerCompteurs(); // une fois par minute
                }, 20000);
            },
            onClose: (link) => {
                if (link !== bridgeLink) return;
                if (link.error) lastBridgeAuthError = link.error;
                bridgeLink = null;
                if (keepaliveInterval) {
                    clearInterval(keepaliveInterval);
                    keepaliveInterval = null;
                }
                scheduleBridgeReconnect();
            }
        });
    } catch (e) {
        bridgeLink = null;
        scheduleBridgeReconnect();
    }
}

function scheduleBridgeReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delayMs = Math.min(30000, Math.round(1500 * Math.pow(1.618, Math.min(reconnectAttempts, 6))));
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectBridgeWS, delayMs);
}

function bridgeStatus() {
    return {
        connected: bridgeReady(),
        wsUrl: BRIDGE_WS_URL,
        links: {
            service_worker: bridgeLink ? bridgeLink.describe() : { role: "service_worker", state: "closed", ready: false, error: lastBridgeAuthError },
            offscreen: offscreenLinkState
                ? { ...offscreenLinkState, ready: offscreenReady() }
                : { role: "offscreen", state: "unknown", ready: false, error: null }
        },
        authError: (bridgeReady() ? null : (lastBridgeAuthError || offscreenLinkState?.error || null)),
        activeDebuggers: attachedDebuggers.size
    };
}

async function ensureOffscreenDocument() {
    if (!chrome.offscreen?.createDocument) return;
    try {
        if (chrome.runtime?.getContexts) {
            const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
            if (contexts && contexts.length > 0) return;
        }
    } catch (_) {}
    try {
        await chrome.offscreen.createDocument({
            url: "offscreen.html",
            reasons: ["BLOBS"],
            justification: "NexusBrowser persistent local WebSocket bridge connection"
        });
        console.log("[NexusBrowser] Offscreen keepalive document created.");
    } catch (_) {}
}

/** Message venu d'une page de l'extension (fenêtre de la barre d'outils, offscreen), jamais d'un script de contenu ni d'une page web. */
function fromExtensionPage(sender) {
    if (!sender || sender.id !== chrome.runtime?.id || sender.tab) return false;
    return !sender.url || String(sender.url).startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

if (typeof chrome !== "undefined") {
    ensureOffscreenDocument();
    // Fil de l'ancienne discussion du panneau (retirée le 20/10/2026) : effacé des installations existantes.
    chrome.storage?.local?.remove?.(["agyChat", "agyInstance"])?.catch?.(() => {});
    if (chrome.runtime?.onStartup) chrome.runtime.onStartup.addListener(() => {
        ensureOffscreenDocument();
        setTimeout(connectBridgeWS, 300);
    });
    if (chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(() => {
        ensureOffscreenDocument();
        setTimeout(connectBridgeWS, 300);
    });
    // Coché ou décoché dans la fenêtre de l'icône : le pont l'apprend tout de suite.
    chrome.storage?.onChanged?.addListener?.((changes, zone) => {
        if (zone === "local" && changes[COMPTEUR_GMAIL]) envoyerCompteurs();
    });
    if (chrome.alarms?.create) {
        chrome.alarms.create("bridge_keepalive_alarm", { periodInMinutes: 1 });
        chrome.alarms.onAlarm.addListener(() => {
            ensureOffscreenDocument();
            if (!bridgeLink || !bridgeLink.alive) {
                connectBridgeWS();
            }
        });
    }
    if (chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (!message || message.target !== "background") return;
            if (message.ping) {
                // Seul message permis aux scripts de contenu : réveille le service worker et sa liaison.
                connectBridgeWS();
                sendResponse({ pong: true, connected: bridgeReady() });
                return true;
            }
            if (message.bridgePaired && sender?.id === chrome.runtime?.id
                && String(sender.url || "").startsWith(`chrome-extension://${chrome.runtime.id}/pair.html`)) {
                // pair.html (onglet de l'extension) vient d'enregistrer la clé : reconnexion immédiate, par elle si
                // l'hôte natif manque. Rien d'autre n'est accepté de cette page.
                reconnectAttempts = 0;
                if (bridgeLink && !bridgeLink.ready) bridgeLink.close();
                connectBridgeWS();
                sendResponse({ ok: true });
                return true;
            }
            if (!fromExtensionPage(sender)) return;
            if (message.getStatus) {
                sendResponse(bridgeStatus());
                return true;
            }
            if (message.bridgeProve) {
                // Poignée de main de la liaison offscreen (qui n'a pas accès à la messagerie native).
                proveBridge(message.bridgeProve).then(sendResponse);
                return true;
            }
            if (message.bridgeAuth) {
                bridgeAuthMethod().then(sendResponse);
                return true;
            }
            if (message.bridgeState) {
                offscreenLinkState = { ...message.bridgeState, at: Date.now() };
                if (offscreenLinkState.error) lastBridgeAuthError = offscreenLinkState.error;
                sendResponse({ ok: true });
                return true;
            }
            if (message.request) {
                // Commande reçue par la liaison offscreen, déjà authentifiée et vérifiée par elle.
                handleCommand(message.request).then(sendResponse);
                return true;
            }
        });
    }
}

setTimeout(connectBridgeWS, 300);

// -----------------------------------------------------------------------------
// CDP Event Monitor (Console logs, Dialogs, FileChooser & Network In-flight)
// -----------------------------------------------------------------------------
const pendingFileChoosers = new Map();
const activeUploads = new Set();
// Un flux CDP suspend sa production si ses images ne sont pas acquittées.
// Ne garder ni l'image ni ses métadonnées : seul l'identifiant sert à l'ACK.
const captureScreencasts = new Set();
const captureTargetKey = (target) => `${target.tabId}|${target.sessionId || ""}`;

chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (!source.tabId) return;
    if (method === "Page.screencastFrame") {
        if (captureScreencasts.has(captureTargetKey(source)) && Number.isInteger(params?.sessionId)) {
            await chrome.debugger.sendCommand(source, "Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        }
        return;
    }
    if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
        if (!tabConsoleLogs.has(source.tabId)) tabConsoleLogs.set(source.tabId, []);
        const logs = tabConsoleLogs.get(source.tabId);
        logs.push({ timestamp: Date.now(), method, params });
        if (logs.length > 100) logs.shift();
    } else if (method === "Network.requestWillBeSent") {
        // Un même requestId revient à chaque redirection : un ensemble ne le compte qu'une fois.
        inFlightSet(source.tabId).add(networkKey(source, params?.requestId ?? `anon-${Date.now()}-${Math.random()}`));
        recordNetworkRequest(source, params);
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        inFlightSet(source.tabId).delete(networkKey(source, params?.requestId));
        recordNetworkEnd(source, method, params);
    } else if (method === "Network.responseReceived") {
        recordNetworkResponse(source, params);
    } else if (method === "Network.requestServedFromCache") {
        const rec = networkLog(source.tabId).byKey.get(networkKey(source, params?.requestId));
        if (rec) rec.fromCache = true;
    } else if (method === "Target.attachedToTarget") {
        trackChildSession(source, params);
    } else if (method === "Target.detachedFromTarget") {
        if (params?.sessionId) forgetChildSession(source.tabId, params.sessionId);
    } else if (method === "Target.targetInfoChanged") {
        for (const info of (childSessions.get(source.tabId) || new Map()).values()) {
            if (info.targetId === params?.targetInfo?.targetId) info.url = params.targetInfo.url;
        }
    } else if (method === "Page.frameNavigated") {
        // Nouveau document principal : les requêtes de l'ancien ne finiront jamais, on repart de zéro.
        if (!params?.frame?.parentId && !source.sessionId) resetNetworkTracking(source.tabId);
    } else if (method === "Runtime.executionContextCreated") {
        // Monde isolé « nexus-browser » d'un cadre, créé avant un rattachement du débogueur : repris tel quel (ses
        // marqueurs de interactive_map restent valables), jamais confondu avec un monde de la page.
        const context = params?.context;
        const frameId = context?.auxData?.frameId;
        if (context?.name === FRAME_WORLD_NAME && frameId && context.auxData?.type === "isolated") {
            isolatedWorlds.set(`${source.tabId}|${source.sessionId || ""}|${frameId}`, context.id);
        }
    } else if (method === "Runtime.executionContextDestroyed") {
        for (const [key, id] of [...isolatedWorlds]) {
            if (id === params?.executionContextId && key.startsWith(`${source.tabId}|${source.sessionId || ""}|`)) isolatedWorlds.delete(key);
        }
    } else if (method === "Runtime.executionContextsCleared") {
        const prefix = `${source.tabId}|${source.sessionId || ""}|`;
        for (const key of [...isolatedWorlds.keys()]) if (key.startsWith(prefix)) isolatedWorlds.delete(key);
    } else if (method === "Page.javascriptDialogOpening") {
        // Jamais d'acceptation automatique : la boîte est mémorisée, signalée dans les réponses, et l'agent
        // répond explicitement avec handle_dialog (browser_handle_dialog).
        const dialog = {
            tabId: source.tabId,
            type: params?.type || "alert",
            message: params?.message || "",
            defaultPrompt: params?.defaultPrompt || "",
            url: params?.url || "",
            sessionId: source.sessionId || null,
            openedAt: Date.now()
        };
        pendingDialogs.set(source.tabId, dialog);
        const waiters = dialogWaiters.get(source.tabId);
        if (waiters) for (const notify of [...waiters]) notify(dialog);
        keepDialogTabBehind(source.tabId).catch(() => {});
    } else if (method === "Page.javascriptDialogClosed") {
        pendingDialogs.delete(source.tabId);
    } else if (method === "Page.fileChooserOpened") {
        console.log("[CDP] File chooser opened event detected:", params);
        const pending = pendingFileChoosers.get(source.tabId);
        if (pending) {
            pendingFileChoosers.delete(source.tabId);
            try {
                await chrome.debugger.sendCommand(source, "DOM.setFileInputFiles", {
                    files: pending.files,
                    backendNodeId: params.backendNodeId
                });
                pending.resolve({ success: true, files: pending.files });
            } catch (err) {
                pending.reject(err);
            }
        }
    }
});

chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
        attachedDebuggers.delete(source.tabId);
        forgetFocusEmulation(source.tabId);
        tabInFlightRequests.delete(source.tabId);
        clearDebuggerIdleTimer(source.tabId);
        pendingDialogs.delete(source.tabId);
        forgetTabFrames(source.tabId);
        const pending = pendingFileChoosers.get(source.tabId);
        if (pending) {
            pendingFileChoosers.delete(source.tabId);
            pending.reject(new Error("Debugger detached during upload"));
        }
        activeUploads.delete(source.tabId);
    }
});

/**
 * Onglet d'agent passé au premier plan par Chrome pour sa boîte de dialogue (beforeunload) : l'onglet que
 * l'utilisateur regardait juste avant redevient actif. La boîte reste ouverte dans l'onglet de fond et se règle par
 * handle_dialog comme les autres (vérifié dans Chrome le 26/10). Rien si l'onglet était déjà au premier plan.
 */
async function keepDialogTabBehind(tabId) {
    const dialog = pendingDialogs.get(tabId);
    if (!dialog || dialog.keptBehind || !tabOwners.has(tabId)) return;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (_) { return; }
    const seen = tab?.active ? activeTabs.get(tab.windowId) : null;
    if (!seen || seen.current !== tabId || !seen.previous || Date.now() - seen.at > DIALOG_ACTIVATION_MS) return;
    if (Math.abs(seen.at - dialog.openedAt) > DIALOG_ACTIVATION_MS) return;
    dialog.keptBehind = true;
    try { await chrome.tabs.update(seen.previous, { active: true }); } catch (_) { dialog.keptBehind = false; }
}

if (chrome.tabs?.onActivated?.addListener) {
    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
        const seen = activeTabs.get(windowId);
        if (seen?.current === tabId) return;
        activeTabs.set(windowId, { current: tabId, previous: seen ? seen.current : null, at: Date.now() });
        // Activation annoncée après la boîte : même règle.
        if (pendingDialogs.has(tabId)) keepDialogTabBehind(tabId).catch(() => {});
    });
    // Service worker (re)lancé : onglets actifs du moment, pour connaître celui d'avant à la prochaine activation.
    Promise.resolve(chrome.tabs.query?.({ active: true })).then((tabs) => {
        for (const t of tabs || []) {
            if (t && t.windowId !== undefined && !activeTabs.has(t.windowId)) activeTabs.set(t.windowId, { current: t.id, previous: null, at: 0 });
        }
    }).catch(() => {});
}

if (chrome.tabs?.onRemoved?.addListener) {
    chrome.tabs.onRemoved.addListener((tabId) => {
        if (attachedDebuggers.has(tabId)) detachDebugger(tabId);
        clearDebuggerIdleTimer(tabId);
        pendingDialogs.delete(tabId);
        attachedDebuggers.delete(tabId);
        tabConsoleLogs.delete(tabId);
        tabInFlightRequests.delete(tabId);
        tabNetwork.delete(tabId);
        lastActionAt.delete(tabId);
        networkRecording.delete(tabId);
        forgetTabFrames(tabId);
        const pending = pendingFileChoosers.get(tabId);
        if (pending) {
            pendingFileChoosers.delete(tabId);
            pending.reject(new Error("Tab closed during file upload"));
        }
        activeUploads.delete(tabId);
        extensionStateReady.then(() => forgetTabOwner(tabId)).catch(() => {});
    });
}
// Onglet ouvert PAR un onglet d'agent (lien target=_blank, window.open, fenêtre de connexion OAuth) : il revient au
// même client, sinon l'agent perdait la main sur la suite de sa tâche. Seulement depuis un onglet qu'il a créé lui-même
// (pas adopté chez l'utilisateur) et jamais un onglet qui a déjà un propriétaire.
// Deux signaux : openerTabId de l'onglet, et webNavigation.onCreatedNavigationTarget, seul présent pour un lien
// target=_blank (noopener implicite) : sans lui, l'onglet ouvert restait à l'utilisateur (mesuré le 20/10).
function inheritOpenerOwner(tabId, openerTabId) {
    extensionStateReady.then(async () => {
        const opener = Number.isInteger(openerTabId) ? tabOwners.get(openerTabId) : null;
        if (!Number.isInteger(tabId) || !opener || opener.adopted || tabOwners.has(tabId)) return;
        tabOwners.set(tabId, {
            agent: opener.agent, client: opener.client, adopted: false, since: Date.now(), openedBy: openerTabId
        });
        await saveExtensionState();
    }).catch(() => {});
}
if (chrome.tabs?.onCreated?.addListener) {
    chrome.tabs.onCreated.addListener((tab) => inheritOpenerOwner(tab?.id, tab?.openerTabId));
}
if (chrome.webNavigation?.onCreatedNavigationTarget?.addListener) {
    chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => inheritOpenerOwner(details?.tabId, details?.sourceTabId));
}
// Onglet remplacé par Chrome (prérendu, navigation instantanée) : la propriété suit le nouvel identifiant.
if (chrome.tabs?.onReplaced?.addListener) {
    chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
        extensionStateReady.then(async () => {
            const owner = tabOwners.get(removedTabId);
            if (!owner) return;
            tabOwners.delete(removedTabId);
            tabOwners.set(addedTabId, owner);
            await saveExtensionState();
        }).catch(() => {});
    });
}

// -----------------------------------------------------------------------------
// Command Router
// -----------------------------------------------------------------------------
// Commandes sans onglet visé (ou qui en créent un). Toutes les autres exigent un onglet du client qui les demande.
const TAB_FREE_ACTIONS = new Set([
    "ping", "list_tabs", "active_tab", "create_tab", "download_status", "download_erase",
    "reload_extension", "adopt_tab", "heartbeat"
]);
// Commandes permises sur un onglet ORPHELIN du même agent (session morte), sans le reprendre d'abord.
const ORPHAN_ACTIONS = new Set(["close_tab", "release_tab"]);
// Commandes du pont lui-même (canal signé), sans client : contrôle de vie et arrêt d'urgence.
const BRIDGE_ACTIONS = new Set(["ping", "emergency_stop"]);

function normalizedAction(req) {
    return String(req.action || req.command || "").toLowerCase().replace(/-/g, "_");
}

function foreignTabMessage(tabId, owner, client) {
    if (orphanFor(owner, client)) {
        return `Tab ${tabId} is orphaned: its ${owner.agent} session has ended (server restarted or stopped). ` +
            "Take it back with browser_adopt_tab(tab_id) (without user_asked), close it (browser_close_tab) or hand it back to the user (browser_release_tab).";
    }
    if (!owner) {
        return `Tab ${tabId} is not driven by any agent (user's tab): refused. Open your own with browser_new_tab; ` +
            "browser_adopt_tab(tab_id, user_asked=True) only if the user explicitly asked for it.";
    }
    const sameAgent = client && owner.agent === client.agent;
    return `Tab ${tabId} is driven by ${owner.agent}${sameAgent ? " in another session" : ""}: refused. ` +
        "Each agent acts only in the tabs it opened (browser_new_tab).";
}

/**
 * Rechargement de l'extension : il coupe les commandes en cours de TOUS les agents et leur fait perdre leurs onglets.
 * Réservé à l'installeur (identité « Installer », NexusBrowser.exe --refresh-extension), et seulement quand aucun agent ne
 * travaille : aucune commande en cours, aucun onglet tenu par une session vivante. Même un client qui prendrait le nom
 * de l'installeur ne peut donc rien interrompre.
 */
function reloadRefusal(client) {
    if (client.agent !== INSTALLER_AGENT) {
        return "reload_extension is reserved to the installer (install.ps1): refused. Reloading the extension would cut " +
            "every agent's running commands and tabs.";
    }
    const working = new Set([...busyAgents.keys()]);
    for (const owner of tabOwners.values()) if (sessionAlive(owner)) working.add(owner.agent);
    if (working.size || tabCommandsInFlight.size) {
        const who = [...working].sort().join(", ") || "an agent";
        return `reload_extension refused: ${who} is still working in Chrome (driven tabs or running commands). ` +
            "Run install.ps1 again once the agents have closed their tabs.";
    }
    return null;
}

/** Refus (message) d'une commande, ou null : identité, arrêt d'urgence, propriété de l'onglet visé. */
function authorizeCommand(action, params, client) {
    if (BRIDGE_ACTIONS.has(action)) return null;
    if (!client) return "Command without client identity (agent and session set by the bridge): refused. Run install.ps1 again (up-to-date bridge).";
    if (stopActive() && !STOP_ALLOWED_ACTIONS.has(action)) return stopMessage();
    if (action === "reload_extension") return reloadRefusal(client);
    if (TAB_FREE_ACTIONS.has(action)) return null;
    // Toute commande qui vise plusieurs onglets (tabIds), quel que soit son nom : chacun doit être au client. Le contrôle
    // ne dépend plus du nom d'action (l'alias tabs_group le contournait, relevé par Codex le 24/10).
    if (Array.isArray(params.tabIds) && params.tabIds.length) {
        for (const raw of params.tabIds) {
            const tabId = Number(raw);
            if (!Number.isInteger(tabId)) return `Invalid tab_id: ${raw}`;
            if (!ownedBy(tabOwners.get(tabId), client)) return foreignTabMessage(tabId, tabOwners.get(tabId), client);
        }
        // Les onglets de tabIds ne dispensent jamais du contrôle de l'onglet visé par tab_id (un tabIds à soi servait
        // de leurre pour agir sur un onglet étranger, relevé par Codex le 24/10).
        if (requestedTabId(params) === null) return null;
    }
    const tabId = requestedTabId(params);
    if (tabId === null) {
        const given = params.tabId ?? params.tab_id;
        if (given !== undefined && given !== null && given !== "") return `Invalid tab_id: ${given}`;
        return MISSING_TAB_MESSAGE;
    }
    const owner = tabOwners.get(tabId);
    if (ownedBy(owner, client)) return null;
    if (ORPHAN_ACTIONS.has(action) && orphanFor(owner, client)) return null;
    return foreignTabMessage(tabId, owner, client);
}

async function handleCommand(req) {
    await extensionStateReady;
    const action = normalizedAction(req);
    const canonical = canonicalTabParams(req.params || req.payload || {});
    if (canonical.error) return { error: canonical.error };
    const params = canonical.params;
    // Identité posée par le pont à côté des paramètres (jamais lue dans les paramètres eux-mêmes).
    const client = validClient(req.client) ? { agent: req.client.agent, id: req.client.id } : null;
    // Signe de vie noté AVANT l'autorisation (une commande refusée prouve aussi que la session vit) ; « gone » : posé
    // par le pont dans le canal signé, jamais lu dans les paramètres.
    if (client) await noteClientAlive(client, req.gone);
    const refusal = authorizeCommand(action, params, client);
    if (refusal) return { error: refusal };
    const tabId = requestedTabId(params);
    if (tabId !== null) tabCommandsInFlight.set(tabId, (tabCommandsInFlight.get(tabId) || 0) + 1);
    // Travail d'agent visible pour l'utilisateur (logo qui tourne) : commandes de page et ouverture d'onglet, jamais
    // les battements ni les listes, qui tournent en continu.
    const busyAgent = client && (tabId !== null || action === "create_tab") ? client.agent : null;
    if (busyAgent) busyStart(busyAgent);
    let result;
    try {
        result = await routeCommand({ action, params }, client);
    } finally {
        if (tabId !== null) {
            const left = (tabCommandsInFlight.get(tabId) || 1) - 1;
            if (left > 0) tabCommandsInFlight.set(tabId, left);
            else tabCommandsInFlight.delete(tabId);
        }
        if (busyAgent) busyEnd(busyAgent);
    }
    const visible = tabId !== null && ownedBy(tabOwners.get(tabId), client) ? tabId : null;
    // Evaluation may legitimately return an object containing an error field.
    if (action !== "eval" && result?.data?.error) result = { error: result.data.error };
    // Erreur brute de Chrome sur une page qu'il protège : message clair, quelle que soit la commande.
    if (typeof result?.error === "string" && CHROME_PROTECTED_RAW.test(result.error)) {
        let url = null;
        if (tabId !== null) try { url = (await chrome.tabs.get(tabId))?.url || null; } catch (_) {}
        result = { error: clearProtectedError(result.error, url) };
    }
    // Onglet ouvert ou mené sur une page protégée : dit dès la réponse, avant toute attente ou lecture vouée à l'échec.
    if ((action === "create_tab" || action === "navigate") && result?.data && isChromeProtectedPage(params.url)) {
        result = { ...result, data: { ...result.data, protected_page: true, warning: chromeProtectedMessage(params.url) } };
    }
    return annotatePendingDialogs(result, visible);
}

/**
 * Numéros d'onglet lus UNE fois, strictement, avant l'autorisation : entier, ou chaîne de chiffres seuls. Le contrôle
 * de propriété et l'exécution voient donc le même onglet (« 1e2 » valait 100 au contrôle et 1 à l'exécution, relevé
 * par Codex le 24/10). tab_id et tabId différents, ou un tabIds mal formé : refusé.
 */
function strictTabId(value) {
    if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
    if (typeof value === "string" && /^\s*\d{1,15}\s*$/.test(value)) return Number(value.trim());
    return null;
}

function canonicalTabParams(raw) {
    const params = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
    const given = ["tabId", "tab_id"].filter(key => params[key] !== undefined && params[key] !== null && params[key] !== "");
    const ids = given.map(key => strictTabId(params[key]));
    if (ids.some(id => id === null)) return { error: `Invalid tab_id: ${params[given[ids.indexOf(null)]]}` };
    if (ids.length === 2 && ids[0] !== ids[1]) return { error: `Conflicting tab_id: ${params.tabId} and ${params.tab_id}` };
    if (ids.length) {
        params.tabId = ids[0];
        delete params.tab_id;
    }
    if (params.tabIds !== undefined) {
        if (!Array.isArray(params.tabIds)) return { error: `Invalid tab_ids: ${params.tabIds}` };
        const list = params.tabIds.map(strictTabId);
        const bad = list.indexOf(null);
        if (bad !== -1) return { error: `Invalid tab_id: ${params.tabIds[bad]}` };
        params.tabIds = list;
    }
    return { params };
}

/** Onglet explicitement visé par une commande (tab_id ou tabId), sinon null. */
function requestedTabId(params) {
    if (!params || typeof params !== "object") return null;
    for (const key of ["tabId", "tab_id"]) {
        const value = params[key];
        if (value === undefined || value === null || value === "") continue;
        const id = typeof value === "number" ? value : Number(String(value).trim());
        return Number.isInteger(id) ? id : null;
    }
    return null;
}

function publicDialog(dialog) {
    return {
        tabId: dialog.tabId,
        type: dialog.type,
        message: dialog.message,
        defaultPrompt: dialog.defaultPrompt,
        url: dialog.url
    };
}

function describeDialog(dialog) {
    return `JavaScript ${dialog.type} dialog open in tab ${dialog.tabId}: "${String(dialog.message).slice(0, 300)}"`;
}

/**
 * Signale dans la réponse d'une commande la boîte de dialogue encore ouverte dans l'onglet qu'ELLE vise (aucune
 * n'est acceptée d'office). Jamais celles des autres onglets : elles appartiennent peut-être à un autre agent.
 */
function annotatePendingDialogs(result, tabId = null) {
    if (!result || tabId === null || !pendingDialogs.has(tabId)) return result;
    const dialogs = [publicDialog(pendingDialogs.get(tabId))];
    if (result.error) {
        return { ...result, error: `${result.error} [${dialogs.map(d => describeDialog(d)).join("; ")}: answer with handle_dialog]` };
    }
    if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
        return { ...result, data: { ...result.data, pendingDialogs: dialogs } };
    }
    return result;
}

function waitForDialog(tabId) {
    let notify;
    const promise = new Promise(resolve => { notify = resolve; });
    if (!dialogWaiters.has(tabId)) dialogWaiters.set(tabId, new Set());
    dialogWaiters.get(tabId).add(notify);
    return {
        promise,
        cancel() {
            const set = dialogWaiters.get(tabId);
            if (!set) return;
            set.delete(notify);
            if (set.size === 0) dialogWaiters.delete(tabId);
        }
    };
}

/**
 * Commande CDP qui peut ouvrir une boîte de dialogue (évaluation, frappe, souris). Tant qu'une boîte est ouverte,
 * Chrome bloque la page : la commande est refusée avant, ou rendue dès que la boîte s'ouvre (sans l'accepter).
 */
async function sendCommandWatchingDialogs(target, method, commandParams) {
    const open = pendingDialogs.get(target.tabId);
    if (open) {
        throw new Error(`${describeDialog(open)}. The page is blocked: answer it first with handle_dialog (browser_handle_dialog).`);
    }
    const watch = waitForDialog(target.tabId);
    const call = chrome.debugger.sendCommand(target, method, commandParams);
    try {
        const outcome = await Promise.race([
            call.then(value => ({ value })),
            watch.promise.then(dialog => ({ dialog }))
        ]);
        if (outcome.dialog) {
            call.catch(() => {});
            return { __dialog: outcome.dialog };
        }
        return outcome.value;
    } finally {
        watch.cancel();
    }
}

function dialogInterruption(dialog) {
    return {
        dialogOpened: true,
        dialog: publicDialog(dialog),
        message: `The command opened a ${describeDialog(dialog)}. Nothing was accepted: read the message, then answer with browser_handle_dialog(accept, prompt_text, tab_id).`
    };
}

async function routeCommand(req, client = null) {
    const action = normalizedAction(req);
    const rawParams = req.params || req.payload || {};
    const params = { ...rawParams };
    if (params.tab_id !== undefined && params.tabId === undefined) {
        params.tabId = params.tab_id;
    }
    if (params.tabId !== undefined && params.tabId !== null) {
        const parsed = parseInt(params.tabId, 10);
        if (!isNaN(parsed)) params.tabId = parsed;
    }

    try {
        switch (action) {
            case "ping":
                return {
                    data: {
                        status: "pong",
                        version: extensionVersion(),
                        features: AGY_FEATURES,
                        timestamp: Date.now(),
                    },
                };

            case "list_tabs":
                return await listTabs(params, client);

            case "active_tab":
                return await getActiveTab(client);

            case "select_tab":
                return await selectTab(params);

            case "create_tab":
                return await createTab(params, client);

            case "adopt_tab":
                return await adoptTab(params, client);

            case "heartbeat":
                return await heartbeat(params, client);

            case "release_tab":
                return await releaseTab(params);

            case "emergency_stop":
                return { data: await emergencyStop({ holdMs: Number(params.hold_s) * 1000, source: "pont" }) };

            case "network_record":
                return await recordNetwork(params);

            case "network_stop":
                return await stopNetworkRecording(params);

            case "group_tabs":
                return await groupTabs(params);

            case "close_tab":
                return await closeTab(params);

            case "navigate":
                return await navigateTab(params);

            case "reload":
                return await reloadTab(params);

            case "hover":
                return await hoverElement(params);

            case "eval":
                return await evaluateScript(params);

            case "content":
                return await getPageContent(params);

            case "axtree":
                return await getAccessibilityTree(params);

            case "logs":
                return await getConsoleLogs(params);

            case "click":
                return await clickElement(params);

            case "fill":
                return await fillElement(params);

            case "check":
                return await setChecked({ ...params, checked: params.checked === undefined ? true : params.checked });

            case "find":
                return await findElements(params);

            case "network_requests":
                return await getNetworkRequests(params);

            case "network_response":
                return await getNetworkResponse(params);

            case "wait_download":
                return await waitForDownload(params, client);

            case "download_erase":
                return await eraseDownload(params, client);

            case "type_keys":
                return await typeKeys(params);

            case "scroll":
                return await scrollPage(params);

            case "screenshot":
                return await takeScreenshot(params);

            case "pdf":
                return await printToPdf(params);

            case "handle_dialog":
                return await handleJsDialog(params);

            case "upload":
                return await uploadFiles(params);

            case "vision_inspect":
                return await visionInspect(params);

            case "check_handoff":
                return await checkHandoff(params);

            case "download_status":
                return await getDownloadStatus(params);

            case "press_key":
                return await pressKey(params);

            case "select_option":
                return await selectOption(params);

            case "field_state":
                return await fieldState(params);

            case "wait_load":
                return await waitForLoad(params);

            case "wait_network_idle":
                return await waitForNetworkIdle(params);

            case "get_cookies":
                return await getCookies(params);

            case "cdp_send":
                return await sendCdpCommand(params);

            case "interactive_map":
                return await getInteractiveMap(params);

            case "drag_and_drop":
                return await dragAndDrop(params);

            case "export_content":
                return await exportContent(params);

            case "export_gsuite":
                return await exportGsuite(params);

            case "export_youtube_transcript":
                return await exportYoutubeTranscript(params);

            case "reload_extension":
                setTimeout(() => { try { chrome.runtime.reload(); } catch(e) {} }, 100);
                return { data: { reloading: true, version: extensionVersion() } };

            default:
                return { error: `Unknown action '${action}'` };
        }
    } catch (error) {
        console.log(`[NexusBrowser] Notice for '${action}':`, error.message);
        return { error: error.message || String(error) };
    }
}

// -----------------------------------------------------------------------------
// Recherche d'élément par texte (injectée dans les scripts de page)
// Jamais <html>/<body> : on prend l'élément le plus spécifique dont le texte correspond — correspondance exacte
// d'abord, puis inclusion ; visible, interactif, texte le plus court, le plus profond — puis son ancêtre interactif
// le plus proche (le <button> d'un <span>), pour que focus() et le compte rendu visent le vrai contrôle.
// -----------------------------------------------------------------------------
// Vraie fonction (et non gabarit texte) : sérialisée pour Runtime.evaluate et injectable telle quelle par
// chrome.scripting.executeScript (repli sans débogueur). install=true la range dans la page et renvoie true.
function agyTextKit(install) {
        const __AGY_SKIP_TAGS = new Set(["HTML", "HEAD", "BODY", "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "META", "LINK", "TITLE"]);
        const __AGY_INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "SUMMARY", "LABEL", "OPTION", "OSDS-BUTTON"]);
        const __AGY_INTERACTIVE_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch", "treeitem", "gridcell", "row"]);
        function __agyNorm(value) { return String(value === undefined || value === null ? "" : value).replace(/\s+/g, " ").trim().toLowerCase(); }
        function __agyAttr(el, name) { try { return el && el.getAttribute ? el.getAttribute(name) : null; } catch (_) { return null; } }
        function __agyTag(el) { return String((el && el.tagName) || "").toUpperCase(); }
        function __agySkipped(el) { return __AGY_SKIP_TAGS.has(__agyTag(el)); }
        function __agyLabels(el, withName) {
            const out = [];
            const push = (v) => { const n = __agyNorm(v); if (n) out.push(n); };
            push(el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent);
            if (typeof el.value === "string") push(el.value);
            push(__agyAttr(el, "aria-label"));
            push(__agyAttr(el, "title"));
            push(__agyAttr(el, "placeholder"));
            push(__agyAttr(el, "alt"));
            if (withName) push(__agyAttr(el, "name"));
            return out;
        }
        function __agyAllElements(root, out) {
            out = out || [];
            if (!root || !root.querySelectorAll) return out;
            let list = [];
            try { list = Array.from(root.querySelectorAll("*")); } catch (_) {}
            for (const el of list) {
                out.push(el);
                if (el.shadowRoot) __agyAllElements(el.shadowRoot, out);
                if (__agyTag(el) === "IFRAME") {
                    try { if (el.contentDocument) __agyAllElements(el.contentDocument, out); } catch (_) {}
                }
            }
            return out;
        }
        function __agyIsInteractive(el) {
            if (__AGY_INTERACTIVE_TAGS.has(__agyTag(el))) return true;
            const role = __agyNorm(__agyAttr(el, "role"));
            if (__AGY_INTERACTIVE_ROLES.has(role)) return true;
            const onclick = __agyAttr(el, "onclick");
            if (onclick !== null && onclick !== undefined) return true;
            const tabindex = __agyAttr(el, "tabindex");
            if (tabindex !== null && tabindex !== undefined && String(tabindex).trim() !== "-1") return true;
            return __agyAttr(el, "contenteditable") === "true";
        }
        function __agyIsVisible(el) {
            try {
                const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                if (!r || !(r.width > 0) || !(r.height > 0)) return false;
                const view = (el.ownerDocument && el.ownerDocument.defaultView) || (typeof window !== "undefined" ? window : null);
                if (view && typeof view.getComputedStyle === "function") {
                    const st = view.getComputedStyle(el);
                    if (st && (st.display === "none" || st.visibility === "hidden" || st.opacity === "0")) return false;
                }
                return true;
            } catch (_) { return false; }
        }
        function __agyDepth(el) {
            let depth = 0;
            let node = el;
            while (node && depth < 1000) {
                node = node.parentElement || (node.parentNode && node.parentNode.host) || null;
                depth++;
            }
            return depth;
        }
        function __agyKey(el, search, order) {
            if (!search) return [__agyIsVisible(el) ? 0 : 1, order];
            let exact = false;
            let length = Infinity;
            for (const label of __agyLabels(el, true)) {
                if (label === search) exact = true;
                if (label.includes(search)) length = Math.min(length, label.length);
            }
            return [__agyIsVisible(el) ? 0 : 1, exact ? 0 : 1, __agyIsInteractive(el) ? 0 : 1, length, -__agyDepth(el), order];
        }
        function __agyLess(a, b) {
            for (let i = 0; i < a.length; i++) {
                if (a[i] !== b[i]) return a[i] < b[i];
            }
            return false;
        }
        function __agyPick(candidates, search) {
            let best = null;
            let bestKey = null;
            candidates.forEach((el, order) => {
                const key = __agyKey(el, search, order);
                if (best === null || __agyLess(key, bestKey)) { best = el; bestKey = key; }
            });
            return best;
        }
        // Bouton d'un composant web : premier contrôle de sa shadow root (le texte affiché vient souvent d'un <slot>).
        function __agyShadowControl(el) {
            if (!el || !el.shadowRoot || !String(__agyTag(el)).includes("-")) return null;
            let inner = [];
            try { inner = Array.from(el.shadowRoot.querySelectorAll("button, a[href], [role='button'], [role='link']")); } catch (_) {}
            return inner[0] || null;
        }
        // Contrôle le plus proche dans l'arbre RENDU : un texte placé dans un <slot> remonte par ce slot jusqu'au
        // bouton du composant qui l'affiche, jamais jusqu'à la carte qui contient le composant.
        function __agyInteractiveTarget(el) {
            let node = el;
            for (let hops = 0; node && hops < 12; hops++) {
                if (node.nodeType === 11) { node = node.host || null; continue; }
                if (__agySkipped(node)) break;
                if (__agyIsInteractive(node)) return node;
                const inner = __agyShadowControl(node);
                if (inner) return inner;
                node = node.assignedSlot || node.parentElement || (node.parentNode && node.parentNode.host) || null;
            }
            return el;
        }
        function __agyFindByText(text) {
            const search = __agyNorm(text);
            if (!search) return null;
            const matches = __agyAllElements(document).filter(el => {
                if (__agySkipped(el)) return false;
                const raw = el.textContent !== undefined && el.textContent !== null ? el.textContent : el.innerText;
                if (__agyNorm(raw).includes(search)) return __agyLabels(el, false).some(l => l.includes(search));
                return [__agyAttr(el, "aria-label"), __agyAttr(el, "title"), __agyAttr(el, "placeholder"), __agyAttr(el, "alt"), typeof el.value === "string" ? el.value : ""]
                    .some(v => __agyNorm(v).includes(search));
            });
            const best = __agyPick(matches, search);
            return best ? __agyInteractiveTarget(best) : null;
        }
        const kit = { __agyNorm, __agyAttr, __agyTag, __agySkipped, __agyLabels, __agyAllElements, __agyIsInteractive,
            __agyIsVisible, __agyDepth, __agyKey, __agyLess, __agyPick, __agyInteractiveTarget, __agyFindByText };
        if (!install) return kit;
        try { (typeof window !== "undefined" ? window : globalThis).__nexusBrowserTextKit = kit; } catch (_) {}
        return true;
}

// -----------------------------------------------------------------------------
// Souris réelle, côté page : localisation, point visé (défilement, iframes same-origin), test d'atteinte
// (elementFromPoint à travers les shadow roots) et sonde isTrusted posée sur le document de l'élément.
// Vraie fonction autonome : sérialisée pour Runtime.evaluate, ou injectée par chrome.scripting (repli JavaScript).
// -----------------------------------------------------------------------------
function agyMouseKit(spec, textKit, locatorKit) {
    const win0 = typeof window !== "undefined" ? window : globalThis;
    const doc0 = typeof document !== "undefined" ? document : null;
    const kit = textKit || win0.__nexusBrowserTextKit || null;
    const lk = locatorKit || win0.__nexusBrowserLocatorKit || null;
    // Échec détaillé du dernier locate() (localisateur ambigu, aucun élément...).
    let locateFailure = null;
    let store = win0.__nexusBrowserMouse;
    if (!store || !store.probes || typeof store.probes.get !== "function") {
        store = { probes: new Map(), seq: 0 };
        try { win0.__nexusBrowserMouse = store; } catch (_) {}
    }
    if (!store.layers || typeof store.layers.get !== "function") store.layers = new Map();

    // Arbre aplati (rendu) : un nœud placé dans un <slot> remonte par ce slot, donc par le bouton du composant web
    // qui l'affiche ; sinon parent, puis hôte d'une shadow root.
    function up(node) { return node ? (node.assignedSlot || node.parentNode || node.parentElement || node.host || null) : null; }
    function within(node, el) {
        for (let n = node, i = 0; n && i < 5000; n = up(n), i++) if (n === el) return true;
        return false;
    }
    function reaches(node, el) {
        if (within(node, el)) return true;
        try {
            const label = node && typeof node.closest === "function" ? node.closest("label") : null;
            return !!(label && label.control && label.control === el);
        } catch (_) { return false; }
    }
    function describe(node) {
        if (!node || !node.tagName) return null;
        let out = String(node.tagName).toLowerCase();
        const id = node.id || (typeof node.getAttribute === "function" ? node.getAttribute("id") : null);
        if (id) out += "#" + id;
        const cls = typeof node.className === "string" ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : [];
        if (cls.length) out += "." + cls.join(".");
        return out;
    }
    // Mot de passe, code à usage unique, carte bancaire : sa valeur ne sort jamais de la page (kit de localisation).
    function sensitive(el) {
        if (lk && typeof lk.sensitiveField === "function") return lk.sensitiveField(el);
        return String((el && el.type) || "").toLowerCase() === "password";
    }
    function info(el) {
        const raw = el.innerText !== undefined && el.innerText !== null ? el.innerText : (typeof el.value === "string" && !sensitive(el) ? el.value : "");
        return {
            tagName: el.tagName || null,
            id: el.id || (typeof el.getAttribute === "function" ? el.getAttribute("id") : null) || null,
            text: raw ? String(raw).slice(0, 50) : null
        };
    }
    function findDeep(root, selector, index) {
        if (!root || !root.querySelectorAll) return null;
        try {
            const els = root.querySelectorAll(selector);
            if (els && els[index]) return els[index];
        } catch (_) {}
        let all = [];
        try { all = root.querySelectorAll("*"); } catch (_) {}
        for (const child of all) {
            if (child.shadowRoot) {
                const res = findDeep(child.shadowRoot, selector, index);
                if (res) return res;
            }
        }
        let frames = [];
        try { frames = root.querySelectorAll("iframe"); } catch (_) {}
        for (const frame of frames) {
            try {
                if (frame.contentDocument) {
                    const res = findDeep(frame.contentDocument, selector, index);
                    if (res) return res;
                }
            } catch (_) {}
        }
        return null;
    }
    function axPool(token) {
        const reg = win0.__nexusBrowserAx;
        const list = reg && token ? reg[token] : null;
        return Array.isArray(list) ? list.filter(x => x && x.el && x.el.isConnected !== false).map(x => ({ el: x.el, role: x.role, name: x.name })) : null;
    }
    // Correspondances d'un localisateur dans ce contexte (ce cadre et ses cadres same-origin).
    function locatorMatches(loc) {
        if (!lk) throw new Error("Locator engine unavailable in this context");
        return lk.query(doc0, loc.locator, loc.axToken ? axPool(loc.axToken) : null);
    }
    function locate(loc) {
        if (!loc) return null;
        locateFailure = null;
        if (loc.locator) {
            let res;
            try { res = locatorMatches(loc); } catch (error) {
                locateFailure = { invalid: true, error: String(error && error.message || error) };
                return null;
            }
            const list = res.matches;
            let index = loc.pick;
            if (index === undefined || index === null) {
                if (list.length > 1) {
                    locateFailure = { ambiguous: true, count: list.length, candidates: list.slice(0, 10).map(m => lk.describe(m)) };
                    return null;
                }
                index = 0;
            }
            if (index < 0) index = list.length + index;
            const hit = list[index];
            if (!hit) {
                locateFailure = { notFound: true, hidden: res.hidden, error: "No element matches the locator " + JSON.stringify(loc.locator) };
                return null;
            }
            return hit.el;
        }
        if (loc.probeRef) {
            const probe = store.probes.get(loc.probeRef);
            return probe && probe.el && probe.el.isConnected !== false ? probe.el : null;
        }
        if (loc.active) {
            let a = doc0 ? doc0.activeElement : null;
            for (let i = 0; a && i < 64; i++) {
                let inner = null;
                if (a.shadowRoot && a.shadowRoot.activeElement) inner = a.shadowRoot.activeElement;
                else if (String(a.tagName || "").toUpperCase() === "IFRAME") { try { inner = a.contentDocument && a.contentDocument.activeElement; } catch (_) {} }
                if (!inner || inner === a) break;
                a = inner;
            }
            const tag = String((a && a.tagName) || "").toUpperCase();
            return a && tag !== "BODY" && tag !== "HTML" ? a : null;
        }
        const som = win0.__nexus_som_elements;
        if (loc.mark !== undefined && loc.mark !== null) {
            return som && typeof som.get === "function" ? (som.get(Number(loc.mark)) || null) : null;
        }
        if (loc.selector) {
            const sel = String(loc.selector);
            if (/^#[0-9]+$/.test(sel) && som && typeof som.has === "function" && som.has(Number(sel.slice(1)))) {
                return som.get(Number(sel.slice(1)));
            }
            return findDeep(doc0, sel, loc.index || 0);
        }
        if (loc.text) return kit ? kit.__agyFindByText(loc.text) : null;
        if (loc.point) {
            const hit = deepHit(doc0, Number(loc.point.x), Number(loc.point.y));
            return hit || null;
        }
        return null;
    }
    function notFound(loc) {
        if (locateFailure) {
            if (locateFailure.ambiguous) return Object.assign({ notFound: false, error: "Ambiguous locator" }, locateFailure);
            if (locateFailure.invalid) return Object.assign({ notFound: false }, locateFailure);
            return locateFailure;
        }
        if (loc && loc.active) return { notFound: true, error: "No field has focus (give selector, mark or locator)" };
        if (loc && loc.mark !== undefined && loc.mark !== null) {
            return { notFound: true, error: "No element registered for mark #" + loc.mark + ". Run vision-inspect or interactive_map first." };
        }
        return { notFound: true, error: "Element not found for " + JSON.stringify(loc) };
    }
    // Champ réellement éditable visé : contrôle d'un <label>, ou unique champ éditable contenu dans l'élément.
    function tagUp(n) { return String((n && n.tagName) || "").toUpperCase(); }
    // État du type d'un <input> selon HTML : valeur absente, vide ou inconnue (type="short_text" de Typeform) = texte.
    // Lu sur l'attribut puis normalisé (jamais une propriété que la page pourrait masquer).
    const INPUT_TYPES = new Set(["hidden", "text", "search", "tel", "url", "email", "password", "date", "month", "week",
        "time", "datetime-local", "number", "range", "color", "checkbox", "radio", "file", "submit", "image", "reset", "button"]);
    const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
    // Champs à sélecteur (date, heure, couleur, curseur) : pas de frappe caractère par caractère fiable ; valeur posée
    // par le setter natif puis input/change, comme Playwright, et relue.
    const PICKER_TYPES = new Set(["date", "time", "datetime-local", "month", "week", "color", "range"]);
    function inputTypeOf(n) {
        const raw = typeof n.getAttribute === "function" ? n.getAttribute("type") : n.type;
        const t = String(raw || "").trim().toLowerCase();
        return INPUT_TYPES.has(t) ? t : "text";
    }
    function isTextInput(n) {
        return tagUp(n) === "INPUT" && TEXT_TYPES.has(inputTypeOf(n));
    }
    function editableOf(n) { return isTextInput(n) || tagUp(n) === "TEXTAREA" || tagUp(n) === "SELECT" || !!(n && n.isContentEditable); }
    function editTargetOf(el) {
        if (!el) return el;
        if (tagUp(el) === "LABEL" && el.control) return el.control;
        if (!editableOf(el) && typeof el.querySelectorAll === "function") {
            let inner = [];
            try { inner = Array.from(el.querySelectorAll("input, textarea, select, [contenteditable='true'], [contenteditable='']")).filter(editableOf); } catch (_) {}
            if (inner.length === 1) return inner[0];
        }
        return el;
    }
    function rectOf(el) {
        const r = el.getBoundingClientRect();
        return {
            left: r.left !== undefined ? r.left : r.x,
            top: r.top !== undefined ? r.top : r.y,
            width: r.width,
            height: r.height
        };
    }
    function viewOf(node) {
        const d = (node && node.ownerDocument) || doc0;
        return { doc: d, win: (d && d.defaultView) || win0 };
    }
    function deepHit(d, x, y) {
        if (!d || typeof d.elementFromPoint !== "function") return undefined;
        let hit = d.elementFromPoint(x, y);
        for (let i = 0; hit && hit.shadowRoot && i < 64; i++) {
            const root = hit.shadowRoot;
            const inner = typeof root.elementFromPoint === "function" ? root.elementFromPoint(x, y) : null;
            if (!inner || inner === hit) break;
            hit = inner;
        }
        return hit;
    }
    function frameOf(w) {
        try { return (w && w.frameElement) || null; } catch (_) { return null; }
    }
    function frameOffset(fe) {
        const r = rectOf(fe);
        let padL = 0;
        let padT = 0;
        try {
            const v = viewOf(fe).win;
            const cs = v && typeof v.getComputedStyle === "function" ? v.getComputedStyle(fe) : null;
            if (cs) { padL = parseFloat(cs.paddingLeft) || 0; padT = parseFloat(cs.paddingTop) || 0; }
        } catch (_) {}
        return { x: r.left + (fe.clientLeft || 0) + padL, y: r.top + (fe.clientTop || 0) + padT };
    }
    // Point local (repère du document de l'élément) -> viewport principal ; chaque cadre parent doit aussi être atteint.
    function project(el, lx, ly) {
        const own = viewOf(el);
        const hit = deepHit(own.doc, lx, ly);
        if (hit === null) return { ok: false, blocker: null, reason: "outside the viewport" };
        if (hit !== undefined && !reaches(hit, el)) return { ok: false, blocker: hit };
        const up2 = climb(own.win, lx, ly, true);
        return up2.ok ? Object.assign(up2, { hit }) : up2;
    }
    // Remonte les cadres same-origin depuis la fenêtre w : chaque <iframe> parent doit être atteint au point.
    function climb(w, lx, ly, check) {
        let x = lx;
        let y = ly;
        let depth = 0;
        let fe = frameOf(w);
        while (fe && depth < 32) {
            const off = frameOffset(fe);
            x += off.x;
            y += off.y;
            depth++;
            const parent = viewOf(fe);
            if (check) {
                const outer = deepHit(parent.doc, x, y);
                if (outer === null) return { ok: false, blocker: null, reason: "frame outside the viewport" };
                if (outer !== undefined && !within(outer, fe)) return { ok: false, blocker: outer };
            }
            fe = frameOf(parent.win);
        }
        return { ok: true, x, y, depth };
    }
    // Centre de la partie visible, puis points intérieurs (quarts, puis coins rentrés de 2 px).
    function candidates(el) {
        const w = viewOf(el).win;
        const r = rectOf(el);
        const vw = w && typeof w.innerWidth === "number" && w.innerWidth > 0 ? w.innerWidth : Infinity;
        const vh = w && typeof w.innerHeight === "number" && w.innerHeight > 0 ? w.innerHeight : Infinity;
        const l = Math.max(r.left, 0);
        const t = Math.max(r.top, 0);
        const rr = Math.min(r.left + r.width, vw);
        const bb = Math.min(r.top + r.height, vh);
        if (!(rr - l >= 1) || !(bb - t >= 1)) return [];
        const W = rr - l;
        const H = bb - t;
        const pts = [[l + W / 2, t + H / 2]];
        for (const [fx, fy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) pts.push([l + W * fx, t + H * fy]);
        const inset = Math.min(2, W / 4, H / 4);
        pts.push([l + inset, t + inset], [rr - inset, t + inset], [l + inset, bb - inset], [rr - inset, bb - inset]);
        const seen = new Set();
        return pts.filter(([x, y]) => {
            const key = Math.round(x * 4) + ":" + Math.round(y * 4);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    function addProbe(el, types) {
        const d = viewOf(el).doc;
        const id = ++store.seq;
        const probe = { el, doc: d, types: types.slice(), trusted: 0, untrusted: 0, seen: [], created: Date.now(), attached: false };
        probe.listener = (ev) => {
            let origin = ev.target;
            try {
                const path = typeof ev.composedPath === "function" ? ev.composedPath() : null;
                if (path && path.length) origin = path[0];
            } catch (_) {}
            if (!reaches(origin, el)) return;
            if (ev.isTrusted) {
                probe.trusted++;
                if (probe.seen.length < 64) probe.seen.push(ev.type);
            } else {
                probe.untrusted++;
            }
        };
        if (d && typeof d.addEventListener === "function") {
            for (const type of probe.types) d.addEventListener(type, probe.listener, true);
            probe.attached = true;
        }
        store.probes.set(id, probe);
        return id;
    }
    function dropProbe(id) {
        const probe = store.probes.get(id);
        if (!probe) return null;
        store.probes.delete(id);
        if (probe.attached) {
            for (const type of probe.types) {
                try { probe.doc.removeEventListener(type, probe.listener, true); } catch (_) {}
            }
        }
        return probe;
    }
    function probeReport(probe) {
        return {
            trusted: probe.trusted,
            untrusted: probe.untrusted,
            seen: probe.seen.slice(),
            drops: probe.seen.filter(t => t === "drop").length,
            attached: probe.attached
        };
    }
    function round2(v) { return Math.round(v * 100) / 100; }

    // --- Élément couvert : couche vide traversée, barre collante évitée, jamais un clic sur la couche elle-même.
    const CONTROL_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option",
        "switch", "checkbox", "radio", "treeitem", "textbox", "searchbox", "combobox", "slider", "spinbutton"]);
    // Contenu qui se voit ou qui réagit : une couche qui en porte n'est jamais traversée.
    const CONTENT_SELECTOR = "img, svg, video, canvas, iframe, embed, object, picture, button, a, input, select, " +
        "textarea, label, summary, [role], [tabindex], [onclick], [contenteditable]";
    function attrOf(n, a) { try { return n && typeof n.getAttribute === "function" ? n.getAttribute(a) : null; } catch (_) { return null; } }
    function styleOf(n) {
        try {
            const w = viewOf(n).win;
            return w && typeof w.getComputedStyle === "function" ? w.getComputedStyle(n) : null;
        } catch (_) { return null; }
    }
    // Contrôle (bouton, lien, rôle actif) qui contient le nœud, lui compris, dans l'arbre aplati.
    function controlOf(node) {
        for (let n = node, i = 0; n && i < 64; n = up(n), i++) {
            if (n.nodeType !== undefined && n.nodeType !== 1) continue;
            const t = tagUp(n);
            if (t === "BODY" || t === "HTML") return null;
            if (t === "BUTTON" || t === "SUMMARY" || t === "SELECT" || t === "TEXTAREA" || (t === "A" && attrOf(n, "href") !== null)) return n;
            if (t === "INPUT" && inputTypeOf(n) !== "hidden") return n;
            if (CONTROL_ROLES.has(String(attrOf(n, "role") || "").toLowerCase())) return n;
        }
        return null;
    }
    function transparent(color) {
        const c = String(color || "").replace(/\s+/g, "").toLowerCase();
        if (!c || c === "transparent") return true;
        const m = /^rgba\([^,]+,[^,]+,[^,]+,([0-9.]+)\)$/.exec(c);
        return !!m && Number(m[1]) < 0.05;
    }
    // Boîte de dialogue modale ouverte qui ne contient pas l'élément : la couche qui couvre est son fond, refus.
    function blockedByModal(el) {
        const d = viewOf(el).doc;
        let modals = [];
        try { modals = Array.from(d.querySelectorAll("[aria-modal='true'], dialog[open]")); } catch (_) { return true; }
        return modals.some(m => !within(el, m));
    }
    // Couche sans contenu ni rôle (calque transparent d'une application, X par exemple) : traversable. Tout ce qui ne
    // se lit pas avec certitude (style, descendants) reste un vrai obstacle.
    function emptyLayer(n, el) {
        if (!n || (n.nodeType !== undefined && n.nodeType !== 1) || typeof n.querySelector !== "function") return false;
        const t = tagUp(n);
        if (t === "BODY" || t === "HTML" || t === "DIALOG" || t === "IFRAME") return false;
        if (controlOf(n) || n.isContentEditable) return false;
        const role = String(attrOf(n, "role") || "").toLowerCase();
        if (role && role !== "presentation" && role !== "none") return false;
        if (attrOf(n, "tabindex") !== null || attrOf(n, "onclick") !== null || attrOf(n, "aria-modal") !== null) return false;
        if (n.shadowRoot) return false;
        const raw = n.textContent !== undefined && n.textContent !== null ? n.textContent : n.innerText;
        if (String(raw || "").trim()) return false;
        try { if (n.querySelector(CONTENT_SELECTOR)) return false; } catch (_) { return false; }
        const st = styleOf(n);
        if (!st || !transparent(st.backgroundColor)) return false;
        if (st.backgroundImage && st.backgroundImage !== "none") return false;
        if (!n.style || typeof n.style.setProperty !== "function") return false;
        return !blockedByModal(el);
    }
    // Couche traversée le temps du geste (pointer-events: none, valeur d'origine rendue à la libération).
    function passLayer(n) {
        const id = ++store.seq;
        store.layers.set(id, {
            el: n, value: n.style.getPropertyValue("pointer-events"), priority: n.style.getPropertyPriority("pointer-events"),
            created: Date.now()
        });
        n.style.setProperty("pointer-events", "none", "important");
        return id;
    }
    function restoreLayer(id) {
        const layer = store.layers.get(id);
        if (!layer) return;
        store.layers.delete(id);
        try {
            if (layer.value) layer.el.style.setProperty("pointer-events", layer.value, layer.priority);
            else layer.el.style.removeProperty("pointer-events");
        } catch (_) {}
    }
    // Barre fixe ou collante (en-tête, barre du bas) : l'élément défile hors d'elle, une fois.
    function stickyBar(n) {
        for (let b = n, i = 0; b && i < 32; b = up(b), i++) {
            if (b.nodeType !== undefined && b.nodeType !== 1) continue;
            const t = tagUp(b);
            if (t === "BODY" || t === "HTML") return null;
            const st = styleOf(b);
            if (st && (st.position === "fixed" || st.position === "sticky")) return b;
        }
        return null;
    }
    function scrollerOf(el) {
        for (let n = up(el), i = 0; n && i < 64; n = up(n), i++) {
            if (n.nodeType !== undefined && n.nodeType !== 1) continue;
            const t = tagUp(n);
            if (t === "BODY" || t === "HTML") break;
            const st = styleOf(n);
            if (st && /(auto|scroll|overlay)/.test(String(st.overflowY || "")) && n.scrollHeight > n.clientHeight) return n;
        }
        return null;
    }
    function clearBar(el, blocker) {
        const bar = stickyBar(blocker);
        if (!bar || within(el, bar)) return false;
        const w = viewOf(el).win;
        const vh = w && w.innerHeight > 0 ? w.innerHeight : 0;
        const b = rectOf(bar);
        const r = rectOf(el);
        if (!vh || !(b.height > 0) || b.height > vh / 2) return false;
        const delta = b.top + b.height / 2 > vh / 2 ? (r.top + r.height) - b.top + 8 : r.top - (b.top + b.height) - 8;
        if (!delta) return false;
        const box = scrollerOf(el);
        try {
            if (box && typeof box.scrollBy === "function") box.scrollBy({ top: delta, behavior: "instant" });
            else if (box) box.scrollTop += delta;
            else if (w && typeof w.scrollBy === "function") w.scrollBy({ top: delta, behavior: "instant" });
            else return false;
        } catch (_) { return false; }
        return true;
    }

    // Sondes oubliées (page bloquée, navigation) : retirées après une minute ; couche traversée rendue après 3 s
    // (geste interrompu par une boîte de dialogue : la libération n'a pas pu passer).
    for (const [id, probe] of store.probes) if (Date.now() - probe.created > 60000) dropProbe(id);
    for (const [id, layer] of store.layers) if (Date.now() - layer.created > 3000) restoreLayer(id);

    if (spec.phase === "prepare") {
        const found = locate(spec.locate);
        if (!found) return notFound(spec.locate);
        const el = spec.forEdit ? editTargetOf(found) : found;
        const scroll = spec.scroll || "center";
        if (scroll !== "none" && typeof el.scrollIntoView === "function") {
            try { el.scrollIntoView({ behavior: "instant", block: scroll, inline: scroll }); } catch (_) {}
        }
        // Clic et survol : un calque intérieur du même contrôle (fond de survol d'un bouton) reçoit le geste pour lui.
        const ctl = spec.passThrough && !spec.forEdit ? controlOf(el) : null;
        let pts, blocker, reason, chosen, alternatives;
        const scan = () => {
            pts = candidates(el);
            blocker = null;
            reason = pts.length ? null : "no visible area in the viewport";
            chosen = null;
            alternatives = [];
            for (const [lx, ly] of pts) {
                let p = project(el, lx, ly);
                if (!p.ok && ctl && ctl !== el && p.blocker && within(p.blocker, ctl)) {
                    const outer = climb(viewOf(el).win, lx, ly, true);
                    p = outer.ok ? Object.assign(outer, { hit: p.blocker }) : outer;
                }
                if (p.ok) {
                    if (!chosen) chosen = p;
                    alternatives.push({ x: round2(p.x), y: round2(p.y) });
                    if (!spec.allPoints) break;
                    continue;
                }
                if (!blocker && p.blocker) blocker = p.blocker;
                if (!reason && p.reason) reason = p.reason;
            }
        };
        scan();
        const layers = [];
        let barCleared = false;
        while (!chosen && blocker && spec.passThrough && layers.length < 4) {
            if (emptyLayer(blocker, el)) layers.push(passLayer(blocker));
            else if (!barCleared && clearBar(el, blocker)) barCleared = true;
            else break;
            scan();
        }
        if (!chosen) for (const id of layers) restoreLayer(id);
        const base = info(el);
        const label = describe(el) || "element";
        if (!chosen) {
            const coveredBy = describe(blocker);
            const failure = {
                notReachable: true,
                ...base,
                coveredBy,
                error: coveredBy
                    ? "<" + label + "> is covered by <" + coveredBy + ">: no point of the element is reachable, no mouse action sent."
                    : "<" + label + "> is not reachable (" + (reason || "outside the viewport") + "): no mouse action sent."
            };
            if (!spec.allowUnreachable) return failure;
            // Saisie : le champ peut encore recevoir le focus sans clic (DOM focus).
            const probeId = Array.isArray(spec.probe) && spec.probe.length ? addProbe(el, spec.probe) : null;
            return { success: true, ...base, probeId, point: null, unreachable: failure.error, frameDepth: 0 };
        }
        // Point tenu par le calque intérieur du contrôle : la sonde écoute le contrôle, qui reçoit le geste.
        const heard = ctl && chosen.hit && !reaches(chosen.hit, el) ? ctl : el;
        const probeId = Array.isArray(spec.probe) && spec.probe.length ? addProbe(heard, spec.probe) : null;
        const x = round2(chosen.x);
        const y = round2(chosen.y);
        return {
            success: true,
            ...base,
            probeId,
            layers: layers.length ? layers : undefined,
            point: { x, y },
            points: spec.allPoints ? alternatives : undefined,
            hit: describe(chosen.hit),
            frameDepth: chosen.depth,
            draggable: !!(el.draggable === true || (typeof el.getAttribute === "function" && el.getAttribute("draggable") === "true")),
            devicePixelRatio: win0.devicePixelRatio || 1
        };
    }

    if (spec.phase === "probe") {
        const probe = spec.remove ? dropProbe(spec.probeId) : store.probes.get(spec.probeId);
        return probe ? probeReport(probe) : { missing: true };
    }

    if (spec.phase === "release") {
        for (const id of spec.probeIds || []) dropProbe(id);
        for (const id of spec.layerIds || []) restoreLayer(id);
        return { released: true };
    }

    if (spec.phase === "find") {
        // Candidats d'un localisateur dans ce contexte (sans action) : rôle, nom, état, boîte (repère de ce cadre).
        if (!lk) return { error: "Locator engine unavailable in this context" };
        let res;
        try { res = locatorMatches({ locator: spec.locator, axToken: spec.axToken }); } catch (error) {
            return { invalid: true, error: String(error && error.message || error) };
        }
        const limit = spec.limit || 20;
        return {
            count: res.matches.length,
            hidden: res.hidden,
            candidates: res.matches.slice(0, limit).map(m => lk.describe(m)),
            viewport: { width: win0.innerWidth || 0, height: win0.innerHeight || 0 }
        };
    }

    if (spec.phase === "reveal" || spec.phase === "hop") {
        // Exécutée sur l'élément <iframe> propriétaire d'un cadre d'une autre origine (Runtime.callFunctionOn).
        const owner = spec.__owner;
        if (!owner) return { ok: false, reason: "owner frame not found" };
        if (spec.phase === "reveal") {
            try { owner.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); } catch (_) {}
            return { ok: true };
        }
        // Point local au cadre enfant -> repère du cadre racine de ce contexte (cadres same-origin remontés).
        const off = frameOffset(owner);
        const own = viewOf(owner);
        const mapped = [];
        let blocker = null;
        let reason = null;
        let depth = 0;
        for (const p of spec.points || []) {
            const x = off.x + Number(p.x);
            const y = off.y + Number(p.y);
            if (spec.check !== false) {
                const hit = deepHit(own.doc, x, y);
                if (hit === null) { reason = reason || "frame outside the viewport"; continue; }
                if (hit !== undefined && !within(hit, owner)) { blocker = blocker || hit; continue; }
            }
            const c = climb(own.win, x, y, spec.check !== false);
            if (!c.ok) { blocker = blocker || c.blocker; reason = reason || c.reason; continue; }
            depth = c.depth;
            mapped.push({ x: round2(c.x), y: round2(c.y) });
        }
        if (!mapped.length) {
            const coveredBy = describe(blocker);
            return { ok: false, coveredBy, reason: reason || (coveredBy ? null : "outside the viewport") };
        }
        return { ok: true, points: mapped, depth, owner: describe(owner) };
    }

    if (spec.phase === "edit") {
        // Champ de saisie : état, focus, caret, sélection, repli setter natif, <select>, cases à cocher.
        const raw = locate(spec.locate);
        let el = raw;
        if (!el) return notFound(spec.locate);
        const boxOp = spec.op === "check" || (spec.op === "verify" && spec.expect && spec.expect.checked !== undefined);
        if (!boxOp) el = editTargetOf(el);
        else if (tagUp(el) === "LABEL" && el.control) el = el.control;
        // Relecture (browser_fill_form) : le mark doit désigner le champ lui-même. Un libellé ou un conteneur serait
        // redirigé à chaque lecture vers son champ du moment, qui peut avoir changé (relecture de Codex, 19/10).
        if (spec.op === "verify" && el !== raw) {
            return { error: "The mark points to a label or a container, not the field: target the mark of the field itself (browser_interactive_map)." };
        }
        const kind = tagUp(el) === "TEXTAREA" ? "textarea" : (isTextInput(el) ? "input" : (tagUp(el) === "SELECT" ? "select"
            : (el.isContentEditable ? "contenteditable"
            : (tagUp(el) === "INPUT" && PICKER_TYPES.has(inputTypeOf(el)) ? "picker" : "other"))));
        const own = viewOf(el);
        const readValue = () => {
            if (kind === "contenteditable") {
                const raw = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent;
                return String(raw || "").replace(/ /g, " ").replace(/\n+$/, "");
            }
            return typeof el.value === "string" ? el.value : (el.value === undefined || el.value === null ? "" : String(el.value));
        };
        const deepActive = () => {
            let a = own.doc ? own.doc.activeElement : null;
            for (let i = 0; a && a.shadowRoot && a.shadowRoot.activeElement && i < 32; i++) a = a.shadowRoot.activeElement;
            return a;
        };
        const focused = () => {
            const a = deepActive();
            if (!a) return false;
            if (a === el) return true;
            try { if (typeof el.contains === "function" && el.contains(a)) return true; } catch (_) {}
            try { return kind === "contenteditable" && typeof a.contains === "function" && a.isContentEditable && a.contains(el); } catch (_) { return false; }
        };
        const state = (extra) => Object.assign({
            success: true,
            kind,
            ...info(el),
            type: el.type || null,
            // Valeur réelle gardée pour la relecture (verified) côté extension, masquée avant de sortir (shownValue).
            value: readValue(),
            sensitive: sensitive(el),
            editable: kind !== "other" && kind !== "select" && !el.disabled && !el.readOnly,
            disabled: !!el.disabled,
            readOnly: !!el.readOnly,
            focused: focused(),
            isContentEditable: !!el.isContentEditable
        }, extra || {});
        const op = spec.op || "state";
        if (op === "state") return state();
        if (op === "focus") {
            try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (__) {} }
            return state();
        }
        if (op === "caretEnd" || op === "selectAll") {
            const all = op === "selectAll";
            try {
                if (kind === "input" || kind === "textarea") {
                    if (all && typeof el.select === "function") el.select();
                    else {
                        const len = readValue().length;
                        el.setSelectionRange(len, len);
                    }
                } else if (kind === "contenteditable") {
                    const sel = own.win.getSelection();
                    const range = own.doc.createRange();
                    range.selectNodeContents(el);
                    if (!all) range.collapse(false);
                    sel.removeAllRanges();
                    sel.addRange(range);
                }
            } catch (_) {}
            return state();
        }
        if (op === "selection") {
            let all = null;
            try {
                if (kind === "input" || kind === "textarea") {
                    const len = readValue().length;
                    all = el.selectionStart === 0 && el.selectionEnd === len;
                } else if (kind === "contenteditable") {
                    const sel = own.win.getSelection();
                    const n = (s) => String(s || "").replace(/[\s ]+/g, " ").trim();
                    all = !!sel && sel.rangeCount > 0 && n(sel.toString()) === n(readValue());
                }
            } catch (_) { all = null; }
            return state({ allSelected: all });
        }
        if (op === "setValue") {
            // Repli : setter natif du prototype (React 18/19) puis input/change synthétiques (isTrusted=false).
            const value = String(spec.value === undefined || spec.value === null ? "" : spec.value);
            const next = spec.append ? readValue() + value : value;
            try { el.focus({ preventScroll: true }); } catch (_) {}
            if (kind === "contenteditable") {
                el.textContent = next;
                try { el.dispatchEvent(new own.win.InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); } catch (_) {}
            } else {
                const proto = kind === "textarea" ? own.win.HTMLTextAreaElement : (kind === "select" ? own.win.HTMLSelectElement : own.win.HTMLInputElement);
                let setter = null;
                try { setter = proto && Object.getOwnPropertyDescriptor(proto.prototype, "value").set; } catch (_) {}
                if (setter) { try { setter.call(el, next); } catch (_) { el.value = next; } } else el.value = next;
                const Ev = own.win.Event || (typeof Event !== "undefined" ? Event : null);
                if (Ev) {
                    el.dispatchEvent(new Ev("input", { bubbles: true }));
                    el.dispatchEvent(new Ev("change", { bubbles: true }));
                }
            }
            return state();
        }
        if (op === "selectOption") {
            let options = Array.from(el.options || []);
            if (kind !== "select" && !options.length && typeof el.querySelectorAll === "function") {
                // Composant qui expose value et des <option> (ou équivalents) : même traitement que l'ancien chemin.
                try { options = Array.from(el.querySelectorAll("option")); } catch (_) {}
            }
            if (kind !== "select" && !options.length) {
                return { error: "<" + (describe(el) || "element") + "> is not a <select>: click the list, then the option (browser_click with locator role=option)." };
            }
            const want = spec.option || {};
            const n = (s) => String(s === undefined || s === null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
            const valueOf = (o) => o.value !== undefined ? o.value : (typeof o.getAttribute === "function" ? o.getAttribute("value") : null);
            const textOf = (o) => o.text !== undefined ? o.text : (o.innerText !== undefined ? o.innerText : o.textContent);
            const match = options.find(o => want.value !== undefined && want.value !== null && valueOf(o) === String(want.value))
                || options.find(o => want.label !== undefined && want.label !== null && n(o.label || textOf(o)) === n(want.label))
                || options.find(o => want.text !== undefined && want.text !== null && n(textOf(o)) === n(want.text))
                || options.find(o => want.text !== undefined && want.text !== null && n(textOf(o)).includes(n(want.text)))
                || (Number.isInteger(want.index) ? options[want.index] : undefined);
            if (!match) return { error: "No option matches " + JSON.stringify(want) + " (options: " + options.slice(0, 15).map(o => JSON.stringify(textOf(o))).join(", ") + ")" };
            if (match.disabled) return { error: "Option " + JSON.stringify(textOf(match)) + " is disabled" };
            el.value = valueOf(match);
            match.selected = true;
            const Ev = own.win.Event || (typeof Event !== "undefined" ? Event : null);
            if (Ev) {
                el.dispatchEvent(new Ev("input", { bubbles: true }));
                el.dispatchEvent(new Ev("change", { bubbles: true }));
            }
            return state({ selectedValue: el.value, selectedText: textOf(match) });
        }
        if (op === "check") {
            const target = tagUp(el) === "LABEL" && el.control ? el.control : el;
            return { success: true, ...info(target), checked: lk ? lk.checkedOf(target) : (target.checked === undefined ? null : !!target.checked), disabled: lk ? lk.disabledOf(target) : !!target.disabled };
        }
        if (op === "verify") {
            // Relecture pure (browser_fill_form) : l'état ACTUEL du champ comparé à la valeur voulue, ici, avant tout
            // masquage (un champ sensible n'en sort que verified). Une option : celle que selectOption choisirait
            // pour ce texte doit être l'option sélectionnée maintenant.
            const want = spec.expect || {};
            // Élément remplacé ou retiré par la page (mark d'un nœud détaché) : sa valeur ne dit plus rien du formulaire.
            if (el.isConnected === false) return { error: "Field removed or replaced by the page since the gesture: run browser_interactive_map again." };
            const n = (v) => String(v === undefined || v === null ? "" : v).replace(/[\s ]+/g, " ").trim();
            if (want.checked !== undefined) {
                const checked = lk ? lk.checkedOf(el) : (el.checked === undefined ? null : !!el.checked);
                return state({ checked, verified: checked === !!want.checked });
            }
            if (want.option !== undefined) {
                let options = Array.from(el.options || []);
                if (kind !== "select" && !options.length && typeof el.querySelectorAll === "function") {
                    try { options = Array.from(el.querySelectorAll("option")); } catch (_) {}  // comme selectOption
                }
                const low = (v) => n(v).toLowerCase();
                const textOf = (o) => o.text !== undefined ? o.text : (o.innerText !== undefined ? o.innerText : o.textContent);
                const wanted = low(want.option);
                const match = options.find(o => low(textOf(o)) === wanted) || options.find(o => low(textOf(o)).includes(wanted));
                const valueOf = (o) => o.value !== undefined ? o.value : (typeof o.getAttribute === "function" ? o.getAttribute("value") : null);
                const selected = Number.isInteger(el.selectedIndex) ? (options[el.selectedIndex] || null)
                    : (options.find(o => valueOf(o) === el.value) || null);
                // Liste multiple : l'option voulue doit être la SEULE sélectionnée (une sélection en plus partirait aussi).
                const chosen = el.multiple ? options.filter(o => o.selected) : (selected ? [selected] : []);
                return state({
                    selectedValue: selected ? valueOf(selected) : null, selectedText: selected ? textOf(selected) : null,
                    verified: !!match && chosen.length === 1 && chosen[0] === match
                });
            }
            // Un texte ne se relit que dans un champ de saisie : un libellé devenu sans champ lit "" et confirmerait un
            // effacement (relecture de Codex, 19/10).
            if (kind === "other" || kind === "select") return { error: `<${String(tagUp(el) || "element").toLowerCase()}> is not an input field: target the mark of the field itself.` };
            const actual = readValue();
            return state({ verified: kind === "contenteditable" ? n(actual) === n(want.value) : actual === String(want.value) });
        }
        return { error: "Unknown input operation: " + op };
    }

    if (spec.phase === "html5drop") {
        const src = store.probes.get(spec.srcProbe);
        const dst = store.probes.get(spec.dstProbe);
        if (!src || !dst) return { dispatched: false };
        const view = viewOf(dst.el).win;
        const DT = view.DataTransfer || (typeof DataTransfer !== "undefined" ? DataTransfer : null);
        const DE = view.DragEvent || (typeof DragEvent !== "undefined" ? DragEvent : null);
        if (!DT || !DE) return { dispatched: false };
        const dataTransfer = new DT();
        const fire = (el, type) => el.dispatchEvent(new DE(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(src.el, "dragstart");
        fire(dst.el, "dragenter");
        fire(dst.el, "dragover");
        fire(dst.el, "drop");
        fire(src.el, "dragend");
        return { dispatched: true };
    }

    if (spec.phase === "js") {
        // Repli sans débogueur : événements synthétiques (isTrusted=false), signalés comme tels à l'appelant.
        const el = locate(spec.locate);
        if (!el) return notFound(spec.locate);
        try { el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" }); } catch (_) {}
        const r = rectOf(el);
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const view = viewOf(el).win;
        const ME = (view && view.MouseEvent) || (typeof MouseEvent !== "undefined" ? MouseEvent : null);
        const fire = (type, extra) => {
            if (!ME) return;
            try { el.dispatchEvent(new ME(type, Object.assign({ bubbles: true, cancelable: true, view, clientX: cx, clientY: cy }, extra || {}))); } catch (_) {}
        };
        if (spec.action === "hover") {
            fire("mouseover");
            fire("mouseenter", { bubbles: false });
        } else if (spec.action === "contextmenu") {
            fire("mousedown", { button: 2, buttons: 2 });
            fire("mouseup", { button: 2, buttons: 0 });
            fire("contextmenu", { button: 2, buttons: 0 });
        } else {
            if (typeof el.focus === "function") { try { el.focus(); } catch (_) {} }
            const count = spec.clickCount === 2 ? 2 : 1;
            for (let i = 1; i <= count; i++) {
                if (typeof el.click === "function") el.click();
                else fire("click", { detail: i });
            }
            if (count === 2) fire("dblclick", { detail: 2 });
        }
        return { success: true, ...info(el), coordinates: { x: Math.round(cx), y: Math.round(cy) } };
    }

    if (spec.phase === "jsdrag") {
        const src = locate(spec.from);
        const dst = locate(spec.to);
        if (!src) return notFound(spec.from);
        if (!dst) return notFound(spec.to);
        const view = viewOf(dst).win;
        const DT = view.DataTransfer || (typeof DataTransfer !== "undefined" ? DataTransfer : null);
        const DE = view.DragEvent || (typeof DragEvent !== "undefined" ? DragEvent : null);
        if (!DT || !DE) return { error: "DragEvent unavailable in the page" };
        const dataTransfer = new DT();
        const fire = (el, type) => el.dispatchEvent(new DE(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(src, "dragstart");
        fire(dst, "dragenter");
        fire(dst, "dragover");
        fire(dst, "drop");
        fire(src, "dragend");
        return { success: true, from: info(src), to: info(dst) };
    }

    return { error: "Unknown mouse phase: " + spec.phase };
}

// -----------------------------------------------------------------------------
// Souris réelle, côté extension : séquences CDP Input.dispatchMouseEvent (événements isTrusted) sur l'onglet visé,
// sans jamais le mettre au premier plan. Repli JavaScript signalé si le débogueur est indisponible.
// -----------------------------------------------------------------------------
const MOUSE_KIT_SOURCE = agyMouseKit.toString();
const TEXT_KIT_SOURCE = agyTextKit.toString();
const LOCATOR_KIT_SOURCE = agyLocatorKit.toString();
// Moteur de localisation aussi utilisé côté extension (motifs, comparaison des noms renvoyés par l'arbre AX).
const LK = agyLocatorKit();
const MOUSE_BUTTON_MASK = { none: 0, left: 1, right: 2, middle: 4 };
// Événement de confiance qui prouve l'effet d'un clic, selon le bouton.
const MOUSE_PROOF_EVENT = { left: "click", right: "contextmenu", middle: "auxclick" };
const MOUSE_COMMAND_TIMEOUT_MS = 10000;
const MOUSE_RETRY_MS = 60;
// Fin du message d'un geste refusé avant tout événement (lue par le serveur MCP : accord rendu, geste non parti).
const NOTHING_SENT = "Nothing was sent.";

/**
 * Attente interrompue par l'arrêt d'urgence (frappe, glisser, attentes de chargement, de réseau, de téléchargement) :
 * lève l'erreur d'arrêt avant, pendant (réveil immédiat) et après.
 */
function sleepMs(ms) {
    assertNotStopped();
    return new Promise((resolve, reject) => {
        let timer = null;
        const wake = () => {
            clearTimeout(timer);
            stopWaiters.delete(wake);
            try { assertNotStopped(); resolve(); } catch (error) { reject(error); }
        };
        stopWaiters.add(wake);
        timer = setTimeout(wake, ms);
    });
}

async function withTimeout(promise, ms, message) {
    let timer;
    const guard = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
    try {
        return await Promise.race([promise, guard]);
    } finally {
        clearTimeout(timer);
    }
}

function mouseTimeout(params, fallback) {
    const raw = params.timeoutMs !== undefined ? params.timeoutMs : params.timeout;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function mouseButton(params) {
    const button = String(params.button || "left").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(MOUSE_PROOF_EVENT, button)) {
        throw new Error(`Unknown mouse button '${params.button}' (left, right or middle)`);
    }
    return button;
}

function mouseClickCount(params) {
    const raw = params.clickCount !== undefined ? params.clickCount
        : (params.click_count !== undefined ? params.click_count : (params.double ? 2 : 1));
    const count = parseInt(raw, 10);
    if (count !== 1 && count !== 2) throw new Error("click_count must be 1 (single click) or 2 (double click)");
    return count;
}

function mouseProbeTypes(kind, button, clickCount) {
    if (kind === "hover") return ["mouseover", "mousemove"];
    if (button === "right") return ["contextmenu", "auxclick"];
    if (button === "middle") return ["auxclick"];
    return clickCount === 2 ? ["click", "dblclick"] : ["click"];
}

/**
 * Séquence d'un clic réel : déplacement, puis une paire pressed/released par clic (clickCount 1 puis 2).
 */
function mouseClickSequence(x, y, button = "left", clickCount = 1) {
    const mask = MOUSE_BUTTON_MASK[button] || 1;
    const sequence = [{ type: "mouseMoved", x, y, button: "none", buttons: 0 }];
    for (let n = 1; n <= clickCount; n++) {
        sequence.push({ type: "mousePressed", x, y, button, buttons: mask, clickCount: n });
        sequence.push({ type: "mouseReleased", x, y, button, buttons: 0, clickCount: n });
    }
    return sequence;
}

/**
 * Séquence d'un glisser réel : bouton gauche enfoncé au départ, déplacements intermédiaires (buttons: 1), relâché à l'arrivée.
 */
function mouseDragSequence(from, to, steps) {
    const round = (v) => Math.round(v * 100) / 100;
    const sequence = [
        { type: "mouseMoved", x: from.x, y: from.y, button: "none", buttons: 0 },
        { type: "mousePressed", x: from.x, y: from.y, button: "left", buttons: 1, clickCount: 1 }
    ];
    for (let i = 1; i <= steps; i++) {
        sequence.push({
            type: "mouseMoved",
            x: round(from.x + (to.x - from.x) * (i / steps)),
            y: round(from.y + (to.y - from.y) * (i / steps)),
            button: "left",
            buttons: 1
        });
    }
    sequence.push({ type: "mouseReleased", x: to.x, y: to.y, button: "left", buttons: 0, clickCount: 1 });
    return sequence;
}

function mousePageError(details) {
    const error = new Error(details?.exception?.description || details?.text || "Page script error (mouse)");
    error.pageError = true;
    return error;
}

/**
 * Exécute une phase de agyMouseKit par CDP dans le monde isolé « nexus-browser » du cadre (contextId obligatoire :
 * jamais le monde de la page, qui pourrait remplacer les marqueurs, les sondes ou le registre AX). Renvoie la valeur,
 * ou { __dialog } si une boîte s'ouvre.
 */
async function mousePageCall(target, spec, contextId) {
    if (!contextId) throw new Error("No isolated world: no script run in the page world.");
    const expression = `(${MOUSE_KIT_SOURCE})(${JSON.stringify(spec)}, (${TEXT_KIT_SOURCE})(false), (${LOCATOR_KIT_SOURCE})())`;
    const commandParams = { expression, returnByValue: true, awaitPromise: false, contextId };
    const result = await sendCommandWatchingDialogs(target, "Runtime.evaluate", commandParams);
    if (result?.__dialog) return result;
    if (result?.exceptionDetails) throw mousePageError(result.exceptionDetails);
    return result?.result?.value;
}

/**
 * Débogueur absent ou inutilisable (onglet protégé, autre débogueur, onglet détaché) : repli JavaScript permis.
 */
function isDebuggerUnavailable(error) {
    if (!error || error.pageError) return false;
    const message = String(error.message || error);
    return /debugger|attach|detached|cannot be debugged|Protected internal URL|Cannot access|No tab with id|target closed/i.test(message);
}

async function dispatchMouse(target, params) {
    assertNotStopped();
    const call = sendCommandWatchingDialogs(target, "Input.dispatchMouseEvent", params);
    call.catch(() => {});
    return await withTimeout(call, MOUSE_COMMAND_TIMEOUT_MS,
        `Input.dispatchMouseEvent ${params.type}: no response after ${MOUSE_COMMAND_TIMEOUT_MS} ms`);
}

/**
 * Envoie la séquence ; s'arrête dès qu'une boîte de dialogue s'ouvre. Un bouton enfoncé est toujours relâché
 * (le relâchement part dès que la page est débloquée).
 */
// Onglets dont la page se croit active (Emulation.setFocusEmulationEnabled) pour la session de débogage en cours.
// Clés `${tabId}|${sessionId}` : session principale, et sessions des iframes hors processus où l'agent agit.
const focusEmulatedTabs = new Set();

function forgetFocusEmulation(tabId) {
    for (const key of [...focusEmulatedTabs]) if (key.startsWith(`${tabId}|`)) focusEmulatedTabs.delete(key);
}
const FOCUS_EMULATION_SETTLE_MS = 150;
// Iframe hors processus : son propre processus de rendu prend l'émulation plus tard (mesuré le 15/10 : premier clic
// perdu après 150 ms, la frappe suivante dans le même cadre reçue).
const FOCUS_EMULATION_CHILD_SETTLE_MS = 600;
const FOCUS_EMULATION_MAX_WAIT_MS = 1000;

/** La page principale se croit-elle active ? (document.hasFocus, relu depuis le monde isolé : la page ne peut pas
 * remplacer la fonction pour fausser l'attente) */
async function pageHasFocus(target) {
    try {
        const contextId = await rootContextId(rootOf(target));
        const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
            expression: "document.hasFocus()", returnByValue: true, contextId
        });
        return res?.result?.value === true;
    } catch (_) {
        return null;
    }
}

/**
 * Page d'un onglet en arrière-plan : Chrome y ignore les appuis de souris CDP tant qu'elle ne se croit pas active
 * (mesuré le 15/10 sur le vrai Chrome : page HTTP, mouseMoved reçu mais mousePressed/Released perdus, aucun
 * pointerdown ; émulation du focus activée → clic de confiance reçu). Elle rend aussi la page visible (rendu et
 * chargement paresseux repris). Activée seulement avant une action de souris, de clavier ou un défilement, jamais sur
 * une simple lecture ; levée par Chrome au détachement du débogueur.
 */
async function ensureFocusEmulation(target) {
    if (!target?.tabId || focusEmulatedTabs.has(sessionKey(target))) return;
    try {
        await chrome.debugger.sendCommand(target, "Emulation.setFocusEmulationEnabled", { enabled: true });
        focusEmulatedTabs.add(sessionKey(target));
        // Prise d'effet asynchrone (mesuré : le tout premier clic juste après l'activation était perdu, les suivants
        // arrivaient) ; une seule fois par session de débogage. Page principale : on attend qu'elle se dise active
        // (au plus 1 s) ; iframe hors processus : délai mesuré, son document n'a pas le focus de toute façon.
        if (target.sessionId) {
            await sleepMs(FOCUS_EMULATION_CHILD_SETTLE_MS);
        } else {
            const deadline = Date.now() + FOCUS_EMULATION_MAX_WAIT_MS;
            await sleepMs(30);
            while ((await pageHasFocus(target)) === false && Date.now() < deadline) await sleepMs(30);
            await sleepMs(FOCUS_EMULATION_SETTLE_MS);
        }
    } catch (_) {
        // Domaine indisponible : la séquence part quand même, la sonde de confiance dira si le clic est arrivé.
    }
}

async function runMouseSequence(target, sequence, moveDelayMs = 0) {
    await ensureFocusEmulation(target);
    let pressed = null;
    const release = () => {
        if (!pressed) return;
        const releaseEvent = { ...pressed, type: "mouseReleased", buttons: 0 };
        pressed = null;
        try {
            const pending = chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", releaseEvent);
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch (_) {}
    };
    for (let i = 0; i < sequence.length; i++) {
        const event = sequence[i];
        let result;
        try {
            result = await dispatchMouse(target, event);
        } catch (error) {
            if (event.type === "mousePressed") pressed = event;
            release();
            throw error;
        }
        if (event.type === "mousePressed") pressed = event;
        else if (event.type === "mouseReleased") pressed = null;
        if (result?.__dialog) {
            release();
            return { dialog: result.__dialog, sent: i + 1 };
        }
        if (moveDelayMs > 0 && pressed && event.type === "mouseMoved") await sleepMs(moveDelayMs);
    }
    return { dialog: null, sent: sequence.length };
}

// -----------------------------------------------------------------------------
// Cadres : le cadre principal, plus un « contexte racine » par cadre d'une autre origine que son parent (iframe
// cross-origin du même processus : monde isolé dans la session principale ; iframe hors processus (OOPIF) : session
// enfant obtenue par Target.setAutoAttach flatten, adressée par sessionId depuis Chrome 125). Les cadres same-origin
// sont parcourus par le script de page de leur contexte racine.
// -----------------------------------------------------------------------------
// tabId -> Map(sessionId -> { sessionId, targetId, type, url, parentSessionId, parentFrameId })
const childSessions = new Map();
// `${tabId}|${sessionId}|${frameId}` -> executionContextId du monde isolé « nexus-browser »
const isolatedWorlds = new Map();
// tabId -> Map(mark -> clé du contexte racine) pour les marqueurs posés dans un cadre d'une autre origine
const markRoots = new Map();
// tabId -> true (sessions enfants actives) ou message d'erreur (Target.setAutoAttach refusé)
const crossOriginSupport = new Map();
const domEnabledSessions = new Set();
// tabId -> horodatage de la dernière action (clic, saisie, touche) : point de départ de wait_download
const lastActionAt = new Map();
const FRAME_WORLD_NAME = "nexus-browser";
let axTokenSeq = 0;
// `${tabId}|${frameId}|${loaderId}` -> document du cadre lisible par le script de son parent (même origine)
const frameReach = new Map();
// Contextes racines où Accessibility.queryAXTree a échoué ou n'a pas répondu (moteur DOM ensuite).
const axUnavailable = new Set();
const AX_QUERY_TIMEOUT_MS = 1500;

function sessionKey(target) {
    return `${target.tabId}|${target.sessionId || ""}`;
}

function originOf(url) {
    try { return new URL(url).origin; } catch (_) { return String(url || ""); }
}

function rootOf(where) {
    return where && where.target ? where : { key: "top", label: "top", target: where, contextId: null, parent: null };
}

/**
 * Session enfant attachée (Target.attachedToTarget) : réseau suivi, auto-attachement des cadres plus profonds
 * (non récursif côté Chrome : à redemander à chaque niveau).
 */
function trackChildSession(source, params) {
    const tabId = source.tabId;
    const info = params?.targetInfo || {};
    if (!params?.sessionId) return;
    if (!childSessions.has(tabId)) childSessions.set(tabId, new Map());
    childSessions.get(tabId).set(params.sessionId, {
        sessionId: params.sessionId,
        targetId: info.targetId,
        type: info.type,
        url: info.url,
        parentSessionId: source.sessionId || null,
        parentFrameId: info.parentFrameId || null
    });
    if (info.type !== "iframe") return;
    const child = { tabId, sessionId: params.sessionId };
    for (const [method, commandParams] of [
        ["Page.enable", {}],
        ["Network.enable", {}],
        ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }]
    ]) {
        try {
            const pending = chrome.debugger.sendCommand(child, method, commandParams);
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch (_) {}
    }
}

function forgetChildSession(tabId, sessionId) {
    const sessions = childSessions.get(tabId);
    if (sessions) sessions.delete(sessionId);
    const prefix = `${tabId}|${sessionId}|`;
    for (const key of [...isolatedWorlds.keys()]) if (key.startsWith(prefix)) isolatedWorlds.delete(key);
    domEnabledSessions.delete(`${tabId}|${sessionId}`);
    focusEmulatedTabs.delete(`${tabId}|${sessionId}`);
    mainFrames.delete(`${tabId}|${sessionId}`);
}

function forgetTabFrames(tabId) {
    childSessions.delete(tabId);
    for (const key of [...mainFrames.keys()]) if (key.startsWith(`${tabId}|`)) mainFrames.delete(key);
    for (const key of [...axUnavailable]) if (key.includes(`|${tabId}|`)) axUnavailable.delete(key);
    for (const key of [...frameReach.keys()]) if (key.startsWith(`${tabId}|`)) frameReach.delete(key);
    markRoots.delete(tabId);
    crossOriginSupport.delete(tabId);
    const prefix = `${tabId}|`;
    for (const key of [...isolatedWorlds.keys()]) if (key.startsWith(prefix)) isolatedWorlds.delete(key);
    for (const key of [...domEnabledSessions]) if (key.startsWith(prefix)) domEnabledSessions.delete(key);
}

/**
 * Contextes racines de l'onglet : [top, puis cadres d'une autre origine (même processus, puis hors processus)].
 */
async function listFrameRoots(target) {
    const tabId = target.tabId;
    const top = { key: "top", label: "top", target, contextId: null, frameId: null, sessionId: null, parent: null, origin: null };
    const roots = [top];
    const sessions = [{ target, sessionId: null, info: null }];
    for (const [sid, info] of childSessions.get(tabId) || []) {
        if (info.type === "iframe") sessions.push({ target: { tabId, sessionId: sid }, sessionId: sid, info });
    }
    const oopifFrameIds = new Set(sessions.filter(s => s.info).map(s => s.info.targetId));
    const coveredBy = new Map();  // frameId -> contexte racine qui le parcourt
    const sessionRoot = new Map();
    for (const s of sessions) {
        let tree = null;
        try { tree = (await chrome.debugger.sendCommand(s.target, "Page.getFrameTree"))?.frameTree; } catch (_) {}
        if (!tree?.frame) continue;
        const walk = async (node, parentOrigin, parentRoot, isSessionRoot) => {
            const f = node.frame || {};
            const origin = f.securityOrigin || originOf(f.url);
            let root = parentRoot;
            if (isSessionRoot) {
                if (!s.sessionId) {
                    top.frameId = f.id;
                    top.origin = origin;
                    root = top;
                } else {
                    root = {
                        key: `${s.sessionId}:${f.id}`, label: `${origin} (out-of-process iframe)`, target: s.target,
                        contextId: null, frameId: f.id, sessionId: s.sessionId, origin, url: f.url, oopif: true,
                        ownerTarget: s.info.parentSessionId ? { tabId, sessionId: s.info.parentSessionId } : target,
                        parentFrameId: s.info.parentFrameId, parentSessionId: s.info.parentSessionId
                    };
                    roots.push(root);
                }
                sessionRoot.set(s.sessionId || "", root);
            } else if (origin !== parentOrigin && !oopifFrameIds.has(f.id) && !(await frameReachable(s.target, f))) {
                root = {
                    key: `${s.sessionId || "main"}:${f.id}`, label: `${origin} (cross-origin iframe)`, target: s.target,
                    contextId: null, frameId: f.id, sessionId: s.sessionId, origin, url: f.url, oopif: false,
                    ownerTarget: s.target, parentFrameId: f.parentId || null
                };
                roots.push(root);
            }
            coveredBy.set(f.id, root);
            for (const c of node.childFrames || []) await walk(c, origin, root, false);
        };
        await walk(tree, null, null, true);
    }
    for (const root of roots) {
        if (root === top) continue;
        root.parent = (root.parentFrameId && coveredBy.get(root.parentFrameId))
            || (root.oopif ? sessionRoot.get(root.parentSessionId || "") : null)
            || top;
        if (root.parent === root) root.parent = top;
    }
    return roots;
}

/**
 * Cadre du même processus dont l'origine annoncée diffère de celle du parent : vraiment inaccessible au script du
 * parent ? (mesuré : un iframe srcdoc same-origin est annoncé avec l'origine "://"). Le <iframe> propriétaire est
 * interrogé (contentDocument lisible = cadre déjà parcouru par son parent) ; résultat gardé par document chargé.
 */
async function frameReachable(target, frame) {
    const key = `${target.tabId}|${frame.id}|${frame.loaderId || ""}`;
    if (frameReach.has(key)) return frameReach.get(key);
    let reachable = false;
    try {
        await ensureDomAgent(target);
        const owner = await chrome.debugger.sendCommand(target, "DOM.getFrameOwner", { frameId: frame.id });
        // Lu depuis le monde isolé du cadre parent : la page ne peut pas fausser contentDocument.
        const resolved = owner?.backendNodeId
            ? await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
                backendNodeId: owner.backendNodeId,
                executionContextId: await worldFor(target, frame.parentId || await mainFrameId(target))
            }) : null;
        const objectId = resolved?.object?.objectId;
        if (objectId) {
            const res = await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: "function () { try { return !!(this.contentDocument && this.contentDocument.documentElement); } catch (_) { return false; } }",
                returnByValue: true
            });
            reachable = res?.result?.value === true;
            const pending = chrome.debugger.sendCommand(target, "Runtime.releaseObject", { objectId });
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
        }
    } catch (_) {
        reachable = false;
    }
    if (frameReach.size > 500) frameReach.clear();
    frameReach.set(key, reachable);
    return reachable;
}

async function ensureDomAgent(target) {
    const key = sessionKey(target);
    if (domEnabledSessions.has(key)) return;
    try { await chrome.debugger.sendCommand(target, "DOM.enable"); } catch (_) {}
    domEnabledSessions.add(key);
}

// `${tabId}|${sessionId}` -> identifiant du cadre principal de la session (Page.getFrameTree)
const mainFrames = new Map();

async function mainFrameId(target, refresh = false) {
    const key = sessionKey(target);
    if (!refresh && mainFrames.has(key)) return mainFrames.get(key);
    const tree = (await chrome.debugger.sendCommand(target, "Page.getFrameTree"))?.frameTree;
    const frameId = tree?.frame?.id;
    if (!frameId) throw new Error("Main frame not found (Page.getFrameTree): no script run.");
    mainFrames.set(key, frameId);
    return frameId;
}

/**
 * Monde isolé « nexus-browser » d'un cadre de la session target (créé une fois, recréé si le cadre a navigué). Même
 * séparation que les scripts de contenu : DOM partagé, variables et objets JavaScript invisibles pour la page.
 */
async function worldFor(target, frameId, refresh = false, label = null) {
    const key = `${target.tabId}|${target.sessionId || ""}|${frameId}`;
    if (!refresh && isolatedWorlds.has(key)) return isolatedWorlds.get(key);
    const res = await chrome.debugger.sendCommand(target, "Page.createIsolatedWorld", {
        frameId, worldName: FRAME_WORLD_NAME, grantUniveralAccess: false
    });
    if (!res?.executionContextId) throw new Error(`Isolated world unavailable for frame ${label || frameId}`);
    isolatedWorlds.set(key, res.executionContextId);
    return res.executionContextId;
}

/**
 * Monde isolé du cadre d'un contexte racine : cadre principal compris (plus aucun script de l'extension dans le monde
 * de la page, sauf browser_eval et la transcription YouTube, qui lisent la page elle-même).
 */
async function rootContextId(root, refresh = false) {
    if (!root?.target) throw new Error("Unknown root context");
    const frameId = root.key === "top" ? (root.frameId || await mainFrameId(root.target, refresh)) : root.frameId;
    return await worldFor(root.target, frameId, refresh, root.label);
}

function isContextLost(error) {
    return !error?.pageError && /context|Execution context|frame/i.test(String(error?.message || error));
}

/**
 * Phase du kit de page dans un contexte racine, toujours dans le monde isolé de son cadre.
 */
async function pageCall(where, spec) {
    const root = rootOf(where);
    for (let attempt = 0; ; attempt++) {
        const contextId = await rootContextId(root, attempt > 0);
        try {
            return await mousePageCall(root.target, spec, contextId);
        } catch (error) {
            if (attempt === 0 && isContextLost(error)) continue;
            throw error;
        }
    }
}

/**
 * Phase du kit exécutée sur l'élément <iframe> propriétaire du cadre du contexte racine (dans le cadre parent).
 */
async function ownerCall(root, spec) {
    const ownerTarget = root.ownerTarget || root.target;
    await ensureDomAgent(ownerTarget);
    const owner = await chrome.debugger.sendCommand(ownerTarget, "DOM.getFrameOwner", { frameId: root.frameId });
    if (!owner?.backendNodeId) throw new Error(`Owner <iframe> element not found for frame ${root.label}`);
    // <iframe> propriétaire résolu dans le monde isolé de SON cadre (jamais le monde de la page parente).
    const parentContext = root.parent && sessionKey(root.parent.target) === sessionKey(ownerTarget)
        ? await rootContextId(root.parent)
        : await worldFor(ownerTarget, root.parentFrameId || await mainFrameId(ownerTarget));
    const resolveParams = { backendNodeId: owner.backendNodeId, executionContextId: parentContext };
    const resolved = await chrome.debugger.sendCommand(ownerTarget, "DOM.resolveNode", resolveParams);
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error(`Owner <iframe> element not resolved for frame ${root.label}`);
    try {
        const result = await sendCommandWatchingDialogs(ownerTarget, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: `function (spec) { spec.__owner = this; return (${MOUSE_KIT_SOURCE})(spec, (${TEXT_KIT_SOURCE})(false), (${LOCATOR_KIT_SOURCE})()); }`,
            arguments: [{ value: spec }],
            returnByValue: true
        });
        if (result?.__dialog) return result;
        if (result?.exceptionDetails) throw mousePageError(result.exceptionDetails);
        return result?.result?.value;
    } finally {
        try {
            const pending = chrome.debugger.sendCommand(ownerTarget, "Runtime.releaseObject", { objectId });
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
        } catch (_) {}
    }
}

/**
 * Points locaux d'un contexte racine -> repère du viewport principal, en franchissant chaque <iframe> propriétaire
 * (bordure et marge intérieure comprises). check=true : chaque cadre parent doit être atteint au point (pas couvert).
 */
async function projectToTop(root, points, check = true) {
    let pts = points;
    let depth = 0;
    for (let cur = root, guard = 0; cur && cur.key !== "top" && guard < 16; cur = cur.parent, guard++) {
        const res = await ownerCall(cur, { phase: "hop", points: pts, check });
        if (res?.__dialog) return res;
        if (!res?.ok) return { ok: false, coveredBy: res?.coveredBy || null, reason: res?.reason || null, frame: cur.label };
        pts = res.points;
        depth += 1 + (res.depth || 0);
    }
    return { ok: true, points: pts, depth };
}

async function revealRoot(root) {
    for (let cur = root, guard = 0; cur && cur.key !== "top" && guard < 16; cur = cur.parent, guard++) {
        const res = await ownerCall(cur, { phase: "reveal" });
        if (res?.__dialog) return res;
    }
    return null;
}

function frameLabelOf(root, local) {
    if (!root || root.key === "top") return local || "top";
    return local ? `${root.label} > ${local}` : root.label;
}

/**
 * Accessibility.queryAXTree (rôle et nom calculés par Chrome) : les éléments trouvés sont rangés dans le contexte
 * racine sous un jeton ; le kit de page les filtre ensuite (visibilité, états). null : moteur DOM.
 */
async function axRegister(root, locator) {
    if (!locator?.role || locator.text || String(locator.engine || "auto").toLowerCase() === "dom") return null;
    // Cadre principal seulement : mesuré sur Chromium 155, la requête sur le document d'un cadre d'une autre
    // origine ne répond pas (même processus) ou ne renvoie rien (hors processus) ; ces cadres passent par le DOM.
    if (root.key !== "top") return null;
    try {
        await ensureDomAgent(root.target);
        // Registre AX rangé dans le monde isolé : la page ne peut ni le lire ni y glisser ses propres éléments.
        const contextId = await rootContextId(root);
        const docParams = { expression: "document", returnByValue: false, contextId };
        const docObj = await chrome.debugger.sendCommand(root.target, "Runtime.evaluate", docParams);
        const docId = docObj?.result?.objectId;
        if (!docId) return null;
        const described = await chrome.debugger.sendCommand(root.target, "DOM.describeNode", { objectId: docId });
        const backendNodeId = described?.node?.backendNodeId;
        if (!backendNodeId) return null;
        if (axUnavailable.has(root.key + "|" + sessionKey(root.target))) return null;
        let ax;
        let fullTree = false;
        try {
            // Chromium 155 : queryAXTree peut attendre son délai même sur le document principal
            // avec des iframes. L'arbre AX déjà calculé répond immédiatement, noms calculés compris.
            try {
                ax = await withTimeout(chrome.debugger.sendCommand(root.target, "Accessibility.getFullAXTree", {
                    ...(root.frameId ? { frameId: root.frameId } : {})
                }), AX_QUERY_TIMEOUT_MS, "Accessibility.getFullAXTree: no response");
                if (!Array.isArray(ax?.nodes)) throw new Error("Accessibility tree unavailable");
                fullTree = true;
            } catch (_) {
                ax = await withTimeout(chrome.debugger.sendCommand(root.target, "Accessibility.queryAXTree", {
                    backendNodeId, role: String(locator.role).toLowerCase()
                }), AX_QUERY_TIMEOUT_MS, "Accessibility.queryAXTree: no response");
            }
        } catch (error) {
            axUnavailable.add(root.key + "|" + sessionKey(root.target));
            return null;
        }
        if (!Array.isArray(ax?.nodes)) return null;
        const namePat = locator.name !== undefined && locator.name !== null && locator.name !== "" ? LK.pattern(locator.name, !!locator.exact) : null;
        const hits = ax.nodes.filter(n => n.backendDOMNodeId && (!n.ignored || locator.includeHidden)
            && (!fullTree || String(n.role?.value || "").toLowerCase() === String(locator.role).toLowerCase())
            && (!namePat || LK.matches(n.name?.value || "", namePat))).slice(0, 50);
        if (!hits.length) return null;
        const token = `ax${++axTokenSeq}`;
        let registered = 0;
        for (const n of hits) {
            try {
                const resolveParams = { backendNodeId: n.backendDOMNodeId, executionContextId: contextId };
                const obj = await chrome.debugger.sendCommand(root.target, "DOM.resolveNode", resolveParams);
                const objectId = obj?.object?.objectId;
                if (!objectId) continue;
                await chrome.debugger.sendCommand(root.target, "Runtime.callFunctionOn", {
                    objectId,
                    functionDeclaration: `function (token, role, name) {
                        let w = this.ownerDocument && this.ownerDocument.defaultView;
                        for (let i = 0; w && i < 32; i++) {
                            let fe = null;
                            try { fe = w.frameElement; } catch (_) {}
                            if (!fe || !fe.ownerDocument) break;
                            w = fe.ownerDocument.defaultView;
                        }
                        if (!w) return false;
                        const reg = w.__nexusBrowserAx && typeof w.__nexusBrowserAx === "object" ? w.__nexusBrowserAx : (w.__nexusBrowserAx = {});
                        if (!reg[token]) { for (const k of Object.keys(reg)) delete reg[k]; reg[token] = []; }
                        reg[token].push({ el: this, role, name });
                        return true;
                    }`,
                    arguments: [{ value: token }, { value: String(locator.role).toLowerCase() }, { value: n.name?.value || "" }],
                    returnByValue: true
                });
                registered++;
                const pending = chrome.debugger.sendCommand(root.target, "Runtime.releaseObject", { objectId });
                if (pending && typeof pending.catch === "function") pending.catch(() => {});
            } catch (_) {}
        }
        return registered ? token : null;
    } catch (_) {
        return null;  // domaine indisponible : moteur DOM
    }
}

/**
 * Candidats d'un localisateur dans tous les contextes racines (cadre principal puis cadres d'autres origines).
 */
async function findAcrossRoots(target, locator, options = {}) {
    const roots = options.roots || await listFrameRoots(target);
    const perRoot = [];
    let total = 0;
    let hidden = 0;
    const engines = new Set();
    for (const root of roots) {
        let res;
        let axToken = null;
        try {
            axToken = await axRegister(root, locator);
            res = await pageCall(root, { phase: "find", locator, axToken, limit: options.limit || 20 });
        } catch (error) {
            if (root.key === "top") throw error;
            continue;  // cadre disparu ou inaccessible pendant la recherche
        }
        if (res?.__dialog) return { dialog: res.__dialog };
        if (res?.invalid) return { invalid: true, error: res.error };
        if (!res || res.error || typeof res.count !== "number") continue;
        engines.add(axToken ? "ax" : "dom");
        for (const c of res.candidates || []) c.frame = frameLabelOf(root, c.frame);
        perRoot.push({ root, axToken, count: res.count, candidates: res.candidates || [], viewport: res.viewport });
        total += res.count;
        hidden += res.hidden || 0;
    }
    return { roots, perRoot, total, hidden, engine: [...engines].join("+") || "dom" };
}

function describeCandidate(c, index) {
    const id = c.id ? `#${c.id}` : "";
    return `[${index}] ${c.role || c.tag} "${String(c.name || "").slice(0, 60)}" <${c.tag}${id}> frame ${c.frame || "top"}`;
}

function ambiguityError(locator, total, candidates) {
    const list = candidates.slice(0, 10).map((c, i) => describeCandidate(c, i)).join("; ");
    return `Ambiguous locator ${JSON.stringify(locator)}: ${total} elements match (add exact:true, nth or one more criterion): ${list}`;
}

function notFoundError(locator, hidden) {
    const extra = hidden ? ` (${hidden} hidden match(es) ignored: includeHidden:true to see them)` : "";
    return `No element matches the locator ${JSON.stringify(locator)}${extra}`;
}

/**
 * Message d'erreur d'un échec de préparation (introuvable, ambigu, couvert...).
 */
function prepareError(prep, locate) {
    if (!prep) return "Element not found";
    if (prep.ambiguous && Array.isArray(prep.candidates)) {
        return ambiguityError(locate?.locator, prep.count, prep.candidates);
    }
    return prep.error || "Element not found";
}

/**
 * Prépare l'action dans un contexte racine : localise, fait défiler, choisit un point atteignable, puis le ramène au
 * viewport principal (cadres d'une autre origine : <iframe> propriétaires amenés dans la vue et non couverts).
 */
async function prepareInRoot(root, locate, options) {
    const spec = {
        phase: "prepare", locate, scroll: options.scroll || "center", probe: options.probe || null,
        allowUnreachable: !!options.allowUnreachable, allPoints: root.key !== "top", forEdit: !!options.forEdit,
        passThrough: !!options.passThrough
    };
    const prep = await pageCall(root, spec);
    if (prep?.__dialog || !prep?.success) return prep;
    prep.root = root;
    prep.locate = locate;
    prep.frame = frameLabelOf(root, "");
    if (root.key === "top" || !prep.point) return prep;
    const revealed = await revealRoot(root);
    if (revealed?.__dialog) return revealed;
    const proj = await projectToTop(root, prep.points && prep.points.length ? prep.points : [prep.point], true);
    if (proj?.__dialog) return proj;
    if (!proj.ok) {
        const reason = proj.coveredBy
            ? `frame ${proj.frame} is covered by <${proj.coveredBy}>`
            : `frame ${proj.frame} is not reachable (${proj.reason || "outside the viewport"})`;
        const error = `<${String(prep.tagName || "element").toLowerCase()}> in ${root.label}: ${reason}: no mouse action sent.`;
        if (options.allowUnreachable) return { ...prep, point: null, unreachable: error };
        await releaseMouseProbes(root, [prep.probeId], prep.layers);
        return { notReachable: true, error };
    }
    // Iframe hors processus : son moteur de rendu doit aussi se croire actif (focus clavier dans le cadre).
    if (root.sessionId) await ensureFocusEmulation(root.target);
    prep.localPoint = prep.point;
    prep.point = proj.points[0];
    prep.frameDepth = (prep.frameDepth || 0) + proj.depth;
    return prep;
}

/**
 * Une tentative de localisation dans tous les contextes : localisateur (strict sur l'ensemble des cadres), marqueur
 * (contexte où il a été posé), sinon cadre principal d'abord puis cadres d'autres origines.
 */
async function prepareOnce(target, locate, options) {
    return await locateAndRun(target, locate, (root, loc) => prepareInRoot(root, loc, options));
}

/**
 * Trouve le contexte racine de la cible puis y exécute run(root, locateEffectif) : localisateur strict sur l'ensemble
 * des cadres (nth global), marqueur dans le contexte où il a été posé, sinon cadre principal puis autres cadres.
 */
async function locateAndRun(target, locate, run) {
    const roots = await listFrameRoots(target);
    const top = roots[0];
    if (locate.locator) {
        const found = await findAcrossRoots(target, locate.locator, { roots, limit: 10 });
        if (found.dialog) return { __dialog: found.dialog };
        if (found.invalid) return { invalid: true, error: found.error };
        if (found.total === 0) return { notFound: true, error: notFoundError(locate.locator, found.hidden) };
        const nth = locate.locator.nth;
        if ((nth === undefined || nth === null) && found.total > 1) {
            const candidates = found.perRoot.flatMap(p => p.candidates);
            return { ambiguous: true, error: ambiguityError(locate.locator, found.total, candidates) };
        }
        let index = nth === undefined || nth === null ? 0 : parseInt(nth, 10);
        if (!Number.isInteger(index)) return { invalid: true, error: `Invalid nth: ${nth}` };
        if (index < 0) index += found.total;
        if (index < 0 || index >= found.total) {
            return { notFound: true, error: `nth=${nth} out of range: ${found.total} element(s) match the locator ${JSON.stringify(locate.locator)}` };
        }
        for (const part of found.perRoot) {
            if (index < part.count) {
                return await run(part.root, { locator: locate.locator, pick: index, axToken: part.axToken });
            }
            index -= part.count;
        }
        return { notFound: true, error: notFoundError(locate.locator, found.hidden) };
    }
    if (locate.mark !== undefined && locate.mark !== null) {
        const key = markRoots.get(target.tabId)?.get(Number(locate.mark));
        const root = key ? roots.find(r => r.key === key) : top;
        if (!root) return { notFound: true, error: `The frame of mark #${locate.mark} is gone: run browser_interactive_map again.` };
        return await run(root, locate);
    }
    let first = null;
    for (const root of roots) {
        let prep;
        try {
            prep = await run(root, locate);
        } catch (error) {
            if (root.key === "top") throw error;
            continue;
        }
        if (prep?.__dialog) return prep;
        // Élément actif : dans le cadre principal, un <iframe> focalisé renvoie au cadre qui a vraiment le focus.
        if (locate.active && prep?.success && String(prep.tagName || "").toUpperCase() === "IFRAME" && roots.length > 1) {
            await releaseMouseProbes(root, [prep.probeId]);
            first = first || { notFound: true, error: "Focus is in a cross-origin frame that was not found" };
            continue;
        }
        if (prep?.success) return prep;
        if (!prep?.notFound) return prep;  // couvert, ambigu... : pas de recherche ailleurs
        first = first || prep;
    }
    return first || { notFound: true, error: "Element not found" };
}

/**
 * Localise et prépare avec attente automatique : réessaie tant que l'élément est introuvable ou couvert, jusqu'au
 * délai (un localisateur ambigu échoue tout de suite, comme Playwright).
 */
async function prepareAnywhere(target, locate, options) {
    const start = Date.now();
    for (;;) {
        const prep = await prepareOnce(target, locate, options);
        if (prep?.__dialog || prep?.success) return prep;
        if (!(prep?.notFound || prep?.notReachable) || Date.now() - start >= options.timeoutMs) return prep;
        await sleepMs(MOUSE_RETRY_MS);
    }
}

async function readMouseProbe(where, probeId, remove = true) {
    if (!probeId) return null;
    try {
        const report = await pageCall(where, { phase: "probe", probeId, remove });
        return report && !report.__dialog && !report.missing ? report : null;
    } catch (_) {
        return null;
    }
}

async function releaseMouseProbes(where, probeIds, layerIds = null) {
    const ids = probeIds.filter(Boolean);
    const layers = (layerIds || []).filter(Boolean);
    if (!ids.length && !layers.length) return;
    try { await pageCall(where, { phase: "release", probeIds: ids, layerIds: layers }); } catch (_) {}
}

// Repli sans débogueur : monde ISOLÉ de l'extension (celui des scripts de contenu), jamais le monde de la page.
async function runPageScript(tabId, func, args) {
    const [frame] = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func, args }),
        MOUSE_COMMAND_TIMEOUT_MS,
        `JavaScript injection: no response after ${MOUSE_COMMAND_TIMEOUT_MS} ms (dialog open?)`
    );
    return frame?.result;
}

/**
 * Repli sans débogueur (onglet protégé, autre débogueur attaché) : ancien chemin JavaScript, signalé comme tel.
 * Cadre principal seulement (et ses cadres same-origin).
 */
async function mouseJsFallback(tabId, spec, reason, timeoutMs) {
    if (!chrome.scripting?.executeScript) {
        throw new Error(`Debugger unavailable (${reason}) and no JavaScript fallback possible: no action.`);
    }
    const start = Date.now();
    let value;
    try {
        for (;;) {
            await runPageScript(tabId, agyTextKit, [true]);
            await runPageScript(tabId, agyLocatorKit, [true]);
            value = await runPageScript(tabId, agyMouseKit, [spec, null, null]);
            if (!value?.notFound || Date.now() - start >= timeoutMs) break;
            await sleepMs(MOUSE_RETRY_MS);
        }
    } catch (error) {
        throw new Error(`Debugger unavailable (${reason}) and JavaScript injection refused (${error.message || error}): no action.`);
    }
    if (!value) return { error: `JavaScript fallback returned no result (${reason})` };
    if (value.notFound || value.error) return { error: value.ambiguous ? ambiguityError(spec.locate?.locator, value.count, value.candidates || []) : (value.error || "Element not found") };
    if (spec.phase === "edit") return { data: { ...value, method: "js_fallback", fallback_reason: reason } };
    const proof = spec.action === "hover" ? { trusted_hover: false } : { trusted_click: false };
    return {
        data: {
            ...value,
            method: "js_fallback",
            ...proof,
            fallback_reason: reason,
            warning: "Debugger unavailable: synthetic JavaScript events (isTrusted=false), which many sites ignore. Check the effect."
        }
    };
}

/**
 * Clic ou survol réel sur l'élément décrit par locate ({selector,index} | {text} | {mark} | {locator}), dans le cadre principal ou un cadre d'une autre origine.
 */
async function performMouseAction(params, options) {
    const tabId = await resolveTargetTab(params);
    const { kind, locate, timeoutMs } = options;
    const button = kind === "hover" ? null : options.button;
    const clickCount = kind === "hover" ? 0 : options.clickCount;
    const jsSpec = {
        phase: "js",
        locate,
        action: kind === "hover" ? "hover" : (button === "right" ? "contextmenu" : "click"),
        clickCount
    };
    lastActionAt.set(tabId, Date.now());

    let target;
    try {
        target = await ensureDebugger(tabId);
    } catch (error) {
        return await mouseJsFallback(tabId, jsSpec, error.message || String(error), timeoutMs);
    }

    let prep;
    try {
        prep = await prepareAnywhere(target, locate, {
            // pointerdown en plus : prouve qu'AUCUN événement n'a atteint l'élément (condition de la relance unique).
            probe: kind === "hover" ? mouseProbeTypes(kind, button, clickCount)
                : [...mouseProbeTypes(kind, button, clickCount), "pointerdown"],
            passThrough: true,
            timeoutMs
        });
    } catch (error) {
        if (!isDebuggerUnavailable(error)) throw error;
        attachedDebuggers.delete(tabId);
        return await mouseJsFallback(tabId, jsSpec, error.message || String(error), timeoutMs);
    }
    if (prep?.__dialog) return { data: { ...dialogInterruption(prep.__dialog), method: "cdp" } };
    // Échec avant tout événement : dit tel quel (le serveur MCP rend alors l'accord d'un geste sortant non parti).
    if (!prep?.success) return { error: `${prepareError(prep, locate)} ${NOTHING_SENT}` };
    const root = prep.root || rootOf(target);

    const { x, y } = prep.point;
    const sequence = kind === "hover"
        ? [{ type: "mouseMoved", x, y, button: "none", buttons: 0 }]
        : mouseClickSequence(x, y, button, clickCount);
    if (kind !== "hover") notifyRipple(tabId, x, y);
    let run;
    try {
        run = await runMouseSequence(target, sequence);
    } catch (error) {
        await releaseMouseProbes(root, [prep.probeId], prep.layers);
        throw error;
    } finally {
        scheduleDebuggerDetach(tabId);
    }

    const report = {
        success: true,
        method: "cdp",
        tagName: prep.tagName,
        text: prep.text,
        id: prep.id,
        coordinates: { x, y },
        frameDepth: prep.frameDepth
    };
    if (root.key !== "top") Object.assign(report, { frame: prep.frame, crossOriginFrame: true });
    if (kind !== "hover") Object.assign(report, { button, clickCount });
    if (run.dialog) {
        // La page est bloquée par la boîte : la sonde ne peut pas être relue (retirée plus tard, la couche traversée
        // rendue d'elle-même au prochain passage).
        return { data: { ...dialogInterruption(run.dialog), ...report, trusted_click: null } };
    }

    let probe = await readMouseProbe(root, prep.probeId, kind === "hover");
    if (kind !== "hover" && root.key !== "top" && root.sessionId && probe && probe.seen.length === 0) {
        // Iframe hors processus : son processus de rendu prend parfois l'émulation du focus après le premier clic
        // (mesuré le 16/10 : environ 1 premier clic sur 5 perdu). La sonde prouve qu'AUCUN événement (pas même
        // pointerdown) n'a atteint l'élément, dont le point a été vérifié : une seule relance, sans doublon possible.
        await sleepMs(FOCUS_EMULATION_CHILD_SETTLE_MS);
        try {
            run = await runMouseSequence(target, sequence);
        } finally {
            scheduleDebuggerDetach(tabId);
        }
        if (run.dialog) return { data: { ...dialogInterruption(run.dialog), ...report, trusted_click: null, resent: true } };
        report.resent = true;
        probe = await readMouseProbe(root, prep.probeId);
        await releaseMouseProbes(root, [], prep.layers);
    } else {
        await releaseMouseProbes(root, kind !== "hover" ? [prep.probeId] : [], prep.layers);
    }
    if (prep.layers) report.passed_layers = prep.layers.length;
    if (kind === "hover") {
        report.trusted_hover = probe ? probe.trusted > 0 : null;
    } else {
        report.trusted_click = probe ? probe.seen.includes(MOUSE_PROOF_EVENT[button]) : null;
        report.trusted_events = probe ? probe.seen.filter(type => type !== "pointerdown") : null;
        if (report.trusted_click === false) {
            report.warning = "No trusted event reached the element (re-rendered during the click?): check the effect.";
        } else if (report.trusted_click === null) {
            report.note = "Effect not read back: the page changed during the click (navigation?).";
        }
    }
    return { data: report };
}

// -----------------------------------------------------------------------------
// Core Actions & Helpers
// -----------------------------------------------------------------------------

function isProtectedUrl(url) {
    if (!url || url === "about:blank") return false;
    return url.startsWith("chrome://") || 
           url.startsWith("chrome-extension://") || 
           url.startsWith("devtools://") || 
           url.startsWith("edge://") || 
           (url.startsWith("about:") && url !== "about:blank");
}

// Pages que Chrome interdit à toute extension (aucun script, aucun débogueur) : pages internes et galerie du Chrome
// Web Store. Reconnues tout de suite : l'attente de chargement tournait jusqu'au délai (30 s constatés le 27/10) avant
// l'erreur brute de Chrome (« The extensions gallery cannot be scripted »).
const CHROME_PROTECTED_RAW = /cannot be scripted|cannot access a chrome|cannot access contents of url "(chrome|edge|devtools|chrome-extension)|cannot attach to this target|chrome-extension:\/\/ url of different extension/i;

function isChromeProtectedPage(url) {
    if (isProtectedUrl(url)) return true;
    try {
        const u = new URL(String(url || ""));
        const host = u.hostname.toLowerCase();
        return host === "chromewebstore.google.com" || (host === "chrome.google.com" && /^\/webstore(\/|$)/.test(u.pathname));
    } catch (_) {
        return false;
    }
}

function chromeProtectedMessage(url) {
    let where = "";
    try {
        const u = new URL(String(url));
        where = ` (${/^https?:$/.test(u.protocol) ? u.origin : `${u.protocol}//${u.host}`})`;
    } catch (_) {}
    return `Page protected by Chrome${where}: no extension may read or drive it (Chrome Web Store, chrome:// pages). ` +
        "Use NexusWindows to inspect the window or take a desktop screenshot in the background, or use the " +
        "Chrome Web Store API. Foreground interaction is only needed if the desktop action requires it.";
}

/** Erreur brute de Chrome sur une page protégée : remplacée par le message clair (sinon renvoyée telle quelle). */
function clearProtectedError(message, url = null) {
    return CHROME_PROTECTED_RAW.test(String(message || "")) ? chromeProtectedMessage(url) : message;
}

async function ensureDebugger(tabId) {
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch(e) {}
    
    if (tab && isProtectedUrl(tab.url)) {
        throw new Error(`Protected internal URL cannot be debugged: ${tab.url}`);
    }

    const target = { tabId };
    if (!attachedDebuggers.has(tabId)) {
        let resumed = false;
        try {
            await chrome.debugger.attach(target, "1.3");
        } catch (e) {
            if (!(e.message && e.message.includes("is already attached"))) {
                console.log("[CDP Attach]", e.message);
                throw new Error(`CDP attach error: ${e.message}`);
            }
            // Déjà attaché par CETTE extension avant un redémarrage du service worker : session reprise (domaines,
            // réseau et suivi des iframes relancés), sinon les cadres hors processus seraient perdus.
            resumed = true;
        }
        attachedDebuggers.add(tabId);
        try {
            await setupDebuggerSession(target, resumed);
        } catch (error) {
            attachedDebuggers.delete(tabId);
            throw new Error(`CDP attach error: ${error.message || error}`);
        }
    }
    scheduleDebuggerDetach(tabId);
    return target;
}

/**
 * Domaines CDP d'une session (nouvelle ou reprise) : page, exécution, console, réseau dès l'attachement, et
 * auto-attachement à plat des iframes hors processus (Chrome 125+). Reprise : auto-attachement coupé puis remis,
 * pour que Chrome annonce de nouveau les cadres déjà ouverts (Target.attachedToTarget).
 */
async function setupDebuggerSession(target, resumed = false) {
    const tabId = target.tabId;
    resetNetworkTracking(tabId);
    await chrome.debugger.sendCommand(target, "Page.enable");
    await chrome.debugger.sendCommand(target, "Runtime.enable");
    await chrome.debugger.sendCommand(target, "Log.enable");
    // Suivi réseau dès l'attachement : wait_network_idle voit aussi les requêtes lancées avant son appel.
    await chrome.debugger.sendCommand(target, "Network.enable");
    networkLog(tabId).epoch++;
    try {
        if (resumed) {
            await chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
                autoAttach: false, waitForDebuggerOnStart: false, flatten: true
            });
            childSessions.delete(tabId);
        }
        await chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
            autoAttach: true, waitForDebuggerOnStart: false, flatten: true
        });
        crossOriginSupport.set(tabId, true);
    } catch (error) {
        crossOriginSupport.set(tabId, `Target.setAutoAttach refused: ${error.message || error}`);
    }
}

function inFlightSet(tabId) {
    let set = tabInFlightRequests.get(tabId);
    if (!(set instanceof Set)) {
        set = new Set();
        tabInFlightRequests.set(tabId, set);
    }
    return set;
}

function resetNetworkTracking(tabId) {
    tabInFlightRequests.set(tabId, new Set());
}

function clearDebuggerIdleTimer(tabId) {
    const timer = debuggerIdleTimers.get(tabId);
    if (timer !== undefined) clearTimeout(timer);
    debuggerIdleTimers.delete(tabId);
}

/**
 * (Ré)arme le détachement du débogueur après DEBUGGER_IDLE_MS sans utilisation.
 */
function scheduleDebuggerDetach(tabId) {
    clearDebuggerIdleTimer(tabId);
    debuggerIdleTimers.set(tabId, setTimeout(() => detachIdleDebugger(tabId), DEBUGGER_IDLE_MS));
}

async function detachIdleDebugger(tabId) {
    debuggerIdleTimers.delete(tabId);
    if (!attachedDebuggers.has(tabId)) return;
    // Jamais pendant une commande sur CET onglet, un téléversement, une boîte de dialogue à laquelle l'agent doit
    // répondre, ni pendant l'enregistrement réseau demandé (borné à NETWORK_RECORD_MAX_S).
    const recording = (networkRecording.get(tabId) || 0) > Date.now();
    if ((tabCommandsInFlight.get(tabId) || 0) > 0 || activeUploads.has(tabId) || pendingDialogs.has(tabId) || recording) {
        scheduleDebuggerDetach(tabId);
        return;
    }
    networkRecording.delete(tabId);
    await detachDebugger(tabId);
}

async function detachDebugger(tabId) {
    clearDebuggerIdleTimer(tabId);
    attachedDebuggers.delete(tabId);
    tabInFlightRequests.delete(tabId);
    forgetTabFrames(tabId);
    // detach() volontaire : onDetach n'est pas émis, l'émulation du focus tombe avec la session.
    forgetFocusEmulation(tabId);
    try {
        if (chrome.debugger?.detach) await chrome.debugger.detach({ tabId });
    } catch (_) {}
}

/**
 * Pilote d'un onglet tel que vu par le client qui demande (jamais l'identifiant d'un autre) : agent, à moi ou non, et
 * état : "mine", "orphan" (orphelin de mon agent, à reprendre), "other" (autre agent ou session vivante), "user".
 */
function publicOwner(tabId, client) {
    const owner = tabOwners.get(tabId);
    if (!owner) return { owner: null, mine: false, state: "user" };
    const mine = ownedBy(owner, client);
    const state = mine ? "mine" : (orphanFor(owner, client) ? "orphan" : "other");
    return { owner: ownerLabel(owner), mine, adopted: !!owner.adopted, state };
}

/**
 * Domaine seul d'une adresse (https://mail.google.com), jamais son chemin ni ses paramètres : jetons, identifiants de
 * document ou de session restent dans l'onglet. Adresse sans origine (file:, data:, about:) : son schéma seul.
 */
function tabOrigin(url) {
    if (typeof url !== "string" || !url) return null;
    try {
        const parsed = new URL(url);
        if (parsed.origin && parsed.origin !== "null") return parsed.origin;
        return parsed.host ? `${parsed.protocol}//${parsed.host}` : parsed.protocol;
    } catch (_) {
        return null;
    }
}

/**
 * Onglet tel que le client qui demande a le droit de le voir. Ses onglets (ouverts ou adoptés par lui) : titre et URL
 * complets. Ceux de Julien et des autres agents (sessions orphelines comprises) : domaine seul, titre masqué
 * (redacted) ; leur tab_id et leur domaine suffisent pour les désigner (browser_adopt_tab à la demande de Julien).
 */
function publicTab(t, client) {
    const who = publicOwner(t.id, client);
    const base = {
        id: t.id,
        index: t.index,
        windowId: t.windowId,
        active: t.active,
        pinned: t.pinned,
        groupId: t.groupId !== undefined ? t.groupId : -1
    };
    if (who.mine) return { ...base, title: t.title, url: t.url || t.pendingUrl, favIconUrl: t.favIconUrl, ...who };
    return { ...base, title: null, url: tabOrigin(t.url || t.pendingUrl), redacted: true, ...who };
}

async function listTabs(params = {}, client = null) {
    const tabs = await chrome.tabs.query({});
    return { data: tabs.map(t => publicTab(t, client)) };
}

async function getActiveTab(client = null) {
    // Lecture seule : l'onglet actif de Julien ne devient jamais l'onglet de l'agent par ce biais (domaine seul).
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true });
    return { data: tab ? publicTab(tab, client) : null };
}

/**
 * Onglet visé par une commande de page : tab_id explicite OBLIGATOIRE, et onglet du client qui la demande
 * (authorizeCommand). Trois agents partagent ce Chrome : aucun repli sur un « dernier onglet » ni sur l'onglet actif.
 */
const MISSING_TAB_MESSAGE = "No tab given: pass tab_id or open a tab with new_tab (browser_new_tab, " +
    "which returns its id); never a fallback to the user's active tab or to another agent's tab.";

// Adresses qu'un agent peut ouvrir ou visiter : jamais un fichier local (file://), une page interne de Chrome ou un
// script (javascript:), qui donneraient accès aux secrets du poste ou aux réglages du navigateur.
const NAVIGABLE_URL = /^(https?:\/\/|data:|about:blank$)/i;

function checkNavigableUrl(url) {
    const text = String(url || "").trim();
    if (!NAVIGABLE_URL.test(text)) {
        throw new Error(`URL refused: ${text.slice(0, 80)} (http, https, data: or about:blank only; never file://, chrome://, javascript:).`);
    }
    return text;
}

async function resolveTargetTab(params = {}) {
    const id = requestedTabId(params);
    if (id === null) {
        const given = params.tabId ?? params.tab_id;
        if (given !== undefined && given !== null && given !== "") throw new Error(`Invalid tab_id: ${given}`);
        throw new Error(MISSING_TAB_MESSAGE);
    }
    try {
        await chrome.tabs.get(id);
    } catch (_) {
        throw new Error(`Target tab ${id} no longer exists`);
    }
    return id;
}

// -----------------------------------------------------------------------------
// Indicateur « agent au travail » : le logo NexusBrowser tourne sur lui-même en bas à droite de l'onglet que
// l'utilisateur regarde (les agents travaillent dans des onglets de fond), comme un écran de chargement de jeu, et un
// point sur l'icône de la barre d'outils le dit aussi sur les pages internes de Chrome, où rien ne s'affiche. Dessiné
// par chrome.scripting (monde isolé) : il marche aussi dans un onglet ouvert avant une mise à jour de l'extension, dont
// le script de contenu ne reçoit plus de messages. Affiché tout de suite, retiré après un court délai sans commande.
// -----------------------------------------------------------------------------
const BUSY_LINGER_MS = 1618;
const busyAgents = new Map();  // agent → commandes en cours
let busyShownTab = null;
let busyHideTimer = null;
let busyLogo = null;  // logo en data: URL, lu une fois (aucune ressource exposée aux pages)

function busyStart(agent) {
    busyAgents.set(agent, (busyAgents.get(agent) || 0) + 1);
    if (busyHideTimer) { clearTimeout(busyHideTimer); busyHideTimer = null; }
    refreshBusyIndicator();
}

function busyEnd(agent) {
    const left = (busyAgents.get(agent) || 1) - 1;
    if (left > 0) busyAgents.set(agent, left);
    else busyAgents.delete(agent);
    if (busyAgents.size || busyHideTimer) return;
    busyHideTimer = setTimeout(() => { busyHideTimer = null; refreshBusyIndicator(); }, BUSY_LINGER_MS);
}

async function busyLogoUrl() {
    if (busyLogo) return busyLogo;
    try {
        const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL("icons/logo96.png"))).arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        busyLogo = `data:image/png;base64,${btoa(binary)}`;
    } catch (_) {
        busyLogo = "";
    }
    return busyLogo;
}

/** Exécutée DANS l'onglet (monde isolé) : autonome, sans variable extérieure. */
function drawBusyIndicator(on, logo, label) {
    const ID = "__nexus_busy";
    let host = document.getElementById(ID);
    if (!on) {
        if (host) {
            host.style.opacity = "0";
            host.style.transform = "scale(0.6)";
            setTimeout(() => { const h = document.getElementById(ID); if (h && h.style.opacity === "0") h.remove(); }, 300);
        }
        return true;
    }
    if (!host) {
        host = document.createElement("div");
        host.id = ID;
        Object.assign(host.style, {
            position: "fixed", right: "28px", bottom: "28px", width: "72px", height: "72px", zIndex: "2147483647",
            pointerEvents: "none", opacity: "0", transform: "scale(0.6)", perspective: "320px",
            transition: "opacity 0.3s ease-out, transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)"
        });
        // Racine fermée : la page ne lit ni ne restyle l'indicateur.
        const root = host.attachShadow({ mode: "closed" });
        const coin = document.createElement("div");
        Object.assign(coin.style, { position: "absolute", inset: "0", transformStyle: "preserve-3d" });
        const face = document.createElement("div");
        Object.assign(face.style, {
            position: "absolute", inset: "0", borderRadius: "50%", backfaceVisibility: "visible",
            background: logo ? `center / cover no-repeat url("${logo}")` : "#1e1f20",
            boxShadow: "0 0 0 2px rgba(255, 255, 255, 0.18), 0 8px 22px rgba(0, 0, 0, 0.55)"
        });
        coin.appendChild(face);
        root.append(coin);  // sans halo bleu-violet (demande de Julien du 22/10) : le logo seul, avec son ombre
        document.documentElement.appendChild(host);
        // Le logo roule sur lui-même (axe vertical).
        coin.animate([{ transform: "rotateY(0deg)" }, { transform: "rotateY(360deg)" }],
            { duration: 1618, iterations: Infinity, easing: "cubic-bezier(0.45, 0, 0.55, 1)" });
    }
    host.title = label;
    requestAnimationFrame(() => { host.style.opacity = "1"; host.style.transform = "scale(1)"; });
    setTimeout(() => { host.style.opacity = "1"; host.style.transform = "scale(1)"; }, 50);
    return true;
}

async function drawBusy(tabId, on) {
    if (!chrome.scripting?.executeScript) return;
    const label = `${[...busyAgents.keys()].slice(0, 3).join(", ")} au travail`;
    try {
        await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] }, world: "ISOLATED", func: drawBusyIndicator,
            args: [on, on ? await busyLogoUrl() : "", label]
        });
    } catch (_) {}  // page interne de Chrome, Web Store, PDF : le point de l'icône suffit
}

async function refreshBusyIndicator() {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) return;
    const on = busyAgents.size > 0;
    try {
        chrome.action?.setBadgeBackgroundColor?.({ color: "#4285f4" });
        chrome.action?.setBadgeText?.({ text: on ? "•" : "" });
    } catch (_) {}
    let target = null;
    if (on) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            target = tab?.id ?? null;
        } catch (_) {}
    }
    if (busyShownTab !== null && busyShownTab !== target) drawBusy(busyShownTab, false);
    const already = on && target !== null && busyShownTab === target;
    busyShownTab = on ? target : null;
    if (on && target !== null && !already) await drawBusy(target, true);
}

if (typeof chrome !== "undefined") {
    // L'utilisateur change d'onglet ou de fenêtre pendant que l'agent travaille : le logo le suit.
    chrome.tabs?.onActivated?.addListener?.(() => { if (busyAgents.size) refreshBusyIndicator(); });
    chrome.windows?.onFocusChanged?.addListener?.(() => { if (busyAgents.size) refreshBusyIndicator(); });
}

/** Point visé par un vrai clic, montré dans l'onglet (canal du script de contenu). */
function notifyRipple(tabId, x, y) {
    if (!tabId || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) return;
    try {
        const pending = chrome.tabs.sendMessage(tabId, { nexusRipple: { x, y } }, { frameId: 0 });
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {}
}

async function groupTabs(params = {}) {
    if (!chrome.tabGroups || !chrome.tabs?.group) {
        return { data: { warning: "Tab groups API is not supported in this browser context", tabIds: [] } };
    }

    let tabIds = [];
    if (Array.isArray(params.tabIds) && params.tabIds.length > 0) {
        tabIds = params.tabIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    } else {
        tabIds = [await resolveTargetTab(params)];
    }

    if (tabIds.length === 0) {
        throw new Error("No valid tabId specified or found to group");
    }

    const title = params.title || "Nexus";
    const color = params.color || "purple";
    const collapsed = Boolean(params.collapsed);

    let windowId = null;
    try {
        const firstTab = await chrome.tabs.get(tabIds[0]);
        windowId = firstTab?.windowId;
    } catch (_) {}

    let groupId = null;
    if (windowId && chrome.tabGroups.query) {
        try {
            const existingGroups = await chrome.tabGroups.query({ windowId });
            const existing = existingGroups.find(g => g.title === title);
            if (existing) {
                groupId = existing.id;
            }
        } catch (_) {}
    }

    if (groupId !== null) {
        groupId = await chrome.tabs.group({ tabIds, groupId });
    } else {
        groupId = await chrome.tabs.group({ tabIds });
    }

    // Titre, couleur et repli ne sont annoncés que s'ils ont vraiment été appliqués (relus dans la réponse de Chrome).
    let updateError = chrome.tabGroups.update ? null : "chrome.tabGroups.update unavailable";
    let updatedGroup = null;
    if (!updateError) {
        try {
            updatedGroup = await chrome.tabGroups.update(groupId, { title, color, collapsed });
        } catch (error) {
            updateError = error?.message || String(error);
        }
    }
    if (!updatedGroup) {
        return {
            data: {
                groupId,
                tabIds,
                updated: false,
                warning: `Tabs grouped, but title, color and collapse not applied (${updateError || "no response from Chrome"}).`
            }
        };
    }
    return {
        data: {
            groupId: updatedGroup.id ?? groupId,
            title: updatedGroup.title,
            color: updatedGroup.color,
            collapsed: updatedGroup.collapsed,
            updated: true,
            tabIds
        }
    };
}

async function selectTab(params) {
    const tabId = await resolveTargetTab(params);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (params?.focusWindow && tab?.windowId && chrome.windows?.update) {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
    return { data: { success: true, tab } };
}

/**
 * Fenêtre NORMALE où ouvrir un onglet de fond. Sans windowId, Chrome vise la dernière fenêtre active : si c'est une
 * fenêtre d'application (PWA, Codex LB), il ne peut pas y ajouter d'onglet et ouvre une nouvelle fenêtre qui prend le
 * premier plan à Julien. null : aucune fenêtre normale (il faudra en créer une, réduite et sans focus).
 */
async function backgroundWindowId() {
    if (!chrome.windows?.getLastFocused) return undefined;  // API absente : comportement par défaut de Chrome
    try {
        const win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
        if (win?.id !== undefined && win.type === "normal") return win.id;
    } catch (_) {
        // aucune fenêtre normale
    }
    if (chrome.windows.getAll) {
        const normal = (await chrome.windows.getAll({ windowTypes: ["normal"] })).filter((w) => w.type === "normal");
        if (normal.length) return normal[0].id;
    }
    return null;
}

/**
 * Onglet d'une fenêtre que l'on vient de créer : celui que Chrome renvoie, sinon relu par chrome.tabs.query. Jamais
 * l'identifiant de la FENÊTRE (il désignerait un autre onglet, peut-être celui de Julien).
 */
async function tabOfNewWindow(win) {
    let tab = win?.tabs?.[0] || null;
    if (!tab && Number.isInteger(win?.id) && chrome.tabs?.query) {
        try { [tab] = await chrome.tabs.query({ windowId: win.id }); } catch (_) {}
    }
    if (!tab || !Number.isInteger(tab.id)) {
        throw new Error(`Window ${win?.id ?? "?"} created, but its tab was not found: no tab assigned to the agent.`);
    }
    return tab;
}

async function createTab(params, client = null) {
    const url = checkNavigableUrl(params.url || "about:blank");
    let active = false;
    if (params.active === true) {
        active = true;
    } else if (params.background === false) {
        active = true;
    }

    const windowId = active ? undefined : await backgroundWindowId();
    if (windowId === null) {
        // Seule une fenêtre d'application existe : nouvelle fenêtre normale réduite, sans focus.
        const win = await chrome.windows.create({ url, focused: false, state: "minimized", type: "normal" });
        const createdTab = await tabOfNewWindow(win);
        await ownOrClose(createdTab.id, client);
        return { data: { ...createdTab, windowCreated: true, owner: client?.agent || null } };
    }

    let tab;
    try {
        tab = await chrome.tabs.create(windowId === undefined ? { url, active } : { url, active, windowId });
    } catch (e) {
        const win = await chrome.windows.create(active ? { url, focused: true } : { url, focused: false, state: "minimized" });
        const createdTab = await tabOfNewWindow(win);
        await ownOrClose(createdTab.id, client);
        return { data: { ...createdTab, windowCreated: true, owner: client?.agent || null } };
    }
    // Seul l'échec de chrome.tabs.create mène à la fenêtre de repli : un onglet ouvert n'est jamais doublé.
    await ownOrClose(tab.id, client);
    let assignedGroupId = tab.groupId !== undefined ? tab.groupId : -1;

    const groupParam = params.group !== undefined ? params.group : "Nexus";
    if (groupParam && chrome.tabGroups && chrome.tabs?.group) {
        try {
            const groupTitle = typeof groupParam === "string" ? groupParam : "Nexus";
            const grpRes = await groupTabs({
                tabIds: [tab.id],
                title: groupTitle,
                color: params.groupColor || "purple",
                collapsed: Boolean(params.collapsed)
            });
            if (grpRes?.data?.groupId) {
                assignedGroupId = grpRes.data.groupId;
            }
        } catch (grpErr) {
            console.log("[NexusBrowser] Auto-group notice:", grpErr.message);
        }
    }

    return { data: { ...tab, groupId: assignedGroupId, owner: client?.agent || null } };
}

/**
 * Onglet ouvert pour l'agent mais dont l'attribution n'a pas pu être enregistrée : refermé, jamais laissé à l'abandon
 * (même correctif que chrome-devtools-mcp 1.12 pour new_page).
 */
async function ownOrClose(tabId, client) {
    try {
        await rememberTabOwner(tabId, client);
    } catch (error) {
        const reason = error?.message || error;
        try {
            await chrome.tabs.remove(tabId);
        } catch (closeError) {
            // Fermeture impossible : la propriété en mémoire reste, l'onglet n'est jamais laissé sans maître ni dit fermé.
            throw new Error(`Tab ${tabId} opened but not assigned to the agent (${reason}), and it could not be closed (${closeError?.message || closeError}): close it with browser_close_tab(${tabId}).`);
        }
        tabOwners.delete(tabId);
        throw new Error(`Tab ${tabId} opened but not assigned to the agent (${reason}): closed.`);
    }
}

/**
 * Onglet de l'utilisateur confié à l'agent qui le demande : refusé par défaut, seulement avec userAsked=true (il l'a
 * demandé explicitement), jamais l'onglet d'un autre agent. Marqué « (adopted) » dans l'état des onglets.
 */
async function adoptTab(params = {}, client = null) {
    const tabId = await resolveTargetTab(params);
    const owner = tabOwners.get(tabId);
    if (ownedBy(owner, client)) return { data: { tabId, adopted: !!owner.adopted, already: true, owner: owner.agent } };
    if (orphanFor(owner, client)) return { data: await reclaimOrphan(tabId, owner, client) };
    if (owner) return { error: foreignTabMessage(tabId, owner, client) };
    if (params.userAsked !== true) {
        return { error: `Adoption of tab ${tabId} refused by default: it is the user's tab. Only if the user explicitly asked for it, retry with user_asked=True.` };
    }
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (_) {}
    if (tab && isProtectedUrl(tab.url)) return { error: `Tab ${tabId} is protected (${tab.url}): never handed to an agent.` };
    await rememberTabOwner(tabId, client, "adopted");
    return { data: { tabId, adopted: true, owner: client.agent, title: tab?.title || "", url: maskUrl(tab?.url || "") } };
}

/**
 * Onglet orphelin (session morte du même agent) repris par ce client : sans userAsked, il était déjà à l'agent.
 * Un onglet de Julien adopté par l'ancienne session le reste (« adopté », rendu à Julien par release_tab).
 */
async function reclaimOrphan(tabId, owner, client) {
    await rememberTabOwner(tabId, client, owner.adopted ? "adopted" : "created");
    return { tabId, reclaimed: true, adopted: !!owner.adopted, owner: client.agent };
}

/**
 * Battement d'une session (serveur MCP) : son signe de vie est déjà noté par handleCommand. reclaim=true (premier
 * battement après démarrage) : si cette session ne possède encore aucun onglet, elle reprend les orphelins de son
 * agent. Jamais ceux d'un autre agent ni d'une session vivante.
 */
async function heartbeat(params = {}, client = null) {
    const reclaimed = [];
    if (params.reclaim === true && validClient(client)) {
        const owners = [...tabOwners.entries()];
        if (!owners.some(([, owner]) => ownedBy(owner, client))) {
            for (const [tabId, owner] of owners) {
                if (orphanFor(owner, client)) { await reclaimOrphan(tabId, owner, client); reclaimed.push(tabId); }
            }
        }
    }
    return { data: { alive: true, sessionDeadAfterS: Math.round(SESSION_DEAD_MS / 1000), reclaimed } };
}

/** L'agent rend son onglet à Julien sans le fermer : propriété retirée, débogueur détaché. */
async function releaseTab(params = {}) {
    const tabId = requestedTabId(params);
    networkRecording.delete(tabId);
    await detachDebugger(tabId);
    await forgetTabOwner(tabId);
    return { data: { tabId, released: true } };
}

async function closeTab(params = {}) {
    const tabId = await resolveTargetTab(params);
    await chrome.tabs.remove(tabId);
    await forgetTabOwner(tabId);
    return { data: { success: true, closedTabId: tabId } };
}

async function navigateTab(params) {
    if (params.history === "back" || params.history === "forward") {
        // Précédent / suivant de l'historique de SON onglet : seulement des pages que l'onglet a déjà ouvertes.
        const tabId = await resolveTargetTab(params);
        resetNetworkTracking(tabId);
        // Historique lu par CDP, pas chrome.tabs.goBack : Chrome saute les pages quittées sans geste de l'utilisateur
        // (intervention contre la manipulation de l'historique), et un onglet d'agent n'en a souvent aucun ; goBack
        // répondait « Cannot find a next page in history » juste après une navigation (mesuré le 20/10).
        const target = await ensureDebugger(tabId);
        const { currentIndex, entries = [] } = await chrome.debugger.sendCommand(target, "Page.getNavigationHistory");
        const entry = entries[currentIndex + (params.history === "back" ? -1 : 1)];
        if (!entry) throw new Error(`No ${params.history === "back" ? "previous" : "next"} page in this tab's history`);
        // Même contrat que la navigation explicite : un onglet adopté peut avoir file:// ou chrome:// dans son passé.
        checkNavigableUrl(entry.url);
        await chrome.debugger.sendCommand(target, "Page.navigateToHistoryEntry", { entryId: entry.id });
        scheduleDebuggerDetach(tabId);
        return { data: { success: true, history: params.history } };
    }
    if (!params.url) throw new Error("Missing url parameter");
    const url = checkNavigableUrl(params.url);
    const tabId = await resolveTargetTab(params);

    resetNetworkTracking(tabId);
    // Débogueur attaché d'abord : une boîte beforeunload de la page quittée est vue (rapportée, onglet gardé derrière).
    try { await ensureDebugger(tabId); } catch (_) {}
    const updatedTab = await chrome.tabs.update(tabId, { url });
    return { data: updatedTab };
}

/** Enregistrement réseau gardé (débogueur attaché) pendant une durée bornée, même sans commande. */
async function recordNetwork(params = {}) {
    const tabId = await resolveTargetTab(params);
    const seconds = Math.max(1, Math.min(NETWORK_RECORD_MAX_S, parseInt(params.durationS ?? params.duration_s, 10) || 120));
    await ensureDebugger(tabId);
    const until = Date.now() + seconds * 1000;
    networkRecording.set(tabId, until);
    return { data: { tabId, recording: true, until: new Date(until).toISOString(), duration_s: seconds, max_s: NETWORK_RECORD_MAX_S } };
}

async function stopNetworkRecording(params = {}) {
    const tabId = await resolveTargetTab(params);
    const was = networkRecording.delete(tabId);
    const busy = (tabCommandsInFlight.get(tabId) || 0) > 1 || activeUploads.has(tabId) || pendingDialogs.has(tabId);
    if (!busy) await detachDebugger(tabId);
    return { data: { tabId, recording: false, wasRecording: was, detached: !busy, buffered: networkLog(tabId).records.length } };
}

async function reloadTab(params) {
    const tabId = await resolveTargetTab(params);
    resetNetworkTracking(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache || false });
    return { data: { success: true } };
}

/**
 * browser_eval : expression de l'AGENT dans le MONDE DE LA PAGE (ses variables, comme la console DevTools). Seul
 * chemin de l'extension vers ce monde, avec la transcription YouTube (qui lit le lecteur de la page).
 */
async function evaluateScript(params) {
    let tabId = await resolveTargetTab(params);
    const code = params.code || params.script || params.expression;
    if (!code) throw new Error("Missing code/expression to evaluate");

    const target = await ensureDebugger(tabId);
    const result = await sendCommandWatchingDialogs(target, "Runtime.evaluate", {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
    });
    if (result?.__dialog) {
        return { data: dialogInterruption(result.__dialog) };
    }
    if (result?.exceptionDetails) {
        const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
        throw new Error(desc || "Evaluation error in page context");
    }
    return { data: result?.result?.value !== undefined ? result.result.value : result?.result };
}

/**
 * Script de l'EXTENSION (lecture, carte des éléments, capture, exports) dans le monde isolé « nexus-browser » du cadre
 * principal : DOM partagé, mais ni ses variables (marqueurs, sondes) ni les fonctions qu'il appelle ne sont visibles
 * ou remplaçables par la page. Contexte recréé une fois s'il a disparu (navigation).
 */
async function evaluateIsolated(params) {
    const tabId = await resolveTargetTab(params);
    const code = params.code;
    const target = await ensureDebugger(tabId);
    const root = rootOf(target);
    for (let attempt = 0; ; attempt++) {
        let result;
        try {
            const contextId = await rootContextId(root, attempt > 0);
            result = await sendCommandWatchingDialogs(target, "Runtime.evaluate", {
                expression: code, contextId, returnByValue: true, awaitPromise: true
            });
        } catch (error) {
            if (attempt === 0 && isContextLost(error)) continue;
            throw error;
        }
        if (result?.__dialog) return { data: dialogInterruption(result.__dialog) };
        if (result?.exceptionDetails) {
            const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
            throw new Error(desc || "Extension script error in the page");
        }
        return { data: result?.result?.value !== undefined ? result.result.value : result?.result };
    }
}

// Champ sensible (kit de localisation) d'après les attributs du nœud DOM ; nœud illisible : masqué par prudence.
async function axNodeSensitive(target, backendNodeId) {
    try {
        const { node } = await chrome.debugger.sendCommand(target, "DOM.describeNode", { backendNodeId });
        if (!node) return false;
        const attrs = {};
        const list = node.attributes || [];
        for (let i = 0; i + 1 < list.length; i += 2) attrs[String(list[i]).toLowerCase()] = list[i + 1];
        return LK.sensitiveField({ tagName: node.nodeName, getAttribute: (name) => (name in attrs ? attrs[name] : null) });
    } catch (_) {
        return true;
    }
}

/**
 * Nœuds AX du cadre principal, et ceux d'un champ sensible (carte, code ; Chrome ne masque que les mots de passe) : sa
 * valeur et celle de ses nœuds de texte descendants (StaticText, InlineTextBox, qui la répètent comme nom).
 */
async function maskedAxNodes(target) {
    await chrome.debugger.sendCommand(target, "Accessibility.enable");
    const axResult = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {});
    const raw = axResult?.nodes || [];
    const byId = new Map(raw.map(n => [n.nodeId, n]));
    const masked = new Set();
    for (const n of raw) {
        if (n.ignored || !n.backendDOMNodeId || !n.value || n.value.value === undefined || n.value.value === "") continue;
        if (!(await axNodeSensitive(target, n.backendDOMNodeId))) continue;
        const stack = [n.nodeId];
        while (stack.length) {
            const id = stack.pop();
            if (masked.has(id)) continue;
            masked.add(id);
            for (const child of byId.get(id)?.childIds || []) stack.push(child);
        }
    }
    return { raw, byId, masked };
}

// Instantané compact (façon snapshot ARIA de Playwright MCP) : une ligne par nœud utile, « - rôle "nom" [états] [#N] »,
// en retrait selon l'arbre. Les numéros [#N] sont des marqueurs : browser_click(mark=N), browser_fill(mark=N)...
const SNAPSHOT_REF_ROLES = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox",
    "listbox", "option", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton",
    "treeitem", "DisclosureTriangle", "ToggleButton", "PopUpButton", "InputTime", "date", "DateTime", "ColorWell"]);
// Rôles sans valeur propre : leurs enfants remontent d'un cran (div, span, mise en page, mise en forme du texte).
const SNAPSHOT_FLAT_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "Ignored", "LabelText",
    "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Pre", "Abbr", "Ruby", "Mark", "Time", "Section", "ListMarker",
    "superscript", "subscript", "emphasis", "strong", "code", "insertion", "deletion", "Canvas", "Iframe",
    "IframePresentational", "SvgRoot", "graphics-document", "graphics-symbol", "graphics-object"]);
const SNAPSHOT_OPAQUE_ROLES = new Set(["InputTime", "date", "DateTime"]);
const SNAPSHOT_STATES = ["checked", "pressed", "selected", "expanded", "disabled", "required", "invalid", "readonly"];
const SNAPSHOT_TEXT_MAX = 100;
const SNAPSHOT_MAX_LINES = 400;

function snapshotText(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > SNAPSHOT_TEXT_MAX ? text.slice(0, SNAPSHOT_TEXT_MAX - 1) + "…" : text;
}

function snapshotQuote(text) {
    return JSON.stringify(String(text));
}

/** Arbre réduit aux nœuds utiles ; les candidats à un numéro (contrôles actifs) sont listés dans l'ordre du document. */
function snapshotTree(raw, byId, masked) {
    const candidates = [];
    const build = (id, depth, parentName) => {
        const n = byId.get(id);
        if (!n || depth > 256) return [];
        const role = n.role?.value || "";
        const hide = masked.has(n.nodeId);
        const childrenOf = (name) => (n.childIds || []).flatMap(child => build(child, depth + 1, name));
        if (n.ignored || SNAPSHOT_FLAT_ROLES.has(role)) return childrenOf(parentName);
        if (role === "StaticText") {
            const text = hide ? LK.MASKED_VALUE : snapshotText(n.name?.value);
            // Texte déjà dit par le nom du parent (lien, bouton, titre) : pas répété.
            if (!text || (parentName && parentName.includes(text))) return [];
            return [{ role: "text", name: text, children: [] }];
        }
        const name = role === "RootWebArea" ? "" : snapshotText(hide && role !== "textbox" ? LK.MASKED_VALUE : n.name?.value);
        const props = Object.fromEntries((n.properties || []).map(p => [p.name, p.value?.value]));
        const states = [];
        if (role === "heading" && props.level) states.push(`level=${props.level}`);
        for (const key of SNAPSHOT_STATES) {
            const v = props[key];
            if (v === true || v === "true") states.push(key);
            else if (v === "mixed") states.push(`${key}=mixed`);
        }
        const rawValue = n.value?.value;
        const value = rawValue === undefined || rawValue === null || rawValue === "" ? ""
            : (hide ? LK.MASKED_VALUE : snapshotText(rawValue));
        const node = { role, name, states, value, children: [] };
        if (SNAPSHOT_REF_ROLES.has(role) && n.backendDOMNodeId && props.disabled !== true) {
            node.backendNodeId = n.backendDOMNodeId;
            candidates.push(node);
        }
        // Texte des enfants déjà dit par le nom ou la valeur (texte d'un champ = sa valeur) : pas répété.
        // Parties internes d'un champ date ou heure (heures, minutes, bouton du sélecteur) : le champ suffit.
        node.children = SNAPSHOT_OPAQUE_ROLES.has(role) ? []
            : childrenOf([name, value].filter(Boolean).join(" ") || parentName);
        // Conteneur anonyme sans contenu (groupe vide, liste vide) : omis.
        if (!name && !value && !node.backendNodeId && !node.children.length && role !== "img" && role !== "separator") return [];
        return [node];
    };
    const root = raw.find(n => n.role?.value === "RootWebArea") || raw[0];
    return { tree: root ? build(root.nodeId, 0, "") : [], candidates };
}

function renderSnapshot(tree, maxLines) {
    const lines = [];
    let omitted = 0;
    const walk = (nodes, indent) => {
        for (const node of nodes) {
            if (lines.length >= maxLines) { omitted++; walk(node.children, indent); continue; }
            const pad = "  ".repeat(indent);
            if (node.role === "text") { lines.push(`${pad}- text: ${snapshotQuote(node.name)}`); continue; }
            // Nœud anonyme dont le seul contenu est un texte : sur une ligne (« - paragraph: "..." »).
            const only = !node.name && !node.value && node.children.length === 1 && node.children[0].role === "text"
                ? node.children[0] : null;
            let line = `${pad}- ${node.role === "RootWebArea" ? "document" : node.role}`;
            if (node.name) line += ` ${snapshotQuote(node.name)}`;
            for (const s of node.states) line += ` [${s}]`;
            if (node.ref) line += ` [#${node.ref}]`;
            if (node.value) line += `: ${snapshotQuote(node.value)}`;
            else if (only) line += `: ${snapshotQuote(only.name)}`;
            lines.push(line);
            if (!only) walk(node.children, indent + 1);
        }
    };
    walk(tree, 0);
    if (omitted) lines.push(`- … ${omitted} more nodes (snapshot cut at ${maxLines} lines: max_lines)`);
    return lines.join("\n");
}

/**
 * Numéros des contrôles de l'instantané : chaque nœud DOM est résolu dans le monde isolé de l'extension et rangé dans
 * __nexus_som_elements (la table de browser_interactive_map), donc visé par tous les gestes par mark.
 */
async function registerSnapshotRefs(target, candidates) {
    const root = rootOf(target);
    for (let attempt = 0; ; attempt++) {
        try {
            const contextId = await rootContextId(root, attempt > 0);
            const handles = [];
            for (const node of candidates) {
                try {
                    const res = await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
                        backendNodeId: node.backendNodeId, executionContextId: contextId
                    });
                    if (res?.object?.objectId) handles.push({ node, objectId: res.object.objectId });
                } catch (_) {}
            }
            await chrome.debugger.sendCommand(target, "Runtime.callFunctionOn", {
                executionContextId: contextId,
                functionDeclaration: "function(...els) { if (!(window.__nexus_som_elements instanceof Map)) " +
                    "window.__nexus_som_elements = new Map(); window.__nexus_som_elements.clear(); " +
                    "els.forEach((el, i) => window.__nexus_som_elements.set(i + 1, el)); return els.length; }",
                arguments: handles.map(h => ({ objectId: h.objectId })),
                returnByValue: true
            });
            handles.forEach((h, i) => { h.node.ref = i + 1; });
            markRoots.delete(target.tabId);
            return handles.length;
        } catch (error) {
            if (attempt === 0 && isContextLost(error)) continue;
            throw error;
        }
    }
}

async function getAccessibilitySnapshot(tabId, params = {}) {
    const target = await ensureDebugger(tabId);
    const { raw, byId, masked } = await maskedAxNodes(target);
    const { tree, candidates } = snapshotTree(raw, byId, masked);
    // Toujours enregistré, même vide : la table et les racines de l'instantané précédent ne doivent pas survivre.
    const refs = await registerSnapshotRefs(target, candidates);
    const maxLines = Math.max(20, Math.min(2000, parseInt(params.maxLines ?? params.max_lines, 10) || SNAPSHOT_MAX_LINES));
    let url = "";
    let title = "";
    try { ({ url = "", title = "" } = await chrome.tabs.get(tabId)); } catch (_) {}
    return { data: { url, title, refs, snapshot: renderSnapshot(tree, maxLines) } };
}

async function getAccessibilityTree(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (String(params.mode || "full") === "snapshot") return await getAccessibilitySnapshot(tabId, params);

    const target = await ensureDebugger(tabId);
    const { raw, masked } = await maskedAxNodes(target);
    const nodes = raw.map(n => {
        const hide = masked.has(n.nodeId);
        const isText = hide && n.role?.value !== "textbox";
        return {
            nodeId: n.nodeId,
            role: n.role?.value,
            name: isText && n.name?.value ? LK.MASKED_VALUE : n.name?.value,
            value: hide && n.value?.value ? LK.MASKED_VALUE : n.value?.value,
            description: n.description?.value,
            ignored: n.ignored,
            backendDOMNodeId: n.backendDOMNodeId
        };
    }).filter(n => !n.ignored && (n.name || n.value || n.role === "button" || n.role === "link"));

    return { data: { nodeCount: nodes.length, nodes: nodes.slice(0, 100) } };
}

async function getConsoleLogs(params = {}) {
    let tabId = await resolveTargetTab(params);
    // Messages de la console : mêmes règles que les corps réseau (jetons, mots de passe, cartes), à toute profondeur
    // (texte, arguments, aperçus d'objets { name, value }).
    return { data: (tabConsoleLogs.get(tabId) || []).map(entry => maskLogValue(entry)) };
}

async function getPageContent(params = {}) {
    let tabId = await resolveTargetTab(params);
    const mode = String(params.mode || "interactive");
    const top = await evaluateIsolated({ tabId, code: pageContentScript(params) });
    if (mode === "html" || !top || top.error || (top.data && top.data.dialogOpened)) return top;
    // Cadres d'une autre origine : texte ajouté sous un en-tête, éléments interactifs avec leur cadre.
    for (const { root, value } of await crossOriginFrameEvaluations(tabId, pageContentScript(params))) {
        if (mode === "text") {
            if (typeof top.data === "string" && value) top.data += `\n\n--- frame ${root.label} ---\n${value}`;
        } else if (top.data && Array.isArray(top.data.elements) && value && Array.isArray(value.elements)) {
            let offset = { x: 0, y: 0 };
            try {
                const proj = await projectToTop(root, [{ x: 0, y: 0 }], false);
                if (proj.ok) offset = proj.points[0];
            } catch (_) {}
            for (const el of value.elements) {
                top.data.elements.push({
                    ...el,
                    frame: frameLabelOf(root, el.frame === "top" ? "" : el.frame),
                    crossOriginFrame: true,
                    rect: { ...el.rect, x: Math.round(el.rect.x + offset.x), y: Math.round(el.rect.y + offset.y) }
                });
            }
            top.data.frames = [...(top.data.frames || []), { frame: root.label, url: value.url }];
        }
    }
    return top;
}

// Valeur d'un mot de passe, d'un code à usage unique ou d'une carte bancaire : jamais renvoyée (marqueur à la place).
// Une seule définition (kit de localisation), injectée dans les scripts de page écrits en gabarit texte.
const SENSITIVE_FIELD_EXPR = `(${LOCATOR_KIT_SOURCE})()`;

function pageContentScript(params) {
    return `(() => {
            const mode = ${JSON.stringify(String(params.mode || "interactive"))};
            if (mode === "text") return document.body ? document.body.innerText : "";
            const lk = ${SENSITIVE_FIELD_EXPR};
            if (mode === "html") {
                if (!document.documentElement) return "";
                // Attribut value d'un champ sensible (React le recopie depuis la saisie), composants compris, masqué dans
                // une copie du DOM.
                const copy = document.documentElement.cloneNode(true);
                for (const el of copy.querySelectorAll ? copy.querySelectorAll("[value]") : []) {
                    if (lk.sensitiveField(el)) el.setAttribute("value", lk.MASKED_VALUE);
                }
                return copy.outerHTML;
            }
            
            function scanNode(doc, prefix = "") {
                const elements = [];
                if (!doc || !doc.querySelectorAll) return elements;
                const nodes = doc.querySelectorAll("button, a, input, select, textarea, osds-button, [role='button'], [tabindex], iframe");
                nodes.forEach((el, idx) => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        elements.push({
                            index: idx,
                            tag: el.tagName.toLowerCase(),
                            text: ((lk.sensitiveField(el) ? "" : (el.innerText || el.value)) || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || "").trim().slice(0, 80),
                            ...(lk.sensitiveField(el) ? { value: lk.MASKED_VALUE } : {}),
                            type: el.type || null,
                            id: el.id || null,
                            className: typeof el.className === "string" ? el.className : (el.className?.baseVal || null),
                            frame: prefix || "top",
                            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
                        });
                    }
                    if (el.shadowRoot) {
                        try {
                            elements.push(...scanNode(el.shadowRoot, (prefix ? prefix + " > " : "") + (el.tagName.toLowerCase() + "#shadow")));
                        } catch(e) {}
                    }
                    if (el.tagName.toLowerCase() === "iframe" && el.contentDocument) {
                        try {
                            elements.push(...scanNode(el.contentDocument, (prefix ? prefix + " > " : "") + (el.id || "iframe")));
                        } catch(e) {}
                    }
                });
                return elements;
            }
            return { title: document.title, url: window.location.href, elements: scanNode(document) };
        })()`;
}

/**
 * Paramètre locator : objet (ou chaîne JSON) {role, name, label, text, placeholder, testId, altText, title, hasText,
 * exact, nth, includeHidden, checked, disabled, expanded, pressed, selected, level, engine}.
 */
function parseLocator(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    let loc = raw;
    if (typeof raw === "string") {
        try { loc = JSON.parse(raw); } catch (_) { throw new Error(`Unreadable locator (JSON object expected): ${raw}`); }
    }
    if (!loc || typeof loc !== "object" || Array.isArray(loc)) {
        throw new Error("locator must be an object, for example {\"role\":\"button\",\"name\":\"Submit\"}");
    }
    return loc;
}

/**
 * Cible commune à toutes les actions : locator, puis mark, selector (+index), text ; sinon l'élément qui a le focus
 * quand c'est permis (saisie).
 */
function targetLocate(params, { allowActive = false, allowText = true } = {}) {
    const locator = parseLocator(params.locator);
    if (locator) return { locator };
    if (params.mark !== undefined && params.mark !== null && params.mark !== "") {
        const mark = parseInt(params.mark, 10);
        if (!mark) throw new Error("Missing 'mark' number");
        return { mark };
    }
    if (params.selector) return { selector: params.selector, index: parseInt(params.index, 10) || 0 };
    if (allowText && (params.text || params.textMatch)) return { text: params.text || params.textMatch };
    return allowActive ? { active: true } : null;
}

async function hoverElement(params) {
    const locate = targetLocate(params);
    if (!locate) return { error: "Missing locator, selector, mark or text to hover" };
    return await performMouseAction(params, { kind: "hover", locate, timeoutMs: mouseTimeout(params, 1200) });
}

async function clickElement(params) {
    const locate = targetLocate(params);
    if (!locate) return { error: "Missing locator, selector, mark or text to click" };
    return await performMouseAction(params, {
        kind: "click",
        locate,
        button: mouseButton(params),
        clickCount: mouseClickCount(params),
        timeoutMs: mouseTimeout(params, 1200)
    });
}

// -----------------------------------------------------------------------------
// Clavier réel : Input.dispatchKeyEvent (key, code, windowsVirtualKeyCode, modificateurs) et Input.insertText
// -----------------------------------------------------------------------------
const KEY_DEFINITIONS = {
    Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
    Delete: { key: "Delete", code: "Delete", keyCode: 46 },
    Insert: { key: "Insert", code: "Insert", keyCode: 45 },
    Home: { key: "Home", code: "Home", keyCode: 36 },
    End: { key: "End", code: "End", keyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    Space: { key: " ", code: "Space", keyCode: 32, text: " " },
    ContextMenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
    Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
    Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
    Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
    Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 }
};
const KEY_ALIASES = {
    enter: "Enter", return: "Enter", tab: "Tab", esc: "Escape", escape: "Escape", backspace: "Backspace",
    delete: "Delete", del: "Delete", insert: "Insert", ins: "Insert", home: "Home", end: "End", pageup: "PageUp",
    pagedown: "PageDown", left: "ArrowLeft", arrowleft: "ArrowLeft", up: "ArrowUp", arrowup: "ArrowUp",
    right: "ArrowRight", arrowright: "ArrowRight", down: "ArrowDown", arrowdown: "ArrowDown", space: "Space",
    spacebar: "Space", contextmenu: "ContextMenu", menu: "ContextMenu", shift: "Shift", ctrl: "Control",
    control: "Control", alt: "Alt", option: "Alt", meta: "Meta", cmd: "Meta", command: "Meta", win: "Meta"
};
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const PUNCTUATION_KEYS = {
    ",": ["Comma", 188], ".": ["Period", 190], "-": ["Minus", 189], "=": ["Equal", 187], "/": ["Slash", 191],
    ";": ["Semicolon", 186], "'": ["Quote", 222], "[": ["BracketLeft", 219], "]": ["BracketRight", 221],
    "\\": ["Backslash", 220], "`": ["Backquote", 192]
};
// Raccourcis d'édition : la commande accompagne la touche (exécutée même quand l'association native manque).
const SHORTCUT_COMMANDS = {
    "Control+a": ["selectAll"], "Meta+a": ["selectAll"], "Control+c": ["copy"], "Control+x": ["cut"],
    "Control+v": ["paste"], "Control+z": ["undo"], "Control+y": ["redo"], "Control+Shift+z": ["redo"]
};
const KEY_COMMAND_TIMEOUT_MS = 10000;

function characterKey(ch) {
    if (ch === "\n" || ch === "\r") return { ...KEY_DEFINITIONS.Enter };
    if (ch === "\t") return { ...KEY_DEFINITIONS.Tab };
    if (ch === " ") return { ...KEY_DEFINITIONS.Space };
    if (/^[a-z]$/i.test(ch)) {
        const upper = ch.toUpperCase();
        return { key: ch, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: ch, shift: ch !== ch.toLowerCase() };
    }
    if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: 48 + Number(ch), text: ch };
    if (PUNCTUATION_KEYS[ch]) return { key: ch, code: PUNCTUATION_KEYS[ch][0], keyCode: PUNCTUATION_KEYS[ch][1], text: ch };
    return { key: ch, code: "", keyCode: 0, text: ch };
}

function keyDefinition(name) {
    const raw = String(name);
    const alias = KEY_ALIASES[raw.toLowerCase()] || raw;
    if (KEY_DEFINITIONS[alias]) return { ...KEY_DEFINITIONS[alias] };
    const fn = /^F([1-9]|1[0-2])$/i.exec(raw);
    if (fn) return { key: `F${fn[1]}`, code: `F${fn[1]}`, keyCode: 111 + Number(fn[1]) };
    if ([...raw].length === 1) return characterKey(raw);
    throw new Error(`Unknown key '${name}' (e.g. Enter, Tab, Escape, Backspace, ArrowDown, F5, a, Control+A)`);
}

/**
 * "Control+Shift+K", "ctrl+a", "Enter", "+" -> { modifiers: ["Control", "Shift"], key: "K" }.
 */
function parseKeyCombo(combo) {
    const text = String(combo === undefined || combo === null ? "" : combo).trim();
    if (!text) throw new Error("Empty key");
    if ([...text].length === 1) return { modifiers: [], key: text };
    let parts = text.split("+");
    if (text.endsWith("++")) parts = [...text.slice(0, -2).split("+"), "+"];
    const key = parts.pop();
    const modifiers = [];
    for (const part of parts) {
        const mod = KEY_ALIASES[String(part).trim().toLowerCase()] || String(part).trim();
        if (!Object.prototype.hasOwnProperty.call(MODIFIER_BITS, mod)) throw new Error(`Unknown modifier '${part}' in '${combo}' (Control, Shift, Alt, Meta)`);
        if (!modifiers.includes(mod)) modifiers.push(mod);
    }
    return { modifiers, key: key.trim() || key };
}

async function sendKeyEvent(target, params) {
    // Frappe touche par touche : chaque touche vérifie l'arrêt d'urgence (frappe interrompue au caractère suivant).
    assertNotStopped();
    const call = sendCommandWatchingDialogs(target, "Input.dispatchKeyEvent", params);
    call.catch(() => {});
    return await withTimeout(call, KEY_COMMAND_TIMEOUT_MS, `Input.dispatchKeyEvent ${params.type}: no response after ${KEY_COMMAND_TIMEOUT_MS} ms`);
}

function releaseKeyQuietly(target, params) {
    try {
        const pending = chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", params);
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {}
}

function keyFields(def, modifiers) {
    return {
        modifiers,
        key: def.key,
        code: def.code,
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode
    };
}

/**
 * Touche ou raccourci réel : modificateurs enfoncés, touche (keyDown si elle produit du texte, sinon rawKeyDown),
 * relâchements dans l'ordre inverse. Les touches enfoncées sont toujours relâchées, même si une boîte s'ouvre.
 * Renvoie { dialog } si la page a ouvert une boîte de dialogue.
 */
async function pressKeyCombo(target, combo) {
    await ensureFocusEmulation(target);
    const { modifiers, key } = parseKeyCombo(combo);
    // Lettre d'un raccourci : minuscule (Control+A envoie key "a"), majuscule seulement avec Shift.
    const def = keyDefinition(/^[a-z]$/i.test(key) ? key.toLowerCase() : key);
    let bits = 0;
    const held = [];
    const releaseAll = () => {
        let b = bits;
        for (const mod of held.reverse()) {
            b &= ~MODIFIER_BITS[mod];
            releaseKeyQuietly(target, { type: "keyUp", ...keyFields(KEY_DEFINITIONS[mod], b) });
        }
    };
    for (const mod of modifiers) {
        bits |= MODIFIER_BITS[mod];
        const res = await sendKeyEvent(target, { type: "rawKeyDown", ...keyFields(KEY_DEFINITIONS[mod], bits) });
        held.push(mod);
        if (res?.__dialog) { releaseAll(); return { dialog: res.__dialog }; }
    }
    const textual = !(bits & (MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) && def.text;
    const shifted = (bits & MODIFIER_BITS.Shift) && def.key.length === 1;
    const fields = keyFields(shifted ? { ...def, key: def.key.toUpperCase() } : def, bits);
    const down = { type: textual ? "keyDown" : "rawKeyDown", ...fields };
    if (textual) {
        const text = shifted ? def.text.toUpperCase() : def.text;
        down.text = text;
        down.unmodifiedText = text;
    }
    const commands = SHORTCUT_COMMANDS[[...modifiers, def.key.length === 1 ? def.key.toLowerCase() : def.key].join("+")];
    if (commands) down.commands = commands;
    let sentDown = false;
    try {
        const res = await sendKeyEvent(target, down);
        sentDown = true;
        if (res?.__dialog) {
            releaseKeyQuietly(target, { type: "keyUp", ...fields });
            releaseAll();
            return { dialog: res.__dialog };
        }
        await sendKeyEvent(target, { type: "keyUp", ...fields });
        sentDown = false;
        for (const mod of [...held].reverse()) {
            bits &= ~MODIFIER_BITS[mod];
            await sendKeyEvent(target, { type: "keyUp", ...keyFields(KEY_DEFINITIONS[mod], bits) });
            held.splice(held.indexOf(mod), 1);
        }
    } catch (error) {
        // Arrêt d'urgence ou erreur : jamais une touche laissée enfoncée.
        if (sentDown) releaseKeyQuietly(target, { type: "keyUp", ...fields });
        releaseAll();
        throw error;
    }
    return { dialog: null, key: def.key, modifiers };
}

/**
 * Frappe touche par touche (keydown, keypress, beforeinput, input, keyup de confiance par caractère).
 */
async function typeCharacters(target, text) {
    await ensureFocusEmulation(target);
    let typed = 0;
    for (const ch of String(text)) {
        if (ch === "\n" || ch === "\r") {
            const r = await pressKeyCombo(target, "Enter");
            if (r.dialog) return { dialog: r.dialog, typed };
            typed++;
            continue;
        }
        const def = characterKey(ch);
        const fields = keyFields(def, def.shift ? MODIFIER_BITS.Shift : 0);
        const down = await sendKeyEvent(target, { type: "keyDown", ...fields, text: def.text, unmodifiedText: def.text });
        if (down?.__dialog) {
            releaseKeyQuietly(target, { type: "keyUp", ...fields });
            return { dialog: down.__dialog, typed };
        }
        try {
            await sendKeyEvent(target, { type: "keyUp", ...fields });
        } catch (error) {
            releaseKeyQuietly(target, { type: "keyUp", ...fields });
            throw error;
        }
        typed++;
    }
    return { dialog: null, typed };
}

function keyList(raw) {
    if (raw === undefined || raw === null || raw === "") return [];
    if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
    return [String(raw)];
}

function sameText(actual, expected, kind) {
    if (kind === "contenteditable") {
        const n = (s) => String(s === undefined || s === null ? "" : s).replace(/[\s ]+/g, " ").trim();
        return n(actual) === n(expected);
    }
    return String(actual === undefined || actual === null ? "" : actual) === String(expected);
}

function shortValue(value) {
    const text = String(value === undefined || value === null ? "" : value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}

// Valeur relue d'un champ, telle que l'agent la reçoit : marqueur pour un champ sensible (mot de passe, code, carte).
function shownValue(value, sensitive) {
    return sensitive ? LK.MASKED_VALUE : shortValue(value);
}

// Résultat d'une opération du kit de saisie (état, coche, option) : valeur masquée pour un champ sensible.
function maskEditState(state) {
    if (!state || typeof state !== "object" || !state.sensitive) return state;
    // Toutes les représentations de la valeur (texte du champ, option choisie), pas seulement value (Codex, 18/10).
    const masked = { ...state, value: LK.MASKED_VALUE };
    for (const key of ["text", "selectedValue", "selectedText"]) if (key in masked) masked[key] = LK.MASKED_VALUE;
    return masked;
}

/**
 * Repli sans débogueur : setter natif injecté par chrome.scripting (cadre principal), signalé comme tel.
 */
async function editJsFallback(tabId, locate, opts, reason) {
    const result = await mouseJsFallback(tabId, {
        phase: "edit", locate, op: "setValue", value: opts.value, append: !opts.replace
    }, reason, opts.timeoutMs);
    if (result.data) {
        const expected = opts.replace ? opts.value : null;
        result.data.verified = expected === null ? null : sameText(result.data.value, expected, result.data.kind);
        result.data.value = shownValue(result.data.value, result.data.sensitive);
        result.data.trusted_input = false;
        result.data.warning = "Debugger unavailable: value set by the native setter and synthetic events (isTrusted=false). Check the effect.";
        if (opts.keys.length) result.data.keys_not_sent = opts.keys;
    }
    return result;
}

/**
 * Saisie de confiance dans un champ (input, textarea, contenteditable) du cadre principal ou d'un cadre d'une autre
 * origine : focus par vrai clic CDP (ou DOM focus), remplacement par Ctrl+A réel (sélection JavaScript en repli),
 * texte par Input.insertText (ou touche par touche), touches spéciales, puis valeur relue (verified).
 * Repli setter natif signalé : débogueur indisponible, focus impossible, ou frappe restée sans aucun effet.
 */
async function typeIntoElement(tabId, locate, opts) {
    lastActionAt.set(tabId, Date.now());
    let target;
    try {
        target = await ensureDebugger(tabId);
    } catch (error) {
        if (opts.mode === "trusted") throw new Error(`Trusted typing impossible: debugger unavailable (${error.message || error})`);
        return await editJsFallback(tabId, locate, opts, error.message || String(error));
    }
    try {
        return await typeWithDebugger(target, locate, opts);
    } finally {
        scheduleDebuggerDetach(tabId);
    }
}

async function typeWithDebugger(target, locate, opts) {
    const prep = await prepareAnywhere(target, locate, {
        probe: ["keydown", "beforeinput", "input"], allowUnreachable: true, forEdit: true, timeoutMs: opts.timeoutMs
    });
    if (prep?.__dialog) return { data: { ...dialogInterruption(prep.__dialog), method: "cdp" } };
    if (!prep?.success) return { error: prepareError(prep, locate) };
    const root = prep.root || rootOf(target);
    const ref = { probeRef: prep.probeId };
    const edit = async (op, extra) => {
        const res = await pageCall(root, { phase: "edit", locate: ref, op, ...(extra || {}) });
        if (res?.__dialog) throw Object.assign(new Error("dialog"), { dialog: res.__dialog });
        return res;
    };
    const base = {
        tagName: prep.tagName, id: prep.id, replace: opts.replace,
        ...(root.key !== "top" ? { frame: prep.frame, crossOriginFrame: true } : {})
    };
    const finish = async (data) => {
        await releaseMouseProbes(root, [prep.probeId]);
        return { data };
    };
    try {
        let state = await edit("state");
        if (!state?.success) { await releaseMouseProbes(root, [prep.probeId]); return { error: state?.error || "Field not found" }; }
        base.kind = state.kind;
        if (state.kind === "select") {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `<select>: use browser_select_option (same locator).` };
        }
        if (state.kind === "other") {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `<${String(state.tagName || "element").toLowerCase()}> is not an input field (input, textarea or contenteditable).` };
        }
        if (state.disabled || state.readOnly) {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `${state.disabled ? "Disabled" : "Read-only"} field: nothing typed.` };
        }
        if (state.kind === "picker" && opts.mode === "trusted") {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `<input type=${state.type}>: trusted typing is not available for a picker field (date, time, color, range): use the default mode.` };
        }
        const before = state.value;
        const replace = opts.replace || state.kind === "picker";  // une date ou une heure se remplace, jamais ne s'ajoute
        const expected = replace ? opts.value : before + opts.value;
        const setter = async (reason) => {
            const res = await edit("setValue", { value: opts.value, append: !replace });
            const probe = await readMouseProbe(root, prep.probeId);
            return {
                data: {
                    success: true, ...base, method: "native_setter_fallback", fallback_reason: reason,
                    verified: sameText(res?.value, expected, state.kind), value: shownValue(res?.value, state.sensitive),
                    trusted_input: probe ? probe.seen.includes("input") : null,
                    ...(opts.keys.length ? { keys_not_sent: opts.keys } : {}),
                    warning: "Fallback: value set by the native setter and synthetic events (isTrusted=false), which some sites ignore. Check the effect."
                }
            };
        };
        if (opts.mode === "setter") return await setter("setter mode requested");
        if (state.kind === "picker") return await setter(`<input type=${state.type}>: picker field, value set as Playwright does`);

        // 1. Focus : vrai clic au point vérifié, sinon DOM focus.
        await ensureFocusEmulation(target);
        let focus = state.focused ? "already" : null;
        if (!focus && prep.point) {
            const run = await runMouseSequence(target, mouseClickSequence(prep.point.x, prep.point.y, "left", 1));
            if (run.dialog) return { data: { ...dialogInterruption(run.dialog), ...base, method: "cdp" } };
            state = await edit("state");
            if (state.focused) focus = "click";
        }
        if (!focus) {
            state = await edit("focus");
            if (state.focused) focus = "dom";
        }
        if (!focus) {
            const reason = `focus not possible${prep.unreachable ? ` (${prep.unreachable})` : ""}`;
            if (opts.mode === "trusted") { await releaseMouseProbes(root, [prep.probeId]); return { error: `Trusted typing impossible: ${reason}` }; }
            return await setter(reason);
        }

        // 2. Remplacement : Ctrl+A réel puis contrôle de la sélection ; ajout : caret en fin de texte.
        let selection = null;
        if (opts.replace && state.value.length) {
            const r = await pressKeyCombo(target, "Control+A");
            if (r.dialog) return { data: { ...dialogInterruption(r.dialog), ...base, method: "cdp" } };
            selection = "ctrl+a";
            const sel = await edit("selection");
            if (sel.allSelected === false) {
                await edit("selectAll");
                selection = "javascript";
            }
        } else if (!opts.replace) {
            await edit("caretEnd");
        }

        // 3. Texte : Input.insertText (beforeinput/input de confiance) ou touche par touche.
        if (opts.value.length) {
            if (opts.perKey) {
                const r = await typeCharacters(target, opts.value);
                if (r.dialog) return { data: { ...dialogInterruption(r.dialog), ...base, method: "cdp", typedLength: r.typed } };
            } else {
                assertNotStopped();
                const r = await sendCommandWatchingDialogs(target, "Input.insertText", { text: opts.value });
                if (r?.__dialog) return { data: { ...dialogInterruption(r.__dialog), ...base, method: "cdp" } };
            }
        } else if (opts.replace && state.value.length) {
            const r = await pressKeyCombo(target, "Backspace");
            if (r.dialog) return { data: { ...dialogInterruption(r.dialog), ...base, method: "cdp" } };
        }

        // 4. Relecture avant les touches finales (Entrée peut légitimement vider ou soumettre le champ).
        const after = await edit("state");
        const probe = await readMouseProbe(root, prep.probeId, false);
        // Effet prouvé : un input de confiance (un beforeinput annulé par la page ne compte pas).
        const trustedInput = probe ? probe.seen.includes("input") : null;
        const verified = sameText(after.value, expected, state.kind);
        if (!verified && trustedInput === false && sameText(after.value, before, state.kind) && opts.mode !== "trusted") {
            return await setter("trusted typing had no effect on the field");
        }

        // 5. Touches spéciales et raccourcis.
        const pressed = [];
        for (const combo of opts.keys) {
            const r = await pressKeyCombo(target, combo);
            pressed.push(combo);
            if (r.dialog) return { data: { ...dialogInterruption(r.dialog), ...base, method: "cdp", verified, keys: pressed } };
        }
        const data = {
            success: true, ...base, method: "cdp", typing: opts.perKey ? "keys" : "insertText", focus, selection,
            verified, value: shownValue(after.value, state.sensitive || after.sensitive), trusted_input: trustedInput,
            trusted_events: probe ? [...new Set(probe.seen)] : null
        };
        if (pressed.length) data.keys = pressed;
        if (!verified) {
            data.expected = shownValue(expected, state.sensitive || after.sensitive);
            data.warning = "Value read back differs from the expected value (input mask, filter or editor rewriting the text): check.";
        }
        return await finish(data);
    } catch (error) {
        if (error?.dialog) return { data: { ...dialogInterruption(error.dialog), ...base, method: "cdp" } };
        await releaseMouseProbes(root, [prep.probeId]);
        throw error;
    }
}

function typingMode(params) {
    const mode = String(params.mode || "auto").toLowerCase();
    if (!["auto", "trusted", "setter"].includes(mode)) throw new Error(`Unknown input mode '${params.mode}' (auto, trusted or setter)`);
    return mode;
}

function boolParam(value, fallback) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "string") return !["false", "0", "no", "non"].includes(value.toLowerCase());
    return !!value;
}

/**
 * fill (remplace par défaut) et type (ajoute au texte existant par défaut) : frappe de confiance.
 */
async function fillElement(params, defaults = {}) {
    const tabId = await resolveTargetTab(params);
    const value = params.value !== undefined && params.value !== null
        ? String(params.value)
        : (params.text !== undefined && params.text !== null ? String(params.text) : "");
    const locate = defaults.locate || targetLocate(params, { allowActive: true, allowText: false });
    return await typeIntoElement(tabId, locate, {
        value,
        replace: boolParam(params.replace, defaults.replace !== false),
        mode: typingMode(params),
        perKey: boolParam(params.perKey !== undefined ? params.perKey : params.per_key, false),
        keys: keyList(params.keys),
        timeoutMs: mouseTimeout(params, defaults.timeoutMs || 1200)
    });
}

/**
 * Frappe touche par touche dans l'élément qui a le focus, ou dans la cible donnée (locator, selector, mark).
 */
async function typeKeys(params) {
    const tabId = await resolveTargetTab(params);
    const text = params.text !== undefined && params.text !== null ? String(params.text) : "";
    const locate = targetLocate(params, { allowText: false });
    if (locate) {
        return await typeIntoElement(tabId, locate, {
            value: text, replace: boolParam(params.replace, false), mode: "trusted", perKey: true,
            keys: keyList(params.keys), timeoutMs: mouseTimeout(params, 1200)
        });
    }
    lastActionAt.set(tabId, Date.now());
    const target = await ensureDebugger(tabId);
    const r = await typeCharacters(target, text);
    if (r.dialog) return { data: { ...dialogInterruption(r.dialog), typedLength: r.typed } };
    for (const combo of keyList(params.keys)) {
        const k = await pressKeyCombo(target, combo);
        if (k.dialog) return { data: { ...dialogInterruption(k.dialog), typedLength: r.typed } };
    }
    return { data: { success: true, typedLength: r.typed, method: "cdp" } };
}

async function scrollPage(params = {}) {
    let tabId = await resolveTargetTab(params);
    // Onglet en arrière-plan : document caché, rendu et requestAnimationFrame suspendus, IntersectionObserver muet,
    // donc un fil infini (X, Reddit, LinkedIn, YouTube) ne charge plus la suite (mesuré le 26/10 sur x.com : 5 posts
    // sur 8 défilements). L'émulation du focus rend la page visible et active sans toucher à l'onglet ni à la fenêtre
    // de l'utilisateur (même mesure : visibilityState "visible", 21 posts ; Reddit : 3 → 24).
    await ensureFocusEmulation(await ensureDebugger(tabId));

    const sign = params.direction === "up" ? -1 : 1;
    const dy = sign * Math.abs(params.y !== undefined && params.y !== null ? Number(params.y) : 500);
    const dx = Number(params.x || 0);

    return await evaluateIsolated({
        tabId,
        code: `(() => {
            window.scrollBy({ left: ${dx}, top: ${dy}, behavior: ${JSON.stringify(String(params.behavior || "instant"))} });
            return { scrollX: window.scrollX, scrollY: window.scrollY };
        })()`
    });
}

// Remise de secours de la barre de défilement après une capture d'élément au-delà de la vue (voir takeScreenshot).
const SCROLLBAR_RESTORE_FALLBACK_MS = 15000;
const SCREENSHOT_FORMATS = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };
// Plus grande dimension d'image que Chrome sait rendre en une capture (limite de texture de Skia).
const FULL_PAGE_MAX_PX = 16384;

/**
 * Boîte d'un élément (repère de la vue, getBoundingClientRect) -> zone de Page.captureScreenshot, en repère de la
 * PAGE : défilement ajouté (Page.getLayoutMetrics, comme Puppeteer), sinon la capture d'une page défilée rognait
 * à côté de l'élément, puis zoom de la page appliqué. Partie hors du document (x ou y négatif) retirée.
 */
async function pageClip(target, rect) {
    let pageX = 0;
    let pageY = 0;
    let zoom = 1;
    try {
        const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
        const view = metrics?.cssVisualViewport || metrics?.visualViewport || metrics?.cssLayoutViewport || metrics?.layoutViewport || {};
        pageX = Number(view.pageX) || 0;
        pageY = Number(view.pageY) || 0;
        // Zoom de la page (Ctrl + molette, zoom par défaut de Chrome) : la zone de capture est en pixels non zoomés.
        // Sans lui, Chrome à 90 % rognait à côté de l'élément (image blanche ; mesuré le 18/10).
        zoom = Number(metrics?.cssVisualViewport?.zoom) > 0 ? Number(metrics.cssVisualViewport.zoom) : 1;
    } catch (_) {}
    let x = (Number(rect.x) + pageX) * zoom;
    let y = (Number(rect.y) + pageY) * zoom;
    let width = Number(rect.width) * zoom;
    let height = Number(rect.height) * zoom;
    if (x < 0) { width += x; x = 0; }
    if (y < 0) { height += y; y = 0; }
    return {
        x: Math.round(x), y: Math.round(y),
        width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)), scale: 1
    };
}

/**
 * Champs sensibles (mot de passe affiché par un bouton « afficher », carte, code) rendus en disques le temps d'une
 * capture ou d'un PDF : -webkit-text-security posé en style en ligne dans tous les cadres (composants et cadres
 * same-origin compris, cadres d'une autre origine par leur propre contexte), puis l'ancien style remis. État gardé
 * dans le monde isolé de l'extension : la page ne le voit pas. Renvoie le nombre de champs masqués (on) ou rendus.
 */
function captureMaskScript(on) {
    return `(() => {
        const lk = ${SENSITIVE_FIELD_EXPR};
        const saved = globalThis.__nexusCaptureMask || (globalThis.__nexusCaptureMask = []);
        const P = "-webkit-text-security";
        if (!${on ? "true" : "false"}) {
            const n = saved.length;
            for (const [el, value, priority] of saved.splice(0)) {
                try { if (value) el.style.setProperty(P, value, priority); else el.style.removeProperty(P); } catch (_) {}
            }
            return n;
        }
        const seen = new Set(saved.map(s => s[0]));
        const visit = (root) => {
            if (!root || !root.querySelectorAll) return;
            for (const el of root.querySelectorAll("*")) {
                if (el.shadowRoot) visit(el.shadowRoot);
                if (String(el.tagName).toUpperCase() === "IFRAME") {
                    let doc = null;
                    try { doc = el.contentDocument; } catch (_) {}
                    visit(doc);
                }
                if (seen.has(el) || !el.style || String(el.type || "").toLowerCase() === "password") continue;
                if (!lk.sensitiveField(el)) continue;
                saved.push([el, el.style.getPropertyValue(P), el.style.getPropertyPriority(P)]);
                seen.add(el);
                el.style.setProperty(P, "disc", "important");
            }
        };
        visit(document);
        return saved.length;
    })()`;
}

async function maskSensitiveFields(tabId, on) {
    const code = captureMaskScript(on);
    const top = await evaluateIsolated({ tabId, code });
    if (on && typeof top?.data !== "number") {
        // Boîte de dialogue ou script refusé : aucune image d'une page dont les champs n'ont pas pu être masqués.
        throw new Error("Screenshot refused: sensitive fields cannot be masked in the page " +
            "(dialog open? browser_handle_dialog)");
    }
    let count = Number(top?.data) || 0;
    for (const { value } of await crossOriginFrameEvaluations(tabId, code)) count += Number(value) || 0;
    return count;
}

/** work() (capture, PDF) exécuté avec les champs sensibles masqués dans l'image, puis remis comme avant. */
async function withSensitiveFieldsMasked(tabId, work) {
    await maskSensitiveFields(tabId, true);
    try {
        return await work();
    } finally {
        await maskSensitiveFields(tabId, false).catch(() => {});
    }
}

/**
 * Page.captureScreenshot d'un onglet de fond, sans le mettre au premier plan. Onglet caché : après un défilement ou
 * un changement, Chrome ne dessine plus d'image et la capture attendait 12 à 20 s (mesuré le 18/10 : 11 gels sur 20).
 * Un flux d'images (Page.startScreencast, minuscule, jamais lu) tenu le temps de la capture garde le rendu actif.
 */
async function captureScreenshot(target, params) {
    let screencast = false;
    const key = captureTargetKey(target);
    captureScreencasts.add(key);
    try {
        await chrome.debugger.sendCommand(target, "Page.startScreencast", {
            format: "jpeg", quality: 1, maxWidth: 16, maxHeight: 16
        });
        screencast = true;
    } catch (_) {
        // Flux indisponible : capture directe (onglet visible, ou Chrome qui refuse le flux).
    }
    try {
        return await chrome.debugger.sendCommand(target, "Page.captureScreenshot", params);
    } finally {
        if (screencast) await chrome.debugger.sendCommand(target, "Page.stopScreencast").catch(() => {});
        captureScreencasts.delete(key);
    }
}

async function takeScreenshot(params = {}) {
    let tabId = await resolveTargetTab(params);
    const format = String(params.format || "png").toLowerCase();
    const mimeType = SCREENSHOT_FORMATS[format];
    if (!mimeType) throw new Error(`Unknown screenshot format: ${params.format} (png, jpeg or webp)`);
    const cdpFormat = format === "jpg" ? "jpeg" : format;

    const target = await ensureDebugger(tabId);
    
    if (params.region) {
        // Zone de la vue (pixels CSS de la vue) agrandie : clip.scale (1/4 à 4) choisi par le serveur pour que l'image
        // tienne dans les plafonds de la règle commune ; lire un petit texte sans envoyer tout l'écran en grand.
        const r = params.region;
        const values = [r.x, r.y, r.width, r.height].map(Number);
        if (values.some(v => !Number.isFinite(v)) || values[2] <= 0 || values[3] <= 0) {
            return { error: "Invalid region: {x, y, width, height} in CSS pixels of the view." };
        }
        const scale = Math.min(4, Math.max(0.25, Number(params.scale) || 1));
        const clip = { ...(await pageClip(target, { x: values[0], y: values[1], width: values[2], height: values[3] })), scale };
        const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, { format: cdpFormat, clip }));
        let zoom = 1;
        try {
            const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
            if (Number(metrics?.cssVisualViewport?.zoom) > 0) zoom = Number(metrics.cssVisualViewport.zoom);
        } catch (_) {}
        const ratio = await evaluateIsolated({ tabId, code: "window.devicePixelRatio" });
        const devicePixelRatio = Number(ratio?.data) > 0 ? Number(ratio.data) : null;
        return { data: { dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType, clip, zoom, devicePixelRatio } };
    }

    if (params.selector) {
        const sel = JSON.stringify(params.selector);
        const elRect = await evaluateIsolated({
            tabId,
            code: `(() => {
                const selector = ${sel};
                function findIn(root) {
                    if (!root) return null;
                    if (typeof selector === "string" && selector.startsWith("#") && /^[0-9]+$/.test(selector.slice(1))) {
                        const markNum = parseInt(selector.slice(1));
                        if (window.__nexus_som_elements && window.__nexus_som_elements.has(markNum)) {
                            return window.__nexus_som_elements.get(markNum);
                        }
                    }
                    if (root.querySelectorAll) {
                        try {
                            const els = root.querySelectorAll(selector);
                            if (els.length > 0) return els[0];
                        } catch(e) {}
                    }
                    if (root.querySelectorAll) {
                        for (const child of root.querySelectorAll("*")) {
                            if (child.shadowRoot) {
                                const found = findIn(child.shadowRoot);
                                if (found) return found;
                            }
                        }
                    }
                    return null;
                }
                const el = findIn(document);
                if (!el) return null;
                // Élément gardé dans le monde isolé : la remesure (élément au-delà de la vue) vise exactement le même,
                // composants (Shadow DOM) et repères compris.
                globalThis.__nexusCaptureTarget = el;
                el.scrollIntoView({ behavior: "instant", block: "center" });
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return null;
                return {
                    x: r.x, y: r.y, width: r.width, height: r.height,
                    viewWidth: document.documentElement?.clientWidth, viewHeight: document.documentElement?.clientHeight,
                    devicePixelRatio: window.devicePixelRatio
                };
            })()`
        });
        if (elRect?.data) {
            let rect = elRect.data;
            // captureBeyondViewport retire l'espace de la barre de défilement : la page se décale PENDANT la capture
            // (zone mesurée avant, image rognée à côté ; relevé par Codex le 24/10). Seulement pour un élément qui
            // dépasse vraiment la vue, et alors mesuré dans cette géométrie-là : barre masquée (scrollbar-width: none
            // sur <html>) le temps de la mesure et de la capture. Seule cette propriété est notée puis remise (les
            // autres styles, même changés par la page entre-temps, restent) ; une remise de secours part toute seule
            // (minuterie du monde isolé) si la remise normale est bloquée, par une boîte de dialogue par exemple.
            const inView = rect.viewWidth > 0 && rect.viewHeight > 0 && rect.x >= 0 && rect.y >= 0
                && rect.x + rect.width <= rect.viewWidth && rect.y + rect.height <= rect.viewHeight;
            let restoreScrollbar = null;
            if (!inView) {
                const measured = await evaluateIsolated({
                    tabId,
                    code: `(() => {
                        const root = document.documentElement, P = "scrollbar-width";
                        if (!root || !root.style || typeof root.style.getPropertyValue !== "function") return { applied: false };
                        // Remise encore en attente d'une capture précédente (boîte de dialogue fermée, nouvel essai
                        // avant la minuterie) : faite AVANT de noter l'état, sinon « none » serait pris pour l'origine
                        // (relevé par Codex le 24/10).
                        if (typeof globalThis.__nexusScrollbarRestore === "function") globalThis.__nexusScrollbarRestore();
                        const state = {
                            value: root.style.getPropertyValue(P), priority: root.style.getPropertyPriority(P),
                            hadStyle: typeof root.hasAttribute === "function" && root.hasAttribute("style"), done: false
                        };
                        // Remise liée à CETTE capture (sa minuterie n'appelle jamais celle d'une autre), idempotente.
                        const restore = () => {
                            if (state.done) return true;
                            state.done = true;
                            if (state.value) root.style.setProperty(P, state.value, state.priority);
                            else root.style.removeProperty(P);
                            if (!state.hadStyle && root.getAttribute("style") === "") root.removeAttribute("style");
                            if (globalThis.__nexusScrollbarRestore === finish) globalThis.__nexusScrollbarRestore = null;
                            return true;
                        };
                        const timer = typeof setTimeout === "function" ? setTimeout(restore, ${SCROLLBAR_RESTORE_FALLBACK_MS}) : null;
                        const finish = () => { if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer); return restore(); };
                        globalThis.__nexusScrollbarRestore = finish;
                        root.style.setProperty(P, "none");
                        const el = globalThis.__nexusCaptureTarget;
                        const r = el && el.isConnected !== false ? el.getBoundingClientRect() : null;
                        return { applied: true, rect: r && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null };
                    })()`
                });
                // Boîte de dialogue ouverte par la page pendant la mesure : aucune capture (elle attendrait la boîte),
                // l'interruption est rendue telle quelle ; la minuterie remet la barre dès la boîte fermée.
                if (measured?.data?.dialogOpened) return measured;
                if (measured?.data?.applied) {
                    restoreScrollbar = async () => {
                        const done = await evaluateIsolated({
                            tabId, code: "globalThis.__nexusScrollbarRestore ? globalThis.__nexusScrollbarRestore() : true"
                        }).catch(() => null);
                        if (done?.data !== true) console.log("[NexusBrowser] Scrollbar restore deferred to the isolated-world timer.");
                    };
                }
                if (measured?.data?.applied && !measured.data.rect) {
                    await restoreScrollbar();
                    // Jamais une zone périmée annoncée juste : l'élément a disparu ou changé pendant la mesure.
                    return { error: "Element moved or disappeared while measuring the screenshot: try again." };
                }
                if (measured?.data?.rect) rect = { ...rect, ...measured.data.rect };
            }
            const clip = await pageClip(target, rect);
            let shot;
            try {
                shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, {
                    format: cdpFormat,
                    clip,
                    captureBeyondViewport: !inView
                }));
            } finally {
                if (restoreScrollbar) await restoreScrollbar();
            }
            // clip est en pixels CSS × zoom de la page (pageClip) : zoom rendu pour revenir aux pixels CSS.
            let zoom = 1;
            try {
                const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
                if (Number(metrics?.cssVisualViewport?.zoom) > 0) zoom = Number(metrics.cssVisualViewport.zoom);
            } catch (_) {}
            const devicePixelRatio = Number(rect.devicePixelRatio) > 0 ? Number(rect.devicePixelRatio) : null;
            return { data: { dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType, clip, zoom, devicePixelRatio } };
        } else {
            return { error: "Element not found for screenshot selector: " + params.selector };
        }
    }

    if (params.fullPage) {
        // Page entière (comme Puppeteer fullPage) : taille du contenu en pixels CSS, zoom de la page appliqué comme
        // pour un élément (pageClip), hauteur bornée à la taille d'image maximale de Chrome.
        const metrics = await chrome.debugger.sendCommand(target, "Page.getLayoutMetrics");
        const size = metrics?.cssContentSize || metrics?.contentSize || {};
        const zoom = Number(metrics?.cssVisualViewport?.zoom) > 0 ? Number(metrics.cssVisualViewport.zoom) : 1;
        const width = Math.min(Math.max(1, Math.ceil(Number(size.width) || 0)), Math.floor(FULL_PAGE_MAX_PX / zoom));
        const fullHeight = Math.max(1, Math.ceil(Number(size.height) || 0));
        const height = Math.min(fullHeight, Math.floor(FULL_PAGE_MAX_PX / zoom));
        const clip = { x: 0, y: 0, width: Math.round(width * zoom), height: Math.round(height * zoom), scale: 1 };
        const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, {
            format: cdpFormat, clip, captureBeyondViewport: true
        }));
        const ratio = await evaluateIsolated({ tabId, code: "window.devicePixelRatio" });
        const devicePixelRatio = Number(ratio?.data) > 0 ? Number(ratio.data) : null;
        return { data: {
            dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType, clip, zoom, devicePixelRatio,
            fullPage: { width, height, truncated: height < fullHeight || width < Math.ceil(Number(size.width) || 0) }
        } };
    }

    const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, { format: cdpFormat }));
    const ratio = await evaluateIsolated({ tabId, code: "window.devicePixelRatio" });
    const devicePixelRatio = Number(ratio?.data) > 0 ? Number(ratio.data) : null;
    return { data: { dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType, devicePixelRatio } };
}

/**
 * Headless PDF Generation directly via CDP Page.printToPDF
 */
async function printToPdf(params = {}) {
    let tabId = await resolveTargetTab(params);

    const target = await ensureDebugger(tabId);
    const pdfData = await withSensitiveFieldsMasked(tabId, () => chrome.debugger.sendCommand(target, "Page.printToPDF", {
        landscape: params.landscape || false,
        displayHeaderFooter: params.displayHeaderFooter || false,
        printBackground: true,
        scale: params.scale !== undefined ? Number(params.scale) : 1.0,
        paperWidth: params.paperWidth !== undefined ? Number(params.paperWidth) : 8.27,
        paperHeight: params.paperHeight !== undefined ? Number(params.paperHeight) : 11.69
    }));

    return { data: { pdfBase64: pdfData.data, mimeType: "application/pdf" } };
}

async function handleJsDialog(params = {}) {
    // tab_id obligatoire : sans lui, l'agent répondrait peut-être à la boîte d'un autre agent ou de Julien.
    const tabId = await resolveTargetTab(params);
    const dialog = pendingDialogs.get(tabId) || null;
    const accept = params.accept !== false;
    const promptText = params.promptText !== undefined && params.promptText !== null
        ? String(params.promptText)
        : (params.prompt_text !== undefined && params.prompt_text !== null ? String(params.prompt_text) : "");
    const root = await ensureDebugger(tabId);
    // Boîte ouverte dans une iframe hors processus : la réponse part par la session de ce cadre.
    const target = dialog?.sessionId ? { tabId, sessionId: dialog.sessionId } : root;
    await chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", { accept, promptText });
    pendingDialogs.delete(tabId);
    return { data: { success: true, tabId, accepted: accept, dialog: dialog ? publicDialog(dialog) : null } };
}

// Commandes CDP brutes PERMISES (browser_cdp_send) : lecture de la page, captures, entrées et affichage de l'onglet de
// l'agent. Tout le reste est refusé (liste fermée, nom exact) : cookies et stockage (Storage.clearDataForOrigin
// déconnecterait Julien), corps et données POST des requêtes (mots de passe), Network.loadNetworkResource / IO.read,
// Fetch (onglet bloqué), scripts injectés à chaque document (Page.addScriptToEvaluateOnNewDocument), navigation
// (file://), téléchargements, fichiers téléversés, autres cibles et réglages du navigateur.
const CDP_ALLOWED = new Set([
    // DOM et styles, en lecture
    "DOM.enable", "DOM.disable", "DOM.getDocument", "DOM.querySelector", "DOM.querySelectorAll", "DOM.describeNode",
    "DOM.getBoxModel", "DOM.getContentQuads", "DOM.getOuterHTML", "DOM.getNodeForLocation", "DOM.getFrameOwner",
    "DOM.requestChildNodes", "DOM.performSearch", "DOM.getSearchResults", "DOM.discardSearchResults",
    "DOM.scrollIntoViewIfNeeded", "CSS.enable", "CSS.disable", "CSS.getComputedStyleForNode",
    // Accessibilité
    "Accessibility.enable", "Accessibility.disable", "Accessibility.getFullAXTree", "Accessibility.getPartialAXTree",
    "Accessibility.queryAXTree", "Accessibility.getChildAXNodes", "Accessibility.getRootAXNode",
    // Exécution : Runtime.evaluate dans le monde isolé par défaut, monde de la page sur demande (world: "page")
    "Runtime.enable", "Runtime.evaluate",
    // Page : captures, mesures, cadres, rechargement de SON onglet
    "Page.enable", "Page.captureScreenshot", "Page.getLayoutMetrics", "Page.printToPDF", "Page.getFrameTree",
    "Page.getNavigationHistory", "Page.reload", "Page.stopLoading",
    // Entrées (onglet de l'agent seulement : vérifié avant toute commande)
    "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchTouchEvent",
    "Input.dispatchDragEvent", "Input.synthesizeScrollGesture", "Input.imeSetComposition",
    // Affichage
    "Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride", "Emulation.setEmulatedMedia",
    "Emulation.setEmulatedVisionDeficiency", "Emulation.setTouchEmulationEnabled", "Emulation.setEmitTouchEventsForMouse",
    "Emulation.setFocusEmulationEnabled", "Emulation.setDefaultBackgroundColorOverride", "Emulation.setScrollbarsHidden",
    "Emulation.setPageScaleFactor", "Emulation.setAutoDarkModeOverride",
    "Overlay.enable", "Overlay.disable", "Overlay.highlightNode", "Overlay.highlightRect", "Overlay.hideHighlight",
    // Réseau : activation seulement (le journal et les corps passent par les outils dédiés, secrets masqués)
    "Network.enable", "Network.disable", "Network.setCacheDisabled",
    // Console et performances
    "Log.enable", "Log.disable", "Log.clear", "Console.enable", "Console.disable", "Console.clearMessages",
    "Performance.enable", "Performance.disable", "Performance.getMetrics"
]);

// Paramètres refusés sur une commande permise : Page.reload(scriptToEvaluateOnLoad) injecterait un script dans le
// monde de la page avant ses propres scripts, comme Page.addScriptToEvaluateOnNewDocument (refusée).
const CDP_REFUSED_PARAMS = { "Page.reload": ["scriptToEvaluateOnLoad"] };

function cdpRefusal(method, commandParams) {
    const name = String(method || "").trim();
    if (!name) return "Missing CDP method";
    const refusedParam = (CDP_REFUSED_PARAMS[name] || []).find(key =>
        commandParams && typeof commandParams === "object" && Object.prototype.hasOwnProperty.call(commandParams, key));
    if (refusedParam) {
        return `CDP command refused: ${name} with ${refusedParam} (script injected into the page on load). ` +
            `Reload without this parameter, then run the script with browser_eval.`;
    }
    if (CDP_ALLOWED.has(name)) return null;
    return `CDP command refused: ${name} is not in the list of allowed commands (page reading, ` +
        "screenshots, input and display of the agent's tab). Cookies, storage, request bodies, Fetch, IO, " +
        "injected scripts, navigation and downloads go through the dedicated tools (browser_get_cookies, " +
        "browser_network_response, browser_navigate...).";
}

const CDP_WORLDS = new Set(["isolated", "page"]);
const CDP_IMAGE_METHODS = new Set(["Page.captureScreenshot", "Page.printToPDF"]);

async function sendCdpCommand(params) {
    const refusal = cdpRefusal(params.method, params.commandParams);
    if (refusal) throw new Error(refusal);
    const method = String(params.method).trim();
    const world = params.world === undefined || params.world === null || params.world === "" ? "isolated" : String(params.world);
    if (!CDP_WORLDS.has(world)) throw new Error(`Invalid world: ${world.slice(0, 40)} ("isolated" by default, or "page").`);
    if (world !== "isolated" && method !== "Runtime.evaluate") {
        throw new Error(`world="${world}" applies only to Runtime.evaluate (not to ${method}).`);
    }
    const tabId = await resolveTargetTab(params);
    let target = await ensureDebugger(tabId);
    let evaluationRoot = rootOf(target);
    if (params.mark !== undefined && params.mark !== null) {
        if (method !== "Runtime.evaluate" || world !== "isolated" || !Number.isInteger(params.mark) || params.mark < 1) {
            throw new Error("A mark context requires an integer mark and Runtime.evaluate in the isolated world.");
        }
        const key = markRoots.get(tabId)?.get(params.mark);
        if (key) {
            evaluationRoot = (await listFrameRoots(target)).find(root => root.key === key);
            if (!evaluationRoot) throw new Error(`The frame of mark #${params.mark} is gone: run browser_interactive_map again.`);
            target = evaluationRoot.target;
        }
    }
    let commandParams = params.commandParams && typeof params.commandParams === "object" && !Array.isArray(params.commandParams)
        ? { ...params.commandParams } : {};
    if (method === "Runtime.evaluate") {
        // Contexte imposé (jamais celui choisi par l'agent) et aucune API de la console (copy() écrirait le
        // presse-papiers) : monde isolé de l'extension par défaut ; monde de la PAGE sur demande explicite (comme
        // browser_eval et la console DevTools), pour lire l'état d'une application (store, __INITIAL_STATE__).
        delete commandParams.uniqueContextId;
        delete commandParams.contextId;
        commandParams.includeCommandLineAPI = false;
        if (world === "isolated") commandParams.contextId = await rootContextId(evaluationRoot);
        const result = await sendCommandWatchingDialogs(target, method, commandParams);
        if (result?.__dialog) return { data: dialogInterruption(result.__dialog) };
        return { data: { ...result, world } };
    }
    if (method.startsWith("Input.")) assertNotStopped();
    // Image brute (capture, PDF) : champs sensibles masqués comme dans browser_screenshot et browser_pdf.
    const send = () => chrome.debugger.sendCommand(target, method, commandParams);
    const result = CDP_IMAGE_METHODS.has(method) ? await withSensitiveFieldsMasked(tabId, send) : await send();
    return { data: result };
}

// -----------------------------------------------------------------------------
// SOTA Enhancements: FileChooser, Vision Grounding (SoM), Semantics & Handoff
// -----------------------------------------------------------------------------

/**
 * Intercept and upload files directly to inputs or upload dropzones via CDP
 */
async function uploadFiles(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!params.files || !Array.isArray(params.files) || params.files.length === 0) {
        throw new Error("Missing 'files' parameter (array of absolute file paths)");
    }

    if (activeUploads.has(tabId)) throw new Error("An upload is already pending for this tab");
    activeUploads.add(tabId);
    let target;
    let timeoutId;
    let fileChooserIntercepted = false;
    try {
        target = await ensureDebugger(tabId);
        await chrome.debugger.sendCommand(target, "DOM.enable");
        const selector = params.selector || 'input[type="file"]';
        const doc = await chrome.debugger.sendCommand(target, "DOM.getDocument", { depth: -1 });
        const query = await chrome.debugger.sendCommand(target, "DOM.querySelector", {
            nodeId: doc.root.nodeId, selector
        });
        if (!query.nodeId) throw new Error(`Upload element not found: ${selector}`);
        const description = await chrome.debugger.sendCommand(target, "DOM.describeNode", { nodeId: query.nodeId });
        const attributes = description.node.attributes || [];
        const typeIndex = attributes.indexOf("type");
        if (description.node.nodeName === "INPUT" && typeIndex >= 0 && attributes[typeIndex + 1].toLowerCase() === "file") {
            await chrome.debugger.sendCommand(target, "DOM.setFileInputFiles", { files: params.files, nodeId: query.nodeId });
            return { data: { success: true, method: "direct_dom", files: params.files, selector } };
        }
        await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: true });
        fileChooserIntercepted = true;
        return await new Promise((resolve, reject) => {
            timeoutId = setTimeout(() => reject(new Error("File chooser upload timed out after 10s")), 10000);
            pendingFileChoosers.set(tabId, {
                files: params.files,
                resolve: data => resolve({ data }),
                reject
            });
            clickElement({ tabId, selector }).then(result => {
                if (result.error || result.data?.error) reject(new Error(result.error || result.data.error));
            }, reject);
        });
    } finally {
        clearTimeout(timeoutId);
        pendingFileChoosers.delete(tabId);
        try {
            if (target && fileChooserIntercepted) {
                await chrome.debugger.sendCommand(target, "Page.setInterceptFileChooserDialog", { enabled: false });
            }
        } catch (_) {}
        activeUploads.delete(tabId);
    }
}

/**
 * Gemini Set-of-Mark (SoM) Visual Grounding
 * Renders numbered neon badges on all interactive elements, captures high-res screenshot, and cleans up.
 */
async function visionInspect(params = {}) {
    let tabId = await resolveTargetTab(params);

    const target = await ensureDebugger(tabId);

    // 1. Inject SoM markers and register elements in page context
    markRoots.delete(tabId);  // marqueurs de vision : cadre principal seulement
    const markerData = await evaluateIsolated({
        tabId,
        code: `(() => {
            const lk = ${SENSITIVE_FIELD_EXPR};
            if (!window.__nexus_som_elements) {
                window.__nexus_som_elements = new Map();
            } else {
                window.__nexus_som_elements.clear();
            }
            document.querySelectorAll(".__nexus_som_marker").forEach(m => {
                if (m && typeof m.remove === "function") m.remove();
                else if (m?.parentNode) m.parentNode.removeChild(m);
            });

            const selector = "button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [role='checkbox'], [role='menuitem'], [onclick], [tabindex]";
            const w = window.innerWidth || (document.documentElement ? document.documentElement.clientWidth : 1) || 1;
            const h = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 1) || 1;

            function collectCandidates(root, list = []) {
                if (!root || !root.querySelectorAll) return list;
                try {
                    const found = Array.from(root.querySelectorAll(selector));
                    for (const el of found) list.push(el);
                    const all = root.querySelectorAll("*");
                    for (const el of all) {
                        if (el.shadowRoot) collectCandidates(el.shadowRoot, list);
                    }
                    const iframes = root.querySelectorAll("iframe");
                    for (const f of iframes) {
                        try {
                            if (f.contentDocument) collectCandidates(f.contentDocument, list);
                        } catch(_) {}
                    }
                } catch(_) {}
                return list;
            }

            const candidates = collectCandidates(document);
            const seen = new Set();
            const markers = [];
            let markerId = 1;

            for (const el of candidates) {
                if (markerId > 80) break;
                if (seen.has(el)) continue;
                seen.add(el);

                let rect;
                try { rect = el.getBoundingClientRect(); } catch(_) { continue; }
                if (rect.width <= 4 || rect.height <= 4) continue;
                if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) continue;

                let style;
                try { style = window.getComputedStyle(el); } catch(_) {}
                if (style && (style.display === "none" || style.visibility === "hidden" || style.opacity === "0")) continue;

                const badge = document.createElement("div");
                badge.className = "__nexus_som_marker";
                badge.innerText = String(markerId);
                badge.style.position = "fixed";
                badge.style.left = Math.max(0, Math.round(rect.left)) + "px";
                badge.style.top = Math.max(0, Math.round(rect.top)) + "px";
                badge.style.backgroundColor = "#ff0055";
                badge.style.color = "#ffffff";
                badge.style.fontSize = "11px";
                badge.style.fontWeight = "bold";
                badge.style.padding = "1px 5px";
                badge.style.borderRadius = "3px";
                badge.style.border = "1px solid #ffffff";
                badge.style.boxShadow = "0 2px 5px rgba(0,0,0,0.6)";
                badge.style.zIndex = "2147483646";
                badge.style.pointerEvents = "none";
                badge.style.fontFamily = "monospace";

                document.documentElement.appendChild(badge);
                window.__nexus_som_elements.set(markerId, el);

                const ymin = Math.max(0, Math.min(1000, Math.round((rect.top / h) * 1000)));
                const xmin = Math.max(0, Math.min(1000, Math.round((rect.left / w) * 1000)));
                const ymax = Math.max(0, Math.min(1000, Math.round((rect.bottom / h) * 1000)));
                const xmax = Math.max(0, Math.min(1000, Math.round((rect.right / w) * 1000)));

                markers.push({
                    mark: markerId,
                    tag: el.tagName ? el.tagName.toLowerCase() : "element",
                    role: (el.getAttribute ? el.getAttribute("role") : null) || null,
                    type: el.type || null,
                    text: ((lk.sensitiveField(el) ? "" : (el.innerText || el.value)) || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || "").trim().slice(0, 80),
                    ...(lk.sensitiveField(el) ? { value: lk.MASKED_VALUE } : {}),
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                    box_2d: [ymin, xmin, ymax, xmax]
                });
                markerId++;
            }

            return { markers, title: document.title, url: window.location.href, devicePixelRatio: window.devicePixelRatio };
        })()`
    });

    // 2. Court délai de rendu des badges (lecture : permise pendant l'arrêt d'urgence, donc pas sleepMs)
    await new Promise(r => setTimeout(r, 50));

    // 3. High-res visual screenshot
    const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, {
        format: "png"
    }));

    // 4. Clean up visual marker badges from DOM (keeps window.__nexus_som_elements for clicks by mark)
    await evaluateIsolated({
        tabId,
        code: `document.querySelectorAll(".__nexus_som_marker").forEach(m => {
            if (m && typeof m.remove === "function") m.remove();
            else if (m?.parentNode) m.parentNode.removeChild(m);
        })`
    });

    return {
        data: {
            title: markerData?.data?.title,
            url: markerData?.data?.url,
            markerCount: markerData?.data?.markers?.length || 0,
            markers: markerData?.data?.markers || [],
            devicePixelRatio: Number(markerData?.data?.devicePixelRatio) > 0 ? Number(markerData.data.devicePixelRatio) : null,
            screenshotDataUrl: `data:image/png;base64,${shot.data}`
        }
    };
}

/**
 * Detect security challenges (2FA, SMS code, Authenticator, Cloudflare Turnstile, CAPTCHA)
 */
async function checkHandoff(params = {}) {
    let tabId = await resolveTargetTab(params);

    return await evaluateIsolated({
        tabId,
        code: `(() => {
            const bodyText = (document.body ? document.body.innerText : "").toLowerCase();
            const html = (document.documentElement ? document.documentElement.outerHTML : "").toLowerCase();

            const isCloudflare = html.includes("cf-turnstile") || html.includes("challenges.cloudflare.com") || html.includes("vérifier que vous êtes humain");
            const isCaptcha = html.includes("g-recaptcha") || html.includes("hcaptcha") || html.includes("captcha-box");
            const is2FA = bodyText.includes("validation en deux étapes") || bodyText.includes("two-factor") || bodyText.includes("authenticator") || bodyText.includes("code envoyé par sms") || bodyText.includes("appuyez sur oui sur votre téléphone");

            if (isCloudflare) return { handoffRequired: true, type: "cloudflare", message: "Cloudflare Turnstile verification challenge detected." };
            if (isCaptcha) return { handoffRequired: true, type: "captcha", message: "CAPTCHA challenge detected." };
            if (is2FA) return { handoffRequired: true, type: "2fa", message: "2FA authentication challenge detected (mobile verification required)." };

            return { handoffRequired: false, message: "No authentication challenge detected." };
        })()`
    });
}

/**
 * Track ongoing and recent downloads
 */
async function getDownloadStatus(params = {}) {
    const items = await chrome.downloads.search({ limit: params.limit || 5, orderBy: ["-startTime"] });
    return {
        data: items.map(d => ({
            id: d.id,
            filename: d.filename,
            state: d.state,
            danger: d.danger,
            totalBytes: d.totalBytes,
            bytesReceived: d.bytesReceived,
            mime: d.mime,
            startTime: d.startTime,
            endTime: d.endTime
        }))
    };
}

// -----------------------------------------------------------------------------
// Journal réseau par onglet : tampon circulaire des requêtes vues par le débogueur (session principale et iframes
// hors processus). Les en-têtes secrets (Cookie, Authorization...) ne sortent jamais en clair.
// -----------------------------------------------------------------------------
const NETWORK_BUFFER_SIZE = 500;
const tabNetwork = new Map();
// En-têtes secrets : noms connus, et tout nom qui évoque un jeton, une clé, une session ou une signature.
const SECRET_HEADER = /^(cookie|set-cookie|set-cookie2)$|authorization|token|key|secret|csrf|xsrf|session|signature|password|auth/i;
// Paramètres d'URL secrets (requête et fragment) : jetons OAuth, clés d'API, signatures d'URL présignées (S3, GCS).
const SECRET_URL_PARAM = /^(code|key|sig|auth|x-amz-.+|x-goog-(signature|credential).*)$|token|secret|passw|signature|credential|session|api[_-]?key/i;
const TEXTUAL_MIME = /^(text\/|application\/(json|ld\+json|javascript|ecmascript|xml|xhtml\+xml|x-www-form-urlencoded|graphql|problem\+json|manifest\+json)|image\/svg\+xml)|\+json\b|\+xml\b/i;

function networkLog(tabId) {
    let log = tabNetwork.get(tabId);
    if (!log) {
        log = { records: [], byKey: new Map(), seq: 0, epoch: 0, since: Date.now() };
        tabNetwork.set(tabId, log);
    }
    return log;
}

function networkKey(source, requestId) {
    return source?.sessionId ? `${source.sessionId}:${requestId}` : String(requestId);
}

/** Masque la valeur des paramètres sensibles d'une chaîne de requête ou de fragment (« a=1&b=2 »), sans réencoder. */
function maskParams(text) {
    return text.split("&").map(part => {
        const eq = part.indexOf("=");
        if (eq <= 0) return part;
        let name = part.slice(0, eq);
        try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch (_) {}
        return SECRET_URL_PARAM.test(name) || LK.sensitiveName(name) ? `${part.slice(0, eq)}=[masked]` : part;
    }).join("&");
}

/** URL sans les valeurs de ses paramètres sensibles (requête et fragment OAuth « #access_token=... »). */
function maskUrl(url) {
    if (typeof url !== "string" || !url) return url ?? null;
    const hashAt = url.indexOf("#");
    const beforeHash = hashAt >= 0 ? url.slice(0, hashAt) : url;
    const queryAt = beforeHash.indexOf("?");
    let out = queryAt >= 0 ? `${beforeHash.slice(0, queryAt + 1)}${maskParams(beforeHash.slice(queryAt + 1))}` : beforeHash;
    if (hashAt >= 0) {
        const hash = url.slice(hashAt + 1);
        const lead = /^[!/?]*/.exec(hash)[0];
        out += `#${hash.includes("=") ? lead + maskParams(hash.slice(lead.length)) : hash}`;
    }
    return out;
}

// En-têtes qui portent une URL (redirection OAuth « Location: ...?code=... », référent) : paramètres secrets masqués.
const URL_HEADER = /^(location|content-location|referer|origin)$/i;

function maskHeaders(headers) {
    if (!headers || typeof headers !== "object") return headers || null;
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (SECRET_HEADER.test(name)) out[name] = `[masked, ${String(value).length} chars]`;
        else out[name] = URL_HEADER.test(name) ? maskUrl(String(value)) : value;
    }
    return out;
}

function applyNetworkResponse(rec, response, type) {
    if (!response) return;
    rec.status = response.status;
    rec.statusText = response.statusText || "";
    rec.mimeType = response.mimeType || rec.mimeType || null;
    rec.responseHeaders = response.headers || null;
    rec.protocol = response.protocol || null;
    rec.remoteAddress = response.remoteIPAddress ? `${response.remoteIPAddress}:${response.remotePort}` : null;
    if (response.fromDiskCache || response.fromPrefetchCache) rec.fromCache = true;
    if (response.fromServiceWorker) rec.fromServiceWorker = true;
    if (type) rec.type = type;
}

function recordNetworkRequest(source, params) {
    if (!params?.requestId || !params.request) return;
    const log = networkLog(source.tabId);
    const key = networkKey(source, params.requestId);
    const previous = log.byKey.get(key);
    if (previous && params.redirectResponse) {
        // Redirection : la requête précédente est close avec son statut 3xx, une nouvelle entrée suit.
        applyNetworkResponse(previous, params.redirectResponse);
        previous.state = "redirected";
        previous.redirectedTo = params.request.url;
        previous.endTs = params.timestamp;
    }
    const rec = {
        seq: ++log.seq,
        key,
        requestId: params.requestId,
        sessionId: source.sessionId || null,
        epoch: log.epoch,
        url: params.request.url,
        method: params.request.method,
        type: params.type || null,
        frameId: params.frameId || null,
        initiator: params.initiator?.type || null,
        requestHeaders: params.request.headers || null,
        hasPostData: !!params.request.hasPostData,
        startedAt: params.wallTime ? Math.round(params.wallTime * 1000) : Date.now(),
        startTs: params.timestamp,
        endTs: null,
        status: null,
        statusText: null,
        mimeType: null,
        size: null,
        state: "pending",
        failed: false,
        errorText: null,
        canceled: false,
        fromCache: false,
        redirectedFrom: previous && params.redirectResponse ? previous.url : null
    };
    log.records.push(rec);
    log.byKey.set(key, rec);
    while (log.records.length > NETWORK_BUFFER_SIZE) {
        const old = log.records.shift();
        if (log.byKey.get(old.key) === old) log.byKey.delete(old.key);
    }
}

function recordNetworkResponse(source, params) {
    const rec = networkLog(source.tabId).byKey.get(networkKey(source, params?.requestId));
    if (rec) applyNetworkResponse(rec, params.response, params.type);
}

function recordNetworkEnd(source, method, params) {
    const rec = networkLog(source.tabId).byKey.get(networkKey(source, params?.requestId));
    if (!rec) return;
    rec.endTs = params.timestamp;
    if (method === "Network.loadingFinished") {
        rec.state = "finished";
        rec.size = params.encodedDataLength;
    } else {
        rec.state = "failed";
        rec.failed = true;
        rec.errorText = params.errorText || null;
        rec.canceled = !!params.canceled;
        rec.blockedReason = params.blockedReason || null;
        if (params.type) rec.type = params.type;
    }
}

function publicNetworkRecord(rec, includeHeaders) {
    const out = {
        request_id: rec.key,
        url: maskUrl(rec.url),
        method: rec.method,
        status: rec.status,
        statusText: rec.statusText || null,
        type: rec.type,
        mimeType: rec.mimeType,
        size: rec.size,
        duration_ms: rec.startTs !== undefined && rec.endTs !== null && rec.endTs !== undefined ? Math.round((rec.endTs - rec.startTs) * 1000) : null,
        state: rec.state,
        failed: rec.failed,
        startedAt: new Date(rec.startedAt).toISOString(),
        frame: rec.sessionId ? "out-of-process iframe" : "page"
    };
    if (rec.failed) Object.assign(out, { errorText: rec.errorText, canceled: rec.canceled, blockedReason: rec.blockedReason || null });
    if (rec.fromCache) out.fromCache = true;
    if (rec.redirectedFrom) out.redirectedFrom = maskUrl(rec.redirectedFrom);
    if (rec.redirectedTo) out.redirectedTo = maskUrl(rec.redirectedTo);
    if (includeHeaders) {
        out.requestHeaders = maskHeaders(rec.requestHeaders);
        out.responseHeaders = maskHeaders(rec.responseHeaders);
    }
    return out;
}

function statusMatches(status, wanted) {
    if (wanted === undefined || wanted === null || wanted === "") return true;
    if (status === null || status === undefined) return false;
    const text = String(wanted).trim().toLowerCase();
    const cls = /^([1-5])xx$/.exec(text);
    if (cls) return Math.floor(status / 100) === Number(cls[1]);
    const range = /^(\d{3})\s*-\s*(\d{3})$/.exec(text);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);
    return status === Number(text);
}

/**
 * Requêtes enregistrées de l'onglet (les plus récentes en dernier), filtrées : filter (fragment d'URL ou /regex/),
 * method, status (200, "4xx", "400-499"), resourceType (Fetch, XHR, Document...), failedOnly.
 */
async function getNetworkRequests(params = {}) {
    const tabId = await resolveTargetTab(params);
    // Attacher (si besoin) démarre l'enregistrement : seules les requêtes vues par le débogueur sont connues.
    const wasAttached = attachedDebuggers.has(tabId);
    await ensureDebugger(tabId);
    const log = networkLog(tabId);
    const urlPattern = params.filter !== undefined && params.filter !== null && params.filter !== "" ? LK.pattern(params.filter, false) : null;
    const method = params.method ? String(params.method).toUpperCase() : null;
    const resourceType = params.resourceType || params.resource_type || params.type;
    const failedOnly = boolParam(params.failedOnly !== undefined ? params.failedOnly : params.failed_only, false);
    const includeHeaders = boolParam(params.includeHeaders !== undefined ? params.includeHeaders : params.include_headers, false);
    const limit = Math.max(1, Math.min(NETWORK_BUFFER_SIZE, parseInt(params.limit, 10) || 50));
    const matching = log.records.filter(rec =>
        (!urlPattern || (urlPattern.re ? (urlPattern.re.lastIndex = 0, urlPattern.re.test(rec.url)) : rec.url.toLowerCase().includes(urlPattern.text.toLowerCase())))
        && (!method || rec.method === method)
        && (!resourceType || String(rec.type || "").toLowerCase() === String(resourceType).toLowerCase())
        && (!failedOnly || rec.failed || (rec.status !== null && rec.status >= 400))
        && statusMatches(rec.status, params.status));
    const requests = matching.slice(-limit).map(rec => publicNetworkRecord(rec, includeHeaders));
    if (boolParam(params.clear, false)) {
        log.records = [];
        log.byKey.clear();
    }
    const data = {
        count: requests.length,
        total_matching: matching.length,
        buffered: log.records.length,
        buffer_size: NETWORK_BUFFER_SIZE,
        recording_since: new Date(log.since).toISOString(),
        requests
    };
    const recordingUntil = networkRecording.get(tabId) || 0;
    data.recording_until = recordingUntil > Date.now() ? new Date(recordingUntil).toISOString() : null;
    if (!wasAttached) data.note = "Debugger attached by this call: only requests from now on will be recorded (debugger detached after 30 s of inactivity; browser_network_record keeps it attached for a bounded duration).";
    return { data };
}

/**
 * Corps de réponse d'une requête enregistrée (Network.getResponseBody), tronqué ; un corps binaire est signalé et
 * n'est rendu en base64 que sur demande (includeBinary).
 */
async function getNetworkResponse(params = {}) {
    const tabId = await resolveTargetTab(params);
    const id = String(params.requestId || params.request_id || "").trim();
    if (!id) throw new Error("Missing request_id (request_id field of browser_network_requests)");
    const log = networkLog(tabId);
    let rec = log.byKey.get(id);
    if (!rec) rec = [...log.records].reverse().find(r => r.requestId === id) || null;
    if (!rec) throw new Error(`Request ${id} not in the network log of tab ${tabId} (buffer of ${NETWORK_BUFFER_SIZE} requests).`);
    const target = await ensureDebugger(tabId);
    if (rec.epoch !== log.epoch) {
        throw new Error(`Body unavailable: the debugger was detached then reattached since request ${id} (Chrome keeps bodies only during the debugging session). Run the action again, then read the body right away.`);
    }
    if (rec.state === "pending") throw new Error(`Request ${id} still pending: wait with browser_wait_network_idle.`);
    if (rec.failed) throw new Error(`Request ${id} failed (${rec.errorText || "no body"}): no body.`);
    const session = rec.sessionId ? { tabId, sessionId: rec.sessionId } : target;
    let res;
    try {
        res = await chrome.debugger.sendCommand(session, "Network.getResponseBody", { requestId: rec.requestId });
    } catch (error) {
        throw new Error(`Body unavailable for ${id} (${error.message || error}): redirect, response without body, or resource already released by Chrome.`);
    }
    const maxBytes = Math.max(256, Math.min(5 * 1024 * 1024, parseInt(params.maxBytes !== undefined ? params.maxBytes : params.max_bytes, 10) || 64 * 1024));
    const textual = TEXTUAL_MIME.test(rec.mimeType || "");
    const data = { request_id: rec.key, url: maskUrl(rec.url), status: rec.status, mimeType: rec.mimeType, base64Encoded: !!res?.base64Encoded };
    let body = String(res?.body || "");
    if (res?.base64Encoded && !textual) {
        const bytes = Math.floor(body.length * 3 / 4) - (body.endsWith("==") ? 2 : (body.endsWith("=") ? 1 : 0));
        Object.assign(data, { binary: true, size: bytes });
        if (boolParam(params.includeBinary !== undefined ? params.includeBinary : params.include_binary, false)) {
            const max64 = Math.ceil(maxBytes / 3) * 4;
            data.body = body.slice(0, max64);
            data.truncated = body.length > max64;
        } else {
            data.body = null;
            data.note = "Binary body not returned (include_binary=true for base64, truncated).";
        }
        return { data };
    }
    if (res?.base64Encoded) {
        try {
            const raw = atob(body);
            const bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
            body = new TextDecoder("utf-8").decode(bytes);
        } catch (_) {}
    }
    // Secrets masqués AVANT la troncature (une coupe ne laisse jamais passer la fin d'un jeton).
    const masked = maskSecretBody(body, rec.mimeType);
    body = masked.text;
    Object.assign(data, { binary: false, size: body.length, truncated: body.length > maxBytes, body: body.slice(0, maxBytes), masked: masked.count });
    return { data };
}

// -----------------------------------------------------------------------------
// Corps de réponse : champs secrets masqués à toute profondeur (JSON, formulaires, et motifs "clé": "valeur" d'un
// texte non analysable : JSON tronqué, script, HTML). Mêmes noms que les en-têtes et paramètres d'URL sensibles.
// -----------------------------------------------------------------------------
//
// Trois classes de clés :
// - liste blanche (jamais masquées, sauf valeur au format d'un identifiant connu) : pagination (nextPageToken,
//   pageToken, continuation_token, cursor, syncToken...) et métadonnées (token_type, expires_*, tokenizer...) ;
// - compteurs (total_tokens, prompt_tokens, max_tokens, promptTokenCount, tokens_used...) : un nombre passe tel quel,
//   toute autre valeur est jugée sur sa forme ;
// - clés ambiguës (« token » ou « session » au milieu d'un autre mot : resumeToken, sessionState...) : seule une
//   valeur qui RESSEMBLE à un secret est masquée. Toutes les autres clés de SECRET_BODY_KEY : toujours masquées.
const SECRET_BODY_KEY = /token|secret|passw|pwd|api[_-]?key|apikey|authori[sz]ation|session|cookie|credential|private[_-]?key|csrf|xsrf|signature|^auth$|^(sid|ssid|hsid|apisid|sapisid)$/i;
// Clés qui nomment un secret sans ambiguïté (le reste de SECRET_BODY_KEY ne tient qu'à « token » ou « session »).
const STRONG_SECRET_KEY = /secret|passw|pwd|api[_-]?key|apikey|authori[sz]ation|cookie|credential|private[_-]?key|csrf|xsrf|signature|^auth$|^(sid|ssid|hsid|apisid|sapisid)$|^(token|tokens|session|jwt|bearer)$|(^|[_.-]|[a-z])(access|refresh|id|auth|bearer|session|api|oauth|client|app|install(ation)?|personal|service|push|device|fcm|upload|reset|verification|confirm(ation)?|magic|login|security|secret|private|jwt|sso|saml)[_.-]?tokens?$|^session[_.-]?(id|key|token|cookie)$|session(id|key)$/i;
// Liste blanche : pagination et métadonnées du jeton.
const SECRET_BODY_ALLOWED = /^((next|prev|previous)[_-]?(page[_-]?)?token|page[_-]?token|continuation[_-]?token|(next|prev|previous)?[_-]?cursor|(next[_-]?)?sync[_-]?token|token[_-]?type|expires(_?\w*)?|token[_-]?expir\w*|tokeni[sz]er\w*)$/i;
// Compteurs de jetons de modèle de langue (OpenAI, Anthropic, Gemini, Bedrock...).
const TOKEN_COUNTER_KEY = /^(\w*_tokens(_details)?|\w*[a-z]Tokens|max_?(\w*_)?tokens|max\w*Tokens|\w*tokens?_?count|tokens?_?used|tokens?_?usage)$/i;
// Formats d'identifiants connus (jetons OAuth Google, GitHub, OpenAI, Stripe, Slack, AWS, JWT...), masqués partout.
const KNOWN_SECRET_VALUE = /^(Bearer\s|Basic\s|ya29\.|1\/\/0|gh[pousr]_|github_pat_|glpat-|sk-|sk_(live|test)_|rk_(live|test)_|xox[abprs]-|AKIA[0-9A-Z]{12}|ASIA[0-9A-Z]{12}|AIza[\w-]{30}|eyJ[\w-]+\.[\w-]+\.)/;
// Préfixes anti-XSSI de certaines API (Google : « )]}' »), gardés tels quels devant le JSON masqué.
const XSSI_PREFIX = /^(\)\]\}'[^\n]*\n?|for\s*\(;;\);|while\s*\(1\);)/;

/** Valeur qui ressemble à un secret : format d'identifiant connu, ou chaîne opaque longue (lettres et chiffres). */
function secretLooking(value) {
    if (typeof value !== "string") return false;
    const text = value.trim();
    if (KNOWN_SECRET_VALUE.test(text)) return true;
    return text.length >= 20 && !/\s/.test(text) && /^[\w+/=.~:-]+$/.test(text) && /[A-Za-z]/.test(text) && /\d/.test(text);
}

/**
 * Vrai si la valeur de cette clé doit être masquée. value absente (undefined) : jugement sur le nom seul, pour une
 * clé ambiguë on masque (texte non analysable).
 */
function secretBodyKey(name, value) {
    const key = String(name ?? "");
    if (SECRET_BODY_ALLOWED.test(key)) return typeof value === "string" && KNOWN_SECRET_VALUE.test(value.trim());
    // Carte, cryptogramme, code à usage unique, PIN, IBAN (cardNumber, cc_number, securityCode...) : mêmes noms que les
    // champs de formulaire masqués dans les lectures.
    if (LK.sensitiveName(key)) return true;
    const counter = TOKEN_COUNTER_KEY.test(key);
    const numeric = value === null || typeof value === "number" || typeof value === "boolean"
        || (typeof value === "string" && /^\s*\d+(\.\d+)?\s*$/.test(value));
    if (counter && numeric) return false;
    if (!SECRET_BODY_KEY.test(key)) return false;
    if (STRONG_SECRET_KEY.test(key)) return true;
    // Clé ambiguë (ou compteur dont la valeur n'est pas un nombre) : jugée sur sa valeur.
    if (value === undefined) return !counter;
    if (Array.isArray(value)) return value.some(secretLooking);
    if (value !== null && typeof value === "object") return false;  // contenu parcouru, ses clés jugées une à une
    return secretLooking(value);
}

function maskedValue(value) {
    return typeof value === "string" ? `[masked, ${value.length} chars]` : "[masked]";
}

function maskJsonValue(value, counter, depth = 0) {
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => maskJsonValue(item, counter, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (item !== null && item !== undefined && item !== "" && secretBodyKey(key, item)) {
            out[key] = maskedValue(item);
            counter.count++;
        } else {
            out[key] = maskJsonValue(item, counter, depth + 1);
        }
    }
    return out;
}

function maskFormBody(text, counter) {
    return text.split("&").map(part => {
        const eq = part.indexOf("=");
        if (eq <= 0) return part;
        let name = part.slice(0, eq);
        try { name = decodeURIComponent(name.replace(/\+/g, " ")); } catch (_) {}
        let value = part.slice(eq + 1);
        try { value = decodeURIComponent(value.replace(/\+/g, " ")); } catch (_) {}
        if (!secretBodyParam(name, value) || eq === part.length - 1) return part;
        counter.count++;
        return `${part.slice(0, eq)}=[masked]`;
    }).join("&");
}

/** Paramètre clé=valeur d'un formulaire ou d'une URL citée dans un corps : liste blanche et compteurs compris. */
function secretBodyParam(name, value) {
    return secretBodyKey(name, value) || (SECRET_URL_PARAM.test(name) && !SECRET_BODY_KEY.test(name));
}

/** { text, count } : corps textuel avec ses valeurs secrètes remplacées. */
function maskSecretBody(text, mimeType = "") {
    const counter = { count: 0 };
    const source = String(text ?? "");
    const prefix = (XSSI_PREFIX.exec(source) || [""])[0];
    const rest = source.slice(prefix.length);
    const trimmed = rest.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
            const masked = maskJsonValue(JSON.parse(trimmed), counter);
            return { text: prefix + JSON.stringify(masked), count: counter.count };
        } catch (_) {
            // JSON incomplet ou texte mêlé : motifs ci-dessous.
        }
    }
    const form = /x-www-form-urlencoded/i.test(mimeType || "")
        || /^[\w.%+\-[\]]+=[^&\s]*(&[\w.%+\-[\]]+=[^&\s]*)+$/.test(trimmed);
    if (form) return { text: maskFormBody(source, counter), count: counter.count };
    // "clé" : "valeur" (JSON tronqué, objet dans un script) et clé=valeur dans une requête ou un fragment.
    let out = source.replace(/("((?:[^"\\]|\\.){1,80})"\s*:\s*)"((?:[^"\\]|\\.)*)"/g, (match, head, key, value) => {
        if (!value || !secretBodyKey(key, value)) return match;
        counter.count++;
        return `${head}"[masked, ${value.length} chars]"`;
    });
    out = out.replace(/([?&#]([A-Za-z0-9_.%-]{1,80})=)([^&#"'\s<]+)/g, (match, head, key, value) => {
        if (!secretBodyParam(key, value)) return match;
        counter.count++;
        return `${head}[masked]`;
    });
    return { text: out, count: counter.count };
}

// Identifiants connus cités au milieu d'un texte (« Authorization: Bearer ... », jeton GitHub dans un message).
const EMBEDDED_SECRET = /\b(Bearer|Basic)\s+[\w.~+\/=-]{8,}|\b(ya29\.|gh[pousr]_|github_pat_|glpat-|sk-|sk_(live|test)_|rk_(live|test)_|xox[abprs]-|AIza)[\w.-]{8,}|\b(AKIA|ASIA)[0-9A-Z]{12}\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

function maskLogText(text) {
    return maskSecretBody(text).text.replace(EMBEDDED_SECRET, match => `[masked, ${match.length} chars]`);
}

/** Entrée de console masquée : textes, clés secrètes, et paires { name, value } des aperçus d'objets CDP. */
function maskLogValue(value, depth = 0) {
    if (typeof value === "string") return maskLogText(value);
    if (depth > 32 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(item => maskLogValue(item, depth + 1));
    const pair = typeof value.name === "string" && Object.prototype.hasOwnProperty.call(value, "value")
        && value.value !== null && value.value !== undefined && value.value !== "" && secretBodyKey(value.name, value.value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        if (pair && key === "value") out[key] = maskedValue(item);
        else if (item !== null && item !== undefined && item !== "" && typeof item !== "object" && secretBodyKey(key, item)) {
            out[key] = maskedValue(item);
        } else out[key] = maskLogValue(item, depth + 1);
    }
    return out;
}

// -----------------------------------------------------------------------------
// Téléchargements
// -----------------------------------------------------------------------------
function publicDownload(d) {
    return {
        id: d.id,
        path: d.filename || null,
        url: d.finalUrl || d.url,
        referrer: d.referrer || null,
        state: d.state,
        danger: d.danger,
        mime: d.mime,
        bytes: d.fileSize !== undefined && d.fileSize >= 0 ? d.fileSize : d.totalBytes,
        bytesReceived: d.bytesReceived,
        startTime: d.startTime,
        endTime: d.endTime || null,
        exists: d.exists,
        error: d.error || null
    };
}

/**
 * Attend la fin d'un téléchargement déclenché par l'onglet (lien, bouton...) et renvoie son chemin. Candidats :
 * téléchargements commencés depuis la dernière action de l'agent sur l'onglet (ou since_ms), d'abord ceux dont le
 * référent ou l'URL a l'origine de l'onglet. Jamais d'acceptation d'un fichier jugé dangereux.
 */
async function waitForDownload(params = {}, client = null) {
    if (!chrome.downloads?.search) throw new Error("chrome.downloads API unavailable");
    // L'onglet de l'agent est obligatoire : sans lui, le téléchargement d'un autre agent pourrait être pris.
    const tabId = await resolveTargetTab(params);
    const timeoutMs = Math.max(0, parseInt(params.timeoutMs !== undefined ? params.timeoutMs : params.timeout, 10) || 30000);
    const since = params.since !== undefined && params.since !== null
        ? Number(params.since)
        : (tabId !== null && lastActionAt.has(tabId) ? lastActionAt.get(tabId) - 1000 : Date.now() - 60000);
    let origin = null;
    if (tabId !== null) {
        try { origin = originOf((await chrome.tabs.get(tabId)).url); } catch (_) {}
    }
    const fromTab = (d) => !origin || [d.referrer, d.url, d.finalUrl].some(u => u && originOf(u) === origin);
    const start = Date.now();
    let chosen = null;
    for (;;) {
        const items = await chrome.downloads.search({ startedAfter: new Date(since).toISOString(), orderBy: ["-startTime"] });
        const candidates = (items || []).filter(d => !since || Date.parse(d.startTime) >= since);
        chosen = candidates.find(fromTab) || null;
        // Attribué à l'onglet du client : lui seul pourra en retirer l'entrée (download_erase).
        if (chosen) await rememberDownloadOwner(chosen.id, client);
        if (chosen && chosen.state === "complete") {
            return { data: { success: true, ...publicDownload(chosen), waited_ms: Date.now() - start } };
        }
        if (chosen && chosen.state === "interrupted") {
            return { error: `Download interrupted (${chosen.error || "unknown reason"}): ${chosen.finalUrl || chosen.url}` };
        }
        if (Date.now() - start >= timeoutMs) break;
        await sleepMs(200);
    }
    if (chosen) {
        const danger = chosen.danger && !["safe", "accepted"].includes(chosen.danger)
            ? `; Chrome rates it "${chosen.danger}" and waits for the user's decision (never accepted by the agent)` : "";
        return { error: `Download not finished after ${timeoutMs} ms (state ${chosen.state}, ${chosen.bytesReceived}/${chosen.totalBytes} bytes${danger}): ${chosen.filename || chosen.url}` };
    }
    return { error: `No download${origin ? ` from ${origin}` : ""} started since ${new Date(since).toISOString()} (timeout ${timeoutMs} ms). A Chrome "Save as" window may be waiting for the user.` };
}

/**
 * Retire une entrée de l'historique des téléchargements (le fichier sur disque n'est pas touché). Seulement un
 * téléchargement lancé depuis un onglet du client (attribué par wait_download) : jamais ceux de Julien ni d'un autre
 * agent.
 */
async function eraseDownload(params = {}, client = null) {
    const id = parseInt(params.id !== undefined ? params.id : params.downloadId, 10);
    if (!Number.isInteger(id)) throw new Error("Missing download id");
    if (!ownedBy(downloadOwners.get(id), client)) {
        return { error: `Download ${id} was not started from one of your tabs (browser_wait_download): refused. ` +
            "The user's and other agents' downloads are never erased." };
    }
    const erased = await chrome.downloads.erase({ id });
    downloadOwners.delete(id);
    await saveExtensionState();
    return { data: { success: true, erased: erased || [] } };
}

/**
 * Touche ou raccourci réel (Enter, Escape, Tab, F5, Control+A, Shift+Tab, Control+Shift+K...) sur l'élément qui a
 * le focus, par Input.dispatchKeyEvent (key, code, windowsVirtualKeyCode, modificateurs), émulation du focus comprise.
 */
async function pressKey(params = {}) {
    const tabId = await resolveTargetTab(params);
    const combo = String(params.key || "Enter").trim();
    parseKeyCombo(combo);  // erreur claire avant toute action
    lastActionAt.set(tabId, Date.now());
    const target = await ensureDebugger(tabId);
    try {
        const r = await pressKeyCombo(target, combo);
        if (r.dialog) return { data: dialogInterruption(r.dialog) };
        return { data: { success: true, key: combo, modifiers: r.modifiers, method: "cdp" } };
    } finally {
        scheduleDebuggerDetach(tabId);
    }
}

/**
 * Exécute une opération du kit de saisie sur la cible (localisée dans tous les cadres), sans action de souris.
 */
async function editOperation(params, locate, op, extra, timeoutMs) {
    const tabId = await resolveTargetTab(params);
    let target;
    try {
        target = await ensureDebugger(tabId);
    } catch (error) {
        const fallback = await mouseJsFallback(tabId, { phase: "edit", locate, op, ...extra }, error.message || String(error), timeoutMs);
        return fallback.data ? { ...fallback, data: maskEditState(fallback.data) } : fallback;
    }
    try {
        const runEdit = async (root, loc) => {
            const res = await pageCall(root, { phase: "edit", locate: loc, op, ...extra });
            if (res && res.success && root.key !== "top") Object.assign(res, { frame: frameLabelOf(root, ""), crossOriginFrame: true });
            return res;
        };
        const start = Date.now();
        let res;
        for (;;) {
            res = await locateAndRun(target, locate, runEdit);
            if (res?.__dialog || res?.success || !(res?.notFound) || Date.now() - start >= timeoutMs) break;
            await sleepMs(MOUSE_RETRY_MS);
        }
        if (res?.__dialog) return { data: dialogInterruption(res.__dialog) };
        if (!res || !res.success) return { error: prepareError(res, locate) };
        return { data: maskEditState(res) };
    } finally {
        scheduleDebuggerDetach(tabId);
    }
}

/**
 * Option d'un <select> natif (localisateur, sélecteur ou marqueur) : valeur posée comme le fait Playwright
 * (selectOption), événements input et change ; une liste personnalisée (role=combobox) se pilote par clics.
 */
async function selectOption(params = {}) {
    const locate = targetLocate(params, { allowText: false }) || { selector: "select", index: 0 };
    const option = {};
    if (params.value !== undefined && params.value !== null) option.value = String(params.value);
    if (params.text !== undefined && params.text !== null) option.text = String(params.text);
    if (params.label !== undefined && params.label !== null && !params.locator) option.label = String(params.label);
    if (params.optionIndex !== undefined && params.optionIndex !== null) option.index = parseInt(params.optionIndex, 10);
    if (!Object.keys(option).length) return { error: "Give value, text or optionIndex of the option to choose" };
    const tabId = await resolveTargetTab(params);
    if (tabId) lastActionAt.set(tabId, Date.now());
    return await editOperation(params, locate, "selectOption", { option }, mouseTimeout(params, 1200));
}

/**
 * Coche ou décoche (case, bouton radio, role=checkbox/switch) par un vrai clic, seulement si l'état diffère ;
 * l'état est relu ensuite (verified).
 */
/**
 * Relecture d'un champ sans aucun geste (browser_fill_form) : verified = l'état actuel correspond à expect
 * ({value} | {option} | {checked}), comparé dans la page ; la valeur d'un champ sensible reste masquée.
 */
async function fieldState(params = {}) {
    const locate = targetLocate(params, { allowText: false });
    if (!locate) return { error: "Missing locator, selector or mark of the field to read back" };
    const expect = params.expect && typeof params.expect === "object" ? params.expect : null;
    const kinds = expect ? ["value", "option", "checked"].filter(k => expect[k] !== undefined && expect[k] !== null) : [];
    if (kinds.length !== 1) return { error: "expect: exactly one key among value, option, checked" };
    return await editOperation(params, locate, "verify", { expect: { [kinds[0]]: expect[kinds[0]] } }, mouseTimeout(params, 1200));
}

async function setChecked(params = {}) {
    const locate = targetLocate(params);
    if (!locate) return { error: "Missing locator, selector, mark or text of the checkbox" };
    const wanted = boolParam(params.checked, true);
    const timeoutMs = mouseTimeout(params, 1200);
    const before = await editOperation(params, locate, "check", {}, timeoutMs);
    if (before.error || before.data?.dialogOpened) return before;
    if (before.data.checked === null || before.data.checked === undefined) {
        return { error: `<${String(before.data.tagName || "element").toLowerCase()}> has no checked state (checkbox, radio, role=checkbox/switch expected)` };
    }
    if (before.data.disabled) return { error: "Checkbox disabled: no click." };
    if (before.data.checked === wanted) {
        return { data: { success: true, checked: wanted, changed: false, verified: true, method: "none" } };
    }
    const click = await performMouseAction(params, {
        kind: "click", locate, button: "left", clickCount: 1, timeoutMs
    });
    if (click.error || click.data?.dialogOpened) return click;
    const after = await editOperation(params, locate, "check", {}, 0);
    const checked = after.data ? after.data.checked : null;
    const data = {
        ...click.data,
        checked,
        changed: checked !== before.data.checked,
        verified: checked === wanted
    };
    if (!data.verified) data.warning = `State read back ${JSON.stringify(checked)}, expected ${wanted} after the click (radio button, checkbox controlled by the page?).`;
    return { data };
}

/**
 * Candidats d'un localisateur dans tous les cadres (aucune action) : rôle, nom, état, valeur, boîte dans le repère du
 * viewport principal, cadre. Indique si une action serait sans ambiguïté (unique).
 */
async function findElements(params = {}) {
    const locator = parseLocator(params.locator);
    if (!locator) return { error: "Missing locator (ex. {\"role\":\"button\",\"name\":\"Valider\"})" };
    const tabId = await resolveTargetTab(params);
    const target = await ensureDebugger(tabId);
    const limit = Math.max(1, Math.min(100, parseInt(params.limit, 10) || 20));
    const found = await findAcrossRoots(target, locator, { limit });
    if (found.dialog) return { data: dialogInterruption(found.dialog) };
    if (found.invalid) return { error: found.error };
    const candidates = [];
    for (const part of found.perRoot) {
        let offset = { x: 0, y: 0 };
        if (part.root.key !== "top" && part.candidates.length) {
            try {
                const proj = await projectToTop(part.root, [{ x: 0, y: 0 }], false);
                if (proj.ok) offset = proj.points[0];
            } catch (_) {}
        }
        for (const c of part.candidates) {
            if (c.box) c.box = { ...c.box, x: Math.round((c.box.x + offset.x) * 10) / 10, y: Math.round((c.box.y + offset.y) * 10) / 10 };
            if (part.root.key !== "top") c.crossOriginFrame = true;
            candidates.push(c);
        }
    }
    const nth = locator.nth;
    return {
        data: {
            count: found.total,
            hidden: found.hidden,
            unique: found.total === 1,
            strict_ok: found.total === 1 || (nth !== undefined && nth !== null && found.total > 0),
            engine: found.engine,
            frames: found.roots.map(r => ({ frame: r.label, crossOrigin: r.key !== "top", outOfProcess: !!r.oopif })),
            crossOriginFrames: crossOriginSupport.get(tabId) === undefined ? null : crossOriginSupport.get(tabId),
            candidates: candidates.slice(0, limit)
        }
    };
}
/**
 * Wait for document complete and network idle
 */
async function waitForLoad(params = {}) {
    let tabId = await resolveTargetTab(params);

    const timeoutMs = params.timeoutMs || params.timeout || 8000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            // Un onglet tout juste ouvert (browser_new_tab) est encore sur about:blank, déjà "complete" : tant que
            // Chrome navigue (pendingUrl, status "loading"), ce n'est pas le document attendu.
            const tab = await chrome.tabs.get(tabId);
            // Jugée sur la destination : une navigation qui quitte le Chrome Web Store garde encore son ancienne url.
            const destination = tab?.pendingUrl || tab?.url;
            if (isChromeProtectedPage(destination)) return { error: chromeProtectedMessage(destination) };
            if (tab?.pendingUrl || tab?.status === "loading") {
                await sleepMs(100);
                continue;
            }
            const stateRes = await evaluateIsolated({
                tabId,
                code: `document.readyState`
            });
            if (stateRes?.data === "complete") {
                return { data: { readyState: "complete", waitedMs: Date.now() - startTime } };
            }
        } catch (e) {
            // Execution context destroyed during rapid navigation; continue polling until new context settles.
            // Page protected by Chrome reached by a redirect: said at once, never waited for until the timeout.
            if (CHROME_PROTECTED_RAW.test(String(e?.message || ""))) {
                let url = null;
                try { url = (await chrome.tabs.get(tabId))?.url || null; } catch (_) {}
                return { error: chromeProtectedMessage(url) };
            }
        }
        await sleepMs(100);
    }

    return { data: { readyState: "timeout", waitedMs: timeoutMs } };
}

/**
 * Wait until in-flight network requests drop to zero for at least idleMs
 */
async function waitForNetworkIdle(params = {}) {
    let tabId = await resolveTargetTab(params);

    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Network.enable");

    const idleMs = params.idleMs !== undefined ? parseInt(params.idleMs) : 300;
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 8000);
    const startTime = Date.now();
    let idleSince = null;

    while (Date.now() - startTime < timeoutMs) {
        const inFlight = inFlightSet(tabId).size;
        if (inFlight === 0) {
            if (idleSince === null) {
                idleSince = Date.now();
            } else if (Date.now() - idleSince >= idleMs) {
                return { data: { status: "idle", inFlight: 0, waitedMs: Date.now() - startTime } };
            }
        } else {
            idleSince = null;
        }
        await sleepMs(50);
    }

    return { data: { status: "timeout", inFlight: inFlightSet(tabId).size, waitedMs: timeoutMs } };
}

/**
 * Retrieve session and domain cookies via CDP Network.getCookies
 */
/** Hôte local de développement : localhost, 127.0.0.1, [::1], *.localhost, *.test (jamais un autre domaine). */
function isLocalDevHost(host) {
    const name = String(host || "").trim().toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name === "::1"
        || name.endsWith(".localhost") || name.endsWith(".test");
}

function isLocalDevUrl(url) {
    try {
        const parsed = new URL(String(url));
        return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLocalDevHost(parsed.hostname);
    } catch (_) {
        return false;
    }
}

const LOCAL_COOKIE_REFUSAL = "Cookie values refused: only for a local development origin " +
    "(localhost, 127.0.0.1, [::1], *.localhost, *.test), never for a real site (the user's session secrets). " +
    "Run again without include_values to get names and attributes.";

/**
 * Cookies via CDP Network.getCookies : noms et attributs. Valeurs jamais par défaut ; includeValues=true seulement si
 * TOUTES les URL visées (l'onglet, ou params.urls) sont locales de développement, refus clair sinon (avant tout appel
 * à Chrome), et seulement pour les cookies de domaines locaux.
 */
async function getCookies(params = {}) {
    let tabId = await resolveTargetTab(params);
    const asked = params.includeValues === true || params.include_values === true;

    let commandParams = {};
    if (params.urls && Array.isArray(params.urls)) {
        commandParams.urls = params.urls;
    } else {
        let tab = null;
        try { tab = await chrome.tabs.get(tabId); } catch(e) {}
        if (tab?.url && !isProtectedUrl(tab.url)) {
            commandParams.urls = [tab.url];
        }
    }
    if (asked && !(commandParams.urls?.length && commandParams.urls.every(isLocalDevUrl))) {
        throw new Error(LOCAL_COOKIE_REFUSAL);
    }

    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Network.enable");
    const result = await chrome.debugger.sendCommand(target, "Network.getCookies", commandParams);
    return {
        data: {
            cookieCount: (result.cookies || []).length,
            valuesIncluded: asked,
            cookies: (result.cookies || []).map(c => ({
                name: c.name,
                ...(asked && isLocalDevHost(c.domain) ? { value: c.value } : {}),
                domain: c.domain,
                path: c.path,
                expires: c.expires,
                httpOnly: c.httpOnly,
                secure: c.secure,
                sameSite: c.sameSite
            }))
        }
    };
}

// -----------------------------------------------------------------------------
// Exports de contenu (export_kit.js) : tout est lu dans la page de l'onglet visé (jamais mis au premier plan), avec
// la session de Julien ; aucun cookie ni valeur de champ ne sort de la page.
// -----------------------------------------------------------------------------
const EXPORT_KIT_SOURCE = agyExportKit.toString();
const EK = agyExportKit();
// Fichier binaire transporté en base64 par le pont (messages de 16 Mo au plus) : 8 Mo au plus.
const EXPORT_MAX_BYTES = 8 * 1024 * 1024;
const EXPORT_FETCH_TIMEOUT_MS = 40000;

function exportError(res) {
    if (res?.data?.dialogOpened) return res;
    if (res?.data && typeof res.data === "object" && res.data.error) return { error: res.data.error };
    if (!res?.data) return { error: "The page returned nothing (tab still loading or protected?)" };
    return null;
}

/** Contenu principal de la page (ou d'une zone : selector, locator) en markdown, text ou html, borné. */
async function exportContent(params = {}) {
    const tabId = await resolveTargetTab(params);
    const locator = parseLocator(params.locator);
    const spec = {
        format: params.format || "markdown",
        selector: params.selector || null,
        locator,
        maxChars: params.maxChars !== undefined ? params.maxChars : params.max_chars
    };
    const code = `(${EXPORT_KIT_SOURCE})().pageExport(${JSON.stringify(spec)}, ${locator ? `(${LOCATOR_KIT_SOURCE})()` : "null"})`;
    const res = await evaluateIsolated({ tabId, code });
    return exportError(res) || res;
}

/**
 * Google Docs, Sheets ou Slides ouvert dans l'onglet : URL d'export officielle, fetch depuis la page avec les
 * cookies de la session (credentials: "include"). Repli : même fetch depuis le service worker (droits d'hôte de
 * l'extension) si la page le refuse (CORS d'une redirection). Texte ou base64 renvoyé ; le serveur MCP écrit les
 * binaires sur disque. Aucun cookie n'est lu ni renvoyé.
 */
async function exportGsuite(params = {}) {
    const tabId = await resolveTargetTab(params);
    const tab = await chrome.tabs.get(tabId);
    const plan = EK.gsuitePlan(tab?.url || tab?.pendingUrl || "", params.format, params.gid);
    if (plan.error) return { error: plan.error };
    const opts = { binary: plan.binary, maxBytes: EXPORT_MAX_BYTES, timeoutMs: EXPORT_FETCH_TIMEOUT_MS };
    const res = await evaluateIsolated({ tabId, code: `(${EXPORT_KIT_SOURCE})().fetchResource(${JSON.stringify(plan.url)}, ${JSON.stringify(opts)})` });
    if (res?.data?.dialogOpened) return res;
    let fetched = res?.data || null;
    let via = "page";
    if (fetched?.networkError && typeof fetch === "function") {
        const pageError = fetched.networkError;
        fetched = await EK.fetchResource(plan.url, opts);
        via = "extension";
        if (fetched?.networkError) fetched.networkError = `page : ${pageError} ; extension : ${fetched.networkError}`;
    }
    if (fetched?.networkError && chrome.downloads?.download) {
        // Mesuré le 16/10 sur le vrai Chrome : l'URL d'export redirige vers *.googleusercontent.com, réponse opaque pour
        // fetch (page comme extension : « Failed to fetch »). Un téléchargement par Chrome suit la redirection avec la
        // session, comme Fichier > Télécharger : le fichier est lu par le client puis rangé ou supprimé.
        const fetchError = fetched.networkError;
        fetched = await downloadViaBrowser(plan.url, `nexus-browser-exports/${plan.document_id}.${plan.extension}`, EXPORT_FETCH_TIMEOUT_MS);
        via = "download";
        if (fetched?.networkError) fetched.networkError = `${fetchError}; download: ${fetched.networkError}`;
    }
    const verdict = EK.gsuiteVerdict(plan, fetched);
    if (verdict.error) {
        if (fetched?.downloadId !== undefined) await discardDownload(fetched.downloadId);
        return { error: verdict.error };
    }
    if (fetched?.downloadId !== undefined) {
        // Fichier gardé pour le client ; seule l'entrée de l'historique des téléchargements de Julien est retirée.
        try { await chrome.downloads.erase({ id: fetched.downloadId }); } catch (_) {}
    }
    const data = {
        kind: plan.kind,
        label: plan.label,
        document_id: plan.document_id,
        title: String(tab?.title || "").replace(/\s+-\s+Google (Docs|Sheets|Slides|Drive)$/i, "") || null,
        format: plan.format,
        extension: plan.extension,
        binary: plan.binary,
        mime: String(fetched.type || "").split(";")[0].trim() || plan.mime,
        bytes: fetched.bytes,
        filename: fetched.filename || null,
        export_url: plan.url,
        via
    };
    if (plan.kind === "spreadsheets") {
        data.gid = plan.gid;
        if ((plan.format === "csv" || plan.format === "tsv") && plan.gid === null) data.note = "No gid: first sheet of the spreadsheet only (give gid, or open the wanted sheet).";
    }
    if (via === "download") data.download_path = fetched.path;
    else if (plan.binary) data.base64 = fetched.base64;
    else data.text = fetched.text;
    return { data };
}

/**
 * Téléchargement par Chrome (cookies de la session, redirections suivies), sans boîte « Enregistrer sous », dans
 * Téléchargements\nexus-browser-exports\. Rend { ok, status, path, bytes, type, finalUrl, filename, downloadId } ou
 * { networkError }. L'entrée est retirée de l'historique des téléchargements de Julien (le fichier reste, lu par le
 * client qui le range ou le supprime).
 */
async function downloadViaBrowser(url, filename, timeoutMs) {
    let id;
    try {
        id = await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" });
    } catch (error) {
        return { networkError: String(error?.message || error) };
    }
    return await new Promise((resolve) => {
        let done = false;
        const finish = (value) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(onChanged);
            resolve(value);
        };
        const timer = setTimeout(async () => {
            await discardDownload(id);
            finish({ networkError: `download not finished within ${timeoutMs} ms` });
        }, timeoutMs);
        async function check() {
            const [item] = await chrome.downloads.search({ id });
            if (!item || done) return;
            if (item.state === "complete") {
                finish({
                    ok: true, status: 200, path: item.filename, downloadId: id,
                    bytes: item.fileSize || item.totalBytes || item.bytesReceived || 0,
                    type: item.mime || "", finalUrl: item.finalUrl || item.url,
                    filename: String(item.filename || "").split(/[\\/]/).pop() || null
                });
            } else if (item.state === "interrupted") {
                await discardDownload(id);
                finish({ networkError: `download interrupted (${item.error || "unknown reason"})` });
            }
        }
        function onChanged(delta) {
            if (delta.id === id && (delta.state || delta.error)) check();
        }
        chrome.downloads.onChanged.addListener(onChanged);
        check();
    });
}

/** Fichier d'un téléchargement refusé ou inachevé supprimé, et entrée retirée de l'historique. */
async function discardDownload(id) {
    try { await chrome.downloads.removeFile(id); } catch (_) {}
    try { await chrome.downloads.erase({ id }); } catch (_) {}
}

/** Transcription de la vidéo YouTube ouverte dans l'onglet (piste choisie par langue, json3 ou vtt). */
async function exportYoutubeTranscript(params = {}) {
    const tabId = await resolveTargetTab(params);
    const tab = await chrome.tabs.get(tabId);
    if (!EK.isYoutubeUrl(tab?.url || "")) return { error: `The tab is not a YouTube page (${String(tab?.url || "?").slice(0, 120)}).` };
    const spec = {
        lang: params.lang || null,
        format: params.format || "json3",
        maxChars: params.maxChars !== undefined ? params.maxChars : params.max_chars,
        enableCaptions: params.enableCaptions !== false,
        timeoutMs: EXPORT_FETCH_TIMEOUT_MS / 2
    };
    const res = await evaluateScript({ tabId, code: `(${EXPORT_KIT_SOURCE})().youtubeTranscript(${JSON.stringify(spec)})` });
    return exportError(res) || res;
}

/**
 * Token-optimized compact interactive element map
 * Returns numbered interactive elements ([#1], [#2]...) with labels, selectors, and box_2d coordinates.
 * Populates window.__nexus_som_elements so elements can be targeted directly.
 */
async function getInteractiveMap(params = {}) {
    let tabId = await resolveTargetTab(params);

    const viewportOnly = params.viewportOnly !== false;
    const maxElements = params.maxElements ? parseInt(params.maxElements) : 60;

    const buildScript = (startMark, budget) => `(() => {
        if (!window.__nexus_som_elements) {
            window.__nexus_som_elements = new Map();
        } else {
            window.__nexus_som_elements.clear();
        }

        const selector = "button, a, input, select, textarea, [contenteditable='true'], [contenteditable=''], [contenteditable='plaintext-only'], [role='textbox'], [role='button'], [role='link'], [role='tab'], [role='checkbox'], [role='menuitem'], [onclick], [tabindex]";
        const w = window.innerWidth || (document.documentElement ? document.documentElement.clientWidth : 1) || 1;
        const h = window.innerHeight || (document.documentElement ? document.documentElement.clientHeight : 1) || 1;

        function collectElements(root, elements = []) {
            if (!root || !root.querySelectorAll) return elements;
            try {
                const candidates = Array.from(root.querySelectorAll(selector));
                for (const el of candidates) elements.push(el);
                const all = root.querySelectorAll("*");
                for (const el of all) {
                    if (el.shadowRoot) {
                        collectElements(el.shadowRoot, elements);
                    }
                }
                const iframes = root.querySelectorAll("iframe");
                for (const f of iframes) {
                    try {
                        if (f.contentDocument) collectElements(f.contentDocument, elements);
                    } catch(e) {}
                }
            } catch(e) {}
            return elements;
        }

        const rawList = collectElements(document);
        const seen = new Set();
        const results = [];
        let markId = ${startMark};

        for (const el of rawList) {
            if (seen.has(el)) continue;
            seen.add(el);

            let rect = { x: 0, y: 0, width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0 };
            try {
                rect = el.getBoundingClientRect();
            } catch(e) {
                continue;
            }

            if (rect.width <= 4 || rect.height <= 4) continue;
            if (${viewportOnly}) {
                if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) continue;
            }

            try {
                const style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") continue;
            } catch(e) {}

            window.__nexus_som_elements.set(markId, el);

            const tag = el.tagName ? el.tagName.toLowerCase() : "element";
            const role = el.getAttribute ? el.getAttribute("role") : null;
            const type = el.type || null;
            // Jamais la valeur d'un champ mot de passe ; celle d'un champ de saisie n'est pas un libellé non plus.
            const fieldValue = (tag === "input" && ["button", "submit", "reset"].includes(String(type).toLowerCase())) ? el.value : "";
            // Éditeur riche (contenteditable, role=textbox) : son contenu est une saisie (peut-être sensible), jamais un libellé.
            const editorHost = !!el.isContentEditable || (role === "textbox" && tag !== "input" && tag !== "textarea");
            const ariaLabel = el.getAttribute ? el.getAttribute("aria-label") : "";
            // Libellé visible d'un champ (<label for>, <label> englobant, aria-labelledby) : sans lui, trois boutons
            // radio "size" ou quatre cases "topping" sont indiscernables pour l'agent. Jamais la valeur saisie.
            const labelledBy = el.getAttribute ? String(el.getAttribute("aria-labelledby") || "").split(/\\s+/)
                .map(id => (id && document.getElementById(id)?.textContent) || "").join(" ").trim() : "";
            const fieldLabel = el.labels && el.labels.length
                ? Array.from(el.labels).map(l => l.innerText || l.textContent || "").join(" ").trim() : "";
            const textRaw = editorHost ? (ariaLabel || labelledBy || fieldLabel || el.title || "")
                : (el.innerText || fieldValue || ariaLabel || labelledBy || fieldLabel || el.placeholder || el.title
                    || el.name || "");
            const label = String(textRaw).trim().slice(0, 60);

            let selectorHint = tag;
            if (el.id) {
                const safeId = (typeof window !== "undefined" && window.CSS && typeof CSS.escape === "function") ? CSS.escape(el.id) : el.id;
                selectorHint += "#" + safeId;
            } else if (el.name) {
                // Gabarit texte : chaque barre oblique inverse est doublée pour survivre à la sérialisation.
                const rawName = String(el.name);
                const safeName = (typeof CSS !== "undefined" && typeof CSS.escape === "function")
                    ? CSS.escape(rawName)
                    : rawName.replace(/["\\\\]/g, "\\\\$&").replace(/\\n/g, "\\\\a ");
                selectorHint += '[name="' + safeName + '"]';
            } else {
                const rawClass = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
                if (rawClass) {
                    const firstClass = rawClass.trim().split(/\\s+/)[0];
                    if (firstClass && !firstClass.includes("[") && !firstClass.includes("]") && !firstClass.includes("(") && !firstClass.includes(")") && !firstClass.includes(":") && !firstClass.includes(".") && !firstClass.includes("/") && !firstClass.includes("%")) {
                        const safeClass = (typeof CSS !== "undefined" && typeof CSS.escape === "function") ? CSS.escape(firstClass) : firstClass;
                        selectorHint += "." + safeClass;
                    }
                }
            }

            const ymin = Math.max(0, Math.min(1000, Math.round((rect.top / h) * 1000)));
            const xmin = Math.max(0, Math.min(1000, Math.round((rect.left / w) * 1000)));
            const ymax = Math.max(0, Math.min(1000, Math.round((rect.bottom / h) * 1000)));
            const xmax = Math.max(0, Math.min(1000, Math.round((rect.right / w) * 1000)));

            results.push({
                mark: markId,
                tag,
                role,
                type,
                label,
                selector: selectorHint,
                box_2d: [ymin, xmin, ymax, xmax],
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
            });

            markId++;
            if (results.length >= ${budget}) break;
        }

        return {
            title: typeof document !== "undefined" && document.title ? document.title : "",
            url: typeof window !== "undefined" && window.location ? window.location.href : "",
            viewport: { width: w, height: h },
            count: results.length,
            elements: results
        };
    })()`;

    const top = await evaluateIsolated({ tabId, code: buildScript(1, maxElements) });
    markRoots.delete(tabId);
    if (!top?.data || top.data.dialogOpened || !Array.isArray(top.data.elements)) return top;
    // Cadres d'une autre origine : marqueurs à la suite, boîtes ramenées au viewport principal, cadre indiqué.
    const elements = top.data.elements;
    const marks = new Map();
    const frames = [];
    // Marqueurs numérotés à la suite d'un cadre à l'autre : chaque cadre est traité avant d'évaluer le suivant.
    await crossOriginFrameEvaluations(tabId, () => {
        const used = elements.length;
        return used >= maxElements ? null : buildScript(used + 1, maxElements - used);
    }, async (root, value) => {
        if (!value || !Array.isArray(value.elements)) return;
        frames.push({ frame: root.label, url: value.url, count: value.elements.length });
        let offset = { x: 0, y: 0 };
        try {
            const proj = await projectToTop(root, [{ x: 0, y: 0 }], false);
            if (proj.ok) offset = proj.points[0];
        } catch (_) {}
        const vw = top.data.viewport?.width || 1;
        const vh = top.data.viewport?.height || 1;
        for (const el of value.elements) {
            const rect = { ...el.rect, x: Math.round(el.rect.x + offset.x), y: Math.round(el.rect.y + offset.y) };
            const clamp = (v) => Math.max(0, Math.min(1000, Math.round(v)));
            elements.push({
                ...el,
                rect,
                box_2d: [clamp(rect.y / vh * 1000), clamp(rect.x / vw * 1000), clamp((rect.y + rect.height) / vh * 1000), clamp((rect.x + rect.width) / vw * 1000)],
                frame: root.label,
                crossOriginFrame: true
            });
            marks.set(el.mark, root.key);
        }
    });
    if (marks.size) markRoots.set(tabId, marks);
    top.data.count = elements.length;
    if (frames.length) top.data.frames = frames;
    return top;
}

/**
 * Évalue un script dans chaque cadre d'une autre origine (monde isolé) ; codeFor(root) peut renvoyer null pour sauter.
 */
async function crossOriginFrameEvaluations(tabId, codeFor, onResult) {
    const out = [];
    let target;
    try { target = await ensureDebugger(tabId); } catch (_) { return out; }
    let roots = [];
    try { roots = (await listFrameRoots(target)).slice(1); } catch (_) { return out; }
    for (const root of roots) {
        const code = typeof codeFor === "function" ? codeFor(root) : codeFor;
        if (!code) continue;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const contextId = await rootContextId(root, attempt > 0);
                const res = await sendCommandWatchingDialogs(root.target, "Runtime.evaluate", {
                    expression: code, contextId, returnByValue: true, awaitPromise: true
                });
                if (res?.__dialog || res?.exceptionDetails) break;
                out.push({ root, value: res?.result?.value });
                if (onResult) await onResult(root, res?.result?.value);
                break;
            } catch (error) {
                if (attempt > 0 || !isContextLost(error)) break;
            }
        }
    }
    return out;
}

/**
 * Glisser-déposer réel : bouton gauche enfoncé sur la source, déplacements intermédiaires (buttons: 1), relâché sur la
 * destination, par CDP Input.dispatchMouseEvent (événements isTrusted, glisser HTML5 natif compris).
 * Cibles : sélecteurs, numéros de marqueurs ou coordonnées {x, y} du viewport principal.
 * Le DragEvent HTML5 synthétique n'est plus envoyé en plus (il déposait deux fois) : seulement en repli explicite,
 * si la source est draggable et qu'aucun drop de confiance n'a atteint la destination.
 */
async function dragAndDrop(params = {}) {
    const tabId = await resolveTargetTab(params);

    const side = (selector, mark, coords, locator) => {
        const loc = parseLocator(locator);
        if (loc) return { locate: { locator: loc } };
        if (coords && Array.isArray(coords) && coords.length >= 2) return { point: { x: Number(coords[0]), y: Number(coords[1]) } };
        if (coords && coords.x !== undefined && coords.y !== undefined) return { point: { x: Number(coords.x), y: Number(coords.y) } };
        if (mark !== undefined && mark !== null && !isNaN(parseInt(mark, 10))) return { locate: { mark: parseInt(mark, 10) } };
        if (selector) return { locate: { selector, index: 0 } };
        return null;
    };
    const from = side(params.from_selector || params.fromSelector,
        params.from_mark !== undefined ? params.from_mark : params.fromMark,
        params.from_coordinates || params.fromCoordinates, params.from_locator || params.fromLocator);
    const to = side(params.to_selector || params.toSelector,
        params.to_mark !== undefined ? params.to_mark : params.toMark,
        params.to_coordinates || params.toCoordinates, params.to_locator || params.toLocator);
    if (!from) return { error: "Source location not found for drag-and-drop: " + JSON.stringify(params) };
    if (!to) return { error: "Destination location not found for drag-and-drop: " + JSON.stringify(params) };

    const steps = params.steps !== undefined ? Math.max(2, parseInt(params.steps, 10) || 2) : 12;
    const delay = params.delayMs !== undefined ? Math.max(0, parseInt(params.delayMs, 10) || 0) : 15;
    const timeoutMs = mouseTimeout(params, 1200);

    let target;
    try {
        target = await ensureDebugger(tabId);
    } catch (error) {
        return await dragJsFallback(tabId, from, to, error.message || String(error), timeoutMs);
    }

    lastActionAt.set(tabId, Date.now());
    const probes = [];
    const fail = async (result) => {
        for (const p of probes) await releaseMouseProbes(p.root, [p.id]);
        return result;
    };
    let src = null;
    let dst = null;
    try {
        // Source centrée, destination amenée au plus près, puis point de la source relu sans défiler.
        if (from.locate) {
            src = await prepareAnywhere(target, from.locate, { scroll: "center", timeoutMs });
            if (src?.__dialog) return { data: { ...dialogInterruption(src.__dialog), method: "cdp" } };
            if (!src?.success) return { error: "Source : " + prepareError(src, from.locate) };
        }
        if (to.locate) {
            dst = await prepareAnywhere(target, to.locate, {
                scroll: "nearest", probe: ["dragenter", "dragover", "drop", "mouseup", "pointerup"], timeoutMs
            });
            if (dst?.__dialog) return await fail({ data: { ...dialogInterruption(dst.__dialog), method: "cdp" } });
            if (dst?.probeId) probes.push({ root: dst.root, id: dst.probeId });
            if (!dst?.success) return await fail({ error: "Destination : " + prepareError(dst, to.locate) });
        }
        if (from.locate) {
            src = await prepareAnywhere(target, from.locate, {
                scroll: "none", probe: ["mousedown", "pointerdown", "dragstart"], timeoutMs: 0
            });
            if (src?.__dialog) return await fail({ data: { ...dialogInterruption(src.__dialog), method: "cdp" } });
            if (src?.probeId) probes.push({ root: src.root, id: src.probeId });
            if (!src?.success) {
                return await fail({ error: "Source and destination are not reachable in the same view: " + prepareError(src, from.locate) });
            }
        }
    } catch (error) {
        if (!isDebuggerUnavailable(error)) throw error;
        attachedDebuggers.delete(tabId);
        return await dragJsFallback(tabId, from, to, error.message || String(error), timeoutMs);
    }

    const start = from.point || src.point;
    const end = to.point || dst.point;
    let run;
    try {
        run = await runMouseSequence(target, mouseDragSequence(start, end, steps), delay);
    } catch (error) {
        await fail(null);
        throw error;
    } finally {
        scheduleDebuggerDetach(tabId);
    }
    const report = { success: true, method: "cdp", from: start, to: end, steps };
    if (run.dialog) return { data: { ...dialogInterruption(run.dialog), ...report } };

    // Le drop natif peut suivre de peu le relâchement : relecture brève de la sonde de destination.
    let dstProbe = null;
    if (dst?.probeId) {
        for (let i = 0; i < 5; i++) {
            dstProbe = await readMouseProbe(dst.root, dst.probeId, false);
            if (!dstProbe || dstProbe.drops > 0) break;
            await sleepMs(MOUSE_RETRY_MS);
        }
    }
    let html5Fallback = false;
    const sameContext = src?.root && dst?.root && src.root.key === dst.root.key;
    if (src?.draggable && src.probeId && dstProbe && dstProbe.drops === 0 && sameContext) {
        try {
            const res = await pageCall(src.root, { phase: "html5drop", srcProbe: src.probeId, dstProbe: dst.probeId });
            if (res?.__dialog) {
                return { data: { ...dialogInterruption(res.__dialog), ...report, method: "cdp+html5_fallback", html5_fallback: true } };
            }
            html5Fallback = !!res?.dispatched;
        } catch (_) {}
    }
    const srcProbe = src ? await readMouseProbe(src.root, src.probeId) : null;
    if (dst) await readMouseProbe(dst.root, dst.probeId);
    report.method = html5Fallback ? "cdp+html5_fallback" : "cdp";
    report.html5_fallback = html5Fallback;
    report.drop_events = dstProbe ? dstProbe.drops : null;
    report.trusted_drop = dstProbe ? dstProbe.drops > 0 : null;
    report.trusted_drag = srcProbe ? srcProbe.trusted > 0 : null;
    if (html5Fallback) {
        report.warning = "No trusted drop after the CDP sequence: synthetic HTML5 DragEvent sent once as a fallback.";
    }
    return { data: report };
}

/**
 * Repli sans débogueur du glisser : DragEvent HTML5 synthétiques (isTrusted=false), signalés comme tels.
 */
async function dragJsFallback(tabId, from, to, reason, timeoutMs) {
    const spec = {
        phase: "jsdrag",
        from: from.locate || { point: from.point },
        to: to.locate || { point: to.point }
    };
    const result = await mouseJsFallback(tabId, spec, reason, timeoutMs);
    if (result.data) {
        delete result.data.trusted_click;
        result.data.trusted_drop = false;
    }
    return result;
}
