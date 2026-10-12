/**
 * Antigravity Browser Bridge - Background Service Worker (Manifest V3)
 * Full automation engine with Chrome DevTools Protocol, AXTree, DOM, PDF Export & visual feedback.
 */

let attachedDebuggers = new Set();
let tabConsoleLogs = new Map();
let tabInFlightRequests = new Map();
let lastAgentTabId = null;

console.log("[NexusAGY] Background Service Worker (v2.0.0) active.");

// -----------------------------------------------------------------------------
// Direct WebSocket Bridge & Chrome 116+ Keepalive
// -----------------------------------------------------------------------------
const BRIDGE_WS_URL = "ws://127.0.0.1:9224";
let bridgeWs = null;
let reconnectTimer = null;
let keepaliveInterval = null;
let reconnectAttempts = 0;

function connectBridgeWS() {
    if (typeof WebSocket === "undefined") return;
    if (bridgeWs) {
        if (bridgeWs.readyState === WebSocket.OPEN || bridgeWs.readyState === WebSocket.CONNECTING) {
            return;
        }
        try { bridgeWs.close(); } catch (_) {}
        bridgeWs = null;
    }

    try {
        bridgeWs = new WebSocket(BRIDGE_WS_URL);

        bridgeWs.onopen = () => {
            console.log("[NexusAGY] Service Worker connected directly to " + BRIDGE_WS_URL);
            reconnectAttempts = 0;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }
            try { bridgeWs.send(JSON.stringify({ event: "bridge_connected", timestamp: Date.now() })); } catch(_) {}

            if (keepaliveInterval) clearInterval(keepaliveInterval);
            keepaliveInterval = setInterval(() => {
                if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                    try { bridgeWs.send(JSON.stringify({ event: "keepalive", timestamp: Date.now() })); } catch(_) {}
                }
            }, 20000);
        };

        bridgeWs.onmessage = async (event) => {
            try {
                const request = JSON.parse(event.data);
                const response = await handleCommand(request);
                if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                    bridgeWs.send(JSON.stringify({
                        requestId: request.requestId || request.id,
                        success: response ? !response.error : false,
                        data: response ? response.data : null,
                        error: response ? response.error : "Unknown error in background handler"
                    }));
                }
            } catch (err) {
                console.error("[NexusAGY] Error processing command:", err);
            }
        };

        bridgeWs.onclose = () => {
            bridgeWs = null;
            if (keepaliveInterval) {
                clearInterval(keepaliveInterval);
                keepaliveInterval = null;
            }
            scheduleBridgeReconnect();
        };

        bridgeWs.onerror = () => {
            // onclose will follow
        };
    } catch (e) {
        bridgeWs = null;
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
            if (!bridgeWs || bridgeWs.readyState !== WebSocket.OPEN) {
                connectBridgeWS();
            }
        });
    }
    if (chrome.runtime?.onMessage) {
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
            if (message.target === "background" && message.getStatus) {
                const isConnected = !!(bridgeWs && bridgeWs.readyState === WebSocket.OPEN);
                sendResponse({
                    connected: isConnected,
                    wsUrl: BRIDGE_WS_URL,
                    activeDebuggers: attachedDebuggers.size
                });
                return true;
            }
            if (message.target === "background" && message.getActiveTab) {
                getActiveTab().then(sendResponse);
                return true;
            }
            if (message.target === "background" && message.executeAction) {
                handleCommand({ action: message.action, params: message.params || {} }).then(sendResponse);
                return true;
            }
            if (message.target === "background" && message.request) {
                handleCommand(message.request).then(sendResponse);
                return true;
            }
            if (message.target === "background" && message.ping) {
                connectBridgeWS();
                sendResponse({ pong: true, connected: !!(bridgeWs && bridgeWs.readyState === WebSocket.OPEN) });
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

chrome.debugger.onEvent.addListener(async (source, method, params) => {
    if (!source.tabId) return;
    
    if (method === "Runtime.consoleAPICalled" || method === "Log.entryAdded") {
        if (!tabConsoleLogs.has(source.tabId)) tabConsoleLogs.set(source.tabId, []);
        const logs = tabConsoleLogs.get(source.tabId);
        logs.push({ timestamp: Date.now(), method, params });
        if (logs.length > 100) logs.shift();
    } else if (method === "Network.requestWillBeSent") {
        const cur = tabInFlightRequests.get(source.tabId) || 0;
        tabInFlightRequests.set(source.tabId, cur + 1);
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        const cur = tabInFlightRequests.get(source.tabId) || 1;
        tabInFlightRequests.set(source.tabId, Math.max(0, cur - 1));
    } else if (method === "Page.javascriptDialogOpening") {
        console.log("[CDP] Auto-handling JS Dialog:", params.message);
        try {
            await chrome.debugger.sendCommand(source, "Page.handleJavaScriptDialog", {
                accept: true,
                promptText: ""
            });
        } catch(e) {}
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
        tabInFlightRequests.delete(source.tabId);
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
        if (tabId === lastAgentTabId) lastAgentTabId = null;
        attachedDebuggers.delete(tabId);
        tabConsoleLogs.delete(tabId);
        tabInFlightRequests.delete(tabId);
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
    const result = await routeCommand(req);
    const action = (req.action || req.command || "").toLowerCase().replace(/-/g, "_");
    // Evaluation may legitimately return an object containing an error field.
    if (!["eval", "evaluate", "evaluate_js"].includes(action) && result?.data?.error) {
        return { error: result.data.error };
    }
    return result;
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
            case "type":
            case "fill_element":
                return await fillElement(params);

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
            await chrome.debugger.sendCommand(target, "Page.enable");
            await chrome.debugger.sendCommand(target, "Runtime.enable");
            await chrome.debugger.sendCommand(target, "Log.enable");
        } catch (e) {
            if (e.message && e.message.includes("is already attached")) {
                attachedDebuggers.add(tabId);
                return target;
            }
            console.log("[CDP Attach]", e.message);
            throw new Error(`CDP attach error: ${e.message}`);
        }
    }
    return target;
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

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) {
        const [anyActive] = await chrome.tabs.query({ active: true });
        if (anyActive) lastAgentTabId = anyActive.id;
        return { data: anyActive || null };
    }
    lastAgentTabId = tab.id;
    return { data: tab };
}

async function resolveTargetTab(params = {}, preferActive = false) {
    const candidate = params.tabId !== undefined && params.tabId !== null
        ? params.tabId
        : (params.id !== undefined && params.id !== null ? params.id : null);

    if (candidate !== null) {
        const id = parseInt(candidate, 10);
        if (!isNaN(id)) {
            try {
                await chrome.tabs.get(id);
                lastAgentTabId = id;
                return id;
            } catch (_) {
                throw new Error(`Target tab ${id} no longer exists`);
            }
        }
    }

    if (!preferActive && lastAgentTabId !== null) {
        try {
            await chrome.tabs.get(lastAgentTabId);
            return lastAgentTabId;
        } catch (_) {
            lastAgentTabId = null;
        }
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

    lastAgentTabId = tabId;
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
        lastAgentTabId = tab.id;
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
        if (createdTab.id) lastAgentTabId = createdTab.id;
        return { data: createdTab };
    }
}

async function closeTab(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("Missing tabId and no active tab found to close");
    await chrome.tabs.remove(tabId);
    if (lastAgentTabId === tabId) lastAgentTabId = null;
    return { data: { success: true, closedTabId: tabId } };
}

async function navigateTab(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab to navigate");
    if (!params.url) throw new Error("Missing url parameter");

    const updatedTab = await chrome.tabs.update(tabId, { url: params.url });
    notifyTabStatus(tabId, `Navigation: ${params.url.slice(0, 30)}...`, 2500);
    return { data: updatedTab };
}

async function reloadTab(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
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
    const result = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true
    });
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

    return await evaluateScript({
        tabId,
        code: `(() => {
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
        })()`
    });
}

