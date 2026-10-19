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
    "network-record", "control-panel", "page-coordinates-capture",
    "orphan-tabs", "cdp-page-world", "local-cookie-values", "body-masking-allowlist",
    "sensitive-field-masking", "cdp-reload-no-script", "ax-value-masking", "capture-screencast",
    "capture-field-masking", "console-masking"
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
// « gone ») laisse des onglets ORPHELINS : un client du MÊME agent peut les reprendre (adopt_tab sans julienAsked),
// les fermer ou les rendre. Une session vivante reste protégée, même contre une autre session de son agent.
// -----------------------------------------------------------------------------
const OWNERS_KEY = "nexusBrowserTabOwners";
const STOP_KEY = "nexusBrowserStopUntil";
const SEEN_KEY = "nexusBrowserClientSeen";
// Silence au-delà duquel une session est morte : 1,618 x 60 s (battement des serveurs MCP : 60 / 1,618 s).
const SESSION_DEAD_MS = Math.round(1.618 * 60000);
const SEEN_SAVE_MS = 15000;  // date de vie écrite au plus toutes les 15 s par session (pas une écriture par commande)
const tabOwners = new Map();  // tabId -> { agent, client, adopted, since }
const clientSeen = new Map();  // clientKey -> dernier signe de vie (ms) ; 0 : session morte (processus disparu)
const seenSaved = new Map();  // clientKey -> date de vie déjà écrite dans chrome.storage.session
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
    clientSeen.set(key, now);
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
        const stored = await chrome.storage.session.get([OWNERS_KEY, STOP_KEY, SEEN_KEY]);
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
        [SEEN_KEY]: Object.fromEntries(clientSeen.entries())
    }));
    stateChain = run.catch(() => {});
    return run;
}

// Propriété relue avant la toute première commande (redémarrage du service worker compris).
const extensionStateReady = (typeof chrome !== "undefined" && chrome.storage?.session) ? loadExtensionState() : Promise.resolve();

async function rememberTabOwner(tabId, client, how = "created", panelRequest = null) {
    if (!Number.isInteger(tabId) || !validClient(client)) return;
    const owner = { agent: client.agent, client: client.id, adopted: how === "adopted", since: Date.now() };
    if (panelRequest) owner.panelRequest = String(panelRequest);  // adopté depuis le panneau : suivi des navigations
    tabOwners.set(tabId, owner);
    await saveExtensionState();
    return owner;  // l'objet écrit par CET appel, même si la Map a changé pendant la sauvegarde
}

async function forgetTabOwner(tabId) {
    if (!tabOwners.delete(tabId)) return false;
    await saveExtensionState();
    return true;
}

function ownerLabel(owner) {
    return owner ? `${owner.agent}${owner.adopted ? " (adopté)" : ""}` : "Utilisateur";
}

// -----------------------------------------------------------------------------
// Arrêt d'urgence vu par l'extension (posé par le pont ou par le bouton STOP du poste de contrôle) : toute action est
// refusée jusqu'à l'échéance, et les boucles en cours (frappe touche par touche, glisser, attentes) s'interrompent au
// prochain pas. Les lectures restent permises, comme au pont.
// -----------------------------------------------------------------------------
const STOP_HOLD_MS = 120000;
const stopWaiters = new Set();
// Lectures permises pendant l'arrêt : miroir de READ_ONLY_ACTIONS (native-host/bridge_security.py), aux noms d'action
// reçus par l'extension (vérifié par tests/test_cross_review.py).
const STOP_ALLOWED_ACTIONS = new Set([
    "ping", "list_tabs", "get_active_tab", "active_tab", "get_dom", "get_content", "content", "axtree",
    "get_accessibility_tree", "get_logs", "logs", "console_logs", "screenshot", "take_screenshot", "print_pdf", "pdf",
    "export_pdf", "check_handoff", "download_status", "wait_load", "wait_for_load", "wait_network_idle",
    "network_idle", "interactive_map", "field_state", "interactive_elements", "som_map", "vision_inspect", "som_inspect", "find",
    "find_elements", "locate", "network_requests", "network_response", "network_response_body", "wait_download",
    "export_content", "content_export", "export_gsuite", "gsuite_export", "release_tab", "network_stop",
    "emergency_stop", "heartbeat"
]);

function stopActive() {
    return Date.now() < stoppedUntil;
}

