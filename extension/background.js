/**
 * Antigravity Browser Bridge - Background Service Worker (Manifest V3)
 * Full automation engine with Chrome DevTools Protocol, AXTree, DOM, PDF Export & visual feedback.
 */

// Moteur de localisation par rôle et libellé (agyLocatorKit), partagé avec les scripts de page.
if (typeof importScripts === "function") importScripts("locator_kit.js");

// Fonctions du code RÉELLEMENT chargé, annoncées par ping : la validation réelle les compare à cette même liste lue
// dans le fichier du dépôt (mesuré le 15/10 : un rechargement peut garder l'ancien service worker avec le nouveau
// numéro de version). Ajouter ici chaque nouvelle capacité visible.
const AGY_FEATURES = [
    "cdp-mouse", "focus-emulation", "focus-emulation-child-settle", "locator", "trusted-typing", "oopif",
    "network-log", "wait-download", "dialogs", "bridge-auth", "sidepanel-requests"
];

let attachedDebuggers = new Set();
let tabConsoleLogs = new Map();
// tabId -> Set(requestId) : requêtes réseau en cours depuis l'attachement CDP (remis à zéro à chaque navigation).
let tabInFlightRequests = new Map();
// Onglet de travail de l'agent, persisté dans chrome.storage.session : il survit au redémarrage du service worker.
let lastAgentTabId = null;
const AGENT_TAB_STORAGE_KEY = "nexusagyAgentTabId";
// Débogueur détaché après cette inactivité (bandeau « en cours de débogage » retiré, onglet rendu à Julien).
const DEBUGGER_IDLE_MS = 30000;
const debuggerIdleTimers = new Map();
// tabId -> boîte de dialogue JavaScript ouverte ({type, message, ...}) : jamais acceptée d'office.
const pendingDialogs = new Map();
const dialogWaiters = new Map();
let commandsInFlight = 0;

console.log("[NexusAGY] Background Service Worker (v2.0.0) active.");

// -----------------------------------------------------------------------------
// Pont local authentifié (bridge_link.js) & keepalive Chrome 116+
// Deux liaisons : celle du service worker (ici, elle exécute les commandes elle-même) et celle du document
// offscreen (relais, garde une connexion quand le service worker est suspendu). Les deux prouvent le jeton par
// l'hôte natif com.nexusagy.bridge_auth ; le pont choisit le service worker en priorité.
// -----------------------------------------------------------------------------
if (typeof importScripts === "function") importScripts("bridge_link.js");

const BRIDGE_WS_URL = "ws://127.0.0.1:9224";
const NATIVE_AUTH_HOST = "com.nexusagy.bridge_auth";
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
                    resolve({ ok: false, error: `hôte natif ${NATIVE_AUTH_HOST} injoignable (${error?.message || "aucune réponse"}) : lancer install.ps1 de NexusAGY` });
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
                console.log("[NexusAGY] Service worker authentifié auprès du pont " + BRIDGE_WS_URL);
                link.send({ event: "bridge_connected", timestamp: Date.now() });
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
            justification: "NexusAGY persistent local WebSocket bridge connection"
        });
        console.log("[NexusAGY] Offscreen keepalive document created.");
    } catch (_) {}
}