async function hoverElement(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const sel = JSON.stringify(params.selector || null);
    const txt = JSON.stringify(params.text || params.textMatch || null);
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 1200);

    const script = `(() => {
        const selector = ${sel};
        const textMatch = ${txt};

        function findIn(root) {
            if (!root) return null;
            if (selector) {
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
            } else if (textMatch) {
                const search = textMatch.toLowerCase();
                if (root.querySelectorAll) {
                    const all = Array.from(root.querySelectorAll("button, a, input, select, textarea, osds-button, [role='button'], div, span, td, li, ess-cell, [role='row'], [role='gridcell'], *"));
                    const hit = all.find(el => el.innerText && el.innerText.trim().toLowerCase().includes(search));
                    if (hit) return hit;
                }
            }
            if (root.querySelectorAll) {
                const all = root.querySelectorAll("*");
                for (const child of all) {
                    if (child.shadowRoot) {
                        const res = findIn(child.shadowRoot);
                        if (res) return res;
                    }
                }
                const iframes = root.querySelectorAll("iframe");
                for (const f of iframes) {
                    try {
                        if (f.contentDocument) {
                            const res = findIn(f.contentDocument);
                            if (res) return res;
                        }
                    } catch(e) {}
                }
            }
            return null;
        }

        let target = findIn(document);
        if (!target) return { notFound: true, error: "Element not found for hover: " + selector + " / text: " + textMatch };

        target.scrollIntoView({ behavior: "instant", block: "center" });
        const rect = target.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
        target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true, view: window, clientX: cx, clientY: cy }));

        return {
            success: true,
            tagName: target.tagName,
            text: target.innerText ? target.innerText.slice(0, 50) : null,
            coordinates: { x: Math.round(cx), y: Math.round(cy) }
        };
    })()`;

    const startTime = Date.now();
    let res = await evaluateScript({ tabId, code: script });
    while (res?.data?.notFound && (Date.now() - startTime < timeoutMs)) {
        await new Promise(r => setTimeout(r, 60));
        res = await evaluateScript({ tabId, code: script });
    }

    if (res?.data?.notFound) {
        return { error: res.data.error };
    }

    if (res?.data?.coordinates) {
        try {
            const target = await ensureDebugger(tabId);
            await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                type: "mouseMoved",
                x: res.data.coordinates.x,
                y: res.data.coordinates.y
            });
        } catch(e) {}
    }
    return res;
}