function stopMessage() {
    const left = Math.max(0, Math.round((stoppedUntil - Date.now()) / 1000));
    return `Arrêt d'urgence demandé par l'utilisateur : plus aucune action pendant encore ${left} s (commande en cours interrompue). Attendre ses instructions ; ne pas contourner.`;
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
if (typeof importScripts === "function") importScripts("agy_chat.js");

const BRIDGE_WS_URL = "ws://127.0.0.1:9224";
const NATIVE_AUTH_HOST = "com.nexus.browser_auth";
let bridgeLink = null;
let offscreenLinkState = null;
let lastBridgeAuthError = null;
let reconnectTimer = null;
let keepaliveInterval = null;
let reconnectAttempts = 0;

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

function connectBridgeWS() {
    if (typeof WebSocket === "undefined" || typeof globalThis.AgyBridgeLink !== "function") return;
    if (bridgeLink && bridgeLink.alive) return;
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    try {
        bridgeLink = new globalThis.AgyBridgeLink({
            url: BRIDGE_WS_URL,
            role: "service_worker",
            extensionId: chrome.runtime?.id,
            prove: proveWithNativeHost,
            onRequest: (request) => handleCommand(request),
            onStateChange: (link) => {
                if (link.error) lastBridgeAuthError = link.error;
                if (link.state !== "ready") return;
                lastBridgeAuthError = null;
                reconnectAttempts = 0;
                console.log("[NexusBrowser] Service worker authentifié auprès du pont " + BRIDGE_WS_URL);
                link.send({ event: "bridge_connected", timestamp: Date.now() });
                agyInstance().then((instance) => link.send({ event: "agy_hello", instance })).catch(() => {});
                agyResendPending().catch(() => {});  // demandes du panneau restées sans confirmation
                if (keepaliveInterval) clearInterval(keepaliveInterval);
                keepaliveInterval = setInterval(() => {
                    if (bridgeLink && bridgeLink.ready) bridgeLink.send({ event: "keepalive", timestamp: Date.now() });
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

function scheduleBridgeReconnect(overrideDelayMs = null) {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delayMs = overrideDelayMs !== null
        ? overrideDelayMs
        : Math.min(30000, Math.round(1500 * Math.pow(1.618, Math.min(reconnectAttempts, 6))));
    reconnectAttempts++;
    reconnectTimer = setTimeout(connectBridgeWS, delayMs);
}

/** Événement signé vers le pont par la liaison authentifiée disponible (service worker, sinon offscreen). */
async function sendBridgeEvent(payload) {
    if (bridgeLink && bridgeLink.ready && bridgeLink.send(payload)) return true;
    if (!offscreenReady() || !chrome.runtime?.sendMessage) return false;
    try {
        const reply = await chrome.runtime.sendMessage({ target: "offscreen", bridgeEvent: payload });
        return !!(reply && reply.sent);
    } catch (_) {
        return false;
    }
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

/** Message venu d'une page de l'extension (panneau, offscreen), jamais d'un script de contenu ni d'une page web. */
function fromExtensionPage(sender) {
    if (!sender || sender.id !== chrome.runtime?.id || sender.tab) return false;
    return !sender.url || String(sender.url).startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

// Onglet adopté depuis le panneau (propriété marquée panelRequest, gardée comme la propriété elle-même). Si JULIEN
// change lui-même de page (barre d'adresse, favori, précédent/suivant), son accord ne couvre plus ce document :
// l'onglet lui est rendu. Les navigations du travail (lien, envoi de formulaire, rechargement) restent permises.
const AGY_USER_TRANSITIONS = new Set(["typed", "auto_bookmark", "generated", "keyword", "keyword_generated", "start_page"]);

function agyUserNavigation(details) {
    if (!details || details.frameId !== 0) return false;
    const qualifiers = details.transitionQualifiers || [];
    return AGY_USER_TRANSITIONS.has(details.transitionType)
        || qualifiers.includes("forward_back") || qualifiers.includes("from_address_bar");
}

// Génération de navigation de Julien par onglet, notée AVANT toute attente et même sans propriétaire marqué : une
// adoption du panneau en cours la relit à la fin (5e relecture de Codex).
const agyNavGeneration = new Map();

async function agyOnCommitted(details) {
    if (agyUserNavigation(details)) agyNavGeneration.set(details.tabId, (agyNavGeneration.get(details.tabId) || 0) + 1);
    await extensionStateReady;
    if (!tabOwners.get(details.tabId)?.panelRequest || !agyUserNavigation(details)) return false;
    await releaseTabFromPanel(details.tabId, tabOwners.get(details.tabId));
    notifyTabStatus(details.tabId, "Vous avez changé de page : onglet rendu (la demande du panneau visait l'autre page)", 4000, null);
    return true;
}

if (typeof chrome !== "undefined") {
    ensureOffscreenDocument();
    // Fragment (#/fiche/B) et History API (pushState, précédent entre routes) changent de fiche sans nouveau
    // document : même contrôle (4e relecture de Codex). Les transitions du travail (lien) ne rendent rien.
    for (const event of ["onCommitted", "onReferenceFragmentUpdated", "onHistoryStateUpdated"]) {
        chrome.webNavigation?.[event]?.addListener((details) => { agyOnCommitted(details).catch(() => {}); });
    }
    chrome.storage?.local?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })?.catch?.(() => {});
    if (chrome.sidePanel?.setPanelBehavior) {
        chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    }
    if (chrome.action?.onClicked) {
        chrome.action.onClicked.addListener(async (tab) => {
            try {
                if (tab?.windowId && chrome.sidePanel?.open) {
                    await chrome.sidePanel.open({ windowId: tab.windowId });
                }
            } catch (_) {}
        });
    }
    if (chrome.commands?.onCommand) {
        // sidePanel.open n'est accepté que pendant le geste clavier : appel immédiat avec
        // l'onglet fourni par Chrome, sans await avant (sinon refus silencieux).
        chrome.commands.onCommand.addListener((command, tab) => {
            if (command === "toggle-side-panel" && tab?.windowId && chrome.sidePanel?.open) {
                chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
            }
        });
    }
    if (chrome.runtime?.onStartup) chrome.runtime.onStartup.addListener(() => {
        ensureOffscreenDocument();
        setTimeout(connectBridgeWS, 300);
    });
    if (chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(() => {
        ensureOffscreenDocument();
        setTimeout(connectBridgeWS, 300);
    });
    if (chrome.alarms?.create) {
        chrome.alarms.create("bridge_keepalive_alarm", { periodInMinutes: 1 });
        chrome.alarms.onAlarm.addListener(() => {
            ensureOffscreenDocument();
            if (!bridgeLink || !bridgeLink.alive) {
                connectBridgeWS();
            }
            agyResendPending().catch(() => {});  // demandes du panneau sans confirmation, même panneau fermé
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
            if (!fromExtensionPage(sender)) return;
            if (message.getStatus) {
                sendResponse(bridgeStatus());
                return true;
            }
            // Poste de contrôle (panneau latéral) : il n'exécute aucune action sur les pages ; il montre les onglets
            // pilotés, pose l'arrêt d'urgence et rend un onglet à Julien.
            if (message.getControlState) {
                controlState().then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.panelStop) {
                panelEmergencyStop().then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.agyAsk) {
                agyAskFromPanel(message.agyAsk).then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.agyAbandon) {
                agyChatChange((list) => globalThis.AgyChat.abandon(list, String(message.agyAbandon))).then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.agyClear) {
                agyChatChange((list) => globalThis.AgyChat.clearDisplay(list)).then(() => sendResponse({ ok: true }), (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.panelRelease !== undefined) {
                releaseTabFromPanel(message.panelRelease).then(sendResponse, (error) => sendResponse({ error: error.message || String(error) }));
                return true;
            }
            if (message.bridgeProve) {
                // Poignée de main de la liaison offscreen (qui n'a pas accès à la messagerie native).
                proveWithNativeHost(message.bridgeProve).then(sendResponse);
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
// Poste de contrôle (panneau latéral) : onglets pilotés par chaque agent, état du débogueur, STOP, rendre l'onglet.
// Aucune action sur les pages n'en part ; tout ce qu'il affiche est relu ici.
// -----------------------------------------------------------------------------
async function controlState() {
    await extensionStateReady;
    agyResendPending().catch(() => {});  // le panneau ouvert relit l'état toutes les 1,6 s : reprise sans minuterie
    let tabs = [];
    try { tabs = await chrome.tabs.query({}); } catch (_) {}
    const byId = new Map(tabs.map(t => [t.id, t]));
    const piloted = [...tabOwners.entries()].map(([tabId, owner]) => {
        const tab = byId.get(tabId) || {};
        const recordingUntil = networkRecording.get(tabId) || null;
        return {
            tabId,
            agent: owner.agent,
            session: String(owner.client || "").slice(-8),
            adopted: !!owner.adopted,
            orphan: !sessionAlive(owner),
            since: owner.since || null,
            title: tab.title || "",
            url: maskUrl(tab.url || ""),
            exists: byId.has(tabId),
            debugger: attachedDebuggers.has(tabId),
            commandsInFlight: tabCommandsInFlight.get(tabId) || 0,
            recordingUntil: recordingUntil && recordingUntil > Date.now() ? recordingUntil : null
        };
    }).sort((a, b) => a.agent.localeCompare(b.agent) || a.tabId - b.tabId);
    return {
        version: extensionVersion(),
        bridge: bridgeStatus(),
        stoppedUntil: stopActive() ? stoppedUntil : null,
        tabs: piloted,
        attachedDebuggers: attachedDebuggers.size
    };
}

/** Bouton STOP : arrêt local immédiat, puis arrêt commun ~/.nexus/stop posé par le pont pour tous les agents. */
async function panelEmergencyStop() {
    await emergencyStop({ holdMs: STOP_HOLD_MS, source: "poste de contrôle" });
    const sent = await sendBridgeEvent({ event: "emergency_stop", by: "poste de contrôle", timestamp: Date.now() });
    return {
        stoppedUntil,
        sentToBridge: sent,
        ...(sent ? {} : { warning: "Pont injoignable : arrêt tenu dans Chrome seulement, pas encore chez les autres agents." })
    };
}

// -----------------------------------------------------------------------------
// Panneau Antigravity (accord Claude-Antigravity du 18/10/2026) : la demande tapée par Julien part au pont (liaison
// signée), qui la dépose dans la boîte de Nexus Relay pour Antigravity ; la réponse revient par le pont
// (agy_panel_update). Le fil est gardé dans chrome.storage.session (panneau fermé puis rouvert : rien de perdu).
// Aucune action sur la page ne part d'ici : c'est Antigravity qui agit, avec ses outils nexus-browser.
// -----------------------------------------------------------------------------
const AGY_CHAT_KEY = "agyChat";
const AGY_GRANTS_KEY = "agyGrants";
const AGY_INSTANCE_KEY = "agyInstance";
const AGY_GRANT_MS = 30 * 60 * 1000;
let agyQueue = Promise.resolve();

/** Toute lecture-modification-écriture du panneau (fil, accords, instance) passe par cette file unique du service
 * worker, commun à tous les panneaux du profil : « une demande à la fois » et les accords ne se perdent plus entre
 * deux écritures concurrentes (relecture de Codex). */
function agySerial(task) {
    const run = agyQueue.then(task);
    agyQueue = run.catch(() => {});
    return run;
}

/** Fil gardé dans chrome.storage.local (survit au rechargement de l'extension et au redémarrage de Chrome), réservé aux
 * contextes de confiance de l'extension (jamais aux scripts de contenu : setAccessLevel au démarrage). */
async function agyChatRead() {
    return (await chrome.storage.local.get(AGY_CHAT_KEY))[AGY_CHAT_KEY] || [];
}

function agyChatChange(change) {
    return agySerial(async () => {
        const next = change(await agyChatRead());
        await chrome.storage.local.set({ [AGY_CHAT_KEY]: next });
        return next;
    });
}

/** Identité stable de cette installation (profil) : la réponse revient au Chrome qui a demandé, jamais à un autre. */
let agyInstancePromise = null;
function agyInstance() {
    // Promesse partagée : hello, demande et reprise attendent la MÊME initialisation (jamais deux identités).
    agyInstancePromise ||= (async () => {
        const stored = await chrome.storage.local.get(AGY_INSTANCE_KEY);
        if (stored[AGY_INSTANCE_KEY]) return stored[AGY_INSTANCE_KEY];
        const instance = crypto.randomUUID();
        await chrome.storage.local.set({ [AGY_INSTANCE_KEY]: instance });
        return instance;
    })().catch((error) => {
        agyInstancePromise = null;
        throw error;
    });
    return agyInstancePromise;
}

async function agyAskEvent(entry) {
    const tab = entry.tab ? { id: entry.tab.id, title: entry.tab.title || "", url: entry.tab.origin || "" } : null;
    return { event: "agy_ask", localId: entry.localId, instance: await agyInstance(), text: entry.text, tab, timestamp: Date.now() };
}

/** Accord de Julien lié à SA demande (localId) : onglet et adresse complète de la page au moment de la demande
 * (gardée ici, jamais envoyée). L'adoption issue du panneau doit le présenter (panel_request) ; absent, expiré, autre
 * onglet ou autre page : refusée. Les autres adoptions (Julien l'a demandé ailleurs) n'en dépendent pas. */
async function agyGrants() {
    return (await chrome.storage.session.get(AGY_GRANTS_KEY))[AGY_GRANTS_KEY] || {};
}

function agyGrant(localId, tabId, url) {
    return agySerial(async () => {
        const now = Date.now();
        const grants = Object.fromEntries(Object.entries(await agyGrants()).filter(([, g]) => g.until > now));
        grants[localId] = { tabId, url: String(url || ""), until: now + AGY_GRANT_MS };
        await chrome.storage.session.set({ [AGY_GRANTS_KEY]: grants });
    });
}

/** Refus (message) d'une adoption issue du panneau, ou null si l'accord de Julien couvre cet onglet et cette page. */
async function agyGrantRefusal(panelRequest, tabId, tab) {
    const grant = (await agyGrants())[String(panelRequest)];
    if (!grant) return `Adoption refusée : aucune demande du panneau « ${panelRequest} » en cours pour cet onglet (accord absent ou effacé au rechargement de l'extension). Le dire à l'utilisateur.`;
    if (grant.until <= Date.now()) return "Adoption refusée : l'accord de l'utilisateur pour cette demande du panneau a expiré (30 min). Le dire à l'utilisateur.";
    if (grant.tabId !== tabId) return `Adoption refusée : la demande du panneau visait l'onglet ${grant.tabId}, pas ${tabId}.`;
    if (!tab || tab.url !== grant.url) {
        return `Adoption refusée : l'onglet ${tabId} a changé de page depuis la demande du panneau (${globalThis.AgyChat.originOf(grant.url)} → ${globalThis.AgyChat.originOf(tab && tab.url)}). L'accord de l'utilisateur portait sur l'autre page : le lui dire.`;
    }
    return null;
}

async function agyAskFromPanel(ask) {
    const chat = globalThis.AgyChat;
    const checked = chat.checkText(ask && ask.text);
    if (checked.error) return { error: checked.error };
    let tab = null;
    let pageUrl = "";
    const tabId = typeof ask.tabId === "number" ? ask.tabId : NaN;  // null : demande sans onglet (jamais l'onglet 0)
    if (Number.isInteger(tabId) && tabId >= 0) {
        try {
            const found = await chrome.tabs.get(tabId);
            pageUrl = found.url || "";
            tab = { id: tabId, title: found.title || "", origin: chat.originOf(pageUrl) };
        } catch (_) {}
        // Page vue par Julien pendant la frappe (cible figée du panneau) : si l'onglet a changé de page, rien ne part.
        if (tab && typeof ask.expectUrl === "string" && ask.expectUrl && ask.expectUrl !== pageUrl) {
            return { error: "L'onglet visé a changé de page depuis que vous avez commencé à écrire : rien n'est parti. Vérifiez la page, puis renvoyez." };
        }
    }
    const localId = crypto.randomUUID();
    let refused = null;
    // Test et réservation dans la même étape de la file : deux panneaux simultanés ne passent jamais tous les deux.
    await agyChatChange((list) => {
        if (chat.busyAsk(list)) {
            refused = "Antigravity travaille encore sur la demande précédente : attendre sa réponse, ou l'abandonner (une demande à la fois).";
            return list;
        }
        return chat.addAsk(list, { localId, text: checked.text, tab });
    });
    if (refused) return { error: refused };
    if (tab) await agyGrant(localId, tab.id, pageUrl);
    const sent = await agySendAsk(localId);
    agyScheduleResend();
    // Pas envoyé tout de suite : renvoyé toutes les 15 s avec le même localId (dépôt idempotent dans le relais).
    return { localId, sent };
}

async function agySendAsk(localId) {
    const entry = (await agyChatRead()).find((e) => e.kind === "ask" && e.localId === localId);
    if (!entry || entry.status !== "sending") return false;
    const sent = await sendBridgeEvent(await agyAskEvent(entry));
    if (sent) await agyChatChange((list) => globalThis.AgyChat.markSent(list, localId));  // seul un envoi réel compte
    return sent;
}

/** Demandes sans confirmation du pont : renvoyées avec le même identifiant (aucun second dépôt, aucun travail relancé),
 * au réveil de la liaison et à chaque relecture du panneau ouvert ; jamais abandonnées en silence. */
async function agyResendPending() {
    const chat = globalThis.AgyChat;
    const due = chat.dueResends(await agyChatRead());
    let sent = 0;
    for (const entry of due) if (await agySendAsk(entry.localId)) sent++;
    agyScheduleResend();
    return sent;
}

/** Prochaine reprise tant qu'une demande attend sa confirmation, panneau fermé compris (le service worker reste éveillé
 * par sa liaison WebSocket ; l'alarme de la liaison, chaque minute, reprend aussi après un endormissement). */
let agyResendTimer = null;
function agyScheduleResend() {
    if (agyResendTimer) return;
    agyResendTimer = setTimeout(async () => {
        agyResendTimer = null;
        const waiting = (await agyChatRead()).some((e) => e.kind === "ask" && e.status === "sending");
        if (waiting) agyResendPending().catch(() => {});
    }, globalThis.AgyChat.RESEND_AFTER_MS + 500);
    agyResendTimer?.unref?.();  // Node (tests) : ne retient pas le processus ; sans effet dans Chrome
}

function agyAskUpdate(update) {
    return agyChatChange((list) => globalThis.AgyChat.applyUpdate(list, update));
}

async function agyPanelUpdate(params = {}) {
    const list = await agyAskUpdate(params);
    return { entries: list.length };
}

/** « Rendre l'onglet » : propriété retirée, débogueur détaché ; l'onglet reste ouvert pour Julien. */
// expected : la propriété que l'appelant entend rendre (sinon celle trouvée en entrant). Elle n'est retirée que si
// c'est TOUJOURS elle après le détachement : une restitution ancienne ne supprime jamais une adoption plus récente
// (7e relecture de Codex : deux restitutions d'une même navigation, un autre client adopté entre les deux).
async function releaseTabFromPanel(rawTabId, expected = null) {
    const tabId = Number(rawTabId);
    if (!Number.isInteger(tabId)) return { error: `Onglet invalide : ${rawTabId}` };
    await extensionStateReady;
    const owner = expected || tabOwners.get(tabId) || null;
    if (owner && tabOwners.get(tabId) !== owner) return { tabId, released: false, previousOwner: null };
    networkRecording.delete(tabId);
    await detachDebugger(tabId);  // même après un redémarrage du service worker (attachement oublié en mémoire)
    if (tabOwners.get(tabId) !== owner) return { tabId, released: false, previousOwner: null };
    await forgetTabOwner(tabId);
    notifyTabStatus(tabId, "Onglet rendu à l'utilisateur", 2500, null);
    return { tabId, released: !!owner, previousOwner: owner ? owner.agent : null };
}

// -----------------------------------------------------------------------------
// CDP Event Monitor (Console logs, Dialogs, FileChooser & Network In-flight)
// -----------------------------------------------------------------------------
const pendingFileChoosers = new Map();
const activeUploads = new Set();

chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (!source.tabId) return;
    
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
    "ping", "list_tabs", "active_tab", "get_active_tab", "create_tab", "new_tab", "download_status", "download_erase",
    "reload_extension", "adopt_tab", "heartbeat"
]);
// Commandes permises sur un onglet ORPHELIN du même agent (session morte), sans le reprendre d'abord.
const ORPHAN_ACTIONS = new Set(["close_tab", "release_tab"]);
// Commandes du pont lui-même (canal signé), sans client : contrôle de vie et arrêt d'urgence.
const BRIDGE_ACTIONS = new Set(["ping", "emergency_stop", "agy_panel_update"]);

function normalizedAction(req) {
    return String(req.action || req.command || "").toLowerCase().replace(/-/g, "_");
}

function foreignTabMessage(tabId, owner, client) {
    if (orphanFor(owner, client)) {
        return `L'onglet ${tabId} est orphelin : sa session de ${owner.agent} est terminée (serveur redémarré ou arrêté). ` +
            "Le reprendre avec browser_adopt_tab(tab_id) (sans user_asked), ou le fermer (browser_close_tab) ou le rendre à l'utilisateur (browser_release_tab).";
    }
    if (!owner) {
        return `L'onglet ${tabId} n'est piloté par aucun agent (onglet de l'utilisateur) : refusé. Ouvrir le sien avec browser_new_tab ; ` +
            "browser_adopt_tab(tab_id, user_asked=True) seulement si l'utilisateur l'a demandé explicitement.";
    }
    const sameAgent = client && owner.agent === client.agent;
    return `L'onglet ${tabId} est piloté par ${owner.agent}${sameAgent ? " dans une autre session" : ""} : refusé. ` +
        "Chaque agent n'agit que dans les onglets qu'il a ouverts (browser_new_tab).";
}

/** Refus (message) d'une commande, ou null : identité, arrêt d'urgence, propriété de l'onglet visé. */
function authorizeCommand(action, params, client) {
    if (BRIDGE_ACTIONS.has(action)) return null;
    if (!client) return "Commande sans identité de client (agent et session posés par le pont) : refusée. Relancer install.ps1 (pont à jour).";
    if (stopActive() && !STOP_ALLOWED_ACTIONS.has(action)) return stopMessage();
    if (TAB_FREE_ACTIONS.has(action)) return null;
    if (action === "group_tabs" && Array.isArray(params.tabIds) && params.tabIds.length) {
        for (const raw of params.tabIds) {
            const tabId = Number(raw);
            if (!Number.isInteger(tabId)) return `tab_id invalide : ${raw}`;
            if (!ownedBy(tabOwners.get(tabId), client)) return foreignTabMessage(tabId, tabOwners.get(tabId), client);
        }
        return null;
    }
    const tabId = requestedTabId(params);
    if (tabId === null) {
        const given = params.tabId ?? params.tab_id ?? params.id;
        if (given !== undefined && given !== null && given !== "") return `tab_id invalide : ${given}`;
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
    const params = req.params || req.payload || {};
    // Identité posée par le pont à côté des paramètres (jamais lue dans les paramètres eux-mêmes).
    const client = validClient(req.client) ? { agent: req.client.agent, id: req.client.id } : null;
    // Signe de vie noté AVANT l'autorisation (une commande refusée prouve aussi que la session vit) ; « gone » : posé
    // par le pont dans le canal signé, jamais lu dans les paramètres.
    if (client) await noteClientAlive(client, req.gone);
    const refusal = authorizeCommand(action, params, client);
    if (refusal) return { error: refusal };
    const tabId = requestedTabId(params);
    if (tabId !== null) tabCommandsInFlight.set(tabId, (tabCommandsInFlight.get(tabId) || 0) + 1);
    let result;
    try {
        result = await routeCommand({ action, params }, client);
    } finally {
        if (tabId !== null) {
            const left = (tabCommandsInFlight.get(tabId) || 1) - 1;
            if (left > 0) tabCommandsInFlight.set(tabId, left);
            else tabCommandsInFlight.delete(tabId);
        }
    }
    const visible = tabId !== null && ownedBy(tabOwners.get(tabId), client) ? tabId : null;
    // Evaluation may legitimately return an object containing an error field.
    if (!["eval", "evaluate", "evaluate_js"].includes(action) && result?.data?.error) {
        return annotatePendingDialogs({ error: result.data.error }, visible);
    }
    return annotatePendingDialogs(result, visible);
}

/** Onglet explicitement visé par une commande (tab_id, tabId ou id), sinon null. */
function requestedTabId(params) {
    if (!params || typeof params !== "object") return null;
    for (const key of ["tabId", "tab_id", "id"]) {
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
    return `boîte de dialogue JavaScript ${dialog.type} ouverte dans l'onglet ${dialog.tabId} : « ${String(dialog.message).slice(0, 300)} »`;
}

/**
 * Signale dans la réponse d'une commande la boîte de dialogue encore ouverte dans l'onglet qu'ELLE vise (aucune
 * n'est acceptée d'office). Jamais celles des autres onglets : elles appartiennent peut-être à un autre agent.
 */
function annotatePendingDialogs(result, tabId = null) {
    if (!result || tabId === null || !pendingDialogs.has(tabId)) return result;
    const dialogs = [publicDialog(pendingDialogs.get(tabId))];
    if (result.error) {
        return { ...result, error: `${result.error} [${dialogs.map(d => describeDialog(d)).join(" ; ")} : répondre avec handle_dialog]` };
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
        throw new Error(`${describeDialog(open)}. La page est bloquée : répondre d'abord avec handle_dialog (browser_handle_dialog).`);
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
        message: `La commande a ouvert une ${describeDialog(dialog)}. Rien n'a été accepté : lire le message puis répondre avec browser_handle_dialog(accept, prompt_text, tab_id).`
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
            case "get_active_tab":
                return await getActiveTab(client);

            case "select_tab":
                return await selectTab(params);

            case "create_tab":
            case "new_tab":
                return await createTab(params, client);

            case "adopt_tab":
                return await adoptTab(params, client);

            case "heartbeat":
                return await heartbeat(params, client);

            case "release_tab":
                return await releaseTab(params);

            case "emergency_stop":
                return { data: await emergencyStop({ holdMs: Number(params.hold_s) * 1000, source: "pont" }) };

            case "agy_panel_update":
                // Réservée au pont (canal signé, sans identité de client) : jamais un agent ne parle à la place d'AGY.
                if (client) return { error: "agy_panel_update est réservée au pont." };
                return { data: await agyPanelUpdate(params) };

            case "network_record":
                return await recordNetwork(params);

            case "network_stop":
                return await stopNetworkRecording(params);

            case "group_tabs":
            case "tabs_group":
                return await groupTabs(params);

            case "close_tab":
                return await closeTab(params);

            case "navigate":
                return await navigateTab(params);

            case "reload":
            case "reload_tab":
                return await reloadTab(params);

            case "hover":
            case "hover_element":
                return await hoverElement(params);

            case "eval":
            case "evaluate":
            case "evaluate_js":
                return await evaluateScript(params);

            case "content":
            case "get_dom":
            case "get_content":
                return await getPageContent(params);

            case "get_accessibility_tree":
            case "axtree":
                return await getAccessibilityTree(params);

            case "logs":
            case "get_logs":
            case "console_logs":
                return await getConsoleLogs(params);

            case "click":
            case "click_element":
                return await clickElement(params);

            case "fill":
            case "fill_element":
                return await fillElement(params);

            case "type":
            case "type_text":
                // Comme Playwright pressSequentially : ajoute au texte existant (replace:true pour remplacer).
                return await fillElement(params, { replace: false });

            case "check":
                return await setChecked({ ...params, checked: params.checked === undefined ? true : params.checked });

            case "uncheck":
                return await setChecked({ ...params, checked: false });

            case "find":
            case "find_elements":
            case "locate":
                return await findElements(params);

            case "network_requests":
                return await getNetworkRequests(params);

            case "network_response":
            case "network_response_body":
                return await getNetworkResponse(params);

            case "wait_download":
                return await waitForDownload(params);

            case "download_erase":
                return await eraseDownload(params);

            case "type_keys":
                return await typeKeys(params);

            case "scroll":
                return await scrollPage(params);

            case "screenshot":
            case "take_screenshot":
                return await takeScreenshot(params);

            case "pdf":
            case "print_pdf":
            case "export_pdf":
                return await printToPdf(params);

            case "handle_dialog":
                return await handleJsDialog(params);

            case "upload":
            case "upload_file":
            case "set_files":
                return await uploadFiles(params);

            case "vision_inspect":
            case "som_inspect":
                return await visionInspect(params);

            case "click_mark":
                return await clickMark(params);

            case "semantic_click":
            case "role_click":
                return await semanticClick(params);

            case "semantic_fill":
                return await semanticFill(params);

            case "check_handoff":
                return await checkHandoff(params);

            case "download_status":
                return await getDownloadStatus(params);

            case "press_key":
            case "send_key":
                return await pressKey(params);

            case "select_option":
                return await selectOption(params);

            case "field_state":
                return await fieldState(params);

            case "wait_load":
            case "wait_for_load":
                return await waitForLoad(params);

            case "wait_network_idle":
            case "network_idle":
                return await waitForNetworkIdle(params);

            case "get_cookies":
            case "cookies":
                return await getCookies(params);

            case "cdp_send":
            case "debugger_send":
                return await sendCdpCommand(params);

            case "interactive_map":
            case "interactive_elements":
            case "som_map":
                return await getInteractiveMap(params);

            case "drag_and_drop":
            case "drag":
                return await dragAndDrop(params);

            case "form_fields":
                return await getFormFields(params);

            case "export_content":
            case "content_export":
                return await exportContent(params);

            case "export_gsuite":
            case "gsuite_export":
                return await exportGsuite(params);

            case "export_youtube_transcript":
            case "youtube_transcript":
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
        function __agyInteractiveTarget(el) {
            let node = el;
            for (let hops = 0; node && hops < 8; hops++) {
                if (__agySkipped(node)) break;
                if (__agyIsInteractive(node)) return node;
                node = node.parentElement || null;
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

    function up(node) { return node ? (node.parentNode || node.parentElement || node.host || null) : null; }
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
    function semantic(loc) {
        if (!kit) return null;
        const role = loc.role ? String(loc.role).toLowerCase() : null;
        const nameSearch = loc.name ? kit.__agyNorm(loc.name) : null;
        const textSearch = loc.semanticText ? kit.__agyNorm(loc.semanticText) : null;
        const candidates = kit.__agyAllElements(doc0).filter(el => {
            if (kit.__agySkipped(el)) return false;
            const tag = String(el.tagName || "").toUpperCase();
            const implicit = tag === "BUTTON" ? "button" : (tag === "A" ? "link" : (tag === "INPUT" && (el.type === "button" || el.type === "submit") ? "button" : ""));
            const elRole = String(kit.__agyAttr(el, "role") || implicit).toLowerCase();
            if (role && elRole !== role) return false;
            const textContent = kit.__agyNorm(el.innerText !== undefined && el.innerText !== null ? el.innerText : (el.value || ""));
            if (nameSearch && !kit.__agyLabels(el, true).some(l => l.includes(nameSearch))) return false;
            if (textSearch && !textContent.includes(textSearch)) return false;
            return true;
        });
        // Rôle seul : premier élément visible du rôle. Avec un nom ou un texte : le plus spécifique.
        const hit = kit.__agyPick(candidates, nameSearch || textSearch);
        return hit && !role ? kit.__agyInteractiveTarget(hit) : hit;
    }
    function axPool(token) {
        const reg = win0.__nexusBrowserAx;
        const list = reg && token ? reg[token] : null;
        return Array.isArray(list) ? list.filter(x => x && x.el && x.el.isConnected !== false).map(x => ({ el: x.el, role: x.role, name: x.name })) : null;
    }
    // Correspondances d'un localisateur dans ce contexte (ce cadre et ses cadres same-origin).
    function locatorMatches(loc) {
        if (!lk) throw new Error("Moteur de localisation indisponible dans ce contexte");
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
                locateFailure = { notFound: true, hidden: res.hidden, error: "Aucun élément ne correspond au localisateur " + JSON.stringify(loc.locator) };
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
        if (loc.role || loc.name || loc.semanticText) return semantic(loc);
        if (loc.point) {
            const hit = deepHit(doc0, Number(loc.point.x), Number(loc.point.y));
            return hit || null;
        }
        return null;
    }
    function notFound(loc) {
        if (locateFailure) {
            if (locateFailure.ambiguous) return Object.assign({ notFound: false, error: "Localisateur ambigu" }, locateFailure);
            if (locateFailure.invalid) return Object.assign({ notFound: false }, locateFailure);
            return locateFailure;
        }
        if (loc && loc.active) return { notFound: true, error: "Aucun champ n'a le focus (préciser selector, mark ou locator)" };
        if (loc && loc.mark !== undefined && loc.mark !== null) {
            return { notFound: true, error: "No element registered for mark #" + loc.mark + ". Run vision-inspect or interactive_map first." };
        }
        return { notFound: true, error: "Element not found for " + JSON.stringify(loc) };
    }
    // Champ réellement éditable visé : contrôle d'un <label>, ou unique champ éditable contenu dans l'élément.
    function tagUp(n) { return String((n && n.tagName) || "").toUpperCase(); }
    const TEXT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
    function isTextInput(n) {
        if (tagUp(n) !== "INPUT") return false;
        const t = typeof n.getAttribute === "function" ? (n.getAttribute("type") || "") : (n.type || "");
        return TEXT_TYPES.has(String(t).toLowerCase());
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
        if (hit === null) return { ok: false, blocker: null, reason: "hors de la vue" };
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
                if (outer === null) return { ok: false, blocker: null, reason: "cadre hors de la vue" };
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

    // Sondes oubliées (page bloquée, navigation) : retirées après une minute.
    for (const [id, probe] of store.probes) if (Date.now() - probe.created > 60000) dropProbe(id);

    if (spec.phase === "prepare") {
        const found = locate(spec.locate);
        if (!found) return notFound(spec.locate);
        const el = spec.forEdit ? editTargetOf(found) : found;
        const scroll = spec.scroll || "center";
        if (scroll !== "none" && typeof el.scrollIntoView === "function") {
            try { el.scrollIntoView({ behavior: "instant", block: scroll, inline: scroll }); } catch (_) {}
        }
        const pts = candidates(el);
        let blocker = null;
        let reason = pts.length ? null : "sans surface visible dans la vue";
        let chosen = null;
        const alternatives = [];
        for (const [lx, ly] of pts) {
            const p = project(el, lx, ly);
            if (p.ok) {
                if (!chosen) chosen = p;
                alternatives.push({ x: round2(p.x), y: round2(p.y) });
                if (!spec.allPoints) break;
                continue;
            }
            if (!blocker && p.blocker) blocker = p.blocker;
            if (!reason && p.reason) reason = p.reason;
        }
        const base = info(el);
        const label = describe(el) || "élément";
        if (!chosen) {
            const coveredBy = describe(blocker);
            const failure = {
                notReachable: true,
                ...base,
                coveredBy,
                error: coveredBy
                    ? "<" + label + "> est couvert par <" + coveredBy + "> : aucun point de l'élément n'est atteignable, aucune action souris envoyée."
                    : "<" + label + "> n'est pas atteignable (" + (reason || "hors de la vue") + ") : aucune action souris envoyée."
            };
            if (!spec.allowUnreachable) return failure;
            // Saisie : le champ peut encore recevoir le focus sans clic (DOM focus).
            const probeId = Array.isArray(spec.probe) && spec.probe.length ? addProbe(el, spec.probe) : null;
            return { success: true, ...base, probeId, point: null, unreachable: failure.error, frameDepth: 0 };
        }
        const probeId = Array.isArray(spec.probe) && spec.probe.length ? addProbe(el, spec.probe) : null;
        const x = round2(chosen.x);
        const y = round2(chosen.y);
        return {
            success: true,
            ...base,
            probeId,
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
        return { released: true };
    }

    if (spec.phase === "find") {
        // Candidats d'un localisateur dans ce contexte (sans action) : rôle, nom, état, boîte (repère de ce cadre).
        if (!lk) return { error: "Moteur de localisation indisponible dans ce contexte" };
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
        if (!owner) return { ok: false, reason: "cadre propriétaire introuvable" };
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
                if (hit === null) { reason = reason || "cadre hors de la vue"; continue; }
                if (hit !== undefined && !within(hit, owner)) { blocker = blocker || hit; continue; }
            }
            const c = climb(own.win, x, y, spec.check !== false);
            if (!c.ok) { blocker = blocker || c.blocker; reason = reason || c.reason; continue; }
            depth = c.depth;
            mapped.push({ x: round2(c.x), y: round2(c.y) });
        }
        if (!mapped.length) {
            const coveredBy = describe(blocker);
            return { ok: false, coveredBy, reason: reason || (coveredBy ? null : "hors de la vue") };
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
            return { error: "Le mark désigne un libellé ou un conteneur, pas le champ : viser le mark du champ lui-même (browser_interactive_map)." };
        }
        const kind = tagUp(el) === "TEXTAREA" ? "textarea" : (isTextInput(el) ? "input" : (tagUp(el) === "SELECT" ? "select"
            : (el.isContentEditable ? "contenteditable" : "other")));
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
                return { error: "<" + (describe(el) || "élément") + "> n'est pas un <select> : cliquer la liste puis l'option (browser_click avec locator role=option)." };
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
            if (!match) return { error: "Aucune option ne correspond à " + JSON.stringify(want) + " (options : " + options.slice(0, 15).map(o => JSON.stringify(textOf(o))).join(", ") + ")" };
            if (match.disabled) return { error: "L'option " + JSON.stringify(textOf(match)) + " est désactivée" };
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
            if (el.isConnected === false) return { error: "Champ retiré ou remplacé par la page depuis le geste : relancer browser_interactive_map." };
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
            if (kind === "other" || kind === "select") return { error: `<${String(tagUp(el) || "élément").toLowerCase()}> n'est pas un champ de saisie : viser le mark du champ lui-même.` };
            const actual = readValue();
            return state({ verified: kind === "contenteditable" ? n(actual) === n(want.value) : actual === String(want.value) });
        }
        return { error: "Opération de saisie inconnue : " + op };
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
        if (!DT || !DE) return { error: "DragEvent indisponible dans la page" };
        const dataTransfer = new DT();
        const fire = (el, type) => el.dispatchEvent(new DE(type, { bubbles: true, cancelable: true, dataTransfer }));
        fire(src, "dragstart");
        fire(dst, "dragenter");
        fire(dst, "dragover");
        fire(dst, "drop");
        fire(src, "dragend");
        return { success: true, from: info(src), to: info(dst) };
    }

    return { error: "Phase souris inconnue : " + spec.phase };
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
        throw new Error(`Bouton de souris inconnu '${params.button}' (left, right ou middle)`);
    }
    return button;
}

function mouseClickCount(params) {
    const raw = params.clickCount !== undefined ? params.clickCount
        : (params.click_count !== undefined ? params.click_count : (params.double ? 2 : 1));
    const count = parseInt(raw, 10);
    if (count !== 1 && count !== 2) throw new Error("click_count doit valoir 1 (simple clic) ou 2 (double clic)");
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
    const error = new Error(details?.exception?.description || details?.text || "Erreur du script de page (souris)");
    error.pageError = true;
    return error;
}

/**
 * Exécute une phase de agyMouseKit par CDP dans le monde isolé « nexus-browser » du cadre (contextId obligatoire :
 * jamais le monde de la page, qui pourrait remplacer les marqueurs, les sondes ou le registre AX). Renvoie la valeur,
 * ou { __dialog } si une boîte s'ouvre.
 */
async function mousePageCall(target, spec, contextId) {
    if (!contextId) throw new Error("Monde isolé absent : aucun script exécuté dans le monde de la page.");
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
        `Input.dispatchMouseEvent ${params.type} sans réponse après ${MOUSE_COMMAND_TIMEOUT_MS} ms`);
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
 * pointerdown ; émulation du focus activée → clic de confiance reçu). Activée seulement avant une action de souris,
 * jamais sur une simple lecture ; levée par Chrome au détachement du débogueur.
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
                        key: `${s.sessionId}:${f.id}`, label: `${origin} (iframe hors processus)`, target: s.target,
                        contextId: null, frameId: f.id, sessionId: s.sessionId, origin, url: f.url, oopif: true,
                        ownerTarget: s.info.parentSessionId ? { tabId, sessionId: s.info.parentSessionId } : target,
                        parentFrameId: s.info.parentFrameId, parentSessionId: s.info.parentSessionId
                    };
                    roots.push(root);
                }
                sessionRoot.set(s.sessionId || "", root);
            } else if (origin !== parentOrigin && !oopifFrameIds.has(f.id) && !(await frameReachable(s.target, f))) {
                root = {
                    key: `${s.sessionId || "main"}:${f.id}`, label: `${origin} (iframe d'une autre origine)`, target: s.target,
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
    if (!frameId) throw new Error("Cadre principal introuvable (Page.getFrameTree) : aucun script exécuté.");
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
    if (!res?.executionContextId) throw new Error(`Monde isolé indisponible pour le cadre ${label || frameId}`);
    isolatedWorlds.set(key, res.executionContextId);
    return res.executionContextId;
}

/**
 * Monde isolé du cadre d'un contexte racine : cadre principal compris (plus aucun script de l'extension dans le monde
 * de la page, sauf browser_eval et la transcription YouTube, qui lisent la page elle-même).
 */
async function rootContextId(root, refresh = false) {
    if (!root?.target) throw new Error("Contexte racine inconnu");
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
    if (!owner?.backendNodeId) throw new Error(`Élément <iframe> propriétaire introuvable pour le cadre ${root.label}`);
    // <iframe> propriétaire résolu dans le monde isolé de SON cadre (jamais le monde de la page parente).
    const parentContext = root.parent && sessionKey(root.parent.target) === sessionKey(ownerTarget)
        ? await rootContextId(root.parent)
        : await worldFor(ownerTarget, root.parentFrameId || await mainFrameId(ownerTarget));
    const resolveParams = { backendNodeId: owner.backendNodeId, executionContextId: parentContext };
    const resolved = await chrome.debugger.sendCommand(ownerTarget, "DOM.resolveNode", resolveParams);
    const objectId = resolved?.object?.objectId;
    if (!objectId) throw new Error(`Élément <iframe> propriétaire non résolu pour le cadre ${root.label}`);
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
        try {
            // Mesuré (Chromium 155) : la requête peut ne jamais répondre sur le document d'un cadre d'une autre
            // origine du même processus. Délai court, puis moteur DOM pour ce cadre jusqu'au détachement.
            ax = await withTimeout(chrome.debugger.sendCommand(root.target, "Accessibility.queryAXTree", {
                backendNodeId, role: String(locator.role).toLowerCase()
            }), AX_QUERY_TIMEOUT_MS, "Accessibility.queryAXTree sans réponse");
        } catch (error) {
            axUnavailable.add(root.key + "|" + sessionKey(root.target));
            return null;
        }
        if (!Array.isArray(ax?.nodes)) return null;
        const namePat = locator.name !== undefined && locator.name !== null && locator.name !== "" ? LK.pattern(locator.name, !!locator.exact) : null;
        const hits = ax.nodes.filter(n => n.backendDOMNodeId && (!n.ignored || locator.includeHidden)
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
    return `[${index}] ${c.role || c.tag} « ${String(c.name || "").slice(0, 60)} » <${c.tag}${id}> cadre ${c.frame || "top"}`;
}

function ambiguityError(locator, total, candidates) {
    const list = candidates.slice(0, 10).map((c, i) => describeCandidate(c, i)).join(" ; ");
    return `Localisateur ambigu ${JSON.stringify(locator)} : ${total} éléments correspondent (préciser exact:true, nth ou un critère de plus) : ${list}`;
}

function notFoundError(locator, hidden) {
    const extra = hidden ? ` (${hidden} correspondance(s) masquée(s) ignorée(s) : includeHidden:true pour les voir)` : "";
    return `Aucun élément ne correspond au localisateur ${JSON.stringify(locator)}${extra}`;
}

/**
 * Message d'erreur d'un échec de préparation (introuvable, ambigu, couvert...).
 */
function prepareError(prep, locate) {
    if (!prep) return "Élément introuvable";
    if (prep.ambiguous && Array.isArray(prep.candidates)) {
        return ambiguityError(locate?.locator, prep.count, prep.candidates);
    }
    return prep.error || "Élément introuvable";
}

/**
 * Prépare l'action dans un contexte racine : localise, fait défiler, choisit un point atteignable, puis le ramène au
 * viewport principal (cadres d'une autre origine : <iframe> propriétaires amenés dans la vue et non couverts).
 */
async function prepareInRoot(root, locate, options) {
    const spec = {
        phase: "prepare", locate, scroll: options.scroll || "center", probe: options.probe || null,
        allowUnreachable: !!options.allowUnreachable, allPoints: root.key !== "top", forEdit: !!options.forEdit
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
            ? `le cadre ${proj.frame} est couvert par <${proj.coveredBy}>`
            : `le cadre ${proj.frame} n'est pas atteignable (${proj.reason || "hors de la vue"})`;
        const error = `<${String(prep.tagName || "élément").toLowerCase()}> dans ${root.label} : ${reason} : aucune action souris envoyée.`;
        if (options.allowUnreachable) return { ...prep, point: null, unreachable: error };
        await releaseMouseProbes(root, [prep.probeId]);
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
        if (!Number.isInteger(index)) return { invalid: true, error: `nth invalide : ${nth}` };
        if (index < 0) index += found.total;
        if (index < 0 || index >= found.total) {
            return { notFound: true, error: `nth=${nth} hors limites : ${found.total} élément(s) correspondent au localisateur ${JSON.stringify(locate.locator)}` };
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
        if (!root) return { notFound: true, error: `Le cadre du marqueur #${locate.mark} a disparu : relancer browser_interactive_map.` };
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
            first = first || { notFound: true, error: "Le focus est dans un cadre d'une autre origine non trouvé" };
            continue;
        }
        if (prep?.success) return prep;
        if (!prep?.notFound) return prep;  // couvert, ambigu... : pas de recherche ailleurs
        first = first || prep;
    }
    return first || { notFound: true, error: "Élément introuvable" };
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

async function releaseMouseProbes(where, probeIds) {
    const ids = probeIds.filter(Boolean);
    if (!ids.length) return;
    try { await pageCall(where, { phase: "release", probeIds: ids }); } catch (_) {}
}

// Repli sans débogueur : monde ISOLÉ de l'extension (celui des scripts de contenu), jamais le monde de la page.
async function runPageScript(tabId, func, args) {
    const [frame] = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", func, args }),
        MOUSE_COMMAND_TIMEOUT_MS,
        `injection JavaScript sans réponse après ${MOUSE_COMMAND_TIMEOUT_MS} ms (boîte de dialogue ouverte ?)`
    );
    return frame?.result;
}

/**
 * Repli sans débogueur (onglet protégé, autre débogueur attaché) : ancien chemin JavaScript, signalé comme tel.
 * Cadre principal seulement (et ses cadres same-origin).
 */
async function mouseJsFallback(tabId, spec, reason, timeoutMs) {
    if (!chrome.scripting?.executeScript) {
        throw new Error(`Débogueur indisponible (${reason}) et aucun repli JavaScript possible : aucune action.`);
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
        throw new Error(`Débogueur indisponible (${reason}) et injection JavaScript refusée (${error.message || error}) : aucune action.`);
    }
    if (!value) return { error: `Repli JavaScript sans résultat (${reason})` };
    if (value.notFound || value.error) return { error: value.ambiguous ? ambiguityError(spec.locate?.locator, value.count, value.candidates || []) : (value.error || "Élément introuvable") };
    if (spec.phase === "edit") return { data: { ...value, method: "js_fallback", fallback_reason: reason } };
    const proof = spec.action === "hover" ? { trusted_hover: false } : { trusted_click: false };
    return {
        data: {
            ...value,
            method: "js_fallback",
            ...proof,
            fallback_reason: reason,
            warning: "Débogueur indisponible : événements JavaScript synthétiques (isTrusted=false), que beaucoup de sites ignorent. Vérifier l'effet."
        }
    };
}

/**
 * Clic ou survol réel sur l'élément décrit par locate ({selector,index} | {text} | {mark} | {role,name,semanticText}
 * | {locator}), dans le cadre principal ou un cadre d'une autre origine.
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
            timeoutMs
        });
    } catch (error) {
        if (!isDebuggerUnavailable(error)) throw error;
        attachedDebuggers.delete(tabId);
        return await mouseJsFallback(tabId, jsSpec, error.message || String(error), timeoutMs);
    }
    if (prep?.__dialog) return { data: { ...dialogInterruption(prep.__dialog), method: "cdp" } };
    if (!prep?.success) return { error: prepareError(prep, locate) };
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
        await releaseMouseProbes(root, [prep.probeId]);
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
        // La page est bloquée par la boîte : la sonde ne peut pas être relue (retirée plus tard).
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
    } else if (kind !== "hover") {
        await releaseMouseProbes(root, [prep.probeId]);
    }
    if (kind === "hover") {
        report.trusted_hover = probe ? probe.trusted > 0 : null;
    } else {
        report.trusted_click = probe ? probe.seen.includes(MOUSE_PROOF_EVENT[button]) : null;
        report.trusted_events = probe ? probe.seen.filter(type => type !== "pointerdown") : null;
        if (report.trusted_click === false) {
            report.warning = "Aucun événement de confiance n'a atteint l'élément (re-rendu pendant le clic ?) : vérifier l'effet.";
        } else if (report.trusted_click === null) {
            report.note = "Effet non relu : la page a changé pendant le clic (navigation ?).";
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
        crossOriginSupport.set(tabId, `Target.setAutoAttach refusé : ${error.message || error}`);
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
 * état : "mine", "orphan" (orphelin de mon agent, à reprendre), "other" (autre agent ou session vivante), "julien".
 */
function publicOwner(tabId, client) {
    const owner = tabOwners.get(tabId);
    if (!owner) return { owner: null, mine: false, state: "julien" };
    const mine = ownedBy(owner, client);
    const state = mine ? "mine" : (orphanFor(owner, client) ? "orphan" : "other");
    return { owner: ownerLabel(owner), mine, adopted: !!owner.adopted, state };
}

async function listTabs(params = {}, client = null) {
    const tabs = await chrome.tabs.query({});
    return {
        data: tabs.map(t => ({
            id: t.id,
            index: t.index,
            windowId: t.windowId,
            title: t.title,
            url: t.url,
            active: t.active,
            pinned: t.pinned,
            groupId: t.groupId !== undefined ? t.groupId : -1,
            favIconUrl: t.favIconUrl,
            ...publicOwner(t.id, client)
        }))
    };
}

async function getActiveTab(client = null) {
    // Lecture seule : l'onglet actif de Julien ne devient jamais l'onglet de l'agent par ce biais.
    let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) [tab] = await chrome.tabs.query({ active: true });
    return { data: tab ? { ...tab, ...publicOwner(tab.id, client) } : null };
}

/**
 * Onglet visé par une commande de page : tab_id explicite OBLIGATOIRE, et onglet du client qui la demande
 * (authorizeCommand). Trois agents partagent ce Chrome : aucun repli sur un « dernier onglet » ni sur l'onglet actif.
 */
const MISSING_TAB_MESSAGE = "Aucun onglet précisé : précisez tab_id ou ouvrez un onglet avec new_tab (browser_new_tab, " +
    "qui renvoie son id) ; jamais de repli sur l'onglet actif de l'utilisateur ni sur l'onglet d'un autre agent.";

// Adresses qu'un agent peut ouvrir ou visiter : jamais un fichier local (file://), une page interne de Chrome ou un
// script (javascript:), qui donneraient accès aux secrets du poste ou aux réglages du navigateur.
const NAVIGABLE_URL = /^(https?:\/\/|data:|about:blank$)/i;

function checkNavigableUrl(url) {
    const text = String(url || "").trim();
    if (!NAVIGABLE_URL.test(text)) {
        throw new Error(`Adresse refusée : ${text.slice(0, 80)} (http, https, data: ou about:blank seulement ; jamais file://, chrome://, javascript:).`);
    }
    return text;
}

async function resolveTargetTab(params = {}) {
    const id = requestedTabId(params);
    if (id === null) {
        const given = params.tabId ?? params.tab_id ?? params.id;
        if (given !== undefined && given !== null && given !== "") throw new Error(`tab_id invalide : ${given}`);
        throw new Error(MISSING_TAB_MESSAGE);
    }
    try {
        await chrome.tabs.get(id);
    } catch (_) {
        throw new Error(`Target tab ${id} no longer exists`);
    }
    return id;
}

/**
 * Pastille d'état dans l'onglet (agent qui le pilote et action) : message de l'extension au script de contenu du cadre
 * principal (chrome.tabs.sendMessage), qu'une page ne peut pas émettre. Aucun événement de fenêtre.
 */
function notifyTabStatus(tabId, text, autoHideMs = 3000, agent = undefined) {
    if (!tabId || typeof chrome === "undefined" || !chrome.tabs?.sendMessage) return;
    const who = agent === undefined ? (tabOwners.get(tabId)?.agent || "Nexus") : (agent || "Nexus");
    try {
        const pending = chrome.tabs.sendMessage(tabId, { nexusPill: { agent: who, text: String(text).slice(0, 80), autoHideMs } }, { frameId: 0 });
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {}
}

/** Point visé par un vrai clic, montré dans l'onglet (même canal que la pastille). */
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
    let updateError = chrome.tabGroups.update ? null : "chrome.tabGroups.update indisponible";
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
                warning: `Onglets regroupés, mais titre, couleur et repli non appliqués (${updateError || "aucune réponse de Chrome"}).`
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
    if (tab?.windowId && chrome.windows?.update) {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
    notifyTabStatus(tabId, "Au premier plan", 2000);
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
        throw new Error(`Fenêtre ${win?.id ?? "?"} créée, mais son onglet est introuvable : aucun onglet attribué à l'agent.`);
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
        await rememberTabOwner(createdTab.id, client);
        notifyTabStatus(createdTab.id, "Onglet créé (fenêtre réduite)", 2500);
        return { data: { ...createdTab, windowCreated: true, owner: client?.agent || null } };
    }

    try {
        const tab = await chrome.tabs.create(windowId === undefined ? { url, active } : { url, active, windowId });
        await rememberTabOwner(tab.id, client);
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

        notifyTabStatus(tab.id, "Onglet créé", 2500);
        return { data: { ...tab, groupId: assignedGroupId, owner: client?.agent || null } };
    } catch(e) {
        const win = await chrome.windows.create(active ? { url, focused: true } : { url, focused: false, state: "minimized" });
        const createdTab = await tabOfNewWindow(win);
        await rememberTabOwner(createdTab.id, client);
        return { data: { ...createdTab, windowCreated: true, owner: client?.agent || null } };
    }
}

/**
 * Onglet de Julien confié à l'agent qui le demande : refusé par défaut, seulement avec julienAsked=true (Julien l'a
 * demandé explicitement), jamais l'onglet d'un autre agent. Visible dans le poste de contrôle (« adopté »).
 */
async function adoptTab(params = {}, client = null) {
    const tabId = await resolveTargetTab(params);
    const panelRequest = params.panelRequest ?? params.panel_request;
    if (panelRequest !== undefined && panelRequest !== null && panelRequest !== "") {
        return adoptForPanel(tabId, String(panelRequest), client);
    }
    const owner = tabOwners.get(tabId);
    if (ownedBy(owner, client)) return { data: { tabId, adopted: !!owner.adopted, already: true, owner: owner.agent } };
    if (orphanFor(owner, client)) return { data: await reclaimOrphan(tabId, owner, client) };
    if (owner) return { error: foreignTabMessage(tabId, owner, client) };
    // userAsked (julienAsked, julien_asked : anciens noms, même sens).
    if (![params.userAsked, params.user_asked, params.julienAsked, params.julien_asked].includes(true)) {
        return { error: `Adoption de l'onglet ${tabId} refusée par défaut : c'est un onglet de l'utilisateur. Seulement s'il l'a demandé explicitement, relancer avec user_asked=True (affiché dans le poste de contrôle de Chrome).` };
    }
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (_) {}
    if (tab && isProtectedUrl(tab.url)) return { error: `Onglet ${tabId} protégé (${tab.url}) : jamais confié à un agent.` };
    await rememberTabOwner(tabId, client, "adopted");
    notifyTabStatus(tabId, "Onglet confié à l'agent par l'utilisateur", 3500, client.agent);
    return { data: { tabId, adopted: true, owner: client.agent, title: tab?.title || "", url: maskUrl(tab?.url || "") } };
}

/**
 * Adoption issue du panneau (panel_request) : l'accord de Julien est vérifié AVANT tout autre chemin (déjà à l'agent
 * et orphelin compris), la propriété est écrite UNE fois, déjà marquée, puis la page relue. Une navigation de Julien
 * survenue pendant les attentes (génération de l'onglet changée, même sans propriétaire marqué à cet instant) rend
 * l'onglet ; un refus tardif remet la propriété d'avant, seulement si personne ne l'a changée entre-temps (5e relecture
 * de Codex : ni navigation ignorée, ni restitution annulée).
 */
async function adoptForPanel(tabId, panelRequest, client) {
    const generation = agyNavGeneration.get(tabId) || 0;
    let current = null;
    try { current = await chrome.tabs.get(tabId); } catch (_) {}
    const refusal = await agyGrantRefusal(panelRequest, tabId, current);
    if (refusal) return { error: refusal };
    const previous = tabOwners.get(tabId) || null;
    const already = ownedBy(previous, client);
    const reclaimed = !already && orphanFor(previous, client);
    if (previous && !already && !reclaimed) return { error: foreignTabMessage(tabId, previous, client) };
    if (!previous && current && isProtectedUrl(current.url)) return { error: `Onglet ${tabId} protégé (${current.url}) : jamais confié à un agent.` };
    // L'objet écrit par cette transaction, gardé avant toute attente (6e relecture de Codex) : jamais relu dans la Map,
    // où une restitution suivie d'une adoption par un autre client a pu le remplacer pendant la sauvegarde.
    const mine = await rememberTabOwner(tabId, client, previous && !previous.adopted ? "created" : "adopted", panelRequest);
    const stillMine = () => tabOwners.get(tabId) === mine;
    let after = null;
    try { after = await chrome.tabs.get(tabId); } catch (_) {}
    const late = await agyGrantRefusal(panelRequest, tabId, after);
    if ((agyNavGeneration.get(tabId) || 0) !== generation) {
        if (stillMine()) await releaseTabFromPanel(tabId, mine);
        return { error: "Adoption refusée : l'utilisateur a changé de page pendant l'adoption, l'onglet lui est rendu. Le lui dire." };
    }
    if (late) {
        if (stillMine()) {
            if (previous) {
                tabOwners.set(tabId, previous);
                await saveExtensionState();
            } else {
                await forgetTabOwner(tabId);
            }
        }
        return { error: late };
    }
    // Propriété changée pendant les attentes (rendue, reprise par un autre) : cette adoption n'a plus rien à elle.
    if (!stillMine()) return { error: "Adoption refusée : l'onglet a été rendu ou confié à un autre pendant l'adoption. Le dire à l'utilisateur." };
    if (already) return { data: { tabId, adopted: !!previous.adopted, already: true, owner: client.agent } };
    if (reclaimed) {
        notifyTabStatus(tabId, "Onglet repris par la nouvelle session", 2500, client.agent);
        return { data: { tabId, reclaimed: true, adopted: !!previous.adopted, owner: client.agent } };
    }
    notifyTabStatus(tabId, "Onglet confié à l'agent par l'utilisateur", 3500, client.agent);
    return { data: { tabId, adopted: true, owner: client.agent, title: after?.title || "", url: maskUrl(after?.url || "") } };
}

/**
 * Onglet orphelin (session morte du même agent) repris par ce client : sans julienAsked, il était déjà à l'agent.
 * Un onglet de Julien adopté par l'ancienne session le reste (« adopté », rendu à Julien par release_tab).
 */
async function reclaimOrphan(tabId, owner, client) {
    // Le marqueur du panneau suit la propriété : sans lui, une navigation de Julien ne rendrait plus l'onglet.
    await rememberTabOwner(tabId, client, owner.adopted ? "adopted" : "created", owner.panelRequest || null);
    notifyTabStatus(tabId, "Onglet repris par la nouvelle session", 2500, client.agent);
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
    notifyTabStatus(tabId, "Onglet rendu à l'utilisateur", 2500, null);
    return { data: { tabId, released: true } };
}

async function closeTab(params = {}) {
    const tabId = await resolveTargetTab(params);
    await chrome.tabs.remove(tabId);
    await forgetTabOwner(tabId);
    return { data: { success: true, closedTabId: tabId } };
}

async function navigateTab(params) {
    if (!params.url) throw new Error("Missing url parameter");
    const url = checkNavigableUrl(params.url);
    const tabId = await resolveTargetTab(params);

    resetNetworkTracking(tabId);
    const updatedTab = await chrome.tabs.update(tabId, { url });
    notifyTabStatus(tabId, `Navigation : ${url.slice(0, 30)}…`, 2500);
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
    notifyTabStatus(tabId, "Rechargement", 2000);
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
            throw new Error(desc || "Erreur du script de l'extension dans la page");
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

async function getAccessibilityTree(params = {}) {
    let tabId = await resolveTargetTab(params);

    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Accessibility.enable");
    const axResult = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {
        max_depth: params.maxDepth || 15
    });

    // Champ sensible (carte, code ; Chrome ne masque que les mots de passe) : sa valeur et celle de ses nœuds de texte
    // descendants (StaticText, InlineTextBox, qui la répètent comme nom) remplacées par le marqueur.
    const raw = axResult.nodes || [];
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
            if (typeof top.data === "string" && value) top.data += `\n\n--- cadre ${root.label} ---\n${value}`;
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
        try { loc = JSON.parse(raw); } catch (_) { throw new Error(`locator illisible (objet JSON attendu) : ${raw}`); }
    }
    if (!loc || typeof loc !== "object" || Array.isArray(loc)) {
        throw new Error("locator doit être un objet, par exemple {\"role\":\"button\",\"name\":\"Valider\"}");
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
    throw new Error(`Touche inconnue '${name}' (ex. Enter, Tab, Escape, Backspace, ArrowDown, F5, a, Control+A)`);
}

/**
 * "Control+Shift+K", "ctrl+a", "Enter", "+" -> { modifiers: ["Control", "Shift"], key: "K" }.
 */
function parseKeyCombo(combo) {
    const text = String(combo === undefined || combo === null ? "" : combo).trim();
    if (!text) throw new Error("Touche vide");
    if ([...text].length === 1) return { modifiers: [], key: text };
    let parts = text.split("+");
    if (text.endsWith("++")) parts = [...text.slice(0, -2).split("+"), "+"];
    const key = parts.pop();
    const modifiers = [];
    for (const part of parts) {
        const mod = KEY_ALIASES[String(part).trim().toLowerCase()] || String(part).trim();
        if (!Object.prototype.hasOwnProperty.call(MODIFIER_BITS, mod)) throw new Error(`Modificateur inconnu '${part}' dans '${combo}' (Control, Shift, Alt, Meta)`);
        if (!modifiers.includes(mod)) modifiers.push(mod);
    }
    return { modifiers, key: key.trim() || key };
}

async function sendKeyEvent(target, params) {
    // Frappe touche par touche : chaque touche vérifie l'arrêt d'urgence (frappe interrompue au caractère suivant).
    assertNotStopped();
    const call = sendCommandWatchingDialogs(target, "Input.dispatchKeyEvent", params);
    call.catch(() => {});
    return await withTimeout(call, KEY_COMMAND_TIMEOUT_MS, `Input.dispatchKeyEvent ${params.type} sans réponse après ${KEY_COMMAND_TIMEOUT_MS} ms`);
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
        result.data.warning = "Débogueur indisponible : valeur posée par le setter natif et des événements synthétiques (isTrusted=false). Vérifier l'effet.";
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
        if (opts.mode === "trusted") throw new Error(`Frappe de confiance impossible : débogueur indisponible (${error.message || error})`);
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
        if (!state?.success) { await releaseMouseProbes(root, [prep.probeId]); return { error: state?.error || "Champ introuvable" }; }
        base.kind = state.kind;
        if (state.kind === "select") {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `<select> : utiliser browser_select_option (même localisateur).` };
        }
        if (state.kind === "other") {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `<${String(state.tagName || "élément").toLowerCase()}> n'est pas un champ de saisie (input, textarea ou contenteditable).` };
        }
        if (state.disabled || state.readOnly) {
            await releaseMouseProbes(root, [prep.probeId]);
            return { error: `Champ ${state.disabled ? "désactivé" : "en lecture seule"} : aucune saisie.` };
        }
        const before = state.value;
        const expected = opts.replace ? opts.value : before + opts.value;
        const setter = async (reason) => {
            const res = await edit("setValue", { value: opts.value, append: !opts.replace });
            const probe = await readMouseProbe(root, prep.probeId);
            return {
                data: {
                    success: true, ...base, method: "native_setter_fallback", fallback_reason: reason,
                    verified: sameText(res?.value, expected, state.kind), value: shownValue(res?.value, state.sensitive),
                    trusted_input: probe ? probe.seen.includes("input") : null,
                    ...(opts.keys.length ? { keys_not_sent: opts.keys } : {}),
                    warning: "Repli : valeur posée par le setter natif et des événements synthétiques (isTrusted=false), que certains sites ignorent. Vérifier l'effet."
                }
            };
        };
        if (opts.mode === "setter") return await setter("mode setter demandé");

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
            const reason = `focus impossible${prep.unreachable ? ` (${prep.unreachable})` : ""}`;
            if (opts.mode === "trusted") { await releaseMouseProbes(root, [prep.probeId]); return { error: `Frappe de confiance impossible : ${reason}` }; }
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
            return await setter("la frappe de confiance n'a eu aucun effet sur le champ");
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
            data.warning = "Valeur relue différente de la valeur attendue (masque de saisie, filtre ou éditeur qui réécrit le texte) : vérifier.";
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
    if (!["auto", "trusted", "setter"].includes(mode)) throw new Error(`mode de saisie inconnu '${params.mode}' (auto, trusted ou setter)`);
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

const SCREENSHOT_FORMATS = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };

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
        throw new Error("Capture refusée : champs sensibles impossibles à masquer dans la page " +
            "(boîte de dialogue ouverte ? browser_handle_dialog)");
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
    }
}

async function takeScreenshot(params = {}) {
    let tabId = await resolveTargetTab(params);
    const format = String(params.format || "png").toLowerCase();
    const mimeType = SCREENSHOT_FORMATS[format];
    if (!mimeType) throw new Error(`Format de capture inconnu : ${params.format} (png, jpeg ou webp)`);
    const cdpFormat = format === "jpg" ? "jpeg" : format;

    const target = await ensureDebugger(tabId);
    
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
                el.scrollIntoView({ behavior: "instant", block: "center" });
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.height <= 0) return null;
                return { x: r.x, y: r.y, width: r.width, height: r.height };
            })()`
        });
        if (elRect?.data) {
            const clip = await pageClip(target, elRect.data);
            const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, {
                format: cdpFormat,
                clip,
                captureBeyondViewport: true
            }));
            return { data: { dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType, clip } };
        } else {
            return { error: "Element not found for screenshot selector: " + params.selector };
        }
    }

    const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, { format: cdpFormat }));
    return { data: { dataUrl: `data:${mimeType};base64,${shot.data}`, mimeType } };
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
        return `Commande CDP refusée : ${name} avec ${refusedParam} (script injecté dans la page à son chargement). ` +
            `Recharger sans ce paramètre, puis exécuter le script par browser_eval.`;
    }
    if (CDP_ALLOWED.has(name)) return null;
    return `Commande CDP refusée : ${name} n'est pas dans la liste des commandes permises (lecture de la page, ` +
        "captures, entrées et affichage de l'onglet de l'agent). Cookies, stockage, corps de requêtes, Fetch, IO, " +
        "scripts injectés, navigation et téléchargements passent par les outils dédiés (browser_get_cookies, " +
        "browser_network_response, browser_navigate...).";
}

const CDP_WORLDS = new Set(["isolated", "page"]);
const CDP_IMAGE_METHODS = new Set(["Page.captureScreenshot", "Page.printToPDF"]);

async function sendCdpCommand(params) {
    const refusal = cdpRefusal(params.method, params.commandParams);
    if (refusal) throw new Error(refusal);
    const method = String(params.method).trim();
    const world = params.world === undefined || params.world === null || params.world === "" ? "isolated" : String(params.world);
    if (!CDP_WORLDS.has(world)) throw new Error(`world invalide : ${world.slice(0, 40)} ("isolated" par défaut, ou "page").`);
    if (world !== "isolated" && method !== "Runtime.evaluate") {
        throw new Error(`world="${world}" ne vaut que pour Runtime.evaluate (pas pour ${method}).`);
    }
    const tabId = await resolveTargetTab(params);
    const target = await ensureDebugger(tabId);
    let commandParams = params.commandParams && typeof params.commandParams === "object" && !Array.isArray(params.commandParams)
        ? { ...params.commandParams } : {};
    if (method === "Runtime.evaluate") {
        // Contexte imposé (jamais celui choisi par l'agent) et aucune API de la console (copy() écrirait le
        // presse-papiers) : monde isolé de l'extension par défaut ; monde de la PAGE sur demande explicite (comme
        // browser_eval et la console DevTools), pour lire l'état d'une application (store, __INITIAL_STATE__).
        delete commandParams.uniqueContextId;
        delete commandParams.contextId;
        commandParams.includeCommandLineAPI = false;
        if (world === "isolated") commandParams.contextId = await rootContextId(rootOf(target));
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

            return { markers, title: document.title, url: window.location.href };
        })()`
    });

    // 2. Court délai de rendu des badges (lecture : permise pendant l'arrêt d'urgence, donc pas sleepMs)
    await new Promise(r => setTimeout(r, 50));

    // 3. High-res visual screenshot
    const shot = await withSensitiveFieldsMasked(tabId, () => captureScreenshot(target, {
        format: "png"
    }));

    // 4. Clean up visual marker badges from DOM (keeps window.__nexus_som_elements for clickMark)
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
            screenshotDataUrl: `data:image/png;base64,${shot.data}`
        }
    };
}

/**
 * Click directly on an element identified by its visual Set-of-Mark number
 */
async function clickMark(params = {}) {
    const mark = parseInt(params.mark || params.number || params.id, 10);
    if (!mark) throw new Error("Missing 'mark' number to click");
    return await performMouseAction(params, {
        kind: "click",
        locate: { mark },
        button: mouseButton(params),
        clickCount: mouseClickCount(params),
        timeoutMs: mouseTimeout(params, 0)
    });
}

/**
 * Clic sémantique (vrai clic CDP) : locator, ou role + name (+ text) comme avant (élément le plus spécifique).
 */
async function semanticClick(params = {}) {
    const locator = parseLocator(params.locator);
    if (!locator && !params.role && !params.name && !params.text) return { error: "Missing locator, role, name or text for semantic click" };
    return await performMouseAction(params, {
        kind: "click",
        locate: locator ? { locator } : { role: params.role || null, name: params.name || null, semanticText: params.text || null },
        button: mouseButton(params),
        clickCount: mouseClickCount(params),
        timeoutMs: mouseTimeout(params, 2500)
    });
}

/**
 * Saisie sémantique (frappe de confiance) : locator, sinon champ trouvé par son libellé (label, aria-label,
 * aria-labelledby), puis par son placeholder. Strict : plusieurs champs correspondants -> erreur listant les candidats.
 */
async function semanticFill(params = {}) {
    const tabId = await resolveTargetTab(params);
    let locator = parseLocator(params.locator);
    if (!locator) {
        const label = params.label || params.placeholder;
        if (!label) return { error: "Missing locator, label or placeholder for semantic fill" };
        locator = params.placeholder && !params.label ? { placeholder: label } : { label };
        // Aucun champ par libellé : le placeholder (comme l'ancien semantic_fill).
        if (locator.label) {
            const target = await ensureDebugger(tabId);
            const found = await findAcrossRoots(target, { label, exact: params.exact }, { limit: 1 });
            if (!found.dialog && !found.invalid && found.total === 0) {
                const byPlaceholder = await findAcrossRoots(target, { placeholder: label, exact: params.exact }, { limit: 1 });
                if (!byPlaceholder.dialog && byPlaceholder.total > 0) locator = { placeholder: label };
            }
        }
        if (params.exact !== undefined) locator.exact = !!params.exact;
        if (params.nth !== undefined && params.nth !== null) locator.nth = params.nth;
    }
    return await fillElement(params, { locate: { locator }, replace: true, timeoutMs: 2500 });
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
        return SECRET_URL_PARAM.test(name) || LK.sensitiveName(name) ? `${part.slice(0, eq)}=[masqué]` : part;
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
        if (SECRET_HEADER.test(name)) out[name] = `[masqué, ${String(value).length} caractères]`;
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
        frame: rec.sessionId ? "iframe hors processus" : "page"
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
    if (!wasAttached) data.note = "Débogueur attaché par cet appel : seules les requêtes à partir de maintenant seront enregistrées (débogueur détaché après 30 s d'inactivité ; browser_network_record pour le garder pendant une durée bornée).";
    return { data };
}

/**
 * Corps de réponse d'une requête enregistrée (Network.getResponseBody), tronqué ; un corps binaire est signalé et
 * n'est rendu en base64 que sur demande (includeBinary).
 */
async function getNetworkResponse(params = {}) {
    const tabId = await resolveTargetTab(params);
    const id = String(params.requestId || params.request_id || "").trim();
    if (!id) throw new Error("Missing request_id (champ request_id de browser_network_requests)");
    const log = networkLog(tabId);
    let rec = log.byKey.get(id);
    if (!rec) rec = [...log.records].reverse().find(r => r.requestId === id) || null;
    if (!rec) throw new Error(`Requête ${id} absente du journal réseau de l'onglet ${tabId} (tampon de ${NETWORK_BUFFER_SIZE} requêtes).`);
    const target = await ensureDebugger(tabId);
    if (rec.epoch !== log.epoch) {
        throw new Error(`Corps indisponible : le débogueur a été détaché puis rattaché depuis la requête ${id} (Chrome ne garde les corps que pendant la session de débogage). Relancer l'action puis lire le corps aussitôt.`);
    }
    if (rec.state === "pending") throw new Error(`Requête ${id} encore en cours : attendre browser_wait_network_idle.`);
    if (rec.failed) throw new Error(`Requête ${id} en échec (${rec.errorText || "sans corps"}) : aucun corps.`);
    const session = rec.sessionId ? { tabId, sessionId: rec.sessionId } : target;
    let res;
    try {
        res = await chrome.debugger.sendCommand(session, "Network.getResponseBody", { requestId: rec.requestId });
    } catch (error) {
        throw new Error(`Corps indisponible pour ${id} (${error.message || error}) : redirection, réponse sans corps ou ressource déjà libérée par Chrome.`);
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
            data.note = "Corps binaire non rendu (include_binary=true pour le base64, tronqué).";
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
    return typeof value === "string" ? `[masqué, ${value.length} caractères]` : "[masqué]";
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
        return `${part.slice(0, eq)}=[masqué]`;
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
        return `${head}"[masqué, ${value.length} caractères]"`;
    });
    out = out.replace(/([?&#]([A-Za-z0-9_.%-]{1,80})=)([^&#"'\s<]+)/g, (match, head, key, value) => {
        if (!secretBodyParam(key, value)) return match;
        counter.count++;
        return `${head}[masqué]`;
    });
    return { text: out, count: counter.count };
}

// Identifiants connus cités au milieu d'un texte (« Authorization: Bearer ... », jeton GitHub dans un message).
const EMBEDDED_SECRET = /\b(Bearer|Basic)\s+[\w.~+\/=-]{8,}|\b(ya29\.|gh[pousr]_|github_pat_|glpat-|sk-|sk_(live|test)_|rk_(live|test)_|xox[abprs]-|AIza)[\w.-]{8,}|\b(AKIA|ASIA)[0-9A-Z]{12}\b|\beyJ[\w-]+\.[\w-]+\.[\w-]+/g;

function maskLogText(text) {
    return maskSecretBody(text).text.replace(EMBEDDED_SECRET, match => `[masqué, ${match.length} caractères]`);
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
async function waitForDownload(params = {}) {
    if (!chrome.downloads?.search) throw new Error("API chrome.downloads indisponible");
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
        if (chosen && chosen.state === "complete") {
            return { data: { success: true, ...publicDownload(chosen), waited_ms: Date.now() - start } };
        }
        if (chosen && chosen.state === "interrupted") {
            return { error: `Téléchargement interrompu (${chosen.error || "raison inconnue"}) : ${chosen.finalUrl || chosen.url}` };
        }
        if (Date.now() - start >= timeoutMs) break;
        await sleepMs(200);
    }
    if (chosen) {
        const danger = chosen.danger && !["safe", "accepted"].includes(chosen.danger)
            ? ` ; Chrome le juge « ${chosen.danger} » et attend la décision de l'utilisateur (jamais acceptée par l'agent)` : "";
        return { error: `Téléchargement non terminé après ${timeoutMs} ms (état ${chosen.state}, ${chosen.bytesReceived}/${chosen.totalBytes} octets${danger}) : ${chosen.filename || chosen.url}` };
    }
    return { error: `Aucun téléchargement${origin ? ` venant de ${origin}` : ""} commencé depuis ${new Date(since).toISOString()} (délai ${timeoutMs} ms). Une fenêtre « Enregistrer sous » de Chrome peut attendre l'utilisateur.` };
}

/**
 * Retire une entrée de l'historique des téléchargements (le fichier sur disque n'est pas touché).
 */
async function eraseDownload(params = {}) {
    const id = parseInt(params.id !== undefined ? params.id : params.downloadId, 10);
    if (!Number.isInteger(id)) throw new Error("Missing download id");
    const erased = await chrome.downloads.erase({ id });
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
    if (!Object.keys(option).length) return { error: "Préciser value, text ou optionIndex de l'option à choisir" };
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
    if (kinds.length !== 1) return { error: "expect : une seule clé parmi value, option, checked" };
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
        return { error: `<${String(before.data.tagName || "élément").toLowerCase()}> n'a pas d'état coché (case, radio, role=checkbox/switch attendu)` };
    }
    if (before.data.disabled) return { error: "Case désactivée : aucun clic." };
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
    if (!data.verified) data.warning = `État relu ${JSON.stringify(checked)} au lieu de ${wanted} après le clic (bouton radio, case contrôlée par la page ?).`;
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
            const stateRes = await evaluateIsolated({
                tabId,
                code: `document.readyState`
            });
            if (stateRes?.data === "complete") {
                return { data: { readyState: "complete", waitedMs: Date.now() - startTime } };
            }
        } catch (e) {
            // Execution context destroyed during rapid navigation; continue polling until new context settles
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

const LOCAL_COOKIE_REFUSAL = "Valeurs de cookies refusées : seulement pour une origine locale de développement " +
    "(localhost, 127.0.0.1, [::1], *.localhost, *.test), jamais pour un site réel (secrets de session de l'utilisateur). " +
    "Relancer sans include_values pour les noms et attributs.";

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

/**
 * Champs de formulaire visibles du document principal et de ses cadres same-origin : balise, type, nom, id, libellé
 * (label associé, aria-label, aria-labelledby, placeholder, title), requis, rempli ou non. Aucune valeur n'est lue
 * hors du booléen « rempli ».
 */
async function getFormFields(params = {}) {
    const tabId = await resolveTargetTab(params);
    const limit = Math.max(1, Math.min(200, parseInt(params.limit, 10) || 60));
    return await evaluateIsolated({
        tabId,
        code: `(() => {
            const limit = ${limit};
            const fields = [];
            let total = 0;
            const text = (v) => String(v || "").replace(/\\s+/g, " ").trim().slice(0, 80);
            function labelOf(doc, el) {
                const ids = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean);
                const byIds = ids.map(id => doc.getElementById(id)).filter(Boolean).map(n => n.textContent).join(" ");
                const labels = el.labels ? Array.from(el.labels).map(l => l.textContent).join(" ") : "";
                return text(byIds) || text(labels) || text(el.getAttribute("aria-label")) || text(el.getAttribute("placeholder")) || text(el.getAttribute("title"));
            }
            function scan(doc, frame) {
                if (!doc || !doc.querySelectorAll) return;
                for (const el of doc.querySelectorAll("input, textarea, select, [contenteditable=''], [contenteditable='true']")) {
                    const type = String(el.type || (el.isContentEditable ? "contenteditable" : "")).toLowerCase();
                    if (["hidden", "submit", "button", "reset", "image"].includes(type)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) continue;
                    total++;
                    if (fields.length >= limit) continue;
                    const filled = el.isContentEditable ? !!text(el.textContent)
                        : (type === "checkbox" || type === "radio") ? !!el.checked
                        : String(el.value || "").length > 0;
                    fields.push({
                        tag: String(el.tagName || "").toLowerCase(), type: type || null,
                        name: el.getAttribute("name") || null, id: el.id || null,
                        label: labelOf(doc, el) || null, required: !!el.required, disabled: !!el.disabled,
                        filled, frame
                    });
                }
                for (const f of doc.querySelectorAll("iframe")) {
                    try { if (f.contentDocument) scan(f.contentDocument, frame === "top" ? (f.src || "iframe") : frame); } catch (_) {}
                }
            }
            scan(document, "top");
            return { count: total, fields, truncated: total > fields.length };
        })()`
    });
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
    if (!res?.data) return { error: "La page n'a rien renvoyé (onglet en cours de chargement ou protégé ?)" };
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
        if (fetched?.networkError) fetched.networkError = `${fetchError} ; téléchargement : ${fetched.networkError}`;
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
        if ((plan.format === "csv" || plan.format === "tsv") && plan.gid === null) data.note = "Sans gid : première feuille du classeur seulement (préciser gid, ou ouvrir la feuille voulue).";
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
            finish({ networkError: `téléchargement non terminé en ${timeoutMs} ms` });
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
                finish({ networkError: `téléchargement interrompu (${item.error || "raison inconnue"})` });
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
    if (!EK.isYoutubeUrl(tab?.url || "")) return { error: `L'onglet n'est pas une page YouTube (${String(tab?.url || "?").slice(0, 120)}).` };
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
            const textRaw = editorHost ? (ariaLabel || el.title || "")
                : (el.innerText || fieldValue || el.placeholder || ariaLabel || el.title || el.name || "");
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
                return await fail({ error: "Source et destination ne sont pas atteignables dans la même vue : " + prepareError(src, from.locate) });
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
        report.warning = "Aucun drop de confiance après la séquence CDP : DragEvent HTML5 synthétique envoyé une fois en repli.";
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