/** Message venu d'une page de l'extension (panneau, offscreen), jamais d'un script de contenu ni d'une page web. */
function fromExtensionPage(sender) {
    if (!sender || sender.id !== chrome.runtime?.id || sender.tab) return false;
    return !sender.url || String(sender.url).startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

if (typeof chrome !== "undefined") {
    ensureOffscreenDocument();
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
        chrome.commands.onCommand.addListener(async (command) => {
            if (command === "toggle-side-panel") {
                try {
                    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                    if (tab?.windowId && chrome.sidePanel?.open) {
                        await chrome.sidePanel.open({ windowId: tab.windowId });
                    }
                } catch (_) {}
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
            if (message.getActiveTab) {
                getActiveTab().then(sendResponse);
                return true;
            }
            if (message.executeAction) {
                handleCommand({ action: message.action, params: message.params || {} }).then(sendResponse);
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
            if (message.sidepanelSubmit) {
                submitSidepanelRequest(message.sidepanelSubmit).then(sendResponse);
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
// Panneau latéral : demandes transmises à Antigravity par le pont, réponses de l'agent
// Fil unique dans chrome.storage.session (mémoire, effacé à la fermeture de Chrome), lu par le panneau.
// -----------------------------------------------------------------------------
const SIDEPANEL_THREAD_KEY = "nexusagySidepanelThread";
const SIDEPANEL_THREAD_MAX = 50;
const SIDEPANEL_TEXT_MAX = 4000;
let sidepanelThreadChain = Promise.resolve();

function updateSidepanelThread(mutate) {
    const run = sidepanelThreadChain.then(async () => {
        const stored = await chrome.storage.session.get(SIDEPANEL_THREAD_KEY);
        const thread = Array.isArray(stored?.[SIDEPANEL_THREAD_KEY]) ? stored[SIDEPANEL_THREAD_KEY] : [];
        const result = mutate(thread);
        await chrome.storage.session.set({ [SIDEPANEL_THREAD_KEY]: thread.slice(-SIDEPANEL_THREAD_MAX) });
        return result;
    });
    sidepanelThreadChain = run.catch(() => {});
    return run;
}

function newSidepanelId() {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    return `sp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function submitSidepanelRequest(input = {}) {
    const text = String(input.text || "").trim();
    if (!text) return { error: "Demande vide" };
    if (text.length > SIDEPANEL_TEXT_MAX) return { error: `Demande trop longue (${SIDEPANEL_TEXT_MAX} caractères au plus)` };
    const tab = input.tab && typeof input.tab === "object"
        ? { id: input.tab.id ?? null, title: String(input.tab.title || "").slice(0, 200), url: String(input.tab.url || "").slice(0, 500) }
        : null;
    const request = { id: newSidepanelId(), text, tab, created_at: Date.now() };
    const sent = await sendBridgeEvent({ event: "sidepanel_request", request });
    const entry = { ...request, kind: "request", status: sent ? "sent" : "not_sent" };
    await updateSidepanelThread((thread) => { thread.push(entry); });
    return {
        data: { id: request.id, status: entry.status },
        ...(sent ? {} : { error: "Pont local non authentifié : demande non transmise à Antigravity" })
    };
}

async function replyToSidepanel(params = {}) {
    const text = String(params.text || "").trim();
    if (!text) return { error: "Missing 'text' for the side panel reply" };
    if (text.length > SIDEPANEL_TEXT_MAX * 4) return { error: "Reply too long" };
    const requestId = params.request_id || params.requestId || null;
    const entry = { id: newSidepanelId(), kind: "reply", text, request_id: requestId, created_at: Date.now() };
    await updateSidepanelThread((thread) => {
        thread.push(entry);
        const asked = requestId && thread.find(item => item.kind === "request" && item.id === requestId);
        if (asked) asked.status = "answered";
    });
    return { data: { id: entry.id, shown: true } };
}

async function markSidepanelRead(params = {}) {
    const ids = new Set(Array.isArray(params.ids) ? params.ids : []);
    const marked = await updateSidepanelThread((thread) => {
        let count = 0;
        for (const item of thread) {
            if (item.kind === "request" && ids.has(item.id) && item.status === "sent") {
                item.status = "read";
                count++;
            }
        }
        return count;
    });
    return { data: { marked } };
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
        if (tabId === lastAgentTabId) setAgentTab(null);
        if (attachedDebuggers.has(tabId)) detachDebugger(tabId);
        clearDebuggerIdleTimer(tabId);
        pendingDialogs.delete(tabId);
        attachedDebuggers.delete(tabId);
        tabConsoleLogs.delete(tabId);
        tabInFlightRequests.delete(tabId);
        tabNetwork.delete(tabId);
        lastActionAt.delete(tabId);
        forgetTabFrames(tabId);
        const pending = pendingFileChoosers.get(tabId);
        if (pending) {
            pendingFileChoosers.delete(tabId);
            pending.reject(new Error("Tab closed during file upload"));
        }
        activeUploads.delete(tabId);
    });
}

// -----------------------------------------------------------------------------
// Command Router
// -----------------------------------------------------------------------------
async function handleCommand(req) {
    commandsInFlight++;
    let result;
    try {
        result = await routeCommand(req);
    } finally {
        commandsInFlight--;
    }
    const action = (req.action || req.command || "").toLowerCase().replace(/-/g, "_");
    // Evaluation may legitimately return an object containing an error field.
    if (!["eval", "evaluate", "evaluate_js"].includes(action) && result?.data?.error) {
        return annotatePendingDialogs({ error: result.data.error });
    }
    return annotatePendingDialogs(result);
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
 * Signale dans la réponse de toute commande les boîtes de dialogue encore ouvertes (aucune n'est acceptée d'office).
 */
function annotatePendingDialogs(result) {
    if (pendingDialogs.size === 0 || !result) return result;
    const dialogs = [...pendingDialogs.values()].map(publicDialog);
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

async function routeCommand(req) {
    const rawAction = req.action || req.command || "";
    const action = rawAction.toLowerCase().replace(/-/g, "_");
    const rawParams = req.params || req.payload || req;
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
                        version: chrome.runtime?.getManifest?.()?.version || "2.0.0",
                        features: AGY_FEATURES,
                        timestamp: Date.now(),
                    },
                };

            case "list_tabs":
                return await listTabs(params);

            case "active_tab":
            case "get_active_tab":
                return await getActiveTab();

            case "select_tab":
                return await selectTab(params);

            case "create_tab":
            case "new_tab":
                return await createTab(params);

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

            case "sidepanel_reply":
                return await replyToSidepanel(params);

            case "sidepanel_mark_read":
                return await markSidepanelRead(params);

            case "form_fields":
                return await getFormFields(params);

            case "reload_extension":
                setTimeout(() => { try { chrome.runtime.reload(); } catch(e) {} }, 100);
                return { data: { reloading: true, version: chrome.runtime?.getManifest?.()?.version || "2.0.0" } };

            default:
                return { error: `Unknown action '${action}'` };
        }
    } catch (error) {
        console.log(`[Antigravity] Notice for '${action}':`, error.message);
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
        try { (typeof window !== "undefined" ? window : globalThis).__nexusagyTextKit = kit; } catch (_) {}
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
    const kit = textKit || win0.__nexusagyTextKit || null;
    const lk = locatorKit || win0.__nexusagyLocatorKit || null;
    // Échec détaillé du dernier locate() (localisateur ambigu, aucun élément...).
    let locateFailure = null;
    let store = win0.__nexusagyMouse;
    if (!store || !store.probes || typeof store.probes.get !== "function") {
        store = { probes: new Map(), seq: 0 };
        try { win0.__nexusagyMouse = store; } catch (_) {}
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
    function info(el) {
        const raw = el.innerText !== undefined && el.innerText !== null ? el.innerText : (typeof el.value === "string" ? el.value : "");
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
        const reg = win0.__nexusagyAx;
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
        const som = win0.__antigravity_som_elements;
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
    function visual(x, y) {
        try { win0.dispatchEvent(new CustomEvent("__antigravity_visual_click", { detail: { x, y } })); } catch (_) {}
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
        if (spec.visual) visual(x, y);
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
        let el = locate(spec.locate);
        if (!el) return notFound(spec.locate);
        if (spec.op !== "check") el = editTargetOf(el);
        else if (tagUp(el) === "LABEL" && el.control) el = el.control;
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
            value: readValue(),
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
            visual(cx, cy);
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

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
 * Exécute une phase de agyMouseKit dans la page par CDP. Renvoie la valeur, ou { __dialog } si une boîte s'ouvre.
 * contextId : monde isolé d'un cadre d'une autre origine (sinon monde principal du cadre principal de la session).
 */
async function mousePageCall(target, spec, contextId) {
    const expression = `(${MOUSE_KIT_SOURCE})(${JSON.stringify(spec)}, (${TEXT_KIT_SOURCE})(false), (${LOCATOR_KIT_SOURCE})())`;
    const commandParams = { expression, returnByValue: true, awaitPromise: false };
    if (contextId) commandParams.contextId = contextId;
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

/** La page principale se croit-elle active ? (document.hasFocus, relu dans la page) */
async function pageHasFocus(target) {
    try {
        const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
            expression: "document.hasFocus()", returnByValue: true
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
// `${tabId}|${sessionId}|${frameId}` -> executionContextId du monde isolé « nexusagy »
const isolatedWorlds = new Map();
// tabId -> Map(mark -> clé du contexte racine) pour les marqueurs posés dans un cadre d'une autre origine
const markRoots = new Map();
// tabId -> true (sessions enfants actives) ou message d'erreur (Target.setAutoAttach refusé)
const crossOriginSupport = new Map();
const domEnabledSessions = new Set();
// tabId -> horodatage de la dernière action (clic, saisie, touche) : point de départ de wait_download
const lastActionAt = new Map();
const FRAME_WORLD_NAME = "nexusagy";
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
}

function forgetTabFrames(tabId) {
    childSessions.delete(tabId);
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
        const resolved = owner?.backendNodeId
            ? await chrome.debugger.sendCommand(target, "DOM.resolveNode", { backendNodeId: owner.backendNodeId }) : null;
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

/**
 * Monde isolé du cadre d'un contexte racine non principal (créé une fois, recréé si le cadre a navigué).
 */
async function rootContextId(root, refresh = false) {
    if (!root || root.key === "top") return null;
    const key = `${root.target.tabId}|${root.sessionId || ""}|${root.frameId}`;
    if (!refresh && isolatedWorlds.has(key)) return isolatedWorlds.get(key);
    const res = await chrome.debugger.sendCommand(root.target, "Page.createIsolatedWorld", {
        frameId: root.frameId, worldName: FRAME_WORLD_NAME, grantUniveralAccess: false
    });
    if (!res?.executionContextId) throw new Error(`Monde isolé indisponible pour le cadre ${root.label}`);
    isolatedWorlds.set(key, res.executionContextId);
    return res.executionContextId;
}

function isContextLost(error) {
    return !error?.pageError && /context|Execution context|frame/i.test(String(error?.message || error));
}

/**
 * Phase du kit de page dans un contexte racine (monde principal pour top, monde isolé du cadre sinon).
 */
async function pageCall(where, spec) {
    const root = rootOf(where);
    if (root.key === "top") return await mousePageCall(root.target, spec);
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
    const resolveParams = { backendNodeId: owner.backendNodeId };
    const parentContext = root.parent && root.parent.key !== "top" && sessionKey(root.parent.target) === sessionKey(ownerTarget) ? await rootContextId(root.parent) : null;
    if (parentContext) resolveParams.executionContextId = parentContext;
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
        const contextId = root.key === "top" ? null : await rootContextId(root);
        const docParams = { expression: "document", returnByValue: false };
        if (contextId) docParams.contextId = contextId;
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
                const resolveParams = { backendNodeId: n.backendDOMNodeId };
                if (contextId) resolveParams.executionContextId = contextId;
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
                        const reg = w.__nexusagyAx && typeof w.__nexusagyAx === "object" ? w.__nexusagyAx : (w.__nexusagyAx = {});
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
        visual: !!options.visual, allowUnreachable: !!options.allowUnreachable, allPoints: root.key !== "top",
        forEdit: !!options.forEdit
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

async function runPageScript(tabId, func, args) {
    const [frame] = await withTimeout(
        chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func, args }),
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
    if (!tabId) throw new Error("No active tab");
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
            visual: kind !== "hover",
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
        try {
            await chrome.debugger.attach(target, "1.3");
            attachedDebuggers.add(tabId);
            resetNetworkTracking(tabId);
            await chrome.debugger.sendCommand(target, "Page.enable");
            await chrome.debugger.sendCommand(target, "Runtime.enable");
            await chrome.debugger.sendCommand(target, "Log.enable");
            // Suivi réseau dès l'attachement : wait_network_idle voit aussi les requêtes lancées avant son appel.
            await chrome.debugger.sendCommand(target, "Network.enable");
            networkLog(tabId).epoch++;
            // Iframes hors processus (autre site) : sessions enfants à plat, adressées par sessionId (Chrome 125+).
            try {
                await chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
                    autoAttach: true, waitForDebuggerOnStart: false, flatten: true
                });
                crossOriginSupport.set(tabId, true);
            } catch (error) {
                crossOriginSupport.set(tabId, `Target.setAutoAttach refusé : ${error.message || error}`);
            }
        } catch (e) {
            if (e.message && e.message.includes("is already attached")) {
                attachedDebuggers.add(tabId);
                scheduleDebuggerDetach(tabId);
                return target;
            }
            console.log("[CDP Attach]", e.message);
            throw new Error(`CDP attach error: ${e.message}`);
        }
    }
    scheduleDebuggerDetach(tabId);
    return target;
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
    // Jamais pendant une commande, un téléversement, ou une boîte de dialogue à laquelle l'agent doit répondre.
    if (commandsInFlight > 0 || activeUploads.has(tabId) || pendingDialogs.has(tabId)) {
        scheduleDebuggerDetach(tabId);
        return;
    }
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

async function listTabs(params = {}) {
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
            favIconUrl: t.favIconUrl
        }))
    };
}

function sessionStore() {
    try {
        return (typeof chrome !== "undefined" && chrome.storage?.session) || null;
    } catch (_) {
        return null;
    }
}

let agentTabRestore = null;

/**
 * Relit l'onglet de l'agent mémorisé avant un redémarrage du service worker (une seule fois).
 */
function restoreAgentTab() {
    if (!agentTabRestore) {
        agentTabRestore = (async () => {
            const store = sessionStore();
            if (!store?.get) return;
            try {
                const saved = await store.get(AGENT_TAB_STORAGE_KEY);
                const id = saved ? saved[AGENT_TAB_STORAGE_KEY] : undefined;
                if (lastAgentTabId === null && Number.isInteger(id)) lastAgentTabId = id;
            } catch (_) {}
        })();
    }
    return agentTabRestore;
}

function setAgentTab(tabId) {
    lastAgentTabId = Number.isInteger(tabId) ? tabId : null;
    const store = sessionStore();
    try {
        const pending = lastAgentTabId === null
            ? store?.remove?.(AGENT_TAB_STORAGE_KEY)
            : store?.set?.({ [AGENT_TAB_STORAGE_KEY]: lastAgentTabId });
        if (pending && typeof pending.catch === "function") pending.catch(() => {});
    } catch (_) {}
}

async function getActiveTab() {
    // Lecture seule : l'onglet actif de Julien ne devient jamais l'onglet de l'agent par ce biais.
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
        const [anyActive] = await chrome.tabs.query({ active: true });
        return { data: anyActive || null };
    }
    return { data: tab };
}

/**
 * Onglet visé par une commande : tab_id explicite, sinon l'onglet de l'agent (persisté), sinon l'onglet actif.
 * Une commande destructrice (fermer, naviguer, recharger) sans tab_id ni onglet d'agent connu est REFUSÉE :
 * elle viserait l'onglet de Julien (cas typique : service worker redémarré).
 */
async function resolveTargetTab(params = {}, options = {}) {
    const opts = typeof options === "boolean" ? { preferActive: options } : (options || {});
    await restoreAgentTab();
    const candidate = params.tabId !== undefined && params.tabId !== null
        ? params.tabId
        : (params.id !== undefined && params.id !== null ? params.id : null);

    if (candidate !== null) {
        const id = parseInt(candidate, 10);
        if (!isNaN(id)) {
            try {
                await chrome.tabs.get(id);
                setAgentTab(id);
                return id;
            } catch (_) {
                throw new Error(`Target tab ${id} no longer exists`);
            }
        }
    }

    if (!opts.preferActive && lastAgentTabId !== null) {
        try {
            await chrome.tabs.get(lastAgentTabId);
            return lastAgentTabId;
        } catch (_) {
            setAgentTab(null);
        }
    }

    if (opts.destructive) {
        throw new Error(
            `Aucun onglet de l'agent n'est connu (service worker redémarré ou onglet fermé) : '${opts.action || "commande"}' sans tab_id ` +
            "viserait l'onglet actif de Julien. Précisez tab_id, ou ouvrez un onglet de travail avec new_tab."
        );
    }

    const activeRes = await getActiveTab();
    return activeRes?.data?.id || null;
}

async function notifyTabStatus(tabId, text, autoHideMs = 3000) {
    if (!tabId || typeof chrome === "undefined") return;
    try {
        if (chrome.scripting?.executeScript) {
            await chrome.scripting.executeScript({
                target: { tabId },
                func: (statusText, hideMs) => {
                    window.dispatchEvent(new CustomEvent("__antigravity_status_pill", {
                        detail: { text: statusText, autoHideMs: hideMs }
                    }));
                },
                args: [text, autoHideMs]
            });
        }
    } catch (_) {}
}

async function groupTabs(params = {}) {
    if (!chrome.tabGroups || !chrome.tabs?.group) {
        return { data: { warning: "Tab groups API is not supported in this browser context", tabIds: [] } };
    }

    let tabIds = [];
    if (Array.isArray(params.tabIds) && params.tabIds.length > 0) {
        tabIds = params.tabIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
    } else if (params.tabId !== undefined && params.tabId !== null) {
        tabIds = [parseInt(params.tabId, 10)];
    } else {
        const targetId = await resolveTargetTab(params);
        if (targetId) tabIds = [targetId];
    }

    if (tabIds.length === 0) {
        throw new Error("No valid tabId specified or found to group");
    }

    const title = params.title || "Antigravity";
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

    let updatedGroup = { id: groupId, title, color, collapsed };
    if (chrome.tabGroups.update) {
        try {
            updatedGroup = await chrome.tabGroups.update(groupId, {
                title,
                color,
                collapsed
            });
        } catch (_) {}
    }

    return {
        data: {
            groupId: updatedGroup.id || groupId,
            title: updatedGroup.title || title,
            color: updatedGroup.color || color,
            collapsed: updatedGroup.collapsed !== undefined ? updatedGroup.collapsed : collapsed,
            tabIds
        }
    };
}

async function selectTab(params) {
    const tabId = parseInt(params.tabId || params.id);
    if (!tabId) throw new Error("Missing tabId");

    setAgentTab(tabId);
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab?.windowId && chrome.windows?.update) {
        await chrome.windows.update(tab.windowId, { focused: true });
    }
    notifyTabStatus(tabId, "Au premier plan", 2000);
    return { data: { success: true, tab } };
}

async function createTab(params) {
    const url = params.url || "about:blank";
    let active = false;
    if (params.active === true) {
        active = true;
    } else if (params.background === false) {
        active = true;
    }

    try {
        const tab = await chrome.tabs.create({ url, active });
        setAgentTab(tab.id);
        let assignedGroupId = tab.groupId !== undefined ? tab.groupId : -1;

        const groupParam = params.group !== undefined ? params.group : "Antigravity";
        if (groupParam && chrome.tabGroups && chrome.tabs?.group) {
            try {
                const groupTitle = typeof groupParam === "string" ? groupParam : "Antigravity";
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
                console.log("[Antigravity] Auto-group notice:", grpErr.message);
            }
        }

        notifyTabStatus(tab.id, "Onglet créé", 2500);
        return { data: { ...tab, groupId: assignedGroupId } };
    } catch(e) {
        const win = await chrome.windows.create({ url, focused: active });
        const createdTab = win.tabs?.[0] || { id: win.id, url, active };
        if (createdTab.id) setAgentTab(createdTab.id);
        return { data: createdTab };
    }
}

async function closeTab(params = {}) {
    let tabId = await resolveTargetTab(params, { destructive: true, action: "close_tab" });
    if (!tabId) throw new Error("Missing tabId and no agent tab found to close");
    await chrome.tabs.remove(tabId);
    if (lastAgentTabId === tabId) setAgentTab(null);
    return { data: { success: true, closedTabId: tabId } };
}

async function navigateTab(params) {
    if (!params.url) throw new Error("Missing url parameter");
    let tabId = await resolveTargetTab(params, { destructive: true, action: "navigate" });
    if (!tabId) throw new Error("No agent tab to navigate");

    resetNetworkTracking(tabId);
    const updatedTab = await chrome.tabs.update(tabId, { url: params.url });
    notifyTabStatus(tabId, `Navigation: ${params.url.slice(0, 30)}...`, 2500);
    return { data: updatedTab };
}

async function reloadTab(params) {
    let tabId = await resolveTargetTab(params, { destructive: true, action: "reload" });
    if (!tabId) throw new Error("No agent tab to reload");
    resetNetworkTracking(tabId);
    await chrome.tabs.reload(tabId, { bypassCache: params.bypassCache || false });
    notifyTabStatus(tabId, "Rechargement", 2000);
    return { data: { success: true } };
}

async function evaluateScript(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
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

async function getAccessibilityTree(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Accessibility.enable");
    const axResult = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {
        max_depth: params.maxDepth || 15
    });

    const nodes = (axResult.nodes || []).map(n => ({
        nodeId: n.nodeId,
        role: n.role?.value,
        name: n.name?.value,
        value: n.value?.value,
        description: n.description?.value,
        ignored: n.ignored,
        backendDOMNodeId: n.backendDOMNodeId
    })).filter(n => !n.ignored && (n.name || n.value || n.role === "button" || n.role === "link"));

    return { data: { nodeCount: nodes.length, nodes: nodes.slice(0, 100) } };
}

async function getConsoleLogs(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    return { data: tabConsoleLogs.get(tabId) || [] };
}

async function getPageContent(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    const mode = String(params.mode || "interactive");
    const top = await evaluateScript({ tabId, code: pageContentScript(params) });
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

function pageContentScript(params) {
    return `(() => {
            const mode = ${JSON.stringify(String(params.mode || "interactive"))};
            if (mode === "text") return document.body ? document.body.innerText : "";
            if (mode === "html") return document.documentElement ? document.documentElement.outerHTML : "";
            
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
                            text: (el.innerText || el.value || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || "").trim().slice(0, 80),
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
    const res = await sendKeyEvent(target, down);
    if (res?.__dialog) {
        releaseKeyQuietly(target, { type: "keyUp", ...fields });
        releaseAll();
        return { dialog: res.__dialog };
    }
    await sendKeyEvent(target, { type: "keyUp", ...fields });
    for (const mod of [...held].reverse()) {
        bits &= ~MODIFIER_BITS[mod];
        await sendKeyEvent(target, { type: "keyUp", ...keyFields(KEY_DEFINITIONS[mod], bits) });
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
        await sendKeyEvent(target, { type: "keyUp", ...fields });
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
        result.data.value = shortValue(result.data.value);
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
                    verified: sameText(res?.value, expected, state.kind), value: shortValue(res?.value),
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
            verified, value: shortValue(after.value), trusted_input: trustedInput,
            trusted_events: probe ? [...new Set(probe.seen)] : null
        };
        if (pressed.length) data.keys = pressed;
        if (!verified) {
            data.expected = shortValue(expected);
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
    if (!tabId) throw new Error("No active tab");
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
    if (!tabId) throw new Error("No active tab");
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
    if (!tabId) throw new Error("No active tab");

    const sign = params.direction === "up" ? -1 : 1;
    const dy = sign * Math.abs(params.y !== undefined && params.y !== null ? Number(params.y) : 500);
    const dx = Number(params.x || 0);

    return await evaluateScript({
        tabId,
        code: `(() => {
            window.scrollBy({ left: ${dx}, top: ${dy}, behavior: ${JSON.stringify(String(params.behavior || "instant"))} });
            return { scrollX: window.scrollX, scrollY: window.scrollY };
        })()`
    });
}

async function takeScreenshot(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab to capture");

    const target = await ensureDebugger(tabId);
    
    if (params.selector) {
        const sel = JSON.stringify(params.selector);
        const elRect = await evaluateScript({
            tabId,
            code: `(() => {
                const selector = ${sel};
                function findIn(root) {
                    if (!root) return null;
                    if (typeof selector === "string" && selector.startsWith("#") && /^[0-9]+$/.test(selector.slice(1))) {
                        const markNum = parseInt(selector.slice(1));
                        if (window.__antigravity_som_elements && window.__antigravity_som_elements.has(markNum)) {
                            return window.__antigravity_som_elements.get(markNum);
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
                return { x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), scale: 1 };
            })()`
        });
        if (elRect?.data) {
            const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
                format: params.format || "png",
                clip: elRect.data
            });
            return { data: { dataUrl: `data:image/png;base64,${shot.data}`, mimeType: "image/png" } };
        } else {
            return { error: "Element not found for screenshot selector: " + params.selector };
        }
    }

    const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: params.format || "png"
    });
    return { data: { dataUrl: `data:image/png;base64,${shot.data}`, mimeType: "image/png" } };
}

/**
 * Headless PDF Generation directly via CDP Page.printToPDF
 */
async function printToPdf(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab to print");

    const target = await ensureDebugger(tabId);
    const pdfData = await chrome.debugger.sendCommand(target, "Page.printToPDF", {
        landscape: params.landscape || false,
        displayHeaderFooter: params.displayHeaderFooter || false,
        printBackground: true,
        scale: params.scale !== undefined ? Number(params.scale) : 1.0,
        paperWidth: params.paperWidth !== undefined ? Number(params.paperWidth) : 8.27,
        paperHeight: params.paperHeight !== undefined ? Number(params.paperHeight) : 11.69
    });

    return { data: { pdfBase64: pdfData.data, mimeType: "application/pdf" } };
}

async function handleJsDialog(params = {}) {
    let tabId = null;
    const explicit = params.tabId !== undefined && params.tabId !== null;
    if (!explicit && pendingDialogs.size === 1) {
        tabId = [...pendingDialogs.keys()][0];  // une seule boîte ouverte : c'est elle
    } else {
        tabId = await resolveTargetTab(params);
    }
    if (!tabId) throw new Error("No tab with a JavaScript dialog");
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

async function sendCdpCommand(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab for CDP command");
    const target = await ensureDebugger(tabId);
    const result = await chrome.debugger.sendCommand(target, params.method, params.commandParams || {});
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
    if (!tabId) throw new Error("No active tab to upload files");
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
    if (!tabId) throw new Error("No active tab for vision inspect");

    const target = await ensureDebugger(tabId);

    // 1. Inject SoM markers and register elements in page context
    markRoots.delete(tabId);  // marqueurs de vision : cadre principal seulement
    const markerData = await evaluateScript({
        tabId,
        code: `(() => {
            if (!window.__antigravity_som_elements) {
                window.__antigravity_som_elements = new Map();
            } else {
                window.__antigravity_som_elements.clear();
            }
            document.querySelectorAll(".__antigravity_som_marker").forEach(m => {
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
                badge.className = "__antigravity_som_marker";
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
                window.__antigravity_som_elements.set(markerId, el);

                const ymin = Math.max(0, Math.min(1000, Math.round((rect.top / h) * 1000)));
                const xmin = Math.max(0, Math.min(1000, Math.round((rect.left / w) * 1000)));
                const ymax = Math.max(0, Math.min(1000, Math.round((rect.bottom / h) * 1000)));
                const xmax = Math.max(0, Math.min(1000, Math.round((rect.right / w) * 1000)));

                markers.push({
                    mark: markerId,
                    tag: el.tagName ? el.tagName.toLowerCase() : "element",
                    role: (el.getAttribute ? el.getAttribute("role") : null) || null,
                    type: el.type || null,
                    text: (el.innerText || el.value || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || "").trim().slice(0, 80),
                    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                    box_2d: [ymin, xmin, ymax, xmax]
                });
                markerId++;
            }

            return { markers, title: document.title, url: window.location.href };
        })()`
    });

    // 2. Short render stabilization delay (50ms)
    await new Promise(r => setTimeout(r, 50));

    // 3. High-res visual screenshot
    const shot = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png"
    });

    // 4. Clean up visual marker badges from DOM (keeps window.__antigravity_som_elements for clickMark)
    await evaluateScript({
        tabId,
        code: `document.querySelectorAll(".__antigravity_som_marker").forEach(m => {
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
    if (!tabId) throw new Error("No active tab");
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
    if (!tabId) throw new Error("No active tab");

    return await evaluateScript({
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
const SECRET_HEADER = /^(cookie|set-cookie|set-cookie2|authorization|proxy-authorization|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$/i;
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

function maskHeaders(headers) {
    if (!headers || typeof headers !== "object") return headers || null;
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        out[name] = SECRET_HEADER.test(name) ? `[masqué, ${String(value).length} caractères]` : value;
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
        url: rec.url,
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
    if (rec.redirectedFrom) out.redirectedFrom = rec.redirectedFrom;
    if (rec.redirectedTo) out.redirectedTo = rec.redirectedTo;
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
    if (!tabId) throw new Error("No active tab");
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
    if (!wasAttached) data.note = "Débogueur attaché par cet appel : seules les requêtes à partir de maintenant seront enregistrées (enregistrement interrompu après 30 s d'inactivité du débogueur).";
    return { data };
}

/**
 * Corps de réponse d'une requête enregistrée (Network.getResponseBody), tronqué ; un corps binaire est signalé et
 * n'est rendu en base64 que sur demande (includeBinary).
 */
async function getNetworkResponse(params = {}) {
    const tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
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
    const data = { request_id: rec.key, url: rec.url, status: rec.status, mimeType: rec.mimeType, base64Encoded: !!res?.base64Encoded };
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
    Object.assign(data, { binary: false, size: body.length, truncated: body.length > maxBytes, body: body.slice(0, maxBytes) });
    return { data };
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
    const explicitTab = params.tabId !== undefined && params.tabId !== null;
    // Sans tab_id : l'onglet de l'agent, s'il est connu (jamais l'onglet actif de Julien).
    if (!explicitTab) await restoreAgentTab();
    const tabId = explicitTab ? await resolveTargetTab(params) : lastAgentTabId;
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
            ? ` ; Chrome le juge « ${chosen.danger} » et attend la décision de Julien (jamais acceptée par l'agent)` : "";
        return { error: `Téléchargement non terminé après ${timeoutMs} ms (état ${chosen.state}, ${chosen.bytesReceived}/${chosen.totalBytes} octets${danger}) : ${chosen.filename || chosen.url}` };
    }
    return { error: `Aucun téléchargement${origin ? ` venant de ${origin}` : ""} commencé depuis ${new Date(since).toISOString()} (délai ${timeoutMs} ms). Une fenêtre « Enregistrer sous » de Chrome peut attendre Julien.` };
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
    if (!tabId) throw new Error("No active tab to press key");
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
    if (!tabId) throw new Error("No active tab");
    let target;
    try {
        target = await ensureDebugger(tabId);
    } catch (error) {
        return await mouseJsFallback(tabId, { phase: "edit", locate, op, ...extra }, error.message || String(error), timeoutMs);
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
        return { data: res };
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
    if (!tabId) throw new Error("No active tab");
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
    if (!tabId) throw new Error("No active tab");

    const timeoutMs = params.timeoutMs || params.timeout || 8000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        try {
            const stateRes = await evaluateScript({
                tabId,
                code: `document.readyState`
            });
            if (stateRes?.data === "complete") {
                return { data: { readyState: "complete", waitedMs: Date.now() - startTime } };
            }
        } catch (e) {
            // Execution context destroyed during rapid navigation; continue polling until new context settles
        }
        await new Promise(r => setTimeout(r, 100));
    }

    return { data: { readyState: "timeout", waitedMs: timeoutMs } };
}

/**
 * Wait until in-flight network requests drop to zero for at least idleMs
 */
async function waitForNetworkIdle(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

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
        await new Promise(r => setTimeout(r, 50));
    }

    return { data: { status: "timeout", inFlight: inFlightSet(tabId).size, waitedMs: timeoutMs } };
}

/**
 * Retrieve session and domain cookies via CDP Network.getCookies
 */
async function getCookies(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Network.enable");

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

    const result = await chrome.debugger.sendCommand(target, "Network.getCookies", commandParams);
    // includeValues: false (panneau latéral) : les valeurs ne quittent jamais le service worker.
    const withValues = params.includeValues !== false;
    return {
        data: {
            cookieCount: (result.cookies || []).length,
            valuesIncluded: withValues,
            cookies: (result.cookies || []).map(c => ({
                name: c.name,
                ...(withValues ? { value: c.value } : {}),
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
    if (!tabId) throw new Error("No active tab");
    const limit = Math.max(1, Math.min(200, parseInt(params.limit, 10) || 60));
    return await evaluateScript({
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

/**
 * Token-optimized compact interactive element map
 * Returns numbered interactive elements ([#1], [#2]...) with labels, selectors, and box_2d coordinates.
 * Populates window.__antigravity_som_elements so elements can be targeted directly.
 */
async function getInteractiveMap(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const viewportOnly = params.viewportOnly !== false;
    const maxElements = params.maxElements ? parseInt(params.maxElements) : 60;

    const buildScript = (startMark, budget) => `(() => {
        if (!window.__antigravity_som_elements) {
            window.__antigravity_som_elements = new Map();
        } else {
            window.__antigravity_som_elements.clear();
        }

        const selector = "button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [role='checkbox'], [role='menuitem'], [onclick], [tabindex]";
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

            window.__antigravity_som_elements.set(markId, el);

            const tag = el.tagName ? el.tagName.toLowerCase() : "element";
            const role = el.getAttribute ? el.getAttribute("role") : null;
            const type = el.type || null;
            // Jamais la valeur d'un champ mot de passe ; celle d'un champ de saisie n'est pas un libellé non plus.
            const fieldValue = (tag === "input" && ["button", "submit", "reset"].includes(String(type).toLowerCase())) ? el.value : "";
            const textRaw = el.innerText || fieldValue || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || el.title || el.name || "";
            const label = String(textRaw).trim().slice(0, 60);

            let selectorHint = tag;
            if (el.id) {
                const safeId = (typeof window !== "undefined" && window.CSS && typeof CSS.escape === "function") ? CSS.escape(el.id) : el.id;
                selectorHint += "#" + safeId;
            } else if (el.name) {
                const safeName = String(el.name).replace(/'/g, "\\'");
                selectorHint += "[name='" + safeName + "']";
            } else {
                const rawClass = typeof el.className === "string" ? el.className : (el.className?.baseVal || "");
                if (rawClass) {
                    const firstClass = rawClass.trim().split(/\s+/)[0];
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

    const top = await evaluateScript({ tabId, code: buildScript(1, maxElements) });
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
    if (!tabId) throw new Error("No active tab");

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