async function clickElement(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    if (params.mark !== undefined && params.mark !== null) {
        return await clickMark(params);
    }

    const sel = JSON.stringify(params.selector || null);
    const txt = JSON.stringify(params.text || params.textMatch || null);
    const idx = params.index || 0;
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 1200);

    const script = `(() => {
        const selector = ${sel};
        const textMatch = ${txt};
        const index = ${idx};
        let target = null;

        function findIn(root) {
            if (!root) return null;
            if (selector) {
                if (typeof selector === "string" && selector.startsWith("#") && /^[0-9]+$/.test(selector.slice(1))) {
                    const markNum = parseInt(selector.slice(1));
                    if (window.__antigravity_som_elements && window.__antigravity_som_elements.has(markNum)) {
                        return window.__antigravity_som_elements.get(markNum);
                    }
                }
                if (root.querySelectorAll) {
                    try {
                        const els = root.querySelectorAll(selector);
                        if (els[index]) return els[index];
                    } catch(e) {}
                }
            } else if (textMatch) {
                const search = textMatch.toLowerCase();
                if (root.querySelectorAll) {
                    const all = Array.from(root.querySelectorAll("button, a, input, select, textarea, osds-button, [role='button'], div, span, td, li, ess-cell, [role='row'], [role='gridcell'], *"));
                    const hit = all.find(el => el.innerText && el.innerText.trim().toLowerCase().includes(search));
                    if (hit) return hit;
                }
            }
            if (root.querySelectorAll) {
                const all = root.querySelectorAll("*");
                for (const child of all) {
                    if (child.shadowRoot) {
                        const res = findIn(child.shadowRoot);
                        if (res) return res;
                    }
                }
                const iframes = root.querySelectorAll("iframe");
                for (const f of iframes) {
                    try {
                        if (f.contentDocument) {
                            const res = findIn(f.contentDocument);
                            if (res) return res;
                        }
                    } catch(e) {}
                }
            }
            return null;
        }

        target = findIn(document);
        if (!target) return { notFound: true, error: "Element not found for selector: " + selector + " / text: " + textMatch };

        target.scrollIntoView({ behavior: "instant", block: "center" });
        if (typeof target.focus === "function") target.focus();
        
        const rect = target.getBoundingClientRect();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;

        window.dispatchEvent(new CustomEvent("__antigravity_visual_click", { detail: { x: cx, y: cy } }));

        const clickEvent = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: cx,
            clientY: cy
        });
        if (typeof target.click === "function") {
            target.click();
        } else {
            const evInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, buttons: 1 };
            if (typeof PointerEvent !== "undefined") {
                try { target.dispatchEvent(new PointerEvent("pointerdown", evInit)); } catch(e) {}
            }
            try { target.dispatchEvent(new MouseEvent("mousedown", evInit)); } catch(e) {}
            if (typeof PointerEvent !== "undefined") {
                try { target.dispatchEvent(new PointerEvent("pointerup", { ...evInit, buttons: 0 })); } catch(e) {}
            }
            try { target.dispatchEvent(new MouseEvent("mouseup", { ...evInit, buttons: 0 })); } catch(e) {}
            target.dispatchEvent(clickEvent);
        }

        return {
            success: true,
            tagName: target.tagName,
            text: target.innerText ? target.innerText.slice(0, 50) : null,
            coordinates: { x: Math.round(cx), y: Math.round(cy) }
        };
    })()`;

    const startTime = Date.now();
    let res = await evaluateScript({ tabId, code: script });
    while (res?.data?.notFound && (Date.now() - startTime < timeoutMs)) {
        await new Promise(r => setTimeout(r, 60));
        res = await evaluateScript({ tabId, code: script });
    }

    if (res?.data?.notFound) {
        return { error: res.data.error };
    }
    return res;
}

async function fillElement(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    const sel = JSON.stringify(params.selector || (params.mark !== undefined ? `#${params.mark}` : null));
    const val = JSON.stringify(params.value !== undefined ? String(params.value) : (params.text || ""));
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 1200);

    const script = `(() => {
        const selector = ${sel};
        const value = ${val};

        function findIn(root) {
            if (!root) return null;
            if (selector) {
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
            }
            if (root.querySelectorAll) {
                const all = root.querySelectorAll("*");
                for (const child of all) {
                    if (child.shadowRoot) {
                        const res = findIn(child.shadowRoot);
                        if (res) return res;
                    }
                }
                const iframes = root.querySelectorAll("iframe");
                for (const f of iframes) {
                    try {
                        if (f.contentDocument) {
                            const res = findIn(f.contentDocument);
                            if (res) return res;
                        }
                    } catch(e) {}
                }
            }
            return null;
        }

        let el = selector ? findIn(document) : document.activeElement;
        if (!el) return { notFound: true, error: "Input element not found: " + selector };

        el.scrollIntoView({ behavior: "instant", block: "center" });
        if (typeof el.focus === "function") el.focus();
        let setter = null;
        if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) {
            setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        } else if (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) {
            setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
        }

        if (setter) {
            try { setter.call(el, value); } catch (_) { el.value = value; }
        } else {
            el.value = value;
        }
        if (el.isContentEditable) {
            el.innerText = value;
            el.textContent = value;
            try { el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); } catch (_) {}
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        return { success: true, value: el.value !== undefined ? el.value : el.innerText, id: el.id, name: el.name };
    })()`;

    const startTime = Date.now();
    let res = await evaluateScript({ tabId, code: script });
    while (res?.data?.notFound && (Date.now() - startTime < timeoutMs)) {
        await new Promise(r => setTimeout(r, 60));
        res = await evaluateScript({ tabId, code: script });
    }

    if (res?.data?.notFound) {
        return { error: res.data.error };
    }
    return res;
}

/**
 * Human-like key by key typing using CDP Input.dispatchKeyEvent
 */
async function typeKeys(params) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    const target = await ensureDebugger(tabId);
    const text = params.text || "";

    for (const char of text) {
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyDown",
            text: char,
            unmodifiedText: char
        });
        await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type: "keyUp"
        });
    }

    return { data: { success: true, typedLength: text.length } };
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
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    const target = await ensureDebugger(tabId);
    await chrome.debugger.sendCommand(target, "Page.handleJavaScriptDialog", {
        accept: params.accept !== false,
        promptText: params.promptText || ""
    });
    return { data: { success: true } };
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
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");
    const mark = parseInt(params.mark || params.number || params.id);
    if (!mark) throw new Error("Missing 'mark' number to click");

    return await evaluateScript({
        tabId,
        code: `(() => {
            const markId = ${mark};
            const el = window.__antigravity_som_elements ? window.__antigravity_som_elements.get(markId) : null;
            if (!el) return { error: "No element registered for mark #" + markId + ". Run vision-inspect first." };

            el.scrollIntoView({ behavior: "instant", block: "center" });
            if (typeof el.focus === "function") el.focus();

            const rect = el.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;

            window.dispatchEvent(new CustomEvent("__antigravity_visual_click", { detail: { x: cx, y: cy } }));

            const clickEv = new MouseEvent("click", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: cx,
                clientY: cy
            });
            if (typeof el.click === "function") el.click();
            else el.dispatchEvent(clickEv);

            return {
                success: true,
                mark: markId,
                tagName: el.tagName,
                text: el.innerText ? el.innerText.slice(0, 50) : null
            };
        })()`
    });
}

/**
 * SOTA Playwright-style semantic click (role, name, text, label)
 */
async function semanticClick(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const role = JSON.stringify(params.role || null);
    const name = JSON.stringify(params.name || null);
    const text = JSON.stringify(params.text || null);
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 2500);

    return await evaluateScript({
        tabId,
        code: `(async () => {
            const targetRole = ${role} ? ${role}.toLowerCase() : null;
            const targetName = ${name} ? ${name}.toLowerCase() : null;
            const targetText = ${text} ? ${text}.toLowerCase() : null;
            const timeout = ${timeoutMs};
            const startTime = Date.now();

            function scanAll(root) {
                const res = [];
                if (!root) return res;
                if (root.querySelectorAll) {
                    res.push(...Array.from(root.querySelectorAll("*")));
                    const all = root.querySelectorAll("*");
                    for (const el of all) {
                        if (el.shadowRoot) {
                            res.push(...scanAll(el.shadowRoot));
                        }
                    }
                    const iframes = root.querySelectorAll("iframe");
                    for (const f of iframes) {
                        try {
                            if (f.contentDocument) res.push(...scanAll(f.contentDocument));
                        } catch(e) {}
                    }
                }
                return res;
            }

            function findSemantic() {
                const all = scanAll(document);
                return all.find(el => {
                    const elRole = (el.getAttribute("role") || (el.tagName === "BUTTON" ? "button" : (el.tagName === "A" ? "link" : (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit") ? "button" : "")))).toLowerCase();
                    const ariaLabel = (el.getAttribute("aria-label") || el.getAttribute("name") || el.getAttribute("title") || "").toLowerCase();
                    const textContent = (el.innerText || el.value || "").trim().toLowerCase();

                    if (targetRole && elRole !== targetRole) return false;
                    if (targetName && !ariaLabel.includes(targetName) && !textContent.includes(targetName)) return false;
                    if (targetText && !textContent.includes(targetText)) return false;
                    return true;
                });
            }

            let hit = findSemantic();
            while (!hit && (Date.now() - startTime < timeout)) {
                await new Promise(r => setTimeout(r, 50));
                hit = findSemantic();
            }

            if (!hit) return { error: "Element not found for role=" + targetRole + ", name=" + targetName + ", text=" + targetText };

            hit.scrollIntoView({ behavior: "instant", block: "center" });
            if (typeof hit.focus === "function") hit.focus();

            const rect = hit.getBoundingClientRect();
            const cx = rect.x + rect.width / 2;
            const cy = rect.y + rect.height / 2;

            window.dispatchEvent(new CustomEvent("__antigravity_visual_click", { detail: { x: cx, y: cy } }));
            if (typeof hit.click === "function") {
                hit.click();
            } else {
                const evInit = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, buttons: 1 };
                if (typeof PointerEvent !== "undefined") {
                    try { hit.dispatchEvent(new PointerEvent("pointerdown", evInit)); } catch(e) {}
                }
                try { hit.dispatchEvent(new MouseEvent("mousedown", evInit)); } catch(e) {}
                if (typeof PointerEvent !== "undefined") {
                    try { hit.dispatchEvent(new PointerEvent("pointerup", { ...evInit, buttons: 0 })); } catch(e) {}
                }
                try { hit.dispatchEvent(new MouseEvent("mouseup", { ...evInit, buttons: 0 })); } catch(e) {}
                hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy }));
            }

            return { success: true, tagName: hit.tagName, text: hit.innerText ? hit.innerText.slice(0, 50) : null };
        })()`
    });
}

/**
 * SOTA Semantic form fill (label, placeholder, name)
 */
async function semanticFill(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const label = JSON.stringify(params.label || params.placeholder || null);
    const val = JSON.stringify(params.value !== undefined ? String(params.value) : "");
    const timeoutMs = params.timeoutMs !== undefined ? parseInt(params.timeoutMs) : (params.timeout !== undefined ? parseInt(params.timeout) : 2500);

    return await evaluateScript({
        tabId,
        code: `(async () => {
            const search = ${label} ? ${label}.toLowerCase() : null;
            const value = ${val};
            const timeout = ${timeoutMs};
            const startTime = Date.now();

            function scanInputs(root) {
                const res = [];
                if (!root) return res;
                if (root.querySelectorAll) {
                    res.push(...Array.from(root.querySelectorAll("input, textarea, select, [contenteditable='true'], [role='textbox']")));
                    const all = root.querySelectorAll("*");
                    for (const el of all) {
                        if (el.shadowRoot) {
                            res.push(...scanInputs(el.shadowRoot));
                        }
                    }
                    const iframes = root.querySelectorAll("iframe");
                    for (const f of iframes) {
                        try {
                            if (f.contentDocument) res.push(...scanInputs(f.contentDocument));
                        } catch(e) {}
                    }
                }
                return res;
            }

            function findInput() {
                const inputs = scanInputs(document);
                return inputs.find(el => {
                    const ph = (el.placeholder || "").toLowerCase();
                    const aria = ((el.getAttribute ? el.getAttribute("aria-label") : "") || el.name || el.id || "").toLowerCase();
                    let labelText = "";
                    if (el.id) {
                        try {
                            const safeId = (typeof CSS !== "undefined" && typeof CSS.escape === "function") ? CSS.escape(el.id) : el.id;
                            const l = document.querySelector("label[for='" + safeId + "']");
                            if (l) labelText += " " + (l.innerText || "").toLowerCase();
                        } catch (_) {}
                    }
                    if (el.closest) {
                        const parentLabel = el.closest("label");
                        if (parentLabel) labelText += " " + (parentLabel.innerText || "").toLowerCase();
                    }
                    const labelledBy = el.getAttribute ? el.getAttribute("aria-labelledby") : null;
                    if (labelledBy) {
                        labelledBy.split(/\s+/).forEach(id => {
                            if (!id) return;
                            const lblEl = document.getElementById(id);
                            if (lblEl) labelText += " " + (lblEl.innerText || "").toLowerCase();
                        });
                    }
                    return ph.includes(search) || aria.includes(search) || labelText.includes(search);
                });
            }

            let hit = findInput();
            while (!hit && (Date.now() - startTime < timeout)) {
                await new Promise(r => setTimeout(r, 50));
                hit = findInput();
            }

            if (!hit) return { error: "Input not found for label/placeholder: " + search };

            hit.scrollIntoView({ behavior: "instant", block: "center" });
            if (typeof hit.focus === "function") hit.focus();
            let setter = null;
            if (typeof HTMLInputElement !== "undefined" && hit instanceof HTMLInputElement) {
                setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
            } else if (typeof HTMLTextAreaElement !== "undefined" && hit instanceof HTMLTextAreaElement) {
                setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
            }

            if (setter) {
                try { setter.call(hit, value); } catch (_) { hit.value = value; }
            } else {
                hit.value = value;
            }
            if (hit.isContentEditable) {
                hit.innerText = value;
                hit.textContent = value;
                try { hit.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value })); } catch (_) {}
            }
            hit.dispatchEvent(new Event("input", { bubbles: true }));
            hit.dispatchEvent(new Event("change", { bubbles: true }));

            return { success: true, value: hit.value !== undefined ? hit.value : hit.innerText, id: hit.id, name: hit.name };
        })()`
    });
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

/**
 * Dispatch precise special keys (Enter, Escape, Tab, Backspace, Arrow keys, etc.) via CDP
 */
async function pressKey(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab to press key");

    const key = (params.key || "Enter").trim();
    const target = await ensureDebugger(tabId);

    const KEY_MAP = {
        "Enter": { code: "Enter", key: "Enter", keyCode: 13, text: "\r" },
        "Tab": { code: "Tab", key: "Tab", keyCode: 9, text: "" },
        "Escape": { code: "Escape", key: "Escape", keyCode: 27, text: "" },
        "Backspace": { code: "Backspace", key: "Backspace", keyCode: 8, text: "" },
        "Delete": { code: "Delete", key: "Delete", keyCode: 46, text: "" },
        "ArrowDown": { code: "ArrowDown", key: "ArrowDown", keyCode: 40, text: "" },
        "ArrowUp": { code: "ArrowUp", key: "ArrowUp", keyCode: 38, text: "" },
        "ArrowLeft": { code: "ArrowLeft", key: "ArrowLeft", keyCode: 37, text: "" },
        "ArrowRight": { code: "ArrowRight", key: "ArrowRight", keyCode: 39, text: "" },
        "Space": { code: "Space", key: " ", keyCode: 32, text: " " }
    };

    const def = KEY_MAP[key] || { code: key, key: key, keyCode: 0, text: key.length === 1 ? key : "" };

    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "rawKeyDown",
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code,
        text: def.text,
        unmodifiedText: def.text
    });

    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
        type: "keyUp",
        windowsVirtualKeyCode: def.keyCode,
        nativeVirtualKeyCode: def.keyCode,
        key: def.key,
        code: def.code
    });

    return { data: { success: true, key } };
}

/**
 * Robust dropdown option selection (<select>)
 */
async function selectOption(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const sel = JSON.stringify(params.selector || "select");
    const val = JSON.stringify(params.value || null);
    const txt = JSON.stringify(params.text || null);

    return await evaluateScript({
        tabId,
        code: `(() => {
            const selector = ${sel};
            function findIn(root) {
                if (!root) return null;
                if (root.querySelectorAll) {
                    try {
                        const el = root.querySelector(selector);
                        if (el) return el;
                    } catch(e) {}
                    const all = root.querySelectorAll("*");
                    for (const child of all) {
                        if (child.shadowRoot) {
                            const res = findIn(child.shadowRoot);
                            if (res) return res;
                        }
                    }
                    const iframes = root.querySelectorAll("iframe");
                    for (const f of iframes) {
                        try {
                            if (f.contentDocument) {
                                const res = findIn(f.contentDocument);
                                if (res) return res;
                            }
                        } catch(e) {}
                    }
                }
                return null;
            }

            const selectEl = findIn(document);
            if (!selectEl) return { error: "Select element not found: " + selector };

            const targetVal = ${val};
            const targetTxt = ${txt};
            const options = Array.from(selectEl.options || (selectEl.querySelectorAll ? selectEl.querySelectorAll("option") : []) || []);

            const match = options.find(opt => {
                const optVal = opt.value !== undefined ? opt.value : opt.getAttribute("value");
                const optText = opt.text !== undefined ? opt.text : opt.innerText;
                if (targetVal && optVal === targetVal) return true;
                if (targetTxt && optText && optText.trim().toLowerCase().includes(targetTxt.toLowerCase())) return true;
                return false;
            });

            if (!match) return { error: "No matching option found for value=" + targetVal + " or text=" + targetTxt };

            const resolvedVal = match.value !== undefined ? match.value : match.getAttribute("value");
            const resolvedTxt = match.text !== undefined ? match.text : match.innerText;
            selectEl.value = resolvedVal;
            match.selected = true;
            selectEl.dispatchEvent(new Event("input", { bubbles: true }));
            selectEl.dispatchEvent(new Event("change", { bubbles: true }));

            return { success: true, selectedValue: selectEl.value, selectedText: resolvedTxt };
        })()`
    });
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
        const inFlight = tabInFlightRequests.get(tabId) || 0;
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

    return { data: { status: "timeout", inFlight: tabInFlightRequests.get(tabId) || 0, waitedMs: timeoutMs } };
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
    return {
        data: {
            cookieCount: (result.cookies || []).length,
            cookies: (result.cookies || []).map(c => ({
                name: c.name,
                value: c.value,
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
 * Token-optimized compact interactive element map
 * Returns numbered interactive elements ([#1], [#2]...) with labels, selectors, and box_2d coordinates.
 * Populates window.__antigravity_som_elements so elements can be targeted directly.
 */
async function getInteractiveMap(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const viewportOnly = params.viewportOnly !== false;
    const maxElements = params.maxElements ? parseInt(params.maxElements) : 60;

    const script = `(() => {
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
        let markId = 1;

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
            const textRaw = el.innerText || el.value || el.placeholder || (el.getAttribute ? el.getAttribute("aria-label") : "") || el.title || el.name || "";
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
            if (results.length >= ${maxElements}) break;
        }

        return {
            title: typeof document !== "undefined" && document.title ? document.title : "",
            url: typeof window !== "undefined" && window.location ? window.location.href : "",
            viewport: { width: w, height: h },
            count: results.length,
            elements: results
        };
    })()`;

    return await evaluateScript({ tabId, code: script });
}

/**
 * Perform smooth Drag and Drop or continuous gesture interpolation
 * Supports selectors, mark numbers, or explicit coordinates.
 * Dispatches CDP Input.dispatchMouseEvent steps and page-level HTML5 DragEvent fallback.
 */
async function dragAndDrop(params = {}) {
    let tabId = await resolveTargetTab(params);
    if (!tabId) throw new Error("No active tab");

    const selFrom = JSON.stringify(params.from_selector || params.fromSelector || null);
    const selTo = JSON.stringify(params.to_selector || params.toSelector || null);
    const markFrom = params.from_mark !== undefined ? JSON.stringify(params.from_mark) : (params.fromMark !== undefined ? JSON.stringify(params.fromMark) : "null");
    const markTo = params.to_mark !== undefined ? JSON.stringify(params.to_mark) : (params.toMark !== undefined ? JSON.stringify(params.toMark) : "null");
    const coordsFrom = JSON.stringify(params.from_coordinates || params.fromCoordinates || null);
    const coordsTo = JSON.stringify(params.to_coordinates || params.toCoordinates || null);

    const resolveScript = `(() => {
        function resolvePoint(sel, mark, coords) {
            if (coords && coords.x !== undefined && coords.y !== undefined) {
                return { x: coords.x, y: coords.y, found: true };
            }
            if (coords && Array.isArray(coords) && coords.length >= 2) {
                return { x: coords[0], y: coords[1], found: true };
            }
            if (mark !== undefined && mark !== null && !isNaN(parseInt(mark, 10)) && window.__antigravity_som_elements) {
                const el = window.__antigravity_som_elements.get(parseInt(mark, 10));
                if (el) {
                    const r = el.getBoundingClientRect();
                    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), found: true, isEl: true };
                }
            }
            if (sel) {
                let target = null;
                if (typeof sel === "string" && sel.startsWith("#") && /^[0-9]+$/.test(sel.slice(1)) && window.__antigravity_som_elements) {
                    target = window.__antigravity_som_elements.get(parseInt(sel.slice(1)));
                }
                if (!target) {
                    function findSel(root) {
                        if (!root || !root.querySelectorAll) return null;
                        try {
                            const m = root.querySelector(sel);
                            if (m) return m;
                        } catch(e) {}
                        const all = root.querySelectorAll("*");
                        for (const c of all) {
                            if (c.shadowRoot) {
                                const res = findSel(c.shadowRoot);
                                if (res) return res;
                            }
                        }
                        return null;
                    }
                    target = findSel(document);
                }
                if (target) {
                    target.scrollIntoView({ behavior: "instant", block: "center" });
                    const r = target.getBoundingClientRect();
                    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), found: true, isEl: true };
                }
            }
            return { found: false };
        }

        const src = resolvePoint(${selFrom}, ${markFrom}, ${coordsFrom});
        const dst = resolvePoint(${selTo}, ${markTo}, ${coordsTo});
        return { src, dst };
    })()`;

    const pointsRes = await evaluateScript({ tabId, code: resolveScript });
    const src = pointsRes?.data?.src;
    const dst = pointsRes?.data?.dst;

    if (!src?.found) {
        return { error: "Source location not found for drag-and-drop: " + JSON.stringify(params) };
    }
    if (!dst?.found) {
        return { error: "Destination location not found for drag-and-drop: " + JSON.stringify(params) };
    }

    const startX = src.x;
    const startY = src.y;
    const endX = dst.x;
    const endY = dst.y;
    const steps = params.steps !== undefined ? Math.max(2, parseInt(params.steps)) : 12;
    const delay = params.delayMs !== undefined ? parseInt(params.delayMs) : 15;

    const target = await ensureDebugger(tabId);

    // 1. Move to start
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: startX,
        y: startY
    });

    // 2. Press left button
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        button: "left",
        clickCount: 1,
        x: startX,
        y: startY
    });

    // 3. Smooth intermediate interpolation
    for (let i = 1; i <= steps; i++) {
        const curX = Math.round(startX + (endX - startX) * (i / steps));
        const curY = Math.round(startY + (endY - startY) * (i / steps));
        await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            button: "left",
            x: curX,
            y: curY
        });
        if (delay > 0) {
            await new Promise(r => setTimeout(r, delay));
        }
    }

    // 4. Release mouse button
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        button: "left",
        clickCount: 1,
        x: endX,
        y: endY
    });

    // 5. HTML5 DragEvent fallback in page context
    if (src.isEl || dst.isEl) {
        await evaluateScript({
            tabId,
            code: `(() => {
                try {
                    const fromEl = document.elementFromPoint(${startX}, ${startY});
                    const toEl = document.elementFromPoint(${endX}, ${endY});
                    if (fromEl && toEl) {
                        const dataTransfer = new DataTransfer();
                        fromEl.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer }));
                        toEl.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer }));
                        toEl.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer }));
                        toEl.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
                        fromEl.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer }));
                    }
                } catch(e) {}
            })()`
        });
    }

    return {
        data: {
            success: true,
            from: { x: startX, y: startY },
            to: { x: endX, y: endY },
            steps
        }
    };
}

