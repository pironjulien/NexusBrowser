const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// -----------------------------------------------------------------------------
// Simulateur d'entrée : Input.dispatchMouseEvent produit des événements de confiance (isTrusted) sur l'élément
// réellement présent au point visé (elementFromPoint, shadow roots et iframes compris), comme Chrome.
// -----------------------------------------------------------------------------
// Objets venus d'un autre contexte vm : comparés par valeur.
const plain = (value) => JSON.parse(JSON.stringify(value));

function pathOf(node) {
    const out = [];
    for (let n = node, i = 0; n && i < 1000; n = n.parentNode || n.parentElement || n.host || null, i++) out.push(n);
    return out;
}

function listenable(target) {
    target.__listeners = {};
    target.addEventListener = (type, fn) => { (target.__listeners[type] ||= []).push(fn); };
    target.removeEventListener = (type, fn) => {
        target.__listeners[type] = (target.__listeners[type] || []).filter(f => f !== fn);
    };
    return target;
}

function hitAt(doc, x, y) {
    let d = doc;
    let hit = d.elementFromPoint(x, y);
    for (let i = 0; i < 64 && hit; i++) {
        if (hit.shadowRoot && hit.shadowRoot.elementFromPoint) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (inner && inner !== hit) { hit = inner; continue; }
        }
        // Le navigateur route l'entrée dans le cadre (même d'une autre origine : __routeDoc, invisible au script).
        const inner = hit.contentDocument || hit.__routeDoc;
        if (inner && hit.frameOrigin) {
            x -= hit.frameOrigin.x;
            y -= hit.frameOrigin.y;
            d = inner;
            hit = d.elementFromPoint(x, y);
            continue;
        }
        break;
    }
    return {doc: d, hit};
}

function fireTrusted(doc, type, hit, log) {
    log.push({type, target: hit});
    const event = {type, isTrusted: true, target: hit, composedPath: () => pathOf(hit)};
    for (const fn of [...((doc.__listeners || {})[type] || [])]) fn(event);
    for (const node of pathOf(hit)) if (typeof node.onTrusted === 'function') node.onTrusted(type, event);
}

// Clavier simulé comme Chrome : l'élément qui a le focus (cadre focalisé compris) reçoit des événements de confiance.
function focusedIn(doc) {
    let d = doc;
    let el = d && d.activeElement;
    for (let i = 0; el && i < 16; i++) {
        const inner = el.contentDocument || el.__routeDoc;
        if (!inner || !inner.activeElement) break;
        d = inner;
        el = inner.activeElement;
    }
    return {doc: d, el};
}

function editInsert(doc, el, text, log) {
    fireTrusted(doc, 'beforeinput', el, log);
    if (el.__ignoreKeyboard) return;
    if (el.isContentEditable) {
        const sel = doc.__selection;
        const all = sel && sel.el === el && sel.all;
        el.textContent = (all ? '' : el.textContent) + text;
        doc.__selection = {el, all: false};
    } else {
        const v = el.value;
        const a = el.selectionStart ?? v.length;
        const b = el.selectionEnd ?? v.length;
        el.value = v.slice(0, a) + text + v.slice(b);
        el.selectionStart = el.selectionEnd = a + text.length;
    }
    fireTrusted(doc, 'input', el, log);
}

function simulateKeyboard(page, method, params, log) {
    const {doc, el} = focusedIn(page.document);
    if (!doc || !el) return;
    if (method === 'Input.insertText') { editInsert(doc, el, params.text, log); return; }
    if (params.type === 'keyUp') { fireTrusted(doc, 'keyup', el, log); return; }
    fireTrusted(doc, 'keydown', el, log);
    const selectAll = (params.commands || []).includes('selectAll') || ((params.modifiers & 2) && String(params.key).toLowerCase() === 'a');
    if (selectAll) {
        if (el.isContentEditable) doc.__selection = {el, all: true};
        else if (typeof el.select === 'function') el.select();
        return;
    }
    if (params.key === 'Backspace' && !el.__ignoreKeyboard) {
        if (el.isContentEditable) { if (doc.__selection?.all) el.textContent = ''; }
        else {
            const v = el.value; const a = el.selectionStart ?? v.length; const b = el.selectionEnd ?? v.length;
            el.value = a === b ? v.slice(0, Math.max(0, a - 1)) + v.slice(b) : v.slice(0, a) + v.slice(b);
            el.selectionStart = el.selectionEnd = a === b ? Math.max(0, a - 1) : a;
        }
        fireTrusted(doc, 'input', el, log);
        return;
    }
    if (params.type === 'keyDown' && params.text && params.text !== String.fromCharCode(13)) editInsert(doc, el, params.text, log);
}

function simulateMouse(page, state, params, log) {
    const doc = page.document;
    if (!doc || typeof doc.elementFromPoint !== 'function') return;
    const {doc: d, hit} = hitAt(doc, params.x, params.y);
    if (!hit) return;
    if (params.type === 'mouseMoved') {
        fireTrusted(d, 'mousemove', hit, log);
        if (state.over !== hit) { state.over = hit; fireTrusted(d, 'mouseover', hit, log); }
        if (state.pressed && params.buttons === 1 && state.pressed.draggable && state.nativeDrag) {
            if (!state.dragging) { state.dragging = true; fireTrusted(state.pressedDoc, 'dragstart', state.pressed, log); }
            fireTrusted(d, 'dragover', hit, log);
        }
    } else if (params.type === 'mousePressed') {
        state.pressed = hit;
        state.pressedDoc = d;
        fireTrusted(d, 'mousedown', hit, log);
    } else if (params.type === 'mouseReleased') {
        const pressed = state.pressed;
        state.pressed = null;
        if (state.dragging) {
            state.dragging = false;
            fireTrusted(d, 'drop', hit, log);
            fireTrusted(state.pressedDoc, 'dragend', pressed, log);
            return;
        }
        fireTrusted(d, 'mouseup', hit, log);
        if (pressed !== hit) return;
        if (params.button === 'left') {
            fireTrusted(d, 'click', hit, log);
            if (params.clickCount === 2) fireTrusted(d, 'dblclick', hit, log);
        } else if (params.button === 'right') {
            fireTrusted(d, 'contextmenu', hit, log);
            fireTrusted(d, 'auxclick', hit, log);
        } else if (params.button === 'middle') {
            fireTrusted(d, 'auxclick', hit, log);
        }
    }
}

/**
 * Horloge simulée d'un harnais : Date.now et les minuteries du service worker (sauf les 30 s d'inactivité, déclenchées
 * à la main) suivent un temps virtuel. Dès que plus rien d'autre n'est à faire (tâches et microtâches écoulées),
 * le temps saute à la prochaine minuterie et la déclenche : une attente de 50 ms dure toujours 50 ms, quelle que soit
 * la charge du poste. Sans elle, une attente réelle bornée (wait_network_idle 400 ms, wait_download) dépassait sa
 * borne quand le poste était chargé (mesuré : 2 échecs sur 60 passages sous charge).
 */
function virtualClock() {
    const RealDate = Date;
    let now = RealDate.now();
    let order = 0;
    let pumping = false;
    const timers = new Set();
    const pump = () => {
        pumping = false;
        for (const timer of timers) if (timer.cleared) timers.delete(timer);
        if (!timers.size) return;
        const next = [...timers].sort((a, b) => a.at - b.at || a.order - b.order)[0];
        timers.delete(next);
        now = Math.max(now, next.at);
        next.fn(...next.args);
        schedule();
    };
    const schedule = () => {
        if (!pumping && timers.size) {
            pumping = true;
            setImmediate(pump);
        }
    };
    class VirtualDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    return {
        Date: VirtualDate,
        setTimeout(fn, ms = 0, ...args) {
            const timer = {fn, args, at: now + Math.max(0, Number(ms) || 0), order: order++, cleared: false};
            timers.add(timer);
            schedule();
            return timer;  // clearTimeout du harnais le marque « cleared » : il n'est alors jamais déclenché
        },
        get now() { return now; },
        advance(ms) { now += ms; }  // temps qui passe sans minuterie (silence d'une session)
    };
}

// Client du pont simulé : identité posée par le pont à côté des paramètres (agent + session).
const TEST_CLIENT = {agent: 'Test', id: 'test-session-1'};
const AGENT_A = {agent: 'Claude', id: 'claude-aaaa1111'};
const AGENT_B = {agent: 'Codex', id: 'codex-bbbb2222'};

// Monde isolé simulé (comme Page.createIsolatedWorld) : DOM et objets de la page partagés, mais les variables posées
// par les scripts (« expandos » __*) appartiennent à CE monde : la page ne les voit ni ne les remplace.
const isExpando = (key) => typeof key === 'string' && key.startsWith('__');

function isolatedGlobal(page, seed = {}) {
    const own = {...seed};
    const base = page.window || {};
    const has = (key) => Object.prototype.hasOwnProperty.call(own, key);
    const win = new Proxy(base, {
        get: (target, key) => has(key) ? own[key] : (isExpando(key) ? undefined : target[key]),
        set: (target, key, value) => { own[key] = value; return true; },
        has: (target, key) => has(key) || (!isExpando(key) && key in target),
        defineProperty: (target, key, descriptor) => { Object.defineProperty(own, key, descriptor); return true; },
        deleteProperty: (target, key) => { delete own[key]; return true; }
    });
    const global = {};
    for (const key of Object.keys(page)) {
        if (key === 'window') continue;
        Object.defineProperty(global, key, {get: () => page[key], set: (v) => { page[key] = v; }, enumerable: true, configurable: true});
    }
    global.window = win;
    return {context: vm.createContext(global), window: win, own};
}

/** Identifiants d'onglet visés par une commande (tabId, tab_id, id, tabIds). */
function tabIdsOf(params = {}) {
    const ids = [];
    for (const key of ['tabId', 'tab_id']) if (Number.isInteger(params[key])) ids.push(params[key]);
    if (Array.isArray(params.tabIds)) for (const id of params.tabIds) if (Number.isInteger(id)) ids.push(id);
    return ids;
}

function harness(pageOverrides = {}, chromeOverrides = {}) {
    let clicks = 0;
    let found = true;
    let failure = false;
    const calls = [];
    const mouseLog = [];
    const mouseState = {nativeDrag: chromeOverrides.nativeDrag !== false};
    const scriptCalls = [];
    const tabMessages = [];
    const focusCalls = {tabs: 0, windows: 0};
    const element = {
        scrollIntoView() {}, focus() {}, getBoundingClientRect: () => ({x: 0, y: 0, width: 10, height: 10}),
        dispatchEvent() { clicks++; }, click() { clicks++; }, tagName: 'BUTTON', innerText: 'Test',
        parentNode: null,
        onTrusted(type) { if (type === 'click') clicks++; }
    };
    const {isolatedWindow: isolatedSeed, ...pageProps} = pageOverrides;
    const page = {
        document: listenable({
            querySelectorAll: () => found ? [element] : [],
            elementFromPoint: (x, y) => (found && x >= 0 && x <= 10 && y >= 0 && y <= 10) ? element : null
        }),
        window: {dispatchEvent() {}},
        CustomEvent: class {}, MouseEvent: class {}, Event: class {},
        ...pageProps
    };
    // Marqueur #1 déjà posé par une carte précédente, dans le monde isolé de l'extension (jamais dans la page).
    const worldSeed = isolatedSeed || (pageProps.document ? {} : {__nexus_som_elements: new Map([[1, element]])});
    const worlds = new Map();  // executionContextId -> monde isolé du cadre principal
    let nextWorld = 1000;
    let scriptingWorld = null;  // monde ISOLATED de chrome.scripting (repli sans débogueur)
    let onEvent;
    let onMessage;
    let onRemoved;
    const detached = [];
    const idleTimers = [];
    const sessionData = {...(chromeOverrides.sessionStorage || {})};
    const localData = {...(chromeOverrides.localStorage || {})};
    let sidePanelBehavior = null;
    const event = {addListener() {}};
    const messageEvent = {addListener(fn) { onMessage = fn; }};
    const chrome = {
        runtime: {onStartup: event, onInstalled: event, onMessage: messageEvent, ...(chromeOverrides.runtime || {})},
        offscreen: {hasDocument: async () => true}, alarms: {create() {}, onAlarm: event},
        sidePanel: {
            setPanelBehavior: async (opts) => { sidePanelBehavior = opts; },
            open: async () => {},
            ...(chromeOverrides.sidePanel || {})
        },
        tabGroups: {
            query: async () => [],
            update: async (id, p) => ({ id, ...p }),
            ...(chromeOverrides.tabGroups || {})
        },
        tabs: {
            get: async () => ({ url: 'https://example.invalid', windowId: 10 }),
            query: async () => [{ id: 1, url: 'https://example.invalid', title: 'Example' }],
            create: async (p) => ({ id: 99, url: p.url, active: p.active, windowId: 10 }),
            remove: async () => {},
            reload: async () => {},
            update: async (id, p) => { focusCalls.tabs++; return { id, ...p, windowId: 10 }; },
            group: async ({ tabIds, groupId }) => groupId || 101,
            sendMessage: async (tabId, message, options) => { tabMessages.push({tabId, message, options}); },
            onRemoved: {addListener(fn) { onRemoved = fn; }},
            onReplaced: event,
            ...(chromeOverrides.tabs || {})
        },
        windows: {
            update: async () => { focusCalls.windows++; },
            ...(chromeOverrides.windows || {})
        },
        webNavigation: chromeOverrides.webNavigation,
        downloads: chromeOverrides.downloads || {search: async () => [], erase: async () => []},
        scripting: {
            async executeScript({target, world, func, args}) {
                scriptCalls.push({target, world, name: func.name, args});
                if (chromeOverrides.scriptingError) throw new Error(chromeOverrides.scriptingError);
                const code = `(${func.toString()})(...${JSON.stringify(args || [])})`;
                let value;
                if (world === 'MAIN') value = vm.runInNewContext(code, page);
                else value = vm.runInContext(code, (scriptingWorld ||= isolatedGlobal(page)).context);
                return [{frameId: 0, result: value === undefined ? null : JSON.parse(JSON.stringify(value))}];
            }
        },
        storage: {
            session: {
                get: async (keys) => {
                    const list = keys === undefined || keys === null ? Object.keys(sessionData) : (Array.isArray(keys) ? keys : [keys]);
                    return Object.fromEntries(list.filter(k => k in sessionData).map(k => [k, sessionData[k]]));
                },
                set: async (items) => { Object.assign(sessionData, JSON.parse(JSON.stringify(items))); },
                remove: async (key) => { delete sessionData[key]; }
            },
            local: {
                get: async (keys) => {
                    const list = keys === undefined || keys === null ? Object.keys(localData) : (Array.isArray(keys) ? keys : [keys]);
                    return Object.fromEntries(list.filter(k => k in localData).map(k => [k, localData[k]]));
                },
                set: async (items) => { Object.assign(localData, JSON.parse(JSON.stringify(items))); },
                remove: async (key) => { delete localData[key]; }
            }
        },
        debugger: {
            onEvent: {addListener(fn) { onEvent = fn; }}, onDetach: event,
            attach: async () => {
                if (chromeOverrides.attachError) throw new Error(chromeOverrides.attachError);
            },
            detach: async (target) => { detached.push(target.tabId); },
            getTargets: async () => (chromeOverrides.targets || []),
            async sendCommand(target, method, params) {
                calls.push({target, method, params});
                if (chromeOverrides.debuggerSendCommand) {
                    const custom = await chromeOverrides.debuggerSendCommand(target, method, params);
                    if (custom !== undefined) return custom;
                }
                if (method === 'Page.getFrameTree') {
                    return {frameTree: {frame: {id: 'MAIN', url: 'https://example.invalid/', securityOrigin: 'https://example.invalid', loaderId: 'L0'}}};
                }
                if (method === 'Page.createIsolatedWorld') {
                    const id = nextWorld++;
                    worlds.set(id, isolatedGlobal(page, worlds.size ? {} : worldSeed));
                    return {executionContextId: id};
                }
                if (method === 'Runtime.evaluate') {
                    if (failure) return {exceptionDetails: {text: 'Script failed'}};
                    let evalVal;
                    if (params.contextId !== undefined) {
                        const world = worlds.get(params.contextId);
                        if (!world) throw new Error('Cannot find context with specified id');
                        evalVal = vm.runInContext(params.expression, world.context);
                    } else {
                        evalVal = vm.runInNewContext(params.expression, page);
                    }
                    return {result: {value: (evalVal && typeof evalVal.then === 'function') ? await evalVal : evalVal}};
                }
                if (method === 'DOM.getDocument') return {root: {nodeId: 1}};
                if (method === 'DOM.querySelector') return {nodeId: 2};
                if (method === 'DOM.describeNode') return {node: {nodeName: 'BUTTON', attributes: []}};
                if (method === 'Page.captureScreenshot') return {data: 'base64shot'};
                if (method === 'Input.dispatchMouseEvent') simulateMouse(page, mouseState, params, mouseLog);
                if (method === 'Input.insertText' || method === 'Input.dispatchKeyEvent') simulateKeyboard(page, method, params, mouseLog);
                return {};
            }
        }
    };
    const MockWebSocket = chromeOverrides.WebSocket || class { constructor() { this.readyState = 3; } close() {} send() {} };
    // virtualTime : horloge simulée (Date.now et minuteries du service worker), voir virtualClock.
    const clock = chromeOverrides.virtualTime ? virtualClock() : null;
    // Minuteries d'inactivité du débogueur (30 s) capturées pour être déclenchées à la main.
    const fakeSetTimeout = (fn, ms, ...args) => {
        if (ms === 30000) {
            const timer = {fn, cleared: false};
            idleTimers.push(timer);
            return timer;
        }
        return clock ? clock.setTimeout(fn, ms, ...args) : setTimeout(fn, ms, ...args);
    };
    const fakeClearTimeout = (timer) => {
        if (timer && typeof timer === 'object' && 'cleared' in timer) timer.cleared = true;
        else clearTimeout(timer);
    };
    const ctx = vm.createContext({
        chrome, console, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout, setInterval, clearInterval,
        WebSocket: MockWebSocket, URL, atob, btoa, TextDecoder, TextEncoder, Uint8Array, crypto: globalThis.crypto,
        ...(clock ? {Date: clock.Date} : {})
    });
    // importScripts du service worker : fichiers de l'extension chargés dans le même contexte.
    ctx.importScripts = (...files) => {
        for (const file of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), ctx);
    };
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), ctx);
    // autoOwn (défaut) : un onglet visé par un test appartient au client qui le vise, comme s'il l'avait ouvert par
    // new_tab. Les tests d'isolation le coupent (autoOwn: false) pour éprouver la propriété elle-même.
    const autoOwn = chromeOverrides.autoOwn !== false;
    const own = async (tabId, client = TEST_CLIENT, how = 'created') => {
        await vm.runInContext('extensionStateReady', ctx);
        await ctx.rememberTabOwner(tabId, client, how);
    };
    return {
        // extra : champs posés par le pont à côté de la commande (gone : sessions mortes du même agent).
        run: async (action, params = {}, client = TEST_CLIENT, extra = {}) => {
            await vm.runInContext('extensionStateReady', ctx);
            if (autoOwn && client) {
                for (const id of tabIdsOf(params)) {
                    if (!vm.runInContext(`tabOwners.has(${id})`, ctx)) await own(id, client);
                }
            }
            return ctx.handleCommand(client ? {action, params, client, ...extra} : {action, params, ...extra});
        },
        advanceTime: (ms) => clock.advance(ms),
        own,
        owners: () => plain(vm.runInContext('Object.fromEntries(tabOwners)', ctx)),
        element, tabMessages, worlds,
        isolatedWindow: () => [...worlds.values()][0]?.window,
        isolatedWindowFor: (contextId) => worlds.get(contextId)?.window,
        // Expéditeur par défaut : une page de l'extension (panneau, offscreen) ; {tab} = script de contenu.
        sendMessage: (msg, sender = {id: chrome.runtime.id}) => new Promise((resolve) => {
            if (!onMessage) return resolve(undefined);
            const keepOpen = onMessage(msg, sender, resolve);
            if (!keepOpen) resolve(undefined);
        }),
        // Code exécuté dans le contexte du service worker (accès à ses variables de script).
        evalInContext: (code) => vm.runInContext(code, ctx),
        getSidePanelBehavior: () => sidePanelBehavior,
        event: (tabId) => onEvent({tabId}, 'Page.fileChooserOpened', {backendNodeId: 9}),
        emit: (tabId, method, params = {}) => onEvent({tabId}, method, params),
        emitFrom: (source, method, params = {}) => onEvent(source, method, params),
        removeTab: (tabId) => onRemoved(tabId),
        fireIdleTimers: async () => {
            const due = idleTimers.splice(0).filter(t => !t.cleared);
            for (const t of due) await t.fn();
        },
        sessionData, localData, detached, idleTimers,
        missing() { found = false; }, fail() { failure = true; },
        get clicks() { return clicks; }, calls, mouseLog, scriptCalls, focusCalls, page,
        mouse: () => plain(calls.filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params)),
        keyboard: () => plain(calls.filter(c => c.method === 'Input.dispatchKeyEvent' || c.method === 'Input.insertText').map(c => ({method: c.method, ...c.params}))),
        ctx
    };
}

test('one click event for CSS and marker clicks', async () => {
    const h = harness();
    await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(h.clicks, 1);
    await h.run('click_mark', {tabId: 1, mark: 1});
    assert.equal(h.clicks, 2);
});

test('missing target propagates as a transport error', async () => {
    const h = harness();
    h.missing();
    assert.match((await h.run('click', {tabId: 1, selector: '#missing'})).error, /Element not found/);
});

test('explicit evaluation preserves error-shaped data', async () => {
    const h = harness();
    const result = await h.run('evaluate', {tabId: 1, code: '({error: "user data"})'});
    assert.equal(result.data.error, 'user data');
    assert.equal(result.error, undefined);
});

test('failed evaluation is not executed twice', async () => {
    const h = harness();
    h.fail();
    assert.match((await h.run('evaluate', {tabId: 1, code: 'bad()'})).error, /Script failed/);
    assert.equal(h.calls.filter(c => c.method === 'Runtime.evaluate').length, 1);
});

test('parallel uploads stay on their own tab and clean interception', async () => {
    const h = harness();
    const first = h.run('upload', {tabId: 1, files: ['C:/test/one.txt'], selector: 'button'});
    const second = h.run('upload', {tabId: 2, files: ['C:/test/two.txt'], selector: 'button'});
    await new Promise(setImmediate);
    assert.match((await h.run('upload', {tabId: 1, files: ['C:/test/three.txt']})).error, /already pending/);
    await h.event(3);
    assert.equal(h.calls.filter(c => c.method === 'DOM.setFileInputFiles').length, 0);
    await h.event(2);
    await h.event(1);
    assert.equal((await first).data.success, true);
    assert.equal((await second).data.success, true);
    const uploads = h.calls.filter(c => c.method === 'DOM.setFileInputFiles');
    assert.equal(uploads[0].target.tabId, 2);
    assert.equal(uploads[0].params.files[0], 'C:/test/two.txt');
    assert.equal(uploads[1].target.tabId, 1);
    assert.equal(uploads[1].params.files[0], 'C:/test/one.txt');
    assert.equal(h.calls.filter(c => c.method === 'Page.setInterceptFileChooserDialog' && !c.params.enabled).length, 2);
});

test('upload cleans interception when trigger is missing', async () => {
    const h = harness();
    h.missing();
    assert.match((await h.run('upload', {tabId: 1, files: ['C:/test/one.txt'], selector: 'button'})).error, /Element not found/);
    assert.equal(h.calls.at(-1).params.enabled, false);
});

test('focus émulé une seule fois, avant le premier événement de souris (onglet en arrière-plan)', async () => {
    const h = harness();
    await h.run('click', {tabId: 1, selector: 'button'});
    await h.run('click', {tabId: 1, selector: 'button'});
    const methods = h.calls.map(c => c.method);
    const focus = methods.filter(m => m === 'Emulation.setFocusEmulationEnabled');
    assert.equal(focus.length, 1);
    assert.ok(methods.indexOf('Emulation.setFocusEmulationEnabled') < methods.indexOf('Input.dispatchMouseEvent'));
    assert.equal(h.calls.find(c => c.method === 'Emulation.setFocusEmulationEnabled').params.enabled, true);
});

test('une simple lecture n\'émule jamais le focus', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1 + 1'});
    assert.equal(h.calls.filter(c => c.method === 'Emulation.setFocusEmulationEnabled').length, 0);
});

test('hover dispatches mouseMoved CDP command and coordinates', async () => {
    const h = harness();
    const res = await h.run('hover', {tabId: 1, selector: 'button', timeoutMs: 50});
    assert.equal(res.data.success, true);
    assert.equal(res.data.tagName, 'BUTTON');
    const mouseMoves = h.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseMoves.length, 1);
    assert.equal(mouseMoves[0].params.type, 'mouseMoved');
});

test('tab lifecycle supports create_tab, close_tab and reload', async () => {
    const h = harness();
    const created = await h.run('create_tab', {url: 'https://example.com'});
    assert.equal(created.data.url, 'https://example.com');
    const reloaded = await h.run('reload', {tabId: 1});
    assert.equal(reloaded.data.success, true);
    const closed = await h.run('close_tab', {tabId: 1});
    assert.equal(closed.data.success, true);
});

test('get_cookies calls Network.getCookies', async () => {
    const h = harness();
    const res = await h.run('get_cookies', {tabId: 1});
    assert.equal(res.data.cookieCount, 0);
    assert.equal(h.calls.some(c => c.method === 'Network.getCookies'), true);
});

test('interactive_map generates compact numbered element list', async () => {
    const h = harness();
    const res = await h.run('interactive_map', {tabId: 1});
    assert.equal(res.data.count, 1);
    assert.equal(res.data.elements[0].mark, 1);
    assert.equal(res.data.elements[0].tag, 'button');
});

test('drag_and_drop dispatches mousePressed, moved and released sequence', async () => {
    const h = harness();
    const res = await h.run('drag_and_drop', {
        tabId: 1,
        from_coordinates: {x: 10, y: 20},
        to_coordinates: {x: 50, y: 60},
        steps: 4,
        delayMs: 0
    });
    assert.equal(res.data.success, true);
    const mouseEvents = h.calls.filter(c => c.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseEvents[0].params.type, 'mouseMoved');
    assert.equal(mouseEvents[1].params.type, 'mousePressed');
    assert.equal(mouseEvents.at(-1).params.type, 'mouseReleased');
});

test('shadowRoot recursion penetrates custom components', async () => {
    let shadowClicks = 0;
    const inRect = (x, y) => x >= 5 && x <= 25 && y >= 5 && y <= 25;
    const shadowRoot = {
        querySelectorAll: (sel) => (sel === 'button' || sel === '*') ? [shadowChild] : [],
        elementFromPoint: (x, y) => inRect(x, y) ? shadowChild : null
    };
    const shadowChild = {
        scrollIntoView() {}, focus() {}, getBoundingClientRect: () => ({x: 5, y: 5, width: 20, height: 20}),
        dispatchEvent() { shadowClicks++; }, click() { shadowClicks++; }, tagName: 'BUTTON', innerText: 'ShadowSubmit',
        parentNode: shadowRoot,
        onTrusted(type, event) { if (type === 'click' && event.target === shadowChild) shadowClicks++; }
    };
    const hostElement = {shadowRoot, querySelectorAll: () => [], tagName: 'CUSTOM-FORM', parentNode: null};
    shadowRoot.host = hostElement;
    const h = harness({
        document: listenable({
            querySelectorAll: (sel) => {
                if (sel === 'button') return [];
                if (sel === '*') return [hostElement];
                return [];
            },
            // Comme un vrai navigateur : le document ne voit que l'hôte, le shadow root donne la cible réelle.
            elementFromPoint: (x, y) => inRect(x, y) ? hostElement : null
        })
    });
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.success, true);
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.trusted_click, true);
    assert.equal(shadowClicks, 1);
});

test('fill targets mark index or custom selector', async () => {
    let filledValue = '';
    const inputElement = {
        scrollIntoView() {}, focus() {},
        dispatchEvent() {},
        getBoundingClientRect: () => ({x: 0, y: 0, width: 10, height: 10}),
        tagName: 'INPUT',
        get value() { return filledValue; },
        set value(v) { filledValue = v; }
    };
    // Marqueur #5 posé par une carte précédente, dans le monde isolé de l'extension.
    const h = harness({isolatedWindow: {__nexus_som_elements: new Map([[5, inputElement]])}});
    const res = await h.run('fill', {tabId: 1, selector: '#5', value: 'hello@example.com'});
    assert.equal(res.data.success, true);
    assert.equal(filledValue, 'hello@example.com');
});

test('takeScreenshot safely clips element with quotes in selector', async () => {
    const el = {
        scrollIntoView() {},
        getBoundingClientRect: () => ({x: 10, y: 20, width: 200, height: 100})
    };
    const h = harness({
        document: {
            querySelectorAll: (sel) => (sel === 'button[name="test-btn"]') ? [el] : []
        }
    });
    const res = await h.run('screenshot', {tabId: 1, selector: 'button[name="test-btn"]'});
    assert.equal(res.data.mimeType, 'image/png');
    assert.match(res.data.dataUrl, /^data:image\/png;base64,/);
    const clipCalls = h.calls.filter(c => c.method === 'Page.captureScreenshot');
    assert.equal(clipCalls.length, 1);
    const clip = clipCalls[0].params.clip;
    assert.equal(clip.x, 10);
    assert.equal(clip.y, 20);
    assert.equal(clip.width, 200);
    assert.equal(clip.height, 100);
    assert.equal(clip.scale, 1);
});

test('selectOption supports fallback on custom dropdowns', async () => {
    const customOption = {
        getAttribute: (attr) => attr === 'value' ? 'opt2' : null,
        innerText: 'Option Deux'
    };
    const selectEl = {
        querySelectorAll: (sel) => (sel === 'option') ? [customOption] : [],
        dispatchEvent() {}
    };
    const h = harness({
        document: {
            querySelector: () => selectEl,
            querySelectorAll: (sel) => sel === '.custom-dropdown' ? [selectEl] : []
        }
    });
    const res = await h.run('select_option', {tabId: 1, selector: '.custom-dropdown', text: 'Option Deux'});
    assert.equal(res.data.success, true);
    assert.equal(res.data.selectedValue, 'opt2');
    assert.equal(res.data.selectedText, 'Option Deux');
    // Relecture (browser_fill_form) : même recherche d'options que la sélection, valeur posée relue.
    const read = await h.run('field_state', {tabId: 1, selector: '.custom-dropdown', expect: {option: 'Option Deux'}});
    assert.equal(read.data.verified, true);
    assert.equal(read.data.selectedValue, 'opt2');
});

test('getPageContent extracts interactive elements and handles SVG className', async () => {
    const svgEl = {
        tagName: 'svg',
        className: { baseVal: 'lucide-icon', animVal: 'lucide-icon' },
        getBoundingClientRect: () => ({ x: 10, y: 10, width: 24, height: 24 }),
        getAttribute: () => null
    };
    const h = harness({
        document: {
            title: 'Test Page',
            querySelectorAll: () => [svgEl]
        },
        window: { location: { href: 'https://example.com' } }
    });
    const res = await h.run('get_content', { tabId: 1, mode: 'interactive' });
    assert.equal(res.data.title, 'Test Page');
    assert.equal(res.data.elements.length, 1);
    assert.equal(res.data.elements[0].className, 'lucide-icon');
});

test('semanticFill and fill support textarea with prototype setter', async () => {
    let textVal = '';
    const textareaEl = {
        scrollIntoView() {},
        focus() {},
        dispatchEvent() {},
        getBoundingClientRect: () => ({x: 0, y: 0, width: 10, height: 10}),
        tagName: 'TEXTAREA',
        name: 'feedback',
        id: 'msg-box',
        getAttribute: (attr) => attr === 'aria-label' ? 'Votre message' : null,
        get value() { return textVal; },
        set value(v) { textVal = v; }
    };
    const h = harness({
        document: {
            querySelectorAll: () => [textareaEl],
            querySelector: () => null,
            getElementById: () => null
        }
    });
    const res1 = await h.run('semantic_fill', { tabId: 1, label: 'Votre message', value: 'NexusBrowser SOTA' });
    assert.equal(res1.data.success, true);
    assert.equal(textVal, 'NexusBrowser SOTA');

    const res2 = await h.run('fill', { tabId: 1, selector: '#msg-box', value: 'Updated feedback' });
    assert.equal(res2.data.success, true);
    assert.equal(textVal, 'Updated feedback');
});

test('upload directly sets files on input[type=file] without file chooser dialog', async () => {
    let directFilesSet = null;
    const h = harness({}, {
        debuggerSendCommand: async (target, method, params) => {
            if (method === 'DOM.describeNode') {
                return { node: { nodeName: 'INPUT', attributes: ['type', 'file', 'id', 'file-upload'] } };
            }
            if (method === 'DOM.setFileInputFiles') {
                directFilesSet = params.files;
                return {};
            }
        }
    });
    const res = await h.run('upload', { tabId: 1, files: ['C:/photos/bundle.aab'], selector: '#file-upload' });
    assert.equal(res.data.success, true);
    assert.equal(res.data.method, 'direct_dom');
    assert.deepEqual(directFilesSet, ['C:/photos/bundle.aab']);
    // Ensure file chooser was never intercepted
    assert.equal(h.calls.some(c => c.method === 'Page.setInterceptFileChooserDialog'), false);
});

test('select_tab activates tab and focuses window cleanly', async () => {
    let windowFocused = false;
    const h = harness({}, {
        windows: {
            update: async (winId, opts) => {
                if (winId === 10 && opts.focused) windowFocused = true;
            }
        }
    });
    const res = await h.run('select_tab', { tabId: 42 });
    assert.equal(res.data.success, true);
    assert.equal(windowFocused, true);
});

test('vision_inspect captures screenshot and generates Set-of-Mark elements', async () => {
    const btn = {
        scrollIntoView() {}, focus() {},
        getBoundingClientRect: () => ({ x: 20, y: 30, width: 80, height: 40 }),
        tagName: 'BUTTON', innerText: 'Valider',
        getAttribute: () => null
    };
    const h = harness({
        document: {
            querySelectorAll: (sel) => (typeof sel === 'string' && sel.includes('__nexus_som_marker')) ? [] : [btn],
            createElement: () => ({ style: {}, remove() {} }),
            documentElement: { appendChild() {} },
            title: 'Vision Test'
        },
        window: {
            innerWidth: 1024,
            innerHeight: 768,
            location: { href: 'https://example.com' }
        }
    });
    const res = await h.run('vision_inspect', { tabId: 1 });
    assert.equal(res.data.markerCount >= 1, true);
    assert.equal(res.data.markers[0].tag, 'button');
    assert.match(res.data.screenshotDataUrl, /^data:image\/png;base64,/);
});

test('capture d\'un onglet de fond : flux d\'images tenu pendant la capture (screenshot et vision_inspect), sans premier plan', async () => {
    const order = (h) => h.calls.map(c => c.method)
        .filter(m => ['Page.startScreencast', 'Page.captureScreenshot', 'Page.stopScreencast'].includes(m));
    const h = harness({
        document: {querySelectorAll: () => [], createElement: () => ({style: {}, remove() {}}), documentElement: {appendChild() {}}},
        window: {innerWidth: 1024, innerHeight: 768, location: {href: 'https://example.com'}}
    });
    await h.run('screenshot', {tabId: 1});
    assert.deepEqual(order(h), ['Page.startScreencast', 'Page.captureScreenshot', 'Page.stopScreencast']);
    assert.equal(h.calls.some(c => c.method === 'Page.bringToFront'), false);
    h.calls.length = 0;
    await h.run('vision_inspect', {tabId: 1});
    assert.deepEqual(order(h), ['Page.startScreencast', 'Page.captureScreenshot', 'Page.stopScreencast']);
});

test('capture : flux refusé par Chrome -> capture directe ; capture en échec -> flux arrêté quand même', async () => {
    const refused = harness({}, {debuggerSendCommand: async (target, method) => {
        if (method === 'Page.startScreencast') throw new Error('Screencast refusé');
    }});
    const res = await refused.run('screenshot', {tabId: 1});
    assert.match(res.data.dataUrl, /^data:image\/png;base64,/);
    assert.equal(refused.calls.some(c => c.method === 'Page.stopScreencast'), false);
    const failing = harness({}, {debuggerSendCommand: async (target, method) => {
        if (method === 'Page.captureScreenshot') throw new Error('Capture impossible');
    }});
    await failing.run('screenshot', {tabId: 1}).catch(() => {});
    assert.equal(failing.calls.filter(c => /Screencast|captureScreenshot/.test(c.method)).at(-1).method, 'Page.stopScreencast');
});

test('about:blank tabs can be created and debugged without protected URL rejection', async () => {
    const h = harness({}, {
        tabs: {
            get: async (id) => ({ id, url: 'about:blank' })
        }
    });
    const res = await h.run('create_tab', {});
    assert.equal(res.data.url, 'about:blank');
    const evalRes = await h.run('evaluate', { tabId: res.data.id, code: '1 + 1' });
    assert.equal(evalRes.data, 2);
});

test('sidePanel behavior is configured to open panel on action click', async () => {
    const h = harness();
    assert.equal(h.getSidePanelBehavior()?.openPanelOnActionClick, true);
});

test('poste de contrôle : aucune action de page depuis le panneau (ni executeAction ni getActiveTab)', async () => {
    const h = harness();
    assert.equal(await h.sendMessage({target: 'background', executeAction: true, action: 'click', params: {tabId: 1, selector: 'button'}}), undefined);
    assert.equal(await h.sendMessage({target: 'background', getActiveTab: true}), undefined);
    assert.equal(h.clicks, 0);
    assert.equal(h.calls.length, 0);
});

test('create_tab opens in background and automatically creates the agent tab group', async () => {
    let groupedData = null;
    let createdActive = null;
    const h = harness({}, {
        tabs: {
            create: async (p) => {
                createdActive = p.active;
                return { id: 99, url: p.url, active: p.active, windowId: 10 };
            },
            group: async ({ tabIds, groupId }) => {
                groupedData = { tabIds, groupId };
                return 105;
            }
        },
        tabGroups: {
            query: async () => [],
            update: async (id, p) => ({ id, title: p.title, color: p.color, collapsed: p.collapsed })
        }
    });

    const res = await h.run('create_tab', { url: 'https://example.com/agent-task' });
    assert.equal(res.data.id, 99);
    assert.equal(createdActive, false); // Stays in background, user active tab undisturbed
    assert.equal(groupedData.tabIds[0], 99);
});

test('new_tab de fond : fenêtre normale visée, jamais la fenêtre d\'application ; sans fenêtre normale, fenêtre réduite sans focus', async () => {
    const created = [];
    const windowsCreated = [];
    const withNormal = harness({}, {
        tabs: { create: async (p) => { created.push(p); return { id: 77, url: p.url, active: p.active, windowId: p.windowId }; } },
        windows: {
            getLastFocused: async ({ windowTypes }) => {
                assert.deepEqual(JSON.parse(JSON.stringify(windowTypes)), ['normal']);
                return { id: 5, type: 'normal' };
            },
            getAll: async () => [{ id: 5, type: 'normal' }],
        }
    });
    await withNormal.run('create_tab', { url: 'https://example.com/a', group: false });
    assert.deepEqual(JSON.parse(JSON.stringify(created.at(-1))), { url: 'https://example.com/a', active: false, windowId: 5 });

    const appOnly = harness({}, {
        tabs: { create: async () => { throw new Error('ne doit pas être appelé'); } },
        windows: {
            getLastFocused: async () => { throw new Error('No last-focused window'); },
            getAll: async () => [{ id: 9, type: 'app' }],
            create: async (p) => { windowsCreated.push(p); return { id: 12, tabs: [{ id: 120, url: p.url, active: false }] }; },
        }
    });
    const res = await appOnly.run('create_tab', { url: 'https://example.com/b' });
    assert.equal(res.data.id, 120);
    assert.equal(res.data.windowCreated, true);
    assert.deepEqual(JSON.parse(JSON.stringify(windowsCreated)), [{ url: 'https://example.com/b', focused: false, state: 'minimized', type: 'normal' }]);
});

test('group_tabs explicitly groups specified tabs with custom color and title', async () => {
    const h = harness({}, {
        tabGroups: {
            query: async () => [],
            update: async (id, p) => ({ id, ...p })
        }
    });
    const res = await h.run('group_tabs', { tabIds: [1, 2], title: 'Nexus', color: 'purple', collapsed: true });
    assert.equal(res.data.groupId, 101);
    assert.equal(res.data.title, 'Nexus');
    assert.equal(res.data.color, 'purple');
    assert.equal(res.data.collapsed, true);
    assert.equal(res.data.tabIds[0], 1);
    assert.equal(res.data.tabIds[1], 2);
});

test('onglets partagés : après new_tab, une commande de page sans tab_id est refusée (ni onglet commun, ni onglet actif)', async () => {
    const h = harness({}, {
        tabs: {
            create: async (p) => ({ id: 88, url: p.url, active: false, windowId: 10 }),
            get: async (id) => ({ id, url: 'https://example.invalid', windowId: 10 })
        }
    });
    // L'agent A ouvre son onglet ; l'agent B (même extension) envoie une commande sans tab_id.
    assert.equal((await h.run('create_tab', { url: 'https://example.com/isolated' })).data.id, 88);
    const pageCommands = [
        ['click', {selector: 'button'}], ['fill', {selector: 'input', value: 'x'}], ['evaluate', {code: '1'}],
        ['upload', {files: ['C:/test/one.txt']}], ['press_key', {key: 'Enter'}], ['get_cookies', {}],
        ['cdp_send', {method: 'Page.reload'}], ['get_content', {mode: 'text'}], ['screenshot', {}],
        ['handle_dialog', {accept: true}], ['wait_download', {timeoutMs: 10}], ['group_tabs', {title: 'X'}],
        ['interactive_map', {}], ['network_requests', {}], ['type_keys', {text: 'a'}], ['select_tab', {}]
    ];
    for (const [action, params] of pageCommands) {
        const res = await h.run(action, params);
        assert.match(res.error || '', /pass tab_id or open a tab with new_tab/, action);
    }
    assert.equal(h.calls.length, 0);  // aucun débogueur attaché, rien n'a touché l'onglet 88 ni l'onglet actif 1
    // Avec son tab_id, chaque agent agit sur SON onglet.
    await h.run('click', {tabId: 88, selector: 'button'});
    assert.ok(h.calls.length > 0 && h.calls.every(c => c.target.tabId === 88));
    // Restent permis sans tab_id : ping, liste des onglets, identité de l'onglet actif, nouvel onglet.
    for (const action of ['ping', 'list_tabs', 'active_tab']) assert.equal((await h.run(action, {})).error, undefined, action);
    assert.match((await h.run('click', {tabId: 'abc', selector: 'button'})).error, /Invalid tab_id/);
});

// -----------------------------------------------------------------------------
// DOM factice hiérarchique : <html> et <body> contiennent tout le texte de la page, comme dans un vrai navigateur.
// -----------------------------------------------------------------------------
function closestTag(el, tag) {
    for (let n = el; n; n = n.parentElement) if (n.tagName === tag) return n;
    return null;
}

function fakeDom(build) {
    const clicked = [];
    const hovered = [];
    const synthetic = [];
    class El {
        constructor(tag, attrs = {}, kids = []) {
            this.tagName = tag.toUpperCase();
            this.attrs = attrs;
            this.children = [];
            this.ownText = '';
            this.parentElement = null;
            for (const kid of kids) {
                if (typeof kid === 'string') this.ownText += (this.ownText ? ' ' : '') + kid;
                else { kid.parentElement = this; this.children.push(kid); }
            }
        }
        get innerText() { return [this.ownText, ...this.children.map(c => c.innerText)].filter(Boolean).join(' '); }
        get textContent() { return this.innerText; }
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
        get parentNode() { return this.parentElement; }
        getBoundingClientRect() { return this.rect; }
        descendants() { const out = []; for (const c of this.children) out.push(c, ...c.descendants()); return out; }
        querySelectorAll(sel) { return sel === '*' ? this.descendants() : this.descendants().filter(e => e.tagName === sel.toUpperCase()); }
        scrollIntoView() {}
        focus() {}
        click() { clicked.push(this); }
        dispatchEvent() { synthetic.push(this); }
        onTrusted(type, event) {
            if (event.target !== this) return;
            if (type === 'click') clicked.push(this);
            if (type === 'mouseover') hovered.push(this);
        }
    }
    const h = (tag, attrs, ...kids) => new El(tag, attrs || {}, kids);
    const html = h('html', {}, h('head', {}, h('title', {}, 'Page')), h('body', {}, ...build(h)));
    // Mise en page : chaque feuille sur sa ligne, un parent couvre ses enfants, un élément caché n'a pas de surface.
    let row = 0;
    (function layout(el) {
        if (el.attrs['data-hidden']) { el.rect = {x: 0, y: 0, width: 0, height: 0}; return; }
        const kids = el.children.filter(c => { layout(c); return c.rect.width > 0; });
        if (!kids.length) { el.rect = {x: 10, y: 10 + 30 * row++, width: 100, height: 20}; return; }
        const top = Math.min(...kids.map(k => k.rect.y));
        const bottom = Math.max(...kids.map(k => k.rect.y + k.rect.height));
        el.rect = {x: 10, y: top, width: 100, height: bottom - top};
    })(html);
    const all = () => [html, ...html.descendants()];
    const depth = (el) => { let d = 0; for (let n = el; n; n = n.parentElement) d++; return d; };
    const document = listenable({
        documentElement: html,
        title: 'Page',
        querySelectorAll: (sel) => sel === '*' ? all() : html.querySelectorAll(sel),
        querySelector: () => null,
        // Élément le plus profond sous le point (le dernier peint en cas d'égalité).
        elementFromPoint: (x, y) => {
            let best = null;
            for (const el of all()) {
                const r = el.rect;
                if (!(r.width > 0) || x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
                if (!best || depth(el) >= depth(best)) best = el;
            }
            return best;
        }
    });
    return {document, clicked, hovered, synthetic, html};
}

function domPage(dom) {
    return {document: dom.document, window: {dispatchEvent() {}, __nexus_som_elements: new Map()}};
}

const toolbar = (h) => [
    h('div', {}, h('p', {}, 'Bienvenue, choisissez une action puis Enregistrer')),
    h('div', {class: 'toolbar'},
        h('button', {}, 'Enregistrer et quitter'),
        h('button', {id: 'save'}, h('span', {}, 'Enregistrer'))
    )
];

test('click(text) vise le contrôle le plus spécifique, jamais <html> ou <body>', async () => {
    const dom = fakeDom(toolbar);
    const h = harness(domPage(dom));
    const res = await h.run('click', {tabId: 1, text: 'Enregistrer', timeoutMs: 50});
    assert.equal(res.data.success, true);
    assert.equal(res.data.trusted_click, true);
    assert.equal(dom.clicked.length, 1);
    // Le vrai clic tombe sur le <span> intérieur : il appartient au bouton #save (exact avant inclusion).
    assert.equal(closestTag(dom.clicked[0], 'BUTTON').getAttribute('id'), 'save');
    assert.equal(res.data.tagName, 'BUTTON');
    assert.equal(res.data.id, 'save');
    assert.equal(dom.synthetic.length, 0);
});

test('click(text) retombe sur l\'inclusion et ignore un élément caché', async () => {
    const dom = fakeDom((h) => [
        h('button', {'data-hidden': true}, 'Supprimer'),
        h('div', {}, h('a', {href: '#'}, 'Supprimer le brouillon'))
    ]);
    const h = harness(domPage(dom));
    const res = await h.run('click', {tabId: 1, text: 'supprimer', timeoutMs: 50});
    assert.equal(res.data.success, true);
    assert.equal(dom.clicked.length, 1);
    assert.equal(dom.clicked[0].tagName, 'A');
    assert.equal(res.data.trusted_click, true);
});

test('click(text) introuvable : erreur, aucun clic sur la page entière', async () => {
    const dom = fakeDom(toolbar);
    const h = harness(domPage(dom));
    const res = await h.run('click', {tabId: 1, text: 'Publier', timeoutMs: 50});
    assert.match(res.error, /Element not found/);
    assert.equal(dom.clicked.length, 0);
});

test('hover(text) survole le bouton visé et non <html>', async () => {
    const dom = fakeDom(toolbar);
    const h = harness(domPage(dom));
    const res = await h.run('hover', {tabId: 1, text: 'Enregistrer et quitter', timeoutMs: 50});
    assert.equal(res.data.success, true);
    assert.equal(res.data.tagName, 'BUTTON');
    assert.equal(res.data.trusted_hover, true);
    assert.ok(dom.hovered.length > 0);
    assert.ok(dom.hovered.every(el => el.tagName === 'BUTTON' && el.getAttribute('id') === null));
    assert.equal(dom.synthetic.length, 0);  // plus de mouseover/mouseenter synthétique en doublon
});

test('semantic_click sans rôle vise le contrôle nommé, pas la page', async () => {
    const dom = fakeDom(toolbar);
    const h = harness(domPage(dom));
    const res = await h.run('semantic_click', {tabId: 1, name: 'Enregistrer', timeoutMs: 50});
    assert.equal(res.data.success, true);
    assert.equal(res.data.method, 'cdp');
    assert.equal(dom.clicked.length, 1);
    assert.equal(closestTag(dom.clicked[0], 'BUTTON').getAttribute('id'), 'save');
});

test('close_tab, navigate et reload sans tab_id ni onglet d\'agent connu sont refusés', async () => {
    let removed = 0;
    let updated = 0;
    let reloaded = 0;
    const h = harness({}, {
        tabs: {
            remove: async () => { removed++; },
            update: async (id, p) => { updated++; return {id, ...p}; },
            reload: async () => { reloaded++; }
        }
    });
    assert.match((await h.run('close_tab', {})).error, /pass tab_id/);
    assert.match((await h.run('navigate', {url: 'https://example.com'})).error, /tab_id/);
    assert.match((await h.run('reload', {})).error, /new_tab/);
    assert.equal(removed + updated + reloaded, 0);
    // Les lectures de page ne visent plus l'onglet actif de Julien non plus.
    assert.match((await h.run('get_content', {mode: 'text'})).error, /pass tab_id/);
    assert.equal(h.calls.some(c => c.method === 'Runtime.evaluate'), false);
});

test('l\'extension ne mémorise aucun onglet d\'agent (ancien onglet commun ignoré après redémarrage)', async () => {
    const first = harness();
    await first.run('create_tab', {url: 'https://example.com/agent'});
    assert.equal('nexusBrowserAgentTabId' in first.sessionData, false);

    let navigated = null;
    const restarted = harness({}, {
        sessionStorage: {nexusBrowserAgentTabId: 77},
        tabs: {
            get: async (id) => ({id, url: 'https://example.invalid', windowId: 10}),
            update: async (id, p) => { navigated = id; return {id, ...p}; }
        }
    });
    assert.match((await restarted.run('navigate', {url: 'https://example.com/next'})).error, /pass tab_id/);
    assert.equal(navigated, null);
    assert.equal((await restarted.run('navigate', {tabId: 77, url: 'https://example.com/next'})).error, undefined);
    assert.equal(navigated, 77);
});

test('une boîte de dialogue n\'est jamais acceptée d\'office et se règle par handle_dialog', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.emit(1, 'Page.javascriptDialogOpening', {type: 'confirm', message: 'Supprimer définitivement ?'});
    assert.equal(h.calls.some(c => c.method === 'Page.handleJavaScriptDialog'), false);

    const blocked = await h.run('evaluate', {tabId: 1, code: '2'});
    assert.match(blocked.error, /confirm/);
    assert.match(blocked.error, /Supprimer définitivement/);
    const read = await h.run('get_content', {tabId: 1, mode: 'text'});
    assert.match(read.error, /Supprimer définitivement/);
    // Sans tab_id : refusé, la boîte n'est pas réglée au hasard.
    assert.match((await h.run('handle_dialog', {accept: true})).error, /pass tab_id/);
    assert.equal(h.calls.some(c => c.method === 'Page.handleJavaScriptDialog'), false);

    const handled = await h.run('handle_dialog', {tabId: 1, accept: false});
    assert.equal(handled.data.accepted, false);
    assert.equal(handled.data.dialog.type, 'confirm');
    const call = h.calls.find(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(call.params.accept, false);
    assert.equal(call.target.tabId, 1);
    assert.equal((await h.run('evaluate', {tabId: 1, code: '3'})).data, 3);
});

test('un clic qui ouvre une boîte de dialogue rend la main et la signale', async () => {
    let fired = false;
    let ref = null;
    const h = harness({}, {
        debuggerSendCommand: (target, method) => {
            if (method === 'Runtime.evaluate' && !fired) {
                fired = true;
                ref.emit(target.tabId, 'Page.javascriptDialogOpening', {type: 'alert', message: 'Enregistré'});
                return new Promise(() => {});  // la page reste bloquée tant que la boîte est ouverte
            }
        }
    });
    ref = h;
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.dialogOpened, true);
    assert.equal(res.data.dialog.message, 'Enregistré');
    assert.equal(h.calls.some(c => c.method === 'Page.handleJavaScriptDialog'), false);
});

test('Network.enable dès l\'attachement et compteur remis à zéro à la navigation', async () => {
    const h = harness({}, {virtualTime: true});
    await h.run('evaluate', {tabId: 1, code: '1'});
    const methods = h.calls.map(c => c.method);
    assert.ok(methods.indexOf('Network.enable') >= 0 && methods.indexOf('Network.enable') < methods.indexOf('Runtime.evaluate'));

    // Redirection : même requestId deux fois, une seule fin
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'r1'});
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'r1'});
    await h.emit(1, 'Network.loadingFinished', {requestId: 'r1'});
    assert.equal((await h.run('wait_network_idle', {tabId: 1, idleMs: 10, timeoutMs: 400})).data.status, 'idle');

    // Requête de l'ancien document jamais terminée : la navigation principale remet à zéro
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'stale'});
    assert.equal((await h.run('wait_network_idle', {tabId: 1, idleMs: 10, timeoutMs: 100})).data.status, 'timeout');
    await h.emit(1, 'Page.frameNavigated', {frame: {id: 'main'}});
    assert.equal((await h.run('wait_network_idle', {tabId: 1, idleMs: 10, timeoutMs: 400})).data.status, 'idle');
});

test('le débogueur est détaché après inactivité et à la fermeture de l\'onglet', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    assert.ok(h.idleTimers.length > 0);
    await h.fireIdleTimers();
    assert.deepEqual(h.detached, [1]);

    // Boîte de dialogue en attente : le débogueur reste attaché pour pouvoir y répondre
    await h.run('evaluate', {tabId: 2, code: '1'});
    await h.emit(2, 'Page.javascriptDialogOpening', {type: 'alert', message: 'x'});
    await h.fireIdleTimers();
    assert.deepEqual(h.detached, [1]);

    await h.run('evaluate', {tabId: 3, code: '1'});
    h.removeTab(3);
    await new Promise(setImmediate);
    assert.ok(h.detached.includes(3));
});

// -----------------------------------------------------------------------------
// Souris réelle : séquences CDP Input.dispatchMouseEvent, point visé, atteinte, sonde isTrusted, repli JavaScript
// -----------------------------------------------------------------------------
const MOVE_TO_CENTER = {type: 'mouseMoved', x: 5, y: 5, button: 'none', buttons: 0};

test('clic : séquence CDP exacte et clic de confiance prouvé', async () => {
    const h = harness();
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.deepEqual(h.mouse(), [
        MOVE_TO_CENTER,
        {type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1},
        {type: 'mouseReleased', x: 5, y: 5, button: 'left', buttons: 0, clickCount: 1}
    ]);
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.trusted_click, true);
    assert.deepEqual(plain(res.data.coordinates), {x: 5, y: 5});
    assert.equal(h.clicks, 1);
    // La sonde est retirée après lecture : aucun écouteur ne reste dans la page.
    assert.equal((h.page.document.__listeners.click || []).length, 0);
});

test('double clic : deux paires pressed/released, clickCount 1 puis 2', async () => {
    const h = harness();
    const res = await h.run('click', {tabId: 1, selector: 'button', click_count: 2});
    assert.deepEqual(h.mouse(), [
        MOVE_TO_CENTER,
        {type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1},
        {type: 'mouseReleased', x: 5, y: 5, button: 'left', buttons: 0, clickCount: 1},
        {type: 'mousePressed', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 2},
        {type: 'mouseReleased', x: 5, y: 5, button: 'left', buttons: 0, clickCount: 2}
    ]);
    assert.equal(res.data.trusted_click, true);
    assert.ok(res.data.trusted_events.includes('dblclick'));
    assert.equal(res.data.clickCount, 2);
});

test('clic droit : bouton right, buttons 2, contextmenu de confiance', async () => {
    const h = harness();
    const res = await h.run('click', {tabId: 1, selector: 'button', button: 'right'});
    assert.deepEqual(h.mouse(), [
        MOVE_TO_CENTER,
        {type: 'mousePressed', x: 5, y: 5, button: 'right', buttons: 2, clickCount: 1},
        {type: 'mouseReleased', x: 5, y: 5, button: 'right', buttons: 0, clickCount: 1}
    ]);
    assert.equal(res.data.trusted_click, true);
    assert.ok(res.data.trusted_events.includes('contextmenu'));
    assert.equal(h.clicks, 0);  // un clic droit n'est pas un click
    assert.match((await h.run('click', {tabId: 1, selector: 'button', button: 'sideways'})).error, /Unknown mouse button/);
});

test('survol : un seul mouseMoved, aucun bouton, survol de confiance', async () => {
    const h = harness();
    const res = await h.run('hover', {tabId: 1, selector: 'button'});
    assert.deepEqual(h.mouse(), [MOVE_TO_CENTER]);
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.trusted_hover, true);
    assert.equal(h.clicks, 0);
});

test('click_mark passe aussi par la souris CDP', async () => {
    const h = harness();
    const mark = await h.run('click_mark', {tabId: 1, mark: 1});
    assert.equal(mark.data.method, 'cdp');
    assert.equal(mark.data.trusted_click, true);
    assert.match((await h.run('click_mark', {tabId: 1, mark: 7})).error, /No element registered for mark #7/);
    assert.equal(h.clicks, 1);
});

function dragPage() {
    let synthetic = 0;
    let drops = 0;
    const doc = listenable({});
    const mk = (id, x, draggable) => ({
        id, tagName: 'DIV', innerText: id, draggable, parentNode: null, ownerDocument: doc,
        scrollIntoView() {}, getBoundingClientRect: () => ({x, y: 100, width: 40, height: 40}),
        dispatchEvent(ev) { if (ev && ev.type) synthetic++; }
    });
    const src = mk('source', 0, true);
    const dst = mk('zone', 200, false);
    dst.onTrusted = (type) => { if (type === 'drop') drops++; };
    doc.querySelectorAll = (sel) => sel === '#source' ? [src] : (sel === '#zone' ? [dst] : []);
    doc.elementFromPoint = (x, y) => (y < 100 || y > 140) ? null : (x >= 0 && x <= 40 ? src : (x >= 200 && x <= 240 ? dst : null));
    const DragEvent = class { constructor(type) { this.type = type; } };
    return {
        page: {document: doc, window: {dispatchEvent() {}}, CustomEvent: class {}, MouseEvent: class {}, DragEvent, DataTransfer: class {}},
        get drops() { return drops; },
        get synthetic() { return synthetic; }
    };
}

test('glisser : pressed au départ, mouseMoved intermédiaires buttons 1, released à l\'arrivée, un seul dépôt', async () => {
    const dp = dragPage();
    const h = harness(dp.page);
    const res = await h.run('drag_and_drop', {tabId: 1, from_selector: '#source', to_selector: '#zone', steps: 4, delayMs: 0});
    assert.deepEqual(h.mouse(), [
        {type: 'mouseMoved', x: 20, y: 120, button: 'none', buttons: 0},
        {type: 'mousePressed', x: 20, y: 120, button: 'left', buttons: 1, clickCount: 1},
        {type: 'mouseMoved', x: 70, y: 120, button: 'left', buttons: 1},
        {type: 'mouseMoved', x: 120, y: 120, button: 'left', buttons: 1},
        {type: 'mouseMoved', x: 170, y: 120, button: 'left', buttons: 1},
        {type: 'mouseMoved', x: 220, y: 120, button: 'left', buttons: 1},
        {type: 'mouseReleased', x: 220, y: 120, button: 'left', buttons: 0, clickCount: 1}
    ]);
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.drop_events, 1);
    assert.equal(res.data.trusted_drop, true);
    assert.equal(res.data.trusted_drag, true);
    assert.equal(res.data.html5_fallback, false);
    assert.equal(dp.drops, 1);
    assert.equal(dp.synthetic, 0);  // plus de DragEvent HTML5 en doublon
});

test('glisser : DragEvent HTML5 seulement en repli quand la séquence CDP n\'a produit aucun drop', async () => {
    const dp = dragPage();
    const h = harness(dp.page, {nativeDrag: false});
    const res = await h.run('drag_and_drop', {tabId: 1, from_selector: '#source', to_selector: '#zone', steps: 3, delayMs: 0});
    assert.equal(res.data.method, 'cdp+html5_fallback');
    assert.equal(res.data.html5_fallback, true);
    assert.equal(res.data.drop_events, 0);
    assert.equal(dp.synthetic, 5);  // dragstart, dragenter, dragover, drop, dragend : une seule fois
});

test('point visé : défilement au centre puis décalage de l\'iframe same-origin (bordure comprise)', async () => {
    let scrolled = null;
    const topDoc = listenable({});
    const topWin = {dispatchEvent() {}, innerWidth: 1280, innerHeight: 720};
    topDoc.defaultView = topWin;
    const frameDoc = listenable({});
    const iframe = {
        tagName: 'IFRAME', parentNode: null, ownerDocument: topDoc, contentDocument: frameDoc,
        clientLeft: 2, clientTop: 3, frameOrigin: {x: 102, y: 203},
        getBoundingClientRect: () => ({x: 100, y: 200, width: 400, height: 300}),
        querySelectorAll: () => []
    };
    const frameWin = {innerWidth: 396, innerHeight: 294, frameElement: iframe};
    frameDoc.defaultView = frameWin;
    let frameClicks = 0;
    const inner = {
        tagName: 'BUTTON', id: 'inner', innerText: 'Dans le cadre', parentNode: null, ownerDocument: frameDoc,
        scrollIntoView(opts) { scrolled = opts; },
        // Hors de la vue du cadre avant défilement, centré ensuite.
        getBoundingClientRect: () => scrolled ? {x: 40, y: 120, width: 60, height: 20} : {x: 40, y: 1500, width: 60, height: 20},
        onTrusted(type) { if (type === 'click') frameClicks++; }
    };
    frameDoc.querySelectorAll = (sel) => sel === '#inner' ? [inner] : [];
    frameDoc.elementFromPoint = (x, y) => (scrolled && x >= 40 && x <= 100 && y >= 120 && y <= 140) ? inner : null;
    topDoc.querySelectorAll = (sel) => (sel === '*' || sel === 'iframe') ? [iframe] : [];
    topDoc.elementFromPoint = (x, y) => (x >= 100 && x <= 500 && y >= 200 && y <= 500) ? iframe : null;
    const h = harness({document: topDoc, window: topWin});
    const res = await h.run('click', {tabId: 1, selector: '#inner'});
    assert.deepEqual(plain(scrolled), {behavior: 'instant', block: 'center', inline: 'center'});
    // Centre local (70, 130) + origine du contenu du cadre (100 + 2, 200 + 3).
    assert.deepEqual(plain(res.data.coordinates), {x: 172, y: 333});
    assert.equal(res.data.frameDepth, 1);
    assert.equal(h.mouse()[1].x, 172);
    assert.equal(h.mouse()[1].y, 333);
    assert.equal(res.data.trusted_click, true);
    assert.equal(frameClicks, 1);
});

test('élément en partie couvert : un point intérieur dégagé est choisi', async () => {
    const h = harness();
    // Bandeau sur la moitié haute du bouton : le centre (5, 5) est couvert, (2.5, 7.5) ne l'est pas.
    const banner = {tagName: 'DIV', id: 'banner', parentNode: null};
    const button = h.element;
    h.page.document.elementFromPoint = (x, y) => y <= 6 ? banner : button;
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.trusted_click, true);
    assert.ok(h.mouse().every(e => e.y > 6));
});

test('élément entièrement couvert : erreur explicite et aucun clic ailleurs', async () => {
    const h = harness();
    const overlay = {tagName: 'DIV', id: 'overlay', className: 'modal backdrop', parentNode: null};
    h.page.document.elementFromPoint = () => overlay;
    const res = await h.run('click', {tabId: 1, selector: 'button', timeoutMs: 0});
    assert.match(res.error, /covered by <div#overlay\.modal\.backdrop>/);
    assert.match(res.error, /no mouse action sent/);
    assert.equal(h.mouse().length, 0);
    assert.equal(h.clicks, 0);
    const hover = await h.run('hover', {tabId: 1, selector: 'button', timeoutMs: 0});
    assert.match(hover.error, /covered/);
    assert.equal(h.mouse().length, 0);
});

test('repli JavaScript signalé quand le débogueur ne peut pas s\'attacher', async () => {
    const h = harness({}, {attachError: 'Cannot attach to this target.'});
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.method, 'js_fallback');
    assert.equal(res.data.trusted_click, false);
    assert.match(res.data.fallback_reason, /CDP attach error/);
    assert.equal(h.mouse().length, 0);
    assert.equal(h.clicks, 1);  // el.click() synthétique
    // Repli dans le monde ISOLÉ de l'extension, jamais dans celui de la page.
    assert.ok(h.scriptCalls.length > 0 && h.scriptCalls.every(c => c.world === 'ISOLATED' && c.target.tabId === 1));
    const hover = await h.run('hover', {tabId: 1, selector: 'button'});
    assert.equal(hover.data.method, 'js_fallback');
    assert.equal(hover.data.trusted_hover, false);
});

test('onglet protégé sans injection possible : erreur claire, aucune action', async () => {
    const h = harness({}, {
        tabs: {get: async (id) => ({id, url: 'chrome://settings', windowId: 10})},
        scriptingError: 'Cannot access a chrome:// URL'
    });
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.match(res.error, /Debugger unavailable .*Protected internal URL.*JavaScript injection refused/);
    assert.equal(h.clicks, 0);
});

test('un clic qui ouvre confirm() au relâchement rend la main avec dialogOpened', async () => {
    let ref = null;
    const h = harness({}, {
        debuggerSendCommand: (target, method, params) => {
            if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
                ref.emit(target.tabId, 'Page.javascriptDialogOpening', {type: 'confirm', message: 'Supprimer ?'});
                return new Promise(() => {});  // page bloquée tant que la boîte est ouverte
            }
        }
    });
    ref = h;
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.dialogOpened, true);
    assert.equal(res.data.dialog.type, 'confirm');
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.trusted_click, null);
    assert.equal(h.calls.some(c => c.method === 'Page.handleJavaScriptDialog'), false);
    // Commande suivante refusée tant que la boîte n'est pas réglée.
    assert.match((await h.run('click', {tabId: 1, selector: 'button'})).error, /confirm/);
});

test('une boîte ouverte au mousedown : le bouton est quand même relâché', async () => {
    let ref = null;
    const h = harness({}, {
        debuggerSendCommand: (target, method, params) => {
            if (method === 'Input.dispatchMouseEvent' && params.type === 'mousePressed') {
                ref.emit(target.tabId, 'Page.javascriptDialogOpening', {type: 'alert', message: 'mousedown'});
                return new Promise(() => {});
            }
        }
    });
    ref = h;
    const res = await h.run('click', {tabId: 1, selector: 'button'});
    assert.equal(res.data.dialogOpened, true);
    assert.deepEqual(h.mouse().map(e => e.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(h.mouse()[2].buttons, 0);
});

test('les actions souris ne mettent jamais l\'onglet ni la fenêtre au premier plan', async () => {
    const h = harness();
    await h.run('click', {tabId: 1, selector: 'button'});
    await h.run('click', {tabId: 1, selector: 'button', click_count: 2});
    await h.run('hover', {tabId: 1, selector: 'button'});
    await h.run('click_mark', {tabId: 1, mark: 1});
    const dp = dragPage();
    const h2 = harness(dp.page);
    await h2.run('drag_and_drop', {tabId: 1, from_selector: '#source', to_selector: '#zone', steps: 2, delayMs: 0});
    assert.deepEqual(h.focusCalls, {tabs: 0, windows: 0});
    assert.deepEqual(h2.focusCalls, {tabs: 0, windows: 0});
});

test('un clic réarme le détachement du débogueur à l\'inactivité', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    assert.equal(h.idleTimers.filter(t => !t.cleared).length, 1);
    const first = h.idleTimers.find(t => !t.cleared);
    await h.run('click', {tabId: 1, selector: 'button'});
    const live = h.idleTimers.filter(t => !t.cleared);
    assert.equal(live.length, 1);
    assert.notEqual(live[0], first);  // ancien compte à rebours annulé, nouveau armé
    await h.fireIdleTimers();
    assert.deepEqual(h.detached, [1]);
});

// =============================================================================
// DOM riche : libellés, rôles implicites, focus, valeur et sélection des champs, contenteditable, cases à cocher.
// Mise en page : chaque feuille sur sa ligne, un parent couvre ses enfants, un élément caché n'a pas de surface.
// =============================================================================
function richDom(build, {frameOrigin = null} = {}) {
    const synthetic = [];
    const trusted = [];
    const doc = listenable({title: 'Page', activeElement: null, __selection: null});
    const win = {
        dispatchEvent() {}, innerWidth: 1280, innerHeight: 4000, __nexus_som_elements: new Map(),
        getComputedStyle: (el) => ({display: el.hiddenStyle ? 'none' : (el.inline ? 'inline' : 'block'), visibility: 'visible', paddingLeft: '0', paddingTop: '0'}),
        getSelection: () => ({
            removeAllRanges() { doc.__selection = null; },
            addRange(range) { doc.__selection = {el: range.el, all: !range.collapsed}; },
            toString: () => (doc.__selection && doc.__selection.all ? doc.__selection.el.textContent : ''),
            get rangeCount() { return doc.__selection ? 1 : 0; }
        })
    };
    doc.defaultView = win;
    doc.createRange = () => ({el: null, collapsed: false, selectNodeContents(el) { this.el = el; }, collapse() { this.collapsed = true; }});
    const FOCUSABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'IFRAME']);
    class El {
        constructor(tag, attrs = {}, kids = []) {
            this.nodeType = 1;
            this.tagName = tag.toUpperCase();
            this.attrs = {...attrs};
            this.childNodes = [];
            this.parentNode = null;
            this.ownerDocument = doc;
            this.isConnected = true;
            this.hooks = {};
            this._value = attrs.value !== undefined ? String(attrs.value) : '';
            this._checked = 'checked' in attrs;
            this.selectionStart = null;
            this.selectionEnd = null;
            this.hiddenStyle = 'data-hidden' in attrs;
            for (const kid of kids) this.append(kid);
        }
        append(kid) {
            const node = typeof kid === 'string' ? {nodeType: 3, data: kid, get textContent() { return this.data; }} : kid;
            node.parentNode = this;
            this.childNodes.push(node);
        }
        get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
        get children() { return this.childNodes.filter(n => n.nodeType === 1); }
        get textContent() { return this.childNodes.map(n => n.nodeType === 3 ? n.data : n.textContent).join(''); }
        set textContent(v) { this.childNodes = [{nodeType: 3, data: String(v), parentNode: this}]; }
        get innerText() { return this.hiddenStyle ? '' : this.childNodes.map(n => n.nodeType === 3 ? n.data : n.innerText).join(' ').replace(/\s+/g, ' ').trim(); }
        get id() { return this.attrs.id || ''; }
        get type() { return String(this.attrs.type || (this.tagName === 'INPUT' ? 'text' : '')).toLowerCase(); }
        get value() {
            if (this.tagName === 'SELECT') { const o = this.options.find(x => x.selected) || this.options[0]; return o ? o.value : ''; }
            if (this.tagName === 'OPTION') return this.attrs.value !== undefined ? this.attrs.value : this.textContent;
            return this._value;
        }
        set value(v) {
            if (this.tagName === 'SELECT') { for (const o of this.options) o.selected = o.value === String(v); return; }
            this._value = String(v);
        }
        get text() { return this.textContent; }
        get selected() { return !!this._selected; }
        set selected(v) { this._selected = !!v; }
        get options() { return this.descendants().filter(e => e.tagName === 'OPTION'); }
        get selectedOptions() { return this.options.filter(o => o.selected); }
        get checked() { return this._checked; }
        set checked(v) { this._checked = !!v; }
        get disabled() { return 'disabled' in this.attrs; }
        get readOnly() { return 'readonly' in this.attrs; }
        get multiple() { return 'multiple' in this.attrs; }
        get isContentEditable() {
            for (let n = this; n && n.nodeType === 1; n = n.parentNode) {
                const v = n.attrs.contenteditable;
                if (v === 'true' || v === '' || v === 'plaintext-only') return true;  // hôtes d'édition (HTML §6.8)
                if (v === 'false') return false;
            }
            return false;
        }
        get labels() {
            if (!['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(this.tagName)) return undefined;
            const out = all().filter(e => e.tagName === 'LABEL' && e.attrs.for && e.attrs.for === this.id);
            for (let n = this.parentElement; n; n = n.parentElement) if (n.tagName === 'LABEL') { if (!out.includes(n)) out.push(n); break; }
            return out;
        }
        get control() {
            if (this.tagName !== 'LABEL') return undefined;
            if (this.attrs.for) return doc.getElementById(this.attrs.for);
            return this.descendants().find(e => ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)) || null;
        }
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
        hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
        descendants() { const out = []; for (const c of this.children) out.push(c, ...c.descendants()); return out; }
        querySelectorAll(sel) { return selectIn(this.descendants(), sel); }
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
        contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
        closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (selectIn([n], sel).length) return n; return null; }
        getRootNode() { return doc; }
        getBoundingClientRect() { return this.rect; }
        scrollIntoView() {}
        focus() { if (FOCUSABLE.has(this.tagName) || this.isContentEditable) doc.activeElement = this; }
        select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
        setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
        click() { synthetic.push({el: this, type: 'click'}); }
        dispatchEvent(event) {
            synthetic.push({el: this, type: event && event.type});
            const hook = this.hooks['untrusted:' + (event && event.type)];
            if (hook) hook(event);
            return true;
        }
        onTrusted(type, event) {
            if (event.target !== this) return;
            trusted.push({el: this, type});
            if (type === 'mousedown') {
                let n = this;
                while (n && n.nodeType === 1 && !(FOCUSABLE.has(n.tagName) || n.isContentEditable || n.tagName === 'LABEL')) n = n.parentNode;
                if (n && n.tagName === 'LABEL') n = n.control;
                if (n && n.focus) n.focus();
            }
            if (type === 'click') {
                const box = this.tagName === 'LABEL' ? this.control : this;
                if (box && box.tagName === 'INPUT' && box.type === 'checkbox') box.checked = !box.checked;
                if (box && box.tagName === 'INPUT' && box.type === 'radio') box.checked = true;
            }
            if (this.hooks[type]) this.hooks[type](event);
        }
    }
    function selectIn(list, sel) {
        const parts = String(sel).split(',').map(p => p.trim()).filter(Boolean);
        return list.filter(e => parts.some(p => {
            if (p === '*') return true;
            let m = /^#([\w-]+)$/.exec(p);
            if (m) return e.id === m[1];
            m = /^\[([\w-]+)(?:='([^']*)')?\]$/.exec(p);
            if (m) return m[2] === undefined ? e.hasAttribute(m[1]) : e.getAttribute(m[1]) === m[2];
            m = /^([a-z0-9]+)$/i.exec(p);
            if (m) return e.tagName === m[1].toUpperCase();
            m = /^\.([\w-]+)$/.exec(p);
            if (m) return String(e.attrs.class || '').split(/\s+/).includes(m[1]);
            return false;
        }));
    }
    const h = (tag, attrs, ...kids) => new El(tag, attrs || {}, kids);
    const html = h('html', {}, h('body', {}, ...build(h)));
    const all = () => [html, ...html.descendants()];
    let row = 0;
    (function layout(el) {
        if (el.hiddenStyle) { el.rect = {x: 0, y: 0, width: 0, height: 0}; for (const c of el.descendants()) c.rect = {x: 0, y: 0, width: 0, height: 0}; return; }
        const kids = el.children.filter(c => { layout(c); return c.rect.width > 0; });
        if (!kids.length) { el.rect = {x: 10, y: 10 + 30 * row++, width: 100, height: 20}; return; }
        const top = Math.min(...kids.map(k => k.rect.y));
        const bottom = Math.max(...kids.map(k => k.rect.y + k.rect.height));
        el.rect = {x: 10, y: top, width: 100, height: bottom - top};
    })(html);
    const depth = (el) => { let d = 0; for (let n = el; n && n.nodeType === 1; n = n.parentNode) d++; return d; };
    doc.documentElement = html;
    doc.body = html.children[0];
    doc.querySelectorAll = (sel) => selectIn(all(), sel);
    doc.querySelector = (sel) => doc.querySelectorAll(sel)[0] || null;
    doc.getElementById = (id) => all().find(e => e.id === id) || null;
    doc.elementFromPoint = (x, y) => {
        if (doc.__overlay) return doc.__overlay;
        let best = null;
        for (const el of all()) {
            const r = el.rect;
            if (!(r.width > 0) || x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
            if (!best || depth(el) >= depth(best)) best = el;
        }
        return best;
    };
    const byId = (id) => doc.getElementById(id);
    const page = {
        document: doc, window: win, CustomEvent: class {}, MouseEvent: class {},
        Event: class { constructor(type) { this.type = type; } },
        InputEvent: class { constructor(type) { this.type = type; } }
    };
    win.Event = page.Event;
    win.InputEvent = page.InputEvent;
    return {doc, win, page, html, byId, synthetic, trusted, h, frameOrigin};
}

function richHarness(build, chromeOverrides = {}) {
    const dom = richDom(build);
    const h = harness(dom.page, chromeOverrides);
    return {h, dom};
}

const formPage = (h) => [
    h('button', {id: 'v1'}, 'Valider'),
    h('button', {id: 'v2'}, 'Valider le panier'),
    h('button', {id: 'v3', 'data-hidden': ''}, 'Valider'),
    h('ul', {}, h('li', {}, h('button', {id: 'd1'}, 'Supprimer')), h('li', {}, h('button', {id: 'd2'}, 'Supprimer'))),
    h('button', {id: 'send', 'data-testid': 'submit-zone'}, 'Envoyer'),
    h('a', {id: 'home', href: '/'}, h('img', {alt: 'Accueil du site'})),
    h('a', {id: 'nolink'}, 'Pas un lien'),
    h('h2', {id: 'title'}, 'Titre de section'),
    h('label', {for: 'email', id: 'email-label'}, 'Adresse e-mail'),
    h('input', {id: 'email', type: 'email'}),
    h('input', {id: 'search', placeholder: 'Rechercher un produit'}),
    h('span', {id: 'cp-label'}, 'Code postal'),
    h('input', {id: 'cp', 'aria-labelledby': 'cp-label'}),
    h('input', {id: 'city', 'aria-label': 'Ville'}),
    h('label', {id: 'accept-label'}, h('input', {id: 'accept', type: 'checkbox'}), " J'accepte les conditions"),
    h('label', {for: 'plan'}, 'Formule'),
    h('select', {id: 'plan'}, h('option', {value: 'free'}, 'Découverte'), h('option', {value: 'pro'}, 'Pro')),
    h('div', {id: 'editor', contenteditable: 'true', 'aria-label': 'Éditeur riche'}, 'Ancien texte'),
    h('p', {id: 'para'}, 'Bonjour ', h('b', {id: 'bold'}, 'Continuer'))
];

// -----------------------------------------------------------------------------
// 1. Localisateurs par rôle et libellé
// -----------------------------------------------------------------------------
test('localisateur strict : homonymes refusés avec la liste des candidats, aucun clic', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Valider'}});
    assert.match(res.error, /Ambiguous locator/);
    assert.match(res.error, /2 elements/);
    assert.match(res.error, /"Valider"/);
    assert.match(res.error, /"Valider le panier"/);
    assert.equal(h.mouse().length, 0);
    assert.equal(dom.trusted.filter(t => t.type === 'click').length, 0);
});

test('localisateur exact, nth et testId : vrai clic sur le bon élément', async () => {
    const {h, dom} = richHarness(formPage);
    const exact = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Valider', exact: true}});
    assert.equal(exact.data.trusted_click, true);
    assert.equal(exact.data.id, 'v1');
    const nth = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Supprimer', nth: 1}});
    assert.equal(nth.data.id, 'd2');
    const last = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Supprimer', nth: -1}});
    assert.equal(last.data.id, 'd2');
    const testId = await h.run('click', {tabId: 1, locator: {testId: 'submit-zone'}});
    assert.equal(testId.data.id, 'send');
    const clicked = dom.trusted.filter(t => t.type === 'click').map(t => t.el.id);
    assert.deepEqual(clicked, ['v1', 'd2', 'd2', 'send']);
    assert.match((await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Supprimer', nth: 5}})).error, /out of range/);
});

test('localisateur introuvable : erreur claire, masqués signalés, includeHidden les inclut', async () => {
    const {h} = richHarness(formPage);
    const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Publier'}, timeoutMs: 50});
    assert.match(res.error, /No element matches the locator/);
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Valider', exact: true}});
    assert.equal(found.data.count, 1);
    assert.equal(found.data.hidden, 1);
    assert.equal(found.data.unique, true);
    const withHidden = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Valider', exact: true, includeHidden: true}});
    assert.equal(withHidden.data.count, 2);
    assert.equal(withHidden.data.candidates[1].visible, false);
    assert.match((await h.run('click', {tabId: 1, locator: {role: 'button'}, timeoutMs: 0})).error, /Ambiguous/);
    assert.match((await h.run('click', {tabId: 1, locator: {exact: true}})).error, /without criterion/);
    assert.match((await h.run('click', {tabId: 1, locator: '{pas du json'})).error, /Unreadable locator/);
});

test('rôles implicites et noms accessibles (label, aria-labelledby, aria-label, alt, contenu)', async () => {
    const {h} = richHarness(formPage);
    const find = async (locator) => (await h.run('find', {tabId: 1, locator})).data;
    assert.equal((await find({role: 'link', name: 'Accueil du site'})).candidates[0].id, 'home');
    assert.equal((await find({role: 'link', name: 'Pas un lien'})).count, 0);  // <a> sans href : pas un lien
    const heading = await find({role: 'heading', name: 'Titre'});
    assert.equal(heading.candidates[0].level, 2);
    assert.equal((await find({role: 'textbox', name: 'Adresse e-mail'})).candidates[0].id, 'email');
    assert.equal((await find({role: 'textbox', name: 'Code postal'})).candidates[0].id, 'cp');
    assert.equal((await find({label: 'Ville'})).candidates[0].id, 'city');
    assert.equal((await find({placeholder: 'rechercher'})).candidates[0].id, 'search');
    const box = await find({role: 'checkbox', name: "J'accepte"});
    assert.equal(box.candidates[0].id, 'accept');
    assert.equal(box.candidates[0].checked, false);
    assert.equal((await find({role: 'combobox', name: 'Formule'})).candidates[0].id, 'plan');
    assert.equal((await find({role: 'listitem'})).count, 2);
    assert.equal((await find({role: 'textbox', name: 'Éditeur riche'})).candidates[0].id, 'editor');
    // getByText : l'élément le plus profond dont le texte correspond ; exact et regex.
    assert.equal((await find({text: 'Continuer'})).candidates[0].id, 'bold');
    assert.equal((await find({text: 'bonjour continuer'})).candidates[0].id, 'para');
    assert.equal((await find({text: 'continuer', exact: true})).count, 0);
    assert.equal((await find({role: 'button', name: '/^valider$/i'})).count, 1);
    assert.equal((await find({role: 'button', hasText: 'panier'})).candidates[0].id, 'v2');
    assert.equal((await find({role: 'checkbox', checked: true})).count, 0);
});

test('moteur AX : rôle et nom calculés par Chrome (queryAXTree) puis filtrés dans la page', async () => {
    let ref = null;
    const objects = new Map();
    const {h, dom} = richHarness(formPage, {
        debuggerSendCommand: (target, method, params) => {
            if (method === 'Runtime.evaluate' && params.expression === 'document') return {result: {objectId: 'doc'}};
            if (method === 'DOM.describeNode' && params.objectId === 'doc') return {node: {backendNodeId: 1}};
            if (method === 'Accessibility.queryAXTree') {
                assert.equal(params.role, 'button');
                // Nom exposé par Chrome (ex. contenu CSS ::after), absent du DOM.
                return {nodes: [{backendDOMNodeId: 21, ignored: false, name: {value: 'Envoyer la commande'}}]};
            }
            if (method === 'DOM.resolveNode') {
                // Résolu dans le monde demandé : celui de l'extension (monde isolé du cadre principal).
                objects.set('n' + params.backendNodeId, {el: ref.byId('send'), contextId: params.executionContextId});
                return {object: {objectId: 'n' + params.backendNodeId}};
            }
            if (method === 'Runtime.callFunctionOn' && objects.has(params.objectId)) {
                const {el, contextId} = objects.get(params.objectId);
                const view = h.isolatedWindowFor(contextId);
                assert.ok(view, 'élément résolu hors du monde isolé');
                // this.ownerDocument.defaultView vu depuis ce monde : sa propre fenêtre (comme dans Chrome).
                const ownerDocument = el.ownerDocument;
                el.ownerDocument = {defaultView: view};
                try {
                    const value = vm.runInNewContext(`(${params.functionDeclaration}).apply(el, args)`, {el, args: params.arguments.map(a => a.value)});
                    return {result: {value}};
                } finally {
                    el.ownerDocument = ownerDocument;
                }
            }
        }
    });
    ref = dom;
    const ax = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'commande'}});
    assert.equal(ax.data.engine, 'ax');
    assert.equal(ax.data.count, 1);
    assert.equal(ax.data.candidates[0].name, 'Envoyer la commande');
    const dom2 = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'commande', engine: 'dom'}});
    assert.equal(dom2.data.count, 0);
    const click = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'commande'}});
    assert.equal(click.data.id, 'send');
    assert.equal(click.data.trusted_click, true);
});

test('hover, semantic_click et drag acceptent le même localisateur', async () => {
    const {h} = richHarness(formPage);
    assert.equal((await h.run('hover', {tabId: 1, locator: {role: 'link', name: 'Accueil'}})).data.trusted_hover, true);
    const sem = await h.run('semantic_click', {tabId: 1, locator: {role: 'button', name: 'Envoyer'}});
    assert.equal(sem.data.id, 'send');
    const before = h.mouse().length;
    const drag = await h.run('drag_and_drop', {tabId: 1, from_locator: {testId: 'submit-zone'}, to_locator: {role: 'heading'}, steps: 2, delayMs: 0});
    assert.equal(drag.data.success, true);
    assert.deepEqual(h.mouse().slice(before).map(e => e.type), ['mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
});

// -----------------------------------------------------------------------------
// 2. Frappe de confiance
// -----------------------------------------------------------------------------
test('fill : vrai clic de focus, Input.insertText, valeur relue (verified)', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Adresse e-mail'}, value: 'julien@example.com'});
    assert.equal(res.data.method, 'cdp');
    assert.equal(res.data.focus, 'click');
    assert.equal(res.data.verified, true);
    assert.equal(res.data.trusted_input, true);
    assert.equal(res.data.typing, 'insertText');
    assert.equal(dom.byId('email').value, 'julien@example.com');
    assert.deepEqual(h.keyboard(), [{method: 'Input.insertText', text: 'julien@example.com'}]);
    const methods = h.calls.map(c => c.method);
    assert.ok(methods.indexOf('Emulation.setFocusEmulationEnabled') < methods.indexOf('Input.insertText'));
    assert.equal(dom.synthetic.filter(s => s.type === 'input').length, 0);  // aucun événement synthétique
    assert.deepEqual(h.focusCalls, {tabs: 0, windows: 0});
});

test('fill remplace : Ctrl+A réel (code KeyA, VK 65, modificateur Control, commande selectAll) puis texte', async () => {
    const {h, dom} = richHarness(formPage);
    dom.byId('city')._value = 'Ancienne ville';
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Ville'}, value: 'Lyon'});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.selection, 'ctrl+a');
    assert.equal(dom.byId('city').value, 'Lyon');
    const keys = h.keyboard();
    assert.deepEqual(keys[0], {method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', modifiers: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17});
    assert.deepEqual(keys[1], {method: 'Input.dispatchKeyEvent', type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, commands: ['selectAll']});
    assert.equal(keys.at(-1).method, 'Input.insertText');
    // type ajoute au lieu de remplacer
    const appended = await h.run('type', {tabId: 1, locator: {label: 'Ville'}, value: ' 3e'});
    assert.equal(appended.data.verified, true);
    assert.equal(dom.byId('city').value, 'Lyon 3e');
});

test('contenteditable : Ctrl+A puis texte, contenu relu', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Éditeur riche'}, value: 'Nouveau texte'});
    assert.equal(res.data.kind, 'contenteditable');
    assert.equal(res.data.verified, true);
    assert.equal(res.data.value, 'Nouveau texte');
    assert.equal(dom.byId('editor').textContent, 'Nouveau texte');
});

test('per_key et keys : keyDown/keyUp avec key, code, VK et texte, Shift pour les majuscules, Entrée finale', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('fill', {tabId: 1, locator: {placeholder: 'Rechercher'}, value: 'Ab1', perKey: true, keys: ['Enter']});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.typing, 'keys');
    assert.deepEqual(plain(res.data.keys), ['Enter']);
    assert.equal(dom.byId('search').value, 'Ab1');
    const downs = h.keyboard().filter(k => k.type === 'keyDown');
    assert.deepEqual(downs.map(k => [k.key, k.code, k.windowsVirtualKeyCode, k.modifiers, k.text]), [
        ['A', 'KeyA', 65, 8, 'A'], ['b', 'KeyB', 66, 0, 'b'], ['1', 'Digit1', 49, 0, '1'], ['Enter', 'Enter', 13, 0, '\r']
    ]);
    assert.equal(h.keyboard().filter(k => k.type === 'keyUp').length, 4);
});

test('press_key : raccourci Control+Shift+K, modificateurs enfoncés puis relâchés dans l\'ordre inverse', async () => {
    const {h} = richHarness(formPage);
    const res = await h.run('press_key', {tabId: 1, key: 'ctrl+shift+k'});
    assert.equal(res.data.success, true);
    assert.deepEqual(h.keyboard().map(k => [k.type, k.key, k.modifiers]), [
        ['rawKeyDown', 'Control', 2], ['rawKeyDown', 'Shift', 10], ['rawKeyDown', 'K', 10],
        ['keyUp', 'K', 10], ['keyUp', 'Shift', 2], ['keyUp', 'Control', 0]
    ]);
    assert.match((await h.run('press_key', {tabId: 1, key: 'Hyper+K'})).error, /Unknown modifier/);
    assert.match((await h.run('press_key', {tabId: 1, key: 'Foo'})).error, /Unknown key/);
});

test('champ qui ignore le clavier : repli setter natif signalé ; mode trusted : jamais de repli', async () => {
    const {h, dom} = richHarness(formPage);
    dom.byId('cp').__ignoreKeyboard = true;
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Code postal'}, value: '69001'});
    assert.equal(res.data.method, 'native_setter_fallback');
    assert.match(res.data.fallback_reason, /no effect/);
    assert.match(res.data.warning, /isTrusted=false/);
    assert.equal(res.data.verified, true);
    assert.equal(dom.byId('cp').value, '69001');
    dom.byId('cp')._value = '';
    const strict = await h.run('fill', {tabId: 1, locator: {label: 'Code postal'}, value: '75001', mode: 'trusted'});
    assert.equal(strict.data.method, 'cdp');
    assert.equal(strict.data.verified, false);
    assert.match(strict.data.warning, /differs/);
    assert.equal(dom.byId('cp').value, '');
});

test('saisie sans débogueur : repli JavaScript signalé ; champ non éditable refusé', async () => {
    const dom = richDom(formPage);
    const h = harness(dom.page, {attachError: 'Cannot attach to this target.'});
    const res = await h.run('fill', {tabId: 1, selector: '#city', value: 'Paris'});
    assert.equal(res.data.method, 'js_fallback');
    assert.equal(res.data.trusted_input, false);
    assert.equal(dom.byId('city').value, 'Paris');
    const {h: h2} = richHarness(formPage);
    assert.match((await h2.run('fill', {tabId: 1, locator: {role: 'heading'}, value: 'x'})).error, /is not an input field/);
});

test('semantic_fill : libellé puis placeholder, strict, frappe de confiance', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('semantic_fill', {tabId: 1, label: 'Adresse e-mail', value: 'a@b.c'});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.method, 'cdp');
    assert.equal(dom.byId('email').value, 'a@b.c');
    const byPlaceholder = await h.run('semantic_fill', {tabId: 1, label: 'Rechercher un produit', value: 'souris'});
    assert.equal(byPlaceholder.data.verified, true);
    assert.equal(dom.byId('search').value, 'souris');
});

test('check par vrai clic seulement si l\'état diffère, puis relu ; select_option par libellé', async () => {
    const {h, dom} = richHarness(formPage);
    const res = await h.run('check', {tabId: 1, locator: {role: 'checkbox', name: "J'accepte"}});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.changed, true);
    assert.equal(res.data.trusted_click, true);
    assert.equal(dom.byId('accept').checked, true);
    const before = h.mouse().length;
    const again = await h.run('check', {tabId: 1, locator: {role: 'checkbox', name: "J'accepte"}});
    assert.equal(again.data.changed, false);
    assert.equal(h.mouse().length, before);  // aucun clic
    const off = await h.run('uncheck', {tabId: 1, locator: {label: "J'accepte"}});
    assert.equal(off.data.checked, false);
    const sel = await h.run('select_option', {tabId: 1, locator: {label: 'Formule'}, value: 'pro'});
    assert.equal(sel.data.selectedValue, 'pro');
    assert.equal(dom.byId('plan').value, 'pro');
    assert.match((await h.run('select_option', {tabId: 1, locator: {label: 'Formule'}, text: 'Inconnue'})).error, /No option/);
});

test('field_state relit un champ sans aucun geste (browser_fill_form) : texte, option finale, case, champ sensible', async () => {
    const {h, dom} = richHarness((h) => [...formPage(h), h('input', {id: 'pw', type: 'password', 'aria-label': 'Mot de passe'})]);
    dom.byId('email').value = 'a@b.c';
    const before = h.mouse().length;
    const text = await h.run('field_state', {tabId: 1, locator: {label: 'Adresse e-mail'}, expect: {value: 'a@b.c'}});
    assert.equal(text.data.verified, true);
    assert.equal((await h.run('field_state', {tabId: 1, locator: {label: 'Adresse e-mail'}, expect: {value: 'x'}})).data.verified, false);
    // Option demandée « Pro » puis remise sur « Découverte » par la page : la relecture voit l'option FINALE.
    await h.run('select_option', {tabId: 1, locator: {label: 'Formule'}, text: 'Pro'});
    assert.equal((await h.run('field_state', {tabId: 1, locator: {label: 'Formule'}, expect: {option: 'Pro'}})).data.verified, true);
    dom.byId('plan').value = 'free';
    const reset = await h.run('field_state', {tabId: 1, locator: {label: 'Formule'}, expect: {option: 'Pro'}});
    assert.equal(reset.data.verified, false);
    assert.equal(reset.data.selectedValue, 'free');
    const box = await h.run('field_state', {tabId: 1, locator: {label: "J'accepte"}, expect: {checked: false}});
    assert.equal(box.data.verified, true);
    assert.equal(box.data.checked, false);
    assert.equal(box.data.type, 'checkbox');  // état commun (type, sensible, désactivé…), comme les autres relectures
    assert.equal(box.data.sensitive, false);
    dom.byId('pw').value = 'Secret!1';
    const secret = await h.run('field_state', {tabId: 1, locator: {label: 'Mot de passe'}, expect: {value: 'Secret!1'}});
    assert.equal(secret.data.verified, true);
    assert.notEqual(secret.data.value, 'Secret!1');  // jamais la valeur d'un champ sensible
    assert.match((await h.run('field_state', {tabId: 1, locator: {label: 'Formule'}, expect: {}})).error, /exactly one key/);
    assert.match((await h.run('field_state', {tabId: 1, expect: {value: 'x'}})).error, /Missing locator/);
    assert.equal(h.mouse().length, before);  // aucune souris pour lire (l'option posée avant passe par la page)
    assert.equal(dom.byId('accept').checked, false);
});

test("field_state : liste multiple = l'option voulue SEULE sélectionnée ; champ retiré de la page = erreur", async () => {
    const {h, dom} = richHarness((h) => [
        h('label', {for: 'plans'}, 'Formules'),
        h('select', {id: 'plans', multiple: ''}, h('option', {value: 'free'}, 'Découverte'), h('option', {value: 'pro'}, 'Pro')),
        h('label', {for: 'ville'}, 'Ville'), h('input', {id: 'ville'})
    ]);
    await h.run('select_option', {tabId: 1, locator: {label: 'Formules'}, text: 'Découverte'});
    const alone = await h.run('field_state', {tabId: 1, locator: {label: 'Formules'}, expect: {option: 'Découverte'}});
    assert.equal(alone.data.verified, true);
    dom.byId('plans').options[1].selected = true;  // la page ajoute Pro : il partirait avec le formulaire
    const extra = await h.run('field_state', {tabId: 1, locator: {label: 'Formules'}, expect: {option: 'Découverte'}});
    assert.equal(extra.data.verified, false);
    dom.byId('ville').value = 'Lyon';
    dom.byId('ville').isConnected = false;  // nœud remplacé par la page (un mark garde l'ancien)
    const gone = await h.run('field_state', {tabId: 1, locator: {label: 'Ville'}, expect: {value: 'Lyon'}});
    assert.match(gone.error, /removed or replaced/);
});

test("field_state et select_option : aucune représentation de la valeur d'un champ sensible ne sort (texte, option)", async () => {
    const {h, dom} = richHarness((h) => [
        h('label', {for: 'exp'}, "Mois d'expiration"),
        h('select', {id: 'exp', autocomplete: 'cc-exp-month'}, h('option', {value: '07'}, 'Juillet'), h('option', {value: '08'}, 'Août')),
        h('div', {id: 'pass', contenteditable: 'true', autocomplete: 'current-password', 'aria-label': 'Code'}, 'OnlyInPage-Secret!3')
    ]);
    const chosen = await h.run('select_option', {tabId: 1, locator: {label: "Mois d'expiration"}, text: 'Août'});
    dom.byId('exp').value = '07';  // la page remet Juillet
    const read = await h.run('field_state', {tabId: 1, locator: {label: "Mois d'expiration"}, expect: {option: 'Août'}});
    const box = await h.run('field_state', {tabId: 1, locator: {label: 'Code'}, expect: {value: 'autre'}});
    assert.equal(read.data.sensitive, true);
    assert.equal(read.data.verified, false);
    assert.equal(box.data.sensitive, true);
    for (const out of [chosen, read, box]) {
        const text = JSON.stringify(out);
        for (const secret of ['Juillet', 'Août', '"07"', '"08"', 'OnlyInPage-Secret!3']) assert.ok(!text.includes(secret), `${secret} dans ${text}`);
    }
});

// -----------------------------------------------------------------------------
// 3. Iframes d'une autre origine : sessions enfants (OOPIF) et mondes isolés (même processus)
// -----------------------------------------------------------------------------
function crossOriginHarness({oopif = false, coverFrame = false, sameOriginDocument = false} = {}) {
    const frame = richDom((h) => [h('button', {id: 'act'}, 'Action cadre'), h('label', {for: 'f'}, 'Saisie cadre'), h('input', {id: 'f'})]);
    const top = richDom((h) => [h('button', {id: 'top-btn'}, 'Action cadre'), h('iframe', {id: 'frame'})]);
    const iframe = top.byId('frame');
    // Le <iframe> occupe une zone de 400 x 300 en (100, 200), bordure 2/3 px ; son document est inaccessible au script.
    iframe.rect = {x: 100, y: 200, width: 400, height: 300};
    iframe.clientLeft = 2;
    iframe.clientTop = 3;
    iframe.frameOrigin = {x: 102, y: 203};
    iframe.__routeDoc = frame.doc;
    if (sameOriginDocument) {
        iframe.contentDocument = frame.doc;
        frame.win.frameElement = iframe;
    }
    const owner = top.doc.elementFromPoint;
    top.doc.elementFromPoint = (x, y) => (x >= 100 && x <= 500 && y >= 200 && y <= 500) ? (coverFrame ? {tagName: 'DIV', id: 'cover', parentNode: null} : iframe) : owner(x, y);
    const SESSION = 'child-1';
    const calls = [];
    let ref = null;
    const objects = new Map();
    const frameTree = oopif
        ? {frame: {id: 'MAIN', url: 'http://127.0.0.1:1/', securityOrigin: 'http://127.0.0.1:1', loaderId: 'L1'}, childFrames: []}
        : {frame: {id: 'MAIN', url: 'http://127.0.0.1:1/', securityOrigin: 'http://127.0.0.1:1', loaderId: 'L1'},
            childFrames: [{frame: {id: 'F1', parentId: 'MAIN', url: 'http://127.0.0.1:2/frame', securityOrigin: 'http://127.0.0.1:2', loaderId: 'L2'}}]};
    const h = harness(top.page, {
        debuggerSendCommand: (target, method, params) => {
            calls.push({session: target.sessionId || null, method, params});
            if (method === 'Page.getFrameTree') {
                if (target.sessionId === SESSION) return {frameTree: {frame: {id: 'F1', url: 'http://localhost:2/frame', securityOrigin: 'http://localhost:2', loaderId: 'L3'}}};
                return {frameTree};
            }
            // Monde isolé du cadre d'une autre origine (77) ; celui du cadre principal MAIN est servi par le harnais.
            if (method === 'Page.createIsolatedWorld' && params.frameId === 'F1') return {executionContextId: 77};
            if (method === 'Page.createIsolatedWorld') { assert.equal(params.frameId, 'MAIN'); return undefined; }
            if (method === 'Runtime.evaluate' && params.contextId === 77) {
                const value = vm.runInNewContext(params.expression, frame.page);
                return {result: {value}};
            }
            if (method === 'DOM.getFrameOwner') {
                assert.equal(target.sessionId, undefined);  // le <iframe> propriétaire est dans la page principale
                return {backendNodeId: 5};
            }
            if (method === 'DOM.resolveNode' && params.backendNodeId === 5) { objects.set('owner', iframe); return {object: {objectId: 'owner'}}; }
            if (method === 'Runtime.callFunctionOn' && params.objectId === 'owner') {
                const value = vm.runInNewContext(`(${params.functionDeclaration}).apply(el, args)`, {...top.page, el: iframe, args: (params.arguments || []).map(a => a.value)});
                return {result: {value}};
            }
        }
    });
    ref = h;
    const attach = async () => {
        await h.run('evaluate', {tabId: 1, code: '1'});
        if (oopif) await h.emit(1, 'Target.attachedToTarget', {sessionId: SESSION, targetInfo: {targetId: 'F1', type: 'iframe', url: 'http://localhost:2/frame'}});
    };
    return {h, top, frame, calls, attach, iframe, ref};
}

test('auto-attachement des iframes hors processus : Target.setAutoAttach flatten à l\'attachement', async () => {
    const {h, calls, attach} = crossOriginHarness({oopif: true});
    await attach();
    const auto = calls.find(c => c.method === 'Target.setAutoAttach' && !c.session);
    assert.deepEqual(plain(auto.params), {autoAttach: true, waitForDebuggerOnStart: false, flatten: true});
    // La session enfant est préparée à son tour (réseau, cadres plus profonds).
    const child = calls.filter(c => c.session === 'child-1').map(c => c.method);
    assert.ok(child.includes('Network.enable') && child.includes('Target.setAutoAttach'));
    assert.ok(h);
});

for (const oopif of [false, true]) {
    test(`clic dans une iframe d'une autre origine (${oopif ? 'hors processus' : 'même processus'}) : point ramené au viewport principal`, async () => {
        const {h, frame, calls, attach} = crossOriginHarness({oopif});
        await attach();
        const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Action cadre', nth: 1}});
        assert.equal(res.data.crossOriginFrame, true);
        assert.match(res.data.frame, oopif ? /localhost:2 \(out-of-process iframe\)/ : /127\.0\.0\.1:2 \(cross-origin iframe\)/);
        // Centre local du bouton (60, 20) + origine du contenu du cadre (100 + 2, 200 + 3).
        assert.deepEqual(plain(res.data.coordinates), {x: 162, y: 223});
        assert.equal(res.data.trusted_click, true);
        assert.deepEqual(frame.trusted.filter(t => t.type === 'click').map(t => t.el.id), ['act']);
        // Vraies entrées envoyées à la page principale, script de page dans le monde isolé du cadre.
        assert.ok(calls.filter(c => c.method === 'Input.dispatchMouseEvent').every(c => c.session === null));
        const evals = calls.filter(c => c.method === 'Runtime.evaluate' && c.params.contextId === 77);
        assert.ok(evals.length > 0 && evals.every(c => c.session === (oopif ? 'child-1' : null)));
        // Émulation du focus : page principale, et session de l'iframe hors processus où l'on agit.
        const focus = calls.filter(c => c.method === 'Emulation.setFocusEmulationEnabled').map(c => c.session);
        assert.deepEqual(focus, oopif ? ['child-1', null] : [null]);
        assert.deepEqual(h.focusCalls, {tabs: 0, windows: 0});
    });
}

test('localisateur ambigu entre cadres : candidats listés avec leur cadre', async () => {
    const {h, attach} = crossOriginHarness();
    await attach();
    const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Action cadre'}});
    assert.match(res.error, /2 elements/);
    assert.match(res.error, /frame top/);
    assert.match(res.error, /frame http:\/\/127\.0\.0\.1:2/);
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Action cadre'}});
    assert.deepEqual(plain(found.data.candidates.map(c => c.frame)), ['top', "http://127.0.0.1:2 (cross-origin iframe)"]);
    // Boîte du candidat du cadre dans le repère du viewport principal.
    assert.deepEqual(plain(found.data.candidates[1].box), {x: 112, y: 213, width: 100, height: 20});
});

test('saisie de confiance dans une iframe d\'une autre origine', async () => {
    const {h, frame, attach} = crossOriginHarness({oopif: true});
    await attach();
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Saisie cadre'}, value: 'Bonjour'});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.crossOriginFrame, true);
    assert.equal(frame.byId('f').value, 'Bonjour');
});

test('iframe d\'une autre origine couverte dans la page : erreur, aucune action', async () => {
    const {h, frame, attach} = crossOriginHarness({coverFrame: true});
    await attach();
    const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Action cadre', nth: 1}, timeoutMs: 0});
    assert.match(res.error, /covered by <div#cover>/);
    assert.equal(h.mouse().length, 0);
    assert.equal(frame.trusted.length, 0);
});

test('lecture : content et interactive_map indiquent le cadre ; marqueur d\'un cadre cliquable', async () => {
    const {h, frame, attach} = crossOriginHarness();
    await attach();
    const content = await h.run('content', {tabId: 1, mode: 'text'});
    assert.match(content.data, /--- frame http:\/\/127\.0\.0\.1:2 \(cross-origin iframe\) ---/);
    const map = await h.run('interactive_map', {tabId: 1, viewportOnly: false});
    const framed = map.data.elements.filter(e => e.crossOriginFrame);
    assert.ok(framed.length >= 2);
    const target = framed.find(e => e.label === 'Action cadre');
    assert.equal(target.rect.x, 112);
    const click = await h.run('click', {tabId: 1, mark: target.mark});
    assert.equal(click.data.crossOriginFrame, true);
    assert.deepEqual(frame.trusted.filter(t => t.type === 'click').map(t => t.el.id), ['act']);
});

test("interactive_map numérote les éditeurs riches sans leur contenu ; field_state refuse le mark d'un libellé", async () => {
    const {h, dom} = richHarness((h) => [
        h('label', {id: 'lab', for: 'city', tabindex: '0'}, 'Ville'), h('input', {id: 'city'}),
        h('div', {id: 'body', contenteditable: 'true', 'aria-label': 'Message'}, 'Texte secret du message'),
        h('div', {id: 'note', contenteditable: 'plaintext-only', 'aria-label': 'Note'}, 'Note secrète'),
        h('label', {id: 'orphan', tabindex: '0'}, 'Sans champ')
    ]);
    const map = await h.run('interactive_map', {tabId: 1, viewportOnly: false});
    const editor = map.data.elements.find(e => e.label === 'Message');
    assert.ok(editor, JSON.stringify(map.data.elements));
    assert.ok(!JSON.stringify(map.data).includes('Texte secret'));  // le contenu saisi n'est jamais un libellé
    const label = map.data.elements.find(e => e.label === 'Ville' && /label/.test(e.selector || e.tag || ''));
    const field = map.data.elements.find(e => /#city/.test(e.selector || ''));
    dom.byId('city').value = 'Lyon';
    const direct = await h.run('field_state', {tabId: 1, mark: field.mark, expect: {value: 'Lyon'}});
    assert.equal(direct.data.verified, true);
    const viaLabel = await h.run('field_state', {tabId: 1, mark: label.mark, expect: {value: 'Lyon'}});
    assert.match(viaLabel.error, /label or a container/);
    const rich = await h.run('field_state', {tabId: 1, mark: editor.mark, expect: {value: 'Texte secret du message'}});
    assert.equal(rich.data.verified, true);
    const plain = map.data.elements.find(e => e.label === 'Note');  // contenteditable="plaintext-only" aussi
    assert.ok(plain && !JSON.stringify(map.data).includes('Note secrète'));
    // Libellé sans champ : il lirait "" et confirmerait un effacement ; refusé.
    const orphan = map.data.elements.find(e => e.label === 'Sans champ');
    const empty = await h.run('field_state', {tabId: 1, mark: orphan.mark, expect: {value: ''}});
    assert.match(empty.error, /not an input field/);
});

test('iframe srcdoc same-origin annoncée avec une origine étrange : parcourue une seule fois', async () => {
    const {h, calls, attach} = crossOriginHarness({sameOriginDocument: true});
    await attach();
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Action cadre'}});
    // contentDocument lisible depuis le parent : le cadre est parcouru par le script de la page, pas en double.
    assert.equal(found.data.count, 2);
    assert.deepEqual(plain(found.data.candidates.map(c => c.frame)), ['top', 'iframe#frame']);
    assert.ok(calls.some(c => c.method === 'Runtime.callFunctionOn' && /contentDocument/.test(c.params.functionDeclaration)));
    // Aucun monde isolé pour le cadre (déjà parcouru par sa page) ; seul celui du cadre principal existe.
    assert.equal(calls.filter(c => c.method === 'Page.createIsolatedWorld' && c.params.frameId !== 'MAIN').length, 0);
});

// -----------------------------------------------------------------------------
// 4. Réseau et téléchargements
// -----------------------------------------------------------------------------
async function networkHarness() {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    const request = (id, url, extra = {}) => h.emit(1, 'Network.requestWillBeSent', {
        requestId: id, timestamp: 10, wallTime: 1760000000, type: extra.type || 'Fetch', frameId: 'MAIN',
        request: {url, method: extra.method || 'GET', headers: {Authorization: 'Bearer secret-token', Cookie: 'sid=secret-cookie', 'X-Test': 'visible'}},
        ...(extra.redirectResponse ? {redirectResponse: extra.redirectResponse} : {})
    });
    const response = (id, status, mimeType = 'application/json', extra = {}) => h.emit(1, 'Network.responseReceived', {
        requestId: id, type: extra.type || 'Fetch', response: {status, statusText: 'OK', mimeType, headers: {'Set-Cookie': 'sid=secret-cookie', 'Content-Type': mimeType}}
    });
    const finished = (id, size = 120) => h.emit(1, 'Network.loadingFinished', {requestId: id, timestamp: 10.25, encodedDataLength: size});
    return {h, request, response, finished};
}

test('réseau : requêtes enregistrées (statut, type, taille, durée, échec), secrets masqués', async () => {
    const {h, request, response, finished} = await networkHarness();
    await request('r1', 'https://api.example.invalid/data?x=1');
    await response('r1', 200);
    await finished('r1', 321);
    await request('r2', 'https://api.example.invalid/missing', {method: 'POST'});
    await response('r2', 404);
    await finished('r2', 12);
    await request('r3', 'https://cdn.example.invalid/app.js', {type: 'Script'});
    await h.emit(1, 'Network.loadingFailed', {requestId: 'r3', timestamp: 10.5, errorText: 'net::ERR_BLOCKED_BY_CLIENT', type: 'Script'});
    const all = await h.run('network_requests', {tabId: 1});
    assert.equal(all.data.count, 3);
    const [r1, r2, r3] = all.data.requests;
    assert.deepEqual([r1.status, r1.type, r1.size, r1.duration_ms, r1.method, r1.state], [200, 'Fetch', 321, 250, 'GET', 'finished']);
    assert.equal(r1.requestHeaders, undefined);  // en-têtes seulement sur demande
    assert.deepEqual([r2.status, r2.method], [404, 'POST']);
    assert.deepEqual([r3.failed, r3.errorText, r3.state], [true, 'net::ERR_BLOCKED_BY_CLIENT', 'failed']);
    const withHeaders = await h.run('network_requests', {tabId: 1, filter: '/data', includeHeaders: true});
    const raw = JSON.stringify(withHeaders);
    assert.equal(withHeaders.data.count, 1);
    assert.match(withHeaders.data.requests[0].requestHeaders.Authorization, /^\[masked, 19 chars\]$/);
    assert.match(withHeaders.data.requests[0].requestHeaders.Cookie, /^\[masked/);
    assert.match(withHeaders.data.requests[0].responseHeaders['Set-Cookie'], /^\[masked/);
    assert.equal(withHeaders.data.requests[0].requestHeaders['X-Test'], 'visible');
    assert.ok(!raw.includes('secret-token') && !raw.includes('secret-cookie'));
    assert.equal((await h.run('network_requests', {tabId: 1, status: '4xx'})).data.requests[0].request_id, 'r2');
    assert.equal((await h.run('network_requests', {tabId: 1, method: 'post'})).data.count, 1);
    assert.equal((await h.run('network_requests', {tabId: 1, resourceType: 'script'})).data.count, 1);
    assert.equal((await h.run('network_requests', {tabId: 1, failedOnly: true})).data.count, 2);
    assert.equal((await h.run('network_requests', {tabId: 1, filter: '/\\/data\\?x=\\d/'})).data.count, 1);
    assert.equal((await h.run('network_requests', {tabId: 1, limit: 1})).data.requests[0].request_id, 'r3');
});

test('réseau : tampon circulaire de 500 requêtes par onglet, redirections suivies', async () => {
    const {h, request, response} = await networkHarness();
    for (let i = 0; i < 510; i++) await request(`q${i}`, `https://example.invalid/${i}`);
    const res = await h.run('network_requests', {tabId: 1, limit: 500});
    assert.equal(res.data.buffered, 500);
    assert.equal(res.data.requests[0].url, 'https://example.invalid/10');
    await request('red', 'https://example.invalid/old');
    await request('red', 'https://example.invalid/new', {redirectResponse: {status: 301, statusText: 'Moved', headers: {}, mimeType: 'text/html'}});
    await response('red', 200, 'text/html');
    const both = (await h.run('network_requests', {tabId: 1, filter: '/(old|new)$/'})).data.requests;
    assert.deepEqual(plain(both.map(r => [r.url, r.status, r.state])), [
        ['https://example.invalid/old', 301, 'redirected'], ['https://example.invalid/new', 200, 'pending']
    ]);
    assert.equal(both[1].redirectedFrom, 'https://example.invalid/old');
});

test('réseau : corps de réponse tronqué, binaire signalé, base64 textuel décodé, session de l\'iframe', async () => {
    const bodies = {
        json: {body: '{"message":"' + 'x'.repeat(400) + '"}', base64Encoded: false},
        png: {body: 'iVBORw0KGgoAAAANSUhEUg==', base64Encoded: true},
        b64text: {body: Buffer.from('Bonjour éàü').toString('base64'), base64Encoded: true}
    };
    const seen = [];
    const h = harness({}, {
        debuggerSendCommand: (target, method, params) => {
            if (method === 'Network.getResponseBody') { seen.push(target.sessionId || null); return bodies[params.requestId]; }
        }
    });
    await h.run('evaluate', {tabId: 1, code: '1'});
    const add = async (id, mime, sessionId) => {
        const source = sessionId ? {tabId: 1, sessionId} : {tabId: 1};
        await h.emitFrom(source, 'Network.requestWillBeSent', {requestId: id, timestamp: 1, request: {url: `https://x.invalid/${id}`, method: 'GET', headers: {}}});
        await h.emitFrom(source, 'Network.responseReceived', {requestId: id, response: {status: 200, mimeType: mime, headers: {}}});
        await h.emitFrom(source, 'Network.loadingFinished', {requestId: id, timestamp: 2, encodedDataLength: 10});
    };
    await add('json', 'application/json');
    await add('png', 'image/png');
    await add('b64text', 'text/plain', 'child-9');
    const json = await h.run('network_response', {tabId: 1, request_id: 'json', maxBytes: 256});
    assert.equal(json.data.truncated, true);
    assert.equal(json.data.body.length, 256);
    assert.equal(json.data.binary, false);
    const png = await h.run('network_response', {tabId: 1, request_id: 'png'});
    assert.equal(png.data.binary, true);
    assert.equal(png.data.body, null);
    assert.equal(png.data.size, 16);
    const pngB64 = await h.run('network_response', {tabId: 1, request_id: 'png', includeBinary: true});
    assert.equal(pngB64.data.body, bodies.png.body);
    const list = await h.run('network_requests', {tabId: 1, filter: 'b64text'});
    assert.equal(list.data.requests[0].frame, 'out-of-process iframe');
    const text = await h.run('network_response', {tabId: 1, request_id: list.data.requests[0].request_id});
    assert.equal(text.data.body, 'Bonjour éàü');
    assert.deepEqual(seen, [null, null, null, 'child-9']);
    assert.match((await h.run('network_response', {tabId: 1, request_id: 'inconnu'})).error, /not in the network log/);
});

test('réseau : corps refusé clairement après détachement du débogueur', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'old', timestamp: 1, request: {url: 'https://x.invalid/', method: 'GET', headers: {}}});
    await h.emit(1, 'Network.loadingFinished', {requestId: 'old', timestamp: 2, encodedDataLength: 1});
    await h.fireIdleTimers();
    const res = await h.run('network_response', {tabId: 1, request_id: 'old'});
    assert.match(res.error, /detached then reattached/);
    // L'historique reste lisible.
    assert.equal((await h.run('network_requests', {tabId: 1})).data.count, 1);
});

function downloadsMock(sequence) {
    let call = 0;
    const erased = [];
    return {
        erased,
        api: {
            search: async () => sequence[Math.min(call++, sequence.length - 1)],
            erase: async ({id}) => { erased.push(id); return [id]; }
        }
    };
}

test('wait_download : attend la fin du téléchargement venu de l\'onglet et renvoie le chemin', async () => {
    const now = new Date().toISOString();
    const item = {id: 7, url: 'http://127.0.0.1:5/download/f.txt', referrer: 'http://127.0.0.1:5/full', filename: 'C:\\Users\\x\\Downloads\\f.txt', mime: 'text/plain', startTime: now, danger: 'safe', totalBytes: 12, bytesReceived: 12, fileSize: 12};
    const other = {...item, id: 8, url: 'https://autre.invalid/x.zip', referrer: 'https://autre.invalid/', filename: 'C:\\x.zip', state: 'complete'};
    const dl = downloadsMock([[other], [other, {...item, state: 'in_progress', bytesReceived: 3}], [other, {...item, state: 'complete'}]]);
    const h = harness({}, {virtualTime: true, downloads: dl.api, tabs: {get: async (id) => ({id, url: 'http://127.0.0.1:5/full', windowId: 10})}});
    await h.run('click', {tabId: 1, selector: 'button'});
    const res = await h.run('wait_download', {tabId: 1, timeoutMs: 3000});
    assert.equal(res.data.path, item.filename);
    assert.equal(res.data.bytes, 12);
    assert.equal(res.data.state, 'complete');
    await h.run('download_erase', {id: 7});
    assert.deepEqual(dl.erased, [7]);
});

test('wait_download : interruption, danger et délai rapportés clairement', async () => {
    const now = new Date().toISOString();
    const base = {id: 3, url: 'http://127.0.0.1:5/f.exe', referrer: 'http://127.0.0.1:5/', filename: 'C:\\f.exe', startTime: now, totalBytes: 10, bytesReceived: 0};
    const tabs = {get: async (id) => ({id, url: 'http://127.0.0.1:5/', windowId: 10})};
    let h = harness({}, {tabs, virtualTime: true, downloads: downloadsMock([[{...base, state: 'interrupted', error: 'NETWORK_FAILED'}]]).api});
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 500})).error, /interrupted \(NETWORK_FAILED\)/);
    h = harness({}, {tabs, virtualTime: true, downloads: downloadsMock([[{...base, state: 'in_progress', danger: 'dangerousFile'}]]).api});
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 300})).error, /dangerousFile.*never accepted/);
    h = harness({}, {tabs, virtualTime: true, downloads: downloadsMock([[]]).api});
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 300})).error, /No download from http:\/\/127\.0\.0\.1:5/);
});


// -----------------------------------------------------------------------------
// Pont local authentifié (bridge_link.js) : l'extension n'exécute rien d'un serveur qui ne prouve pas le jeton.
// Serveur et hôte natif simulés avec node:crypto, même protocole que native-host/bridge_auth.py.
// -----------------------------------------------------------------------------
const nodeCrypto = require('node:crypto');
const BRIDGE_PROTOCOL = 'nexus-browser/1';
const TEST_TOKEN = 'jeton-de-test-'.padEnd(64, 'x');
const EXT_ID = 'blcgddmjdkobmgakjffjpgiicjlflgjf';
const hmacRaw = (key, ...parts) => nodeCrypto.createHmac('sha256', key).update([BRIDGE_PROTOCOL, ...parts].join('\n')).digest();
const hmac64 = (key, ...parts) => hmacRaw(key, ...parts).toString('base64url');
const testNonce = () => nodeCrypto.randomBytes(32).toString('base64url');

function controlledSockets() {
    const instances = [];
    class ControlledWebSocket {
        constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.closeCode = null; instances.push(this); }
        send(data) { if (this.readyState !== 1) throw new Error('socket fermée'); this.sent.push(JSON.parse(data)); }
        close(code) {
            if (this.readyState === 3) return;
            this.readyState = 3;
            this.closeCode = code ?? 1000;
            if (this.onclose) this.onclose({code: this.closeCode});
        }
        open() { this.readyState = 1; if (this.onopen) this.onopen(); }
        deliver(message) { if (this.onmessage) this.onmessage({data: typeof message === 'string' ? message : JSON.stringify(message)}); }
    }
    return {ControlledWebSocket, instances};
}

// Hôte natif simulé : même règle que auth_host.py (preuve du serveur vérifiée avant toute preuve du client).
function nativeHostMock(token = TEST_TOKEN) {
    const calls = [];
    return {
        calls,
        answer(msg) {
            calls.push(msg);
            const parts = [msg.client_nonce, msg.server_nonce, msg.role, msg.extension_id];
            if (msg.server_proof !== hmac64(token, 'server', ...parts)) return {ok: false, error: 'le serveur ne prouve pas qu\'il connaît le jeton'};
            return {ok: true, client_proof: hmac64(token, 'client', ...parts), session_key: hmacRaw(token, 'session', ...parts).toString('base64url')};
        },
        sendNativeMessage(name, msg, callback) { setImmediate(() => callback(this.answer(msg))); }
    };
}

// Serveur du port 9224 simulé : poignée de main puis messages signés (s2c), lecture des réponses signées (c2s).
function fakeServer(ws, {token = TEST_TOKEN} = {}) {
    const state = {seq: 0, sessionKey: null};
    return {
        challenge(serverToken = token) {
            const hello = ws.sent.find(m => m.type === 'auth_hello');
            state.serverNonce = testNonce();
            const parts = [hello.client_nonce, state.serverNonce, hello.role, hello.extension_id];
            state.sessionKey = hmacRaw(token, 'session', ...parts);
            state.expectedProof = hmac64(token, 'client', ...parts);
            ws.deliver({type: 'auth_challenge', server_nonce: state.serverNonce, server_proof: hmac64(serverToken, 'server', ...parts)});
        },
        proof: () => ws.sent.find(m => m.type === 'auth_proof'),
        expectedProof: () => state.expectedProof,
        frame(payload, seq = ++state.seq) {
            const body = JSON.stringify(payload);
            return {seq, body, mac: hmac64(state.sessionKey, 's2c', String(seq), body)};
        },
        send(payload) { const frame = this.frame(payload); ws.deliver(frame); return frame; },
        replies() {
            return ws.sent.filter(m => 'seq' in m).map(m => {
                assert.equal(m.mac, hmac64(state.sessionKey, 'c2s', String(m.seq), m.body), 'réponse mal signée');
                return JSON.parse(m.body);
            });
        }
    };
}

async function until(condition, what, ms = 3000) {
    const end = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > end) throw new Error(`attente dépassée : ${what}`);
        await new Promise(r => setTimeout(r, 2));
    }
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

function bridgeHarness({token} = {}) {
    const sockets = controlledSockets();
    const host = nativeHostMock(token);
    const h = harness({}, {
        WebSocket: sockets.ControlledWebSocket,
        runtime: {id: EXT_ID, sendNativeMessage: (name, msg, cb) => host.sendNativeMessage(name, msg, cb), lastError: undefined}
    });
    h.evalInContext('connectBridgeWS()');
    const ws = sockets.instances.at(-1);
    ws.open();
    const server = fakeServer(ws, {token});
    const evaluations = () => h.calls.filter(c => c.method === 'Runtime.evaluate').length;
    h.own(1);  // onglet 1 ouvert par le client de test : seules ses commandes signées par le pont y agissent
    // Fin de test : liaison fermée, aucune minuterie de reconnexion ni de keepalive laissée derrière.
    const stop = () => h.evalInContext('if (bridgeLink) bridgeLink.close(); clearTimeout(reconnectTimer); clearInterval(keepaliveInterval);');
    return {h, ws, host, server, evaluations, stop};
}

async function authenticated(bridge) {
    bridge.server.challenge();
    await until(() => bridge.server.proof(), 'preuve du client');
    bridge.server.send({type: 'auth_ok'});
    await until(() => bridge.server.replies().some(r => r.event === 'bridge_connected'), 'liaison prête');
}

test('pont : un serveur qui envoie une commande sans poignée de main n\'obtient rien et la liaison est fermée', async () => {
    const {h, ws, host, evaluations, stop} = bridgeHarness();
    try {
        const hello = ws.sent[0];
        assert.equal(hello.type, 'auth_hello');
        assert.equal(hello.role, 'service_worker');
        assert.equal(hello.extension_id, EXT_ID);
        assert.match(hello.client_nonce, /^[A-Za-z0-9_-]{43}$/);
        ws.deliver({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}, client: TEST_CLIENT});
        await until(() => ws.readyState === 3, 'fermeture');
        await settle();
        assert.equal(ws.closeCode, 1008);
        assert.equal(evaluations(), 0);
        assert.equal(host.calls.length, 0);
        assert.deepEqual(ws.sent.map(m => m.type), ['auth_hello']);  // ni preuve, ni réponse
        assert.equal((await h.sendMessage({target: 'background', getStatus: true})).connected, false);
    } finally { stop(); }
});

test('pont : preuve du serveur fausse -> aucune preuve du client, aucune commande exécutée', async () => {
    const {h, ws, host, server, evaluations, stop} = bridgeHarness();
    try {
        server.challenge('autre-jeton-'.padEnd(64, 'y'));
        await until(() => ws.readyState === 3, 'fermeture');
        assert.equal(host.calls.length, 1);
        assert.equal(server.proof(), undefined);
        // Liaison fermée : même un message signé avec la clé de session n'est plus lu.
        ws.deliver(server.frame({type: 'auth_ok'}));
        ws.deliver(server.frame({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1'}, client: TEST_CLIENT}));
        await settle();
        assert.equal(evaluations(), 0);
        const status = await h.sendMessage({target: 'background', getStatus: true});
        assert.equal(status.connected, false);
        assert.match(status.authError, /ne prouve pas/);
    } finally { stop(); }
});

const ATTACKS = ['before_auth_ok', 'unsigned', 'bad_mac', 'replay'];

test('pont : commande signée avant auth_ok, non signée, mal signée ou rejouée -> jamais exécutée', async () => {
    for (const attack of ATTACKS) {
        const {ws, server, evaluations, stop} = bridgeHarness();
        try {
            server.challenge();
            await until(() => server.proof(), 'preuve du client');
            assert.equal(server.proof().client_proof, server.expectedProof());
            const command = {requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}, client: TEST_CLIENT};
            if (attack === 'before_auth_ok') {
                ws.deliver(server.frame(command));
            } else {
                server.send({type: 'auth_ok'});
                if (attack === 'unsigned') ws.deliver(command);
                if (attack === 'bad_mac') ws.deliver({...server.frame(command), body: JSON.stringify({...command, params: {tabId: 1, code: '2'}})});
                if (attack === 'replay') {
                    const frame = server.send(command);
                    await until(() => server.replies().some(r => r.requestId === 'r1'), 'première réponse');
                    ws.deliver(frame);
                }
            }
            await until(() => ws.readyState === 3, `fermeture (${attack})`);
            await settle();
            assert.equal(evaluations(), attack === 'replay' ? 1 : 0, attack);
        } finally { stop(); }
    }
});

test('pont : serveur authentifié -> commande exécutée et réponse signée, liaison prête', async () => {
    const bridge = bridgeHarness();
    const {h, ws, server, evaluations, stop} = bridge;
    try {
        await authenticated(bridge);
        server.send({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}, client: TEST_CLIENT});
        await until(() => server.replies().some(r => r.requestId === 'r1'), 'réponse');
        const reply = server.replies().find(r => r.requestId === 'r1');
        assert.deepEqual(plain(reply), {requestId: 'r1', success: true, data: 2});
        assert.equal(evaluations(), 1);
        const status = await h.sendMessage({target: 'background', getStatus: true});
        assert.equal(status.connected, true);
        assert.equal(status.links.service_worker.state, 'ready');
        assert.equal(ws.readyState, 1);
    } finally { stop(); }
});

test("poste de contrôle : STOP pose l'arrêt dans Chrome puis l'annonce au pont (événement signé)", async () => {
    const bridge = bridgeHarness();
    const {h, server, evaluations, stop} = bridge;
    try {
        await authenticated(bridge);
        const res = await h.sendMessage({target: 'background', panelStop: true});
        assert.equal(res.sentToBridge, true);
        assert.ok(res.stoppedUntil > Date.now() + 100000);
        await until(() => server.replies().some(r => r.event === 'emergency_stop'), 'arrêt annoncé au pont');
        assert.equal(server.replies().find(r => r.event === 'emergency_stop').by, 'poste de contrôle');
        // Plus aucune action, même signée par le pont, tant que l'arrêt tient ; les lectures restent permises.
        server.send({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1'}, client: TEST_CLIENT});
        await until(() => server.replies().some(r => r.requestId === 'r1'), 'refus');
        assert.match(server.replies().find(r => r.requestId === 'r1').error, /Emergency stop/);
        assert.equal(evaluations(), 0);
        server.send({requestId: 'r2', action: 'list_tabs', params: {}, client: TEST_CLIENT});
        await until(() => server.replies().some(r => r.requestId === 'r2'), 'lecture');
        assert.equal(server.replies().find(r => r.requestId === 'r2').success, true);
    } finally { stop(); }
});

test("poste de contrôle : un script de contenu ne peut ni lire l'état, ni poser STOP, ni rendre un onglet, ni obtenir de preuve", async () => {
    const {h, host, evaluations, stop} = bridgeHarness();
    try {
        const fromPage = {id: EXT_ID, tab: {id: 1}};
        assert.equal(await h.sendMessage({target: 'background', executeAction: true, action: 'evaluate', params: {tabId: 1, code: '1'}}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', bridgeProve: {op: 'handshake'}}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', getControlState: true}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', panelStop: true}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', panelRelease: 1}, fromPage), undefined);
        assert.equal(h.evalInContext('stopActive()'), false);
        assert.equal(Object.keys(h.owners()).length, 1);  // l'onglet 1 est toujours piloté
        assert.equal(evaluations(), 0);
        assert.equal(host.calls.length, 0);
        assert.equal((await h.sendMessage({target: 'background', ping: true}, fromPage)).pong, true);  // seul permis
    } finally { stop(); }
});

test('document offscreen : serveur sans preuve -> rien relayé au service worker', async () => {
    const sockets = controlledSockets();
    const toBackground = [];
    let listener = null;
    const host = nativeHostMock();
    const chromeMock = {
        runtime: {
            id: EXT_ID,
            lastError: undefined,
            onMessage: {addListener(fn) { listener = fn; }},
            sendMessage(message, callback) {
                toBackground.push(message);
                if (message.bridgeProve) setImmediate(() => callback(host.answer(message.bridgeProve)));
                else setImmediate(() => callback({data: 'exécuté'}));
            }
        }
    };
    const ctx = vm.createContext({
        chrome: chromeMock, console, WebSocket: sockets.ControlledWebSocket, atob, btoa, TextEncoder, crypto: globalThis.crypto,
        // Minuteries jamais déclenchées : reconnexion et garde de 10 s n'ont pas à tourner dans ce test.
        setTimeout: () => ({}), clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}
    });
    for (const file of ['bridge_link.js', 'offscreen.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), ctx);
    const ws = sockets.instances.at(-1);
    ws.open();
    assert.equal(ws.sent[0].role, 'offscreen');
    ws.deliver({requestId: 'r1', action: 'evaluate', params: {code: '1'}});
    await until(() => ws.readyState === 3, 'fermeture');
    await settle();
    assert.equal(toBackground.filter(m => m.request).length, 0);
    // Serveur authentique : la commande signée est relayée au service worker et la réponse revient signée.
    vm.runInContext('connectWS()', ctx);
    const ws2 = sockets.instances.at(-1);
    ws2.open();
    const server = fakeServer(ws2);
    server.challenge();
    await until(() => server.proof(), 'preuve de l\'offscreen');
    assert.equal(toBackground.filter(m => m.bridgeProve).length, 1);
    server.send({type: 'auth_ok'});
    server.send({requestId: 'r2', action: 'ping', params: {}});
    await until(() => server.replies().some(r => r.requestId === 'r2'), 'réponse relayée');
    assert.deepEqual(plain(toBackground.filter(m => m.request).map(m => m.request.requestId)), ['r2']);
    assert.equal(server.replies().find(r => r.requestId === 'r2').data, 'exécuté');
    // Événement à signer pour le service worker (STOP du poste de contrôle) : seulement depuis une page de l'extension.
    let reply = null;
    listener({target: 'offscreen', bridgeEvent: {event: 'emergency_stop', by: 'poste de contrôle'}}, {id: EXT_ID}, (r) => { reply = r; });
    assert.deepEqual(plain(reply), {sent: true});
    reply = null;
    listener({target: 'offscreen', bridgeEvent: {event: 'emergency_stop'}}, {id: EXT_ID, tab: {id: 3}}, (r) => { reply = r; });
    assert.equal(reply, null);
    vm.runInContext('if (link) link.close();', ctx);
});

// -----------------------------------------------------------------------------
// Poste de contrôle (panneau latéral) : mise en forme pure, cookies jamais avec leurs valeurs
// -----------------------------------------------------------------------------
function sidepanelView() {
    const ctx = vm.createContext({URL});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sidepanel_view.js'), 'utf8'), ctx);
    return ctx.AgySidepanelView;
}

test('cookies : valeurs jamais par défaut ; demandées sur un site réel : refus clair, rien lu dans Chrome', async () => {
    const jar = [{name: 'SID', value: 'secret-session-123', domain: '.example.invalid'}, {name: 'pref', value: 'v2', domain: 'example.invalid'}];
    const h = harness({}, {debuggerSendCommand: async (target, method) => method === 'Network.getCookies' ? {cookies: jar} : undefined});
    const res = await h.run('get_cookies', {tabId: 1});
    assert.equal(res.data.cookieCount, 2);
    assert.equal(res.data.valuesIncluded, false);
    assert.ok(!JSON.stringify(res).includes('secret-session-123') && !JSON.stringify(res).includes('v2'));
    assert.ok(res.data.cookies.every(c => !('value' in c)));
    const before = h.calls.length;
    for (const params of [{includeValues: true}, {include_values: true}, {includeValues: true, urls: ['http://localhost:8000/', 'https://example.invalid/']}]) {
        const refused = await h.run('get_cookies', {tabId: 1, ...params});
        assert.match(refused.error, /local development origin/, JSON.stringify(params));
        assert.ok(!JSON.stringify(refused).includes('secret-session-123'));
    }
    assert.equal(h.calls.length, before);  // refus avant tout appel à Chrome
});

test('champs du formulaire : libellé, type, requis et rempli, jamais la valeur saisie', async () => {
    const field = (props) => ({
        getBoundingClientRect: () => ({width: 100, height: 20}),
        getAttribute: (name) => (props.attrs || {})[name] ?? null,
        labels: props.label ? [{textContent: props.label}] : [],
        ...props
    });
    const fields = [
        field({tagName: 'INPUT', type: 'email', id: 'mail', value: 'julien@example.invalid', label: 'Adresse  e-mail', required: true, attrs: {name: 'email'}}),
        field({tagName: 'INPUT', type: 'password', value: 'MotDePasse!', attrs: {'aria-label': 'Mot de passe'}}),
        field({tagName: 'INPUT', type: 'hidden', value: 'csrf'}),
        field({tagName: 'TEXTAREA', type: 'textarea', value: '', attrs: {placeholder: 'Message'}})
    ];
    const h = harness({document: {querySelectorAll: (sel) => sel.startsWith('input') ? fields : [], getElementById: () => null}});
    const res = await h.run('form_fields', {tabId: 1});
    assert.equal(res.data.count, 3);
    assert.deepEqual(plain(res.data.fields.map(f => [f.label, f.type, f.filled, f.required])), [
        ['Adresse e-mail', 'email', true, true], ['Mot de passe', 'password', true, false], ['Message', 'textarea', false, false]
    ]);
    assert.ok(!JSON.stringify(res).includes('MotDePasse!') && !JSON.stringify(res).includes('julien@example.invalid'));
});

test('carte interactive : jamais la valeur d\'un champ comme libellé', async () => {
    const style = () => ({display: 'block', visibility: 'visible', opacity: '1'});
    const password = {tagName: 'INPUT', type: 'password', value: 'MotDePasse!', innerText: '', placeholder: '', getAttribute: () => null,
        getBoundingClientRect: () => ({x: 1, y: 1, width: 50, height: 20, top: 1, bottom: 21, left: 1, right: 51})};
    const h = harness({
        document: {querySelectorAll: (sel) => (sel === '*' || sel === 'iframe') ? [] : [password], title: 'T'},
        window: {innerWidth: 800, innerHeight: 600, getComputedStyle: style, location: {href: 'https://example.invalid'}},
        getComputedStyle: style
    });
    const res = await h.run('interactive_map', {tabId: 1});
    assert.equal(res.data.elements.length, 1);
    assert.ok(!JSON.stringify(res).includes('MotDePasse!'));
});

// -----------------------------------------------------------------------------
// Exports de contenu (export_kit.js) : article avec bruit, Google Docs/Sheets/Slides, transcription YouTube.
// -----------------------------------------------------------------------------
const ARTICLE_URL = 'https://blog.example.invalid/articles/pont-local';

function articlePage(h) {
    return [
        h('header', {class: 'site-header'},
            h('nav', {}, h('ul', {}, h('li', {}, h('a', {href: '/'}, 'Accueil')), h('li', {}, h('a', {href: '/blog'}, 'Menu principal du blog')), h('li', {}, h('a', {href: '/contact'}, 'Contact'))))),
        h('div', {class: 'cookie-banner'}, h('p', {}, 'Nous utilisons des cookies pour mesurer l\'audience, acceptez-les tous, vraiment tous.')),
        h('meta', {name: 'author', content: 'Julien Piron'}),
        h('meta', {property: 'article:published_time', content: '2026-10-16T09:00:00Z'}),
        h('meta', {property: 'og:site_name', content: 'Carnet Nexus'}),
        h('script', {}, 'window.tracker = "SCRIPT_SECRET";'),
        h('main', {},
            h('article', {id: 'main-article', class: 'post'},
                h('h1', {}, 'Un pont local authentifié'),
                h('p', {}, 'Le pont relie l\'agent à Chrome, avec une ', h('strong', {}, 'preuve HMAC'), ' dans les deux sens, et chaque message est signé, numéroté puis vérifié.'),
                h('div', {class: 'ad-slot'}, h('p', {}, 'Publicité : achetez nos montres connectées en promotion aujourd\'hui seulement, profitez-en.')),
                h('h2', {}, 'Étapes'),
                h('ol', {}, h('li', {}, 'Nonce de l\'extension'), h('li', {}, 'Preuve du pont'), h('li', {}, 'Preuve du client')),
                h('p', {}, 'La documentation complète se trouve sur ', h('a', {href: '/docs/pont'}, 'la page du pont'), ', avec des exemples, des schémas et des mesures réelles.'),
                h('table', {},
                    h('tr', {}, h('th', {}, 'Port'), h('th', {}, 'Rôle')),
                    h('tr', {}, h('td', {}, '9224'), h('td', {}, 'WebSocket | signé')),
                    h('tr', {}, h('td', {}, '9225'), h('td', {}, 'API REST'))),
                h('pre', {class: 'language-python'}, 'print("bonjour")\nprint("pont")'),
                h('form', {}, h('label', {}, 'Votre e-mail'), h('input', {type: 'email', value: 'julien@example.invalid'}), h('button', {}, 'S\'abonner')),
                h('p', {}, 'Conclusion : aucun programme local ne peut plus se faire passer pour le pont, ni rejouer une commande déjà signée.')
            )
        ),
        h('aside', {class: 'sidebar'}, h('h3', {}, 'À lire aussi'), h('p', {}, 'Abonnez-vous à la lettre d\'information pour ne rien manquer de nos nouveautés.')),
        h('footer', {}, h('p', {}, 'Mentions légales et plan du site, tous droits réservés, copyright 2026.'))
    ];
}

function exportHarness(build = articlePage, {url = ARTICLE_URL, page = {}, chromeOverrides = {}} = {}) {
    const dom = richDom(build);
    dom.doc.title = 'Un pont local authentifié — Carnet Nexus';
    dom.doc.baseURI = url;
    dom.html.attrs.lang = 'fr';
    Object.assign(dom.page, {location: {href: url}, URL}, page);
    const h = harness(dom.page, {tabs: {get: async (id) => ({id, url, title: dom.doc.title, windowId: 10})}, ...chromeOverrides});
    return {h, dom};
}

const NOISE = ['Menu principal', 'cookies', 'Publicité', 'Abonnez-vous', 'Mentions légales', 'SCRIPT_SECRET', 'julien@example.invalid', 'S\'abonner'];

test('export : Markdown du corps de l\'article, sans menus, publicités, bandeau ni champ ; métadonnées', async () => {
    const {h} = exportHarness();
    const res = await h.run('export_content', {tabId: 1});
    const d = res.data;
    assert.equal(d.format, 'markdown');
    assert.equal(d.root.method, 'article');
    assert.equal(d.root.id, 'main-article');
    const md = d.content;
    assert.match(md, /^# Un pont local authentifié\n/);
    assert.match(md, /avec une \*\*preuve HMAC\*\* dans les deux sens/);
    assert.match(md, /\n## Étapes\n\n1\. Nonce de l'extension\n2\. Preuve du pont\n3\. Preuve du client\n/);
    assert.match(md, /\[la page du pont\]\(https:\/\/blog\.example\.invalid\/docs\/pont\)/);
    assert.match(md, /\| Port \| Rôle \|\n\| --- \| --- \|\n\| 9224 \| WebSocket \\\| signé \|\n\| 9225 \| API REST \|/);
    assert.match(md, /```python\nprint\("bonjour"\)\nprint\("pont"\)\n```/);
    assert.match(md, /Conclusion : aucun programme local/);
    for (const noise of NOISE) assert.ok(!md.includes(noise), `bruit présent : ${noise}`);
    assert.deepEqual(plain(d.metadata), {
        title: 'Un pont local authentifié', author: 'Julien Piron', published: '2026-10-16T09:00:00Z', modified: null,
        lang: 'fr', site_name: 'Carnet Nexus', description: null, canonical: null
    });
    assert.equal(d.url, ARTICLE_URL);
    assert.equal(d.truncated, false);
    assert.equal(d.total_chars, md.length);
    assert.equal(d.stats.tables, 1);
    assert.equal(d.stats.code_blocks, 1);
    assert.ok(d.stats.words > 40);
    assert.ok(!JSON.stringify(res).includes('julien@example.invalid'));
});

test('export : sans <article>, la racine est trouvée au score (paragraphes, densité de liens)', async () => {
    const page = (h) => [
        h('div', {id: 'top-links'}, h('a', {href: '/a'}, 'Lien un'), h('a', {href: '/b'}, 'Lien deux'), h('a', {href: '/c'}, 'Lien trois')),
        h('div', {class: 'layout'},
            h('div', {id: 'story', class: 'content'},
                h('p', {}, 'Premier paragraphe du récit, assez long pour compter, avec des virgules, des détails, et du sens.'),
                h('p', {}, 'Deuxième paragraphe du récit, qui prolonge le premier, toujours avec des virgules, et des faits.')),
            h('div', {class: 'related'}, h('p', {}, 'Articles similaires que vous pourriez aimer lire ensuite, cliquez ici.')))
    ];
    const {h} = exportHarness(page);
    const res = await h.run('export_content', {tabId: 1});
    assert.equal(res.data.root.method, 'scored');
    assert.equal(res.data.root.id, 'story');
    assert.match(res.data.content, /Premier paragraphe[^\n]+\n\nDeuxième paragraphe/);
    assert.ok(!res.data.content.includes('Lien deux') && !res.data.content.includes('similaires'));
});

test('export : formats text et html nettoyé (aucun attribut, script ni champ)', async () => {
    const {h} = exportHarness();
    const text = (await h.run('export_content', {tabId: 1, format: 'text'})).data;
    assert.equal(text.format, 'text');
    assert.match(text.content, /^Un pont local authentifié\n\nLe pont relie l'agent à Chrome, avec une preuve HMAC dans/);
    assert.match(text.content, /Port\tRôle\n9224\tWebSocket \| signé/);
    assert.ok(!text.content.includes('**') && !text.content.includes('](') && !text.content.includes('Publicité'));
    const html = (await h.run('export_content', {tabId: 1, format: 'html'})).data.content;
    assert.match(html, /<h1>Un pont local authentifié<\/h1>/);
    assert.match(html, /<strong>preuve HMAC<\/strong>/);
    assert.match(html, /<a href="https:\/\/blog\.example\.invalid\/docs\/pont">la page du pont<\/a>/);
    assert.match(html, /<thead><tr><th>Port<\/th><th>Rôle<\/th><\/tr><\/thead>/);
    assert.match(html, /<pre><code class="language-python">print\(&quot;bonjour&quot;\)/);
    assert.ok(!/class="post"|<script|<input|<form|SCRIPT_SECRET|Publicité/.test(html));
    const bad = await h.run('export_content', {tabId: 1, format: 'docx'});
    assert.match(bad.error, /Unknown format/);
});

test('export : zone par selector ou locator (strict), troncature signalée', async () => {
    const {h} = exportHarness();
    const zone = (await h.run('export_content', {tabId: 1, selector: 'table'})).data;
    assert.equal(zone.root.method, 'selector');
    assert.equal(zone.content, '| Port | Rôle |\n| --- | --- |\n| 9224 | WebSocket \\| signé |\n| 9225 | API REST |');
    const byLocator = (await h.run('export_content', {tabId: 1, locator: {role: 'list', hasText: 'Nonce'}})).data;
    assert.equal(byLocator.root.method, 'locator');
    assert.equal(byLocator.content, '1. Nonce de l\'extension\n2. Preuve du pont\n3. Preuve du client');
    const missing = await h.run('export_content', {tabId: 1, selector: '#absent'});
    assert.match(missing.error, /No element matches the selector/);
    const ambiguous = await h.run('export_content', {tabId: 1, locator: {role: 'list'}});
    assert.match(ambiguous.error, /Ambiguous locator .* 2 elements match/);
    const second = (await h.run('export_content', {tabId: 1, locator: {role: 'list', nth: -1}})).data;
    assert.match(second.content, /^1\. Nonce/);
    const cut = (await h.run('export_content', {tabId: 1, maxChars: 120})).data;
    assert.equal(cut.truncated, true);
    assert.ok(cut.content.length <= 120 && cut.total_chars > 120);
});

// --- Google Docs / Sheets / Slides ---------------------------------------------------------------------------
function fakeResponse({status = 200, body = '', bytes = null, type = 'text/plain; charset=utf-8', url = null, disposition = null} = {}) {
    const headers = {'content-type': type};
    if (disposition) headers['content-disposition'] = disposition;
    return {
        ok: status >= 200 && status < 300, status, url, redirected: false,
        headers: {get: (name) => headers[String(name).toLowerCase()] ?? null},
        text: async () => body,
        arrayBuffer: async () => (bytes || new TextEncoder().encode(body)).buffer
    };
}

function gsuiteHarness(url, responder, extra = {}) {
    const fetches = [];
    const page = {
        document: {title: 'Doc', cookie: 'SID=cookie-secret-value', documentElement: {}},
        location: {href: url},
        btoa, AbortController, setTimeout, clearTimeout, TextEncoder, Uint8Array,
        fetch: async (u, opts) => { fetches.push({url: u, credentials: opts && opts.credentials, from: 'page'}); return responder(u, opts); }
    };
    const h = harness(page, {tabs: {get: async (id) => ({id, url, title: 'Plan 2026 - Google Docs', windowId: 10})}, ...extra});
    return {h, fetches};
}

test('gsuite : Docs en Markdown par l\'URL d\'export officielle, cookies de la session, jamais renvoyés', async () => {
    const url = 'https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOp/edit?tab=t.0';
    const {h, fetches} = gsuiteHarness(url, (u) => fakeResponse({body: '# Plan 2026\n\nTexte du document.', type: 'text/markdown', url: u, disposition: 'attachment; filename="Plan 2026.md"'}));
    const res = await h.run('export_gsuite', {tabId: 1});
    assert.deepEqual(plain(fetches), [{url: 'https://docs.google.com/document/u/1/d/1AbCdEfGhIjKlMnOp/export?format=md', credentials: 'include', from: 'page'}]);
    const d = res.data;
    assert.equal(d.kind, 'document');
    assert.equal(d.format, 'md');
    assert.equal(d.binary, false);
    assert.equal(d.text, '# Plan 2026\n\nTexte du document.');
    assert.equal(d.filename, 'Plan 2026.md');
    assert.equal(d.title, 'Plan 2026');
    assert.equal(d.via, 'page');
    assert.ok(!JSON.stringify(res).includes('cookie-secret-value'));
});

test('gsuite : formats binaires en base64 (docx), Sheets avec gid, Slides en pptx', async () => {
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x10]);
    const docx = gsuiteHarness('https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit', (u) => fakeResponse({bytes, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', url: u}));
    const d = (await docx.h.run('export_gsuite', {tabId: 1, format: 'docx'})).data;
    assert.equal(d.binary, true);
    assert.equal(d.bytes, 7);
    assert.deepEqual([...Buffer.from(d.base64, 'base64')], [...bytes]);
    assert.equal(d.text, undefined);

    const sheet = gsuiteHarness('https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNm/edit#gid=123456', (u) => fakeResponse({body: 'a,b\n1,2\n', type: 'text/csv', url: u}));
    const s = (await sheet.h.run('export_gsuite', {tabId: 1})).data;
    assert.equal(sheet.fetches[0].url, 'https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNm/export?format=csv&gid=123456');
    assert.equal(s.text, 'a,b\n1,2\n');
    assert.equal(s.gid, '123456');
    await sheet.h.run('export_gsuite', {tabId: 1, format: 'xlsx', gid: 7});
    assert.equal(sheet.fetches[1].url, 'https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNm/export?format=xlsx&gid=7');

    const slides = gsuiteHarness('https://docs.google.com/presentation/d/1SlIdEsDeCk0123/edit#slide=id.p', (u) => fakeResponse({bytes, type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', url: u}));
    const p = (await slides.h.run('export_gsuite', {tabId: 1, format: 'pptx'})).data;
    assert.equal(slides.fetches[0].url, 'https://docs.google.com/presentation/d/1SlIdEsDeCk0123/export/pptx');
    assert.equal(p.kind, 'presentation');
    const bad = await slides.h.run('export_gsuite', {tabId: 1, format: 'xlsx'});
    assert.match(bad.error, /cannot be exported for Google Slides: txt, pdf, pptx, odp/);
});

test('gsuite : erreurs claires (page non Google, droits, connexion, HTML au lieu du fichier), aucun fetch hors Google', async () => {
    const other = gsuiteHarness('https://example.invalid/document/d/1AbCdEfGhIjKlMnOp/edit', () => fakeResponse());
    assert.match((await other.h.run('export_gsuite', {tabId: 1})).error, /is not an open Google Docs, Sheets or Slides/);
    assert.equal(other.fetches.length, 0);
    const docUrl = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit';
    const denied = gsuiteHarness(docUrl, (u) => fakeResponse({status: 403, url: u}));
    assert.match((await denied.h.run('export_gsuite', {tabId: 1})).error, /refused \(HTTP 403\): insufficient rights/);
    const login = gsuiteHarness(docUrl, () => fakeResponse({type: 'text/html', body: '<html>Connexion</html>', url: 'https://accounts.google.com/ServiceLogin?continue=x'}));
    assert.match((await login.h.run('export_gsuite', {tabId: 1})).error, /Google asks for a sign-in/);
    const html = gsuiteHarness(docUrl, (u) => fakeResponse({type: 'text/html; charset=utf-8', body: '<html>Erreur</html>', url: u}));
    assert.match((await html.h.run('export_gsuite', {tabId: 1, format: 'pdf'})).error, /HTML page, not the file/);
    const published = gsuiteHarness('https://docs.google.com/document/d/e/2PACX-1vabcdefghijkl/pub', () => fakeResponse());
    assert.match((await published.h.run('export_gsuite', {tabId: 1})).error, /published to the web/);
    assert.equal(published.fetches.length, 0);
});

test('gsuite : fetch refusé dans la page (CORS) -> repli fetch du service worker avec credentials include', async () => {
    const url = 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOp/edit';
    const {h, fetches} = gsuiteHarness(url, () => { throw new TypeError('Failed to fetch'); });
    h.ctx.fetch = async (u, opts) => { fetches.push({url: u, credentials: opts.credentials, from: 'extension'}); return fakeResponse({body: 'Texte brut', url: u}); };
    const res = await h.run('export_gsuite', {tabId: 1, format: 'txt'});
    assert.deepEqual(plain(fetches.map(f => [f.from, f.credentials])), [['page', 'include'], ['extension', 'include']]);
    assert.equal(res.data.via, 'extension');
    assert.equal(res.data.text, 'Texte brut');
});

// --- YouTube -----------------------------------------------------------------------------------------------------
const VIDEO = 'dQw4w9WgXcQ';
const TRACKS = [
    {baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=fr&sig=abc`, languageCode: 'fr', name: {simpleText: 'Français'}, isTranslatable: true},
    {baseUrl: `https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=en&kind=asr&sig=def`, languageCode: 'en', kind: 'asr', name: {runs: [{text: 'Anglais (générés automatiquement)'}]}, isTranslatable: true}
];
const JSON3 = (lines) => JSON.stringify({events: [{tStartMs: 0, dDurationMs: 500}, ...lines.map(([ms, text]) => ({tStartMs: ms, dDurationMs: 2000, segs: [{utf8: text}]}))]});

function youtubeHarness({tracks = TRACKS, responder, initial, player, entries = []} = {}) {
    const fetches = [];
    const url = `https://www.youtube.com/watch?v=${VIDEO}&t=42s`;
    const pr = {videoDetails: {videoId: VIDEO, title: 'Vidéo de test', author: 'Chaîne Nexus', lengthSeconds: '212'}, playabilityStatus: {status: 'OK'},
        captions: tracks ? {playerCaptionsTracklistRenderer: {captionTracks: tracks, audioTracks: [{defaultCaptionTrackIndex: 0}]}} : undefined};
    const page = {
        document: {getElementById: (id) => (id === 'movie_player' ? player || null : null)},
        window: {ytInitialPlayerResponse: initial === undefined ? pr : initial},
        location: {href: url},
        performance: {getEntriesByType: () => entries.map(name => ({name}))},
        btoa, AbortController, setTimeout, clearTimeout, Date,
        fetch: async (u) => { fetches.push(u); return responder(u, pr); }
    };
    const h = harness(page, {tabs: {get: async (id) => ({id, url, title: 'Vidéo de test - YouTube', windowId: 10})}});
    return {h, fetches, pr};
}

test('youtube : piste choisie par langue (manuelle d\'abord), json3 rendu en texte horodaté et brut', async () => {
    const {h, fetches} = youtubeHarness({responder: (u) => fakeResponse({body: JSON3([[1200, 'Bonjour'], [65000, 'et   bienvenue\n'], [3725000, 'Fin']]), url: u})});
    const res = await h.run('export_youtube_transcript', {tabId: 1, lang: 'fr'});
    const d = res.data;
    assert.match(fetches[0], /lang=fr/);
    assert.match(fetches[0], /fmt=json3/);
    assert.equal(d.video_id, VIDEO);
    assert.equal(d.title, 'Vidéo de test');
    assert.equal(d.channel, 'Chaîne Nexus');
    assert.deepEqual(plain(d.track), {lang: 'fr', name: 'Français', auto: false, translatable: true, translated: false, translated_to: null, source_format: 'json3'});
    assert.equal(d.timed_text, '[00:01] Bonjour\n[01:05] et bienvenue\n[1:02:05] Fin');
    assert.equal(d.text, 'Bonjour et bienvenue Fin');
    assert.equal(d.segments, 3);
    assert.equal(d.method, 'direct');
    assert.deepEqual(plain(d.available_tracks.map(t => [t.lang, t.auto])), [['fr', false], ['en', true]]);
});

test('youtube : piste auto-générée signalée, traduction par tlang, vtt, aucune piste -> erreur claire', async () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>Hello</c> world\n\n00:00:03.000 --> 00:00:05.000\nHello world\n\n00:01:00.500 --> 00:01:02.000\nSecond &amp; last';
    const en = youtubeHarness({responder: (u) => fakeResponse({body: /fmt=vtt/.test(u) ? vtt : '', url: u})});
    const d = (await en.h.run('export_youtube_transcript', {tabId: 1, lang: 'en-US', format: 'vtt'})).data;
    assert.equal(d.track.auto, true);
    assert.equal(d.track.source_format, 'vtt');
    assert.equal(d.timed_text, '[00:01] Hello world\n[01:00] Second & last');
    const de = youtubeHarness({responder: (u) => fakeResponse({body: JSON3([[0, 'Hallo']]), url: u})});
    const t = (await de.h.run('export_youtube_transcript', {tabId: 1, lang: 'de'})).data;
    assert.match(de.fetches[0], /tlang=de/);
    assert.equal(t.track.translated, true);
    assert.equal(t.track.translated_to, 'de');
    const none = youtubeHarness({tracks: null, responder: () => fakeResponse()});
    assert.match((await none.h.run('export_youtube_transcript', {tabId: 1})).error, /No caption track/);
    assert.equal(none.fetches.length, 0);
    const noTranslate = youtubeHarness({tracks: [{...TRACKS[0], isTranslatable: false}], responder: () => fakeResponse()});
    assert.match((await noTranslate.h.run('export_youtube_transcript', {tabId: 1, lang: 'ja'})).error, /No track in "ja" and none translatable: available tracks fr/);
});

test('youtube : données du lecteur obsolètes (navigation SPA) -> getPlayerResponse de la vidéo ouverte', async () => {
    const player = {getPlayerResponse: null};
    const {h, pr} = youtubeHarness({initial: {videoDetails: {videoId: 'AAAAAAAAAAA'}}, player, responder: (u) => fakeResponse({body: JSON3([[0, 'Bonne vidéo']]), url: u})});
    player.getPlayerResponse = () => pr;
    const d = (await h.run('export_youtube_transcript', {tabId: 1})).data;
    assert.equal(d.text, 'Bonne vidéo');
    assert.equal(d.player_source, 'player');
});

test('youtube : piste vide (jeton pot exigé) -> sous-titres activés un instant, URL signée du lecteur, puis remis', async () => {
    const entries = [];
    const options = [];
    const player = {
        getPlayerResponse: null, getOption: () => ({}), loadModule: (m) => options.push(['load', m]),
        unloadModule: (m) => options.push(['unload', m]),
        setOption: (mod, key, value) => {
            options.push(['set', value.languageCode]);
            entries.push(`https://www.youtube.com/api/timedtext?v=${VIDEO}&lang=fr&fmt=srv3&pot=TOKEN123&c=WEB`);
        }
    };
    const {h, fetches, pr} = youtubeHarness({player, entries, responder: (u) => fakeResponse({body: /pot=TOKEN123/.test(u) ? JSON3([[0, 'Avec jeton']]) : '', url: u})});
    player.getPlayerResponse = () => pr;
    const d = (await h.run('export_youtube_transcript', {tabId: 1, lang: 'fr'})).data;
    assert.equal(d.text, 'Avec jeton');
    assert.equal(d.method, 'player_token');
    assert.equal(d.captions_toggled, true);
    assert.match(fetches[1], /pot=TOKEN123/);
    assert.match(fetches[1], /fmt=json3/);
    assert.ok(!/fmt=srv3/.test(fetches[1]));
    assert.deepEqual(plain(options), [['load', 'captions'], ['set', 'fr'], ['unload', 'captions']]);
    const off = youtubeHarness({responder: (u) => fakeResponse({body: '', url: u})});
    assert.match((await off.h.run('export_youtube_transcript', {tabId: 1, enableCaptions: false})).error, /unreadable \(empty response\)/);
});

test('youtube : onglet hors YouTube refusé sans rien lire', async () => {
    const {h} = exportHarness();
    assert.match((await h.run('export_youtube_transcript', {tabId: 1})).error, /is not a YouTube page/);
});

test('exports annoncés par ping (contrôle préalable de la validation réelle)', async () => {
    const h = harness();
    const pong = await h.run('ping', {});
    for (const f of ['content-export', 'gsuite-export', 'youtube-transcript']) assert.ok(pong.data.features.includes(f), f);
});

// -----------------------------------------------------------------------------
// Revue croisée du 16/10 : Chrome partagé par trois agents, secrets, échappements
// -----------------------------------------------------------------------------
test('boîtes de dialogue : seule celle de l\'onglet visé est annoncée, et réglée seulement avec son tab_id', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.run('evaluate', {tabId: 2, code: '1'});
    await h.emit(1, 'Page.javascriptDialogOpening', {type: 'confirm', message: 'Payer 300 euros ?'});
    await h.emit(2, 'Page.javascriptDialogOpening', {type: 'alert', message: 'Enregistré'});
    // L'agent de l'onglet 2 ne voit jamais la boîte de l'onglet 1 (ni l'inverse).
    const onTab2 = await h.run('active_tab', {tabId: 2});
    assert.equal(onTab2.data.pendingDialogs.length, 1);
    assert.equal(onTab2.data.pendingDialogs[0].message, 'Enregistré');
    assert.ok(!JSON.stringify(onTab2).includes('Payer 300 euros'));
    const onTab3 = await h.run('evaluate', {tabId: 3, code: '1'});
    assert.ok(!JSON.stringify(onTab3).includes('Payer') && !JSON.stringify(onTab3).includes('Enregistré'));
    const tabless = await h.run('active_tab', {});
    assert.equal(tabless.data.pendingDialogs, undefined);
    // handle_dialog sans tab_id : refusé, même avec une seule boîte ouverte ailleurs.
    assert.match((await h.run('handle_dialog', {accept: true})).error, /pass tab_id/);
    const handled = await h.run('handle_dialog', {tabId: 2, accept: true});
    assert.equal(handled.data.dialog.message, 'Enregistré');
    const answers = h.calls.filter(c => c.method === 'Page.handleJavaScriptDialog');
    assert.equal(answers.length, 1);
    assert.equal(answers[0].target.tabId, 2);
    assert.match((await h.run('evaluate', {tabId: 1, code: '2'})).error, /Payer 300 euros/);  // toujours ouverte
});

test('cdp_send : liste de commandes PERMISES, tout le reste refusé avant Chrome (revue C1)', async () => {
    const h = harness();
    const refused = [
        // Trous de l'ancienne liste de refus (revue du 17/10)
        'Storage.clearDataForOrigin', 'Network.getRequestPostData', 'Network.loadNetworkResource', 'IO.read',
        'Fetch.enable', 'Page.addScriptToEvaluateOnNewDocument',
        // Cookies, stockage, téléchargements, fichiers, autres cibles
        'Network.getAllCookies', 'Network.getCookies', 'Network.setCookie', 'Storage.getCookies', 'Storage.clearCookies',
        'Page.setDownloadBehavior', 'Browser.setDownloadBehavior', 'DOM.setFileInputFiles', 'DOMStorage.getDOMStorageItems',
        'IndexedDB.requestData', 'CacheStorage.requestEntries', 'Target.attachToTarget', 'Target.createTarget',
        // Navigation (file://), corps de réponse sans masquage, exécution hors monde isolé, réglages
        'Page.navigate', 'Network.getResponseBody', 'Runtime.callFunctionOn', 'Runtime.addBinding', 'Runtime.compileScript',
        'DOMSnapshot.captureSnapshot', 'Input.setIgnoreInputEvents', 'Page.bringToFront', 'Network.setExtraHTTPHeaders',
        'Security.setIgnoreCertificateErrors', 'Emulation.setGeolocationOverride', 'Debugger.enable', 'runtime.evaluate', ''
    ];
    for (const method of refused) {
        const res = await h.run('cdp_send', {tabId: 1, method, commandParams: {}});
        assert.match(res.error || '', method ? /CDP command refused: .*list of allowed commands/ : /Missing CDP method/, method);
    }
    assert.equal(h.calls.length, 0);  // rien n'a atteint Chrome
    const allowed = ['DOM.getDocument', 'DOM.querySelector', 'DOM.describeNode', 'DOM.getBoxModel', 'Accessibility.getFullAXTree',
        'Page.captureScreenshot', 'Page.getLayoutMetrics', 'Page.printToPDF', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent',
        'Emulation.setDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Network.enable', 'Network.disable', 'Log.enable', 'Console.enable'];
    for (const method of allowed) {
        assert.equal((await h.run('cdp_send', {tabId: 1, method, commandParams: {}})).error, undefined, method);
        assert.ok(h.calls.some(c => c.method === method), method);
    }
});

test('cdp_send Runtime.evaluate : toujours dans le monde isolé, sans API de console ni contexte choisi par l\'agent', async () => {
    const h = harness({window: {dispatchEvent() {}, __secretDeLaPage: 'valeur-de-page'}});
    const res = await h.run('cdp_send', {tabId: 1, method: 'Runtime.evaluate', commandParams: {
        expression: 'typeof window.__secretDeLaPage', returnByValue: true, contextId: 1, uniqueContextId: 'page', includeCommandLineAPI: true
    }});
    assert.equal(res.data.result.value, 'undefined');  // variable de la page invisible depuis le monde isolé
    const call = h.calls.filter(c => c.method === 'Runtime.evaluate').at(-1);
    assert.ok(h.worlds.has(call.params.contextId));
    assert.notEqual(call.params.contextId, 1);
    assert.equal(call.params.includeCommandLineAPI, false);
    assert.equal(call.params.uniqueContextId, undefined);
});

test('réseau : en-têtes masqués par motif de nom et paramètres d\'URL sensibles masqués', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    const url = 'https://api.example.invalid/cb?code=abc123&state=ok&access_token=tok1&X-Amz-Signature=sig1' +
        '&X-Amz-Credential=cred1&api_key=k1&page=2#id_token=idt1&scope=email';
    await h.emit(1, 'Network.requestWillBeSent', {
        requestId: 'm1', timestamp: 1, type: 'Fetch',
        request: {url, method: 'GET', headers: {
            'X-Goog-AuthUser': '0', 'X-CSRF-Token': 'csrf1', 'x-session-id': 'sess1', 'X-Amz-Security-Token': 'amz1',
            'Api-Key': 'key1', 'x-signature': 'sg1', 'X-Password': 'pw1', 'Proxy-Authorization': 'Basic pa1',
            Referer: 'https://app.example.invalid/?refresh_token=rt1', Accept: 'application/json'
        }}
    });
    await h.emit(1, 'Network.responseReceived', {requestId: 'm1', type: 'Fetch', response: {
        status: 302, statusText: 'Found', mimeType: 'text/html',
        headers: {'Set-Cookie': 'a=b', Location: 'https://app.example.invalid/next?token=loc1&lang=fr', 'Content-Type': 'text/html'}
    }});
    const res = await h.run('network_requests', {tabId: 1, includeHeaders: true});
    const raw = JSON.stringify(res);
    for (const secret of ['abc123', 'tok1', 'sig1', 'cred1', 'k1', 'idt1', 'csrf1', 'sess1', 'amz1', 'key1', 'sg1', 'pw1', 'pa1', 'rt1', 'loc1']) {
        assert.ok(!raw.includes(secret), secret);
    }
    const rec = res.data.requests[0];
    assert.equal(rec.url, 'https://api.example.invalid/cb?code=[masked]&state=ok&access_token=[masked]&X-Amz-Signature=[masked]' +
        '&X-Amz-Credential=[masked]&api_key=[masked]&page=2#id_token=[masked]&scope=email');
    assert.equal(rec.requestHeaders.Accept, 'application/json');
    assert.equal(rec.requestHeaders['X-Goog-AuthUser'], '[masked, 1 chars]');
    assert.equal(rec.responseHeaders.Location, 'https://app.example.invalid/next?token=[masked]&lang=fr');
    assert.equal(rec.responseHeaders['Content-Type'], 'text/html');
});

test('carte interactive : le script réellement évalué garde ses échappements (classes, name)', async () => {
    const box = () => ({x: 0, y: 0, width: 20, height: 20, top: 0, bottom: 20, left: 0, right: 20});
    const mk = (props) => ({tagName: 'BUTTON', innerText: 'Go', getBoundingClientRect: box, getAttribute: () => null, ...props});
    const els = [mk({className: 'btn  submit'}), mk({className: 'ss'}), mk({name: 'a\'b"c\\d'})];
    const page = {document: {querySelectorAll: (sel) => (sel === '*' || sel === 'iframe') ? [] : els, title: 'T'}};
    const h = harness(page);
    const res = await h.run('interactive_map', {tabId: 1});
    assert.deepEqual(plain(res.data.elements.map(e => e.selector)), ['button.btn', 'button.ss', 'button[name="a\'b\\"c\\\\d"]']);
    const script = h.calls.find(c => c.method === 'Runtime.evaluate' && c.params.expression.includes('__nexus_som_elements')).params.expression;
    assert.ok(script.includes('split(/\\s+/)'));
    // Avec CSS.escape (vrai Chrome) : c'est lui qui échappe le name.
    const withCss = harness({...page, CSS: {escape: (v) => `ESC(${v})`}});
    const escaped = await withCss.run('interactive_map', {tabId: 1});
    assert.equal(escaped.data.elements[2].selector, 'button[name="ESC(a\'b"c\\d)"]');
});

test('group_tabs : titre et couleur annoncés seulement s\'ils ont été appliqués', async () => {
    const h = harness({}, {tabGroups: {update: async () => { throw new Error('Grouping is not supported by tabs in this window'); }}});
    const res = await h.run('group_tabs', {tabIds: [1], title: 'Nexus', color: 'purple'});
    assert.equal(res.data.updated, false);
    assert.equal(res.data.title, undefined);
    assert.equal(res.data.color, undefined);
    assert.match(res.data.warning, /not applied.*Grouping is not supported/);
    const ok = await harness().run('group_tabs', {tabIds: [1], title: 'Nexus', color: 'purple'});
    assert.deepEqual([ok.data.updated, ok.data.title, ok.data.color], [true, 'Nexus', 'purple']);
});

test('capture : type MIME conforme au format demandé, format inconnu refusé', async () => {
    const h = harness();
    const jpeg = await h.run('screenshot', {tabId: 1, format: 'jpeg'});
    assert.equal(jpeg.data.mimeType, 'image/jpeg');
    assert.ok(jpeg.data.dataUrl.startsWith('data:image/jpeg;base64,'));
    assert.equal(h.calls.find(c => c.method === 'Page.captureScreenshot').params.format, 'jpeg');
    assert.equal((await h.run('screenshot', {tabId: 1, format: 'webp'})).data.mimeType, 'image/webp');
    assert.equal((await h.run('screenshot', {tabId: 1})).data.mimeType, 'image/png');
    assert.match((await h.run('screenshot', {tabId: 1, format: 'gif'})).error, /Unknown screenshot format/);
});

test('version annoncée lue dans le manifeste, jamais une valeur codée en dur', async () => {
    const h = harness({}, {runtime: {getManifest: () => ({version: '9.8.7'})}});
    assert.equal((await h.run('ping', {})).data.version, '9.8.7');
    const source = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
    assert.ok(!/["v]2\.0\.0/.test(source), 'version codée en dur');
});

// =============================================================================
// Revue de Claude du 17/10 (partie C) : isolation entre agents et secrets tenus PAR L'EXTENSION
// =============================================================================
test('propriété : l\'agent A n\'agit ni sur l\'onglet de B ni sur ceux de Julien ; même agent, autre session : refusé', async () => {
    let next = 200;
    const h = harness({}, {autoOwn: false, tabs: {
        create: async (p) => ({id: next++, url: p.url, active: false, windowId: 10}),
        query: async () => [{id: 1, title: 'Banque de Julien', url: 'https://banque.invalid'}, {id: 200, title: 'A'}, {id: 201, title: 'B'}]
    }});
    const a = (await h.run('create_tab', {url: 'https://a.invalid', group: false}, AGENT_A)).data.id;
    const b = (await h.run('create_tab', {url: 'https://b.invalid', group: false}, AGENT_B)).data.id;
    assert.deepEqual([a, b], [200, 201]);
    const pageCommands = [
        ['click', () => ({selector: 'button'})], ['evaluate', () => ({code: '1'})], ['fill', () => ({selector: 'input', value: 'x'})],
        ['get_content', () => ({mode: 'text'})], ['screenshot', () => ({})], ['cdp_send', () => ({method: 'DOM.getDocument'})],
        ['close_tab', () => ({})], ['navigate', () => ({url: 'https://x.invalid'})], ['handle_dialog', () => ({accept: true})],
        ['network_response', () => ({request_id: '1'})], ['release_tab', () => ({})], ['select_tab', () => ({})],
        ['upload', () => ({files: ['C:/Dev/rapport.pdf']})], ['get_cookies', () => ({})], ['network_record', () => ({})],
        ['group_tabs', (id) => ({tabIds: [id]})], ['export_content', () => ({})], ['type_keys', () => ({text: 'a'})]
    ];
    for (const [action, extra] of pageCommands) {
        assert.match((await h.run(action, {tabId: b, ...extra(b)}, AGENT_A)).error || '', /is driven by Codex: refused/, `${action} sur l'onglet de B`);
        assert.match((await h.run(action, {tabId: 1, ...extra(1)}, AGENT_A)).error || '', /not driven by any agent \(user's tab\)/, `${action} sur l'onglet de Julien`);
    }
    const otherSession = {agent: 'Claude', id: 'claude-autre-session'};
    assert.match((await h.run('click', {tabId: a, selector: 'button'}, otherSession)).error, /Claude in another session/);
    assert.match((await h.run('click', {tabId: a, selector: 'button'}, null)).error, /without client identity/);
    assert.match((await h.run('click', {tabId: a, selector: 'button'}, {agent: 'Claude'})).error, /without client identity/);
    assert.equal(h.calls.length, 0);  // rien n'a touché Chrome
    assert.equal((await h.run('evaluate', {tabId: a, code: '40 + 2'}, AGENT_A)).data, 42);
    assert.ok(h.calls.length > 0 && h.calls.every(c => c.target.tabId === a));
    const list = (await h.run('list_tabs', {}, AGENT_A)).data;
    assert.deepEqual(plain(list.map(t => [t.id, t.owner, t.mine])), [[1, null, false], [200, 'Claude', true], [201, 'Codex', false]]);
    assert.ok(!JSON.stringify(list).includes('codex-bbbb2222'));  // jamais la session d'un autre agent
});

test('propriété : une boîte de dialogue n\'est annoncée qu\'au pilote de l\'onglet', async () => {
    const h = harness({}, {autoOwn: false});
    await h.own(1, AGENT_A);
    await h.run('evaluate', {tabId: 1, code: '1'}, AGENT_A);
    await h.emit(1, 'Page.javascriptDialogOpening', {type: 'confirm', message: 'Payer 300 euros ?'});
    assert.equal((await h.run('active_tab', {tabId: 1}, AGENT_B)).data.pendingDialogs, undefined);
    assert.equal((await h.run('active_tab', {tabId: 1}, AGENT_A)).data.pendingDialogs[0].message, 'Payer 300 euros ?');
});

test('adoption : onglet de Julien refusé par défaut, seulement avec julienAsked, visible au poste de contrôle ; jamais celui d\'un autre agent', async () => {
    const h = harness({}, {autoOwn: false, tabs: {query: async () => [{id: 1, title: 'Boîte mail', url: 'https://mail.example.invalid/#inbox?token=jeton-zzz'}]}});
    assert.match((await h.run('adopt_tab', {tabId: 1}, AGENT_A)).error, /refused by default/);
    assert.match((await h.run('adopt_tab', {tabId: 1, julienAsked: 'true'}, AGENT_A)).error, /refused by default/);  // booléen strict
    assert.equal((await h.run('adopt_tab', {tabId: 1, julienAsked: true}, AGENT_A)).data.adopted, true);
    assert.match((await h.run('adopt_tab', {tabId: 1, julienAsked: true}, AGENT_B)).error, /driven by Claude/);
    assert.equal((await h.run('evaluate', {tabId: 1, code: '2'}, AGENT_A)).data, 2);
    const state = await h.sendMessage({target: 'background', getControlState: true});
    assert.deepEqual(plain(state.tabs.map(t => [t.tabId, t.agent, t.adopted])), [[1, 'Claude', true]]);
    assert.ok(!JSON.stringify(state).includes('jeton-zzz'));
    assert.equal((await h.run('release_tab', {tabId: 1}, AGENT_A)).data.released, true);
    assert.ok(h.detached.includes(1));
    assert.match((await h.run('evaluate', {tabId: 1, code: '3'}, AGENT_A)).error, /user's tab/);
    // userAsked : nom neutre de julienAsked (même sens).
    assert.equal((await h.run('adopt_tab', {tabId: 1, userAsked: true}, AGENT_A)).data.adopted, true);
    assert.equal((await h.run('release_tab', {tabId: 1}, AGENT_A)).data.released, true);
    const shielded = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url: 'chrome://settings', windowId: 10})}});
    assert.match((await shielded.run('adopt_tab', {tabId: 9, julienAsked: true}, AGENT_A)).error, /protected/);
});

test('propriété conservée après redémarrage du service worker (chrome.storage.session), oubliée si l\'onglet a disparu', async () => {
    const tabs = {create: async (p) => ({id: 300, url: p.url, active: false, windowId: 10}), query: async () => [{id: 300}]};
    const first = harness({}, {autoOwn: false, tabs});
    await first.run('create_tab', {url: 'https://a.invalid', group: false}, AGENT_A);
    assert.equal(first.sessionData.nexusBrowserTabOwners['300'].agent, 'Claude');
    const restarted = harness({}, {autoOwn: false, tabs, sessionStorage: first.sessionData});
    assert.equal((await restarted.run('evaluate', {tabId: 300, code: '4'}, AGENT_A)).data, 4);
    assert.match((await restarted.run('evaluate', {tabId: 300, code: '4'}, AGENT_B)).error, /driven by Claude/);
    const gone = harness({}, {autoOwn: false, tabs: {...tabs, query: async () => []}, sessionStorage: first.sessionData});
    assert.match((await gone.run('evaluate', {tabId: 300, code: '4'}, AGENT_A)).error, /user's tab/);
});

test('réseau : champs secrets des corps masqués à toute profondeur (JSON, préfixe XSSI, formulaire, JSON tronqué)', async () => {
    const bodies = {
        oauth: JSON.stringify({access_token: 'ya29.SECRET1', refresh_token: 'SECRET2', id_token: 'SECRET3', token_type: 'Bearer', expires_in: 3599,
            user: {name: 'Julien', password: 'SECRET4', nested: [{api_key: 'SECRET5', client_secret: 'SECRET6'}], session: {id: 'SECRET7'}},
            Authorization: 'Bearer SECRET8', message: 'ok'}),
        xssi: ")]}'\n" + JSON.stringify({data: {token: 'SECRET9', title: 'Doc'}}),
        form: 'grant_type=refresh_token&refresh_token=SECRET10&client_secret=SECRET11&scope=email',
        cut: '{"items":[1,2],"access_token":"SECRET12","note":"suite tronq',
        page: '<script>var cfg = {"apiKey": "SECRET13", "lang": "fr"}; location.href = "/cb?code=SECRET14&state=ok";</script>'
    };
    const mimes = {oauth: 'application/json', xssi: 'application/json', form: 'application/x-www-form-urlencoded', cut: 'application/json', page: 'text/html'};
    const h = harness({}, {debuggerSendCommand: (target, method, params) => method === 'Network.getResponseBody' ? {body: bodies[params.requestId], base64Encoded: false} : undefined});
    await h.run('evaluate', {tabId: 1, code: '1'});
    for (const id of Object.keys(bodies)) {
        await h.emit(1, 'Network.requestWillBeSent', {requestId: id, timestamp: 1, request: {url: `https://x.invalid/${id}`, method: 'POST', headers: {}}});
        await h.emit(1, 'Network.responseReceived', {requestId: id, response: {status: 200, mimeType: mimes[id], headers: {}}});
        await h.emit(1, 'Network.loadingFinished', {requestId: id, timestamp: 2, encodedDataLength: 10});
    }
    const read = async (id) => (await h.run('network_response', {tabId: 1, request_id: id})).data;
    const oauth = await read('oauth');
    const parsed = JSON.parse(oauth.body);
    assert.equal(parsed.access_token, '[masked, 12 chars]');
    assert.equal(parsed.token_type, 'Bearer');
    assert.equal(parsed.expires_in, 3599);
    assert.equal(parsed.user.name, 'Julien');
    assert.equal(parsed.user.session, '[masked]');
    assert.equal(parsed.message, 'ok');
    assert.equal(oauth.masked, 8);
    const xssi = await read('xssi');
    assert.ok(xssi.body.startsWith(")]}'\n"));
    assert.equal(JSON.parse(xssi.body.slice(5)).data.title, 'Doc');
    assert.equal((await read('form')).body, 'grant_type=refresh_token&refresh_token=[masked]&client_secret=[masked]&scope=email');
    const cut = await read('cut');
    assert.match(cut.body, /"access_token":"\[masked, 8 chars\]"/);
    const page = await read('page');
    assert.match(page.body, /"lang": "fr"/);
    for (const id of Object.keys(bodies)) {
        const raw = JSON.stringify(await read(id));
        for (let n = 1; n <= 14; n++) assert.ok(!raw.includes(`SECRET${n}`), `${id} : SECRET${n}`);
    }
});

test('arrêt d\'urgence : la frappe touche par touche s\'interrompt au caractère suivant, aucune touche laissée enfoncée', async () => {
    let downs = 0;
    let ref = null;
    const {h, dom} = richHarness(formPage, {debuggerSendCommand: (target, method, params) => {
        if (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown' && ++downs === 3) ref.ctx.emergencyStop({holdMs: 120000, source: 'test'});
    }});
    ref = h;
    const res = await h.run('fill', {tabId: 1, locator: {placeholder: 'Rechercher'}, value: 'Bonjour le monde', perKey: true});
    assert.match(res.error, /Emergency stop/);
    const keys = h.keyboard().filter(k => k.method === 'Input.dispatchKeyEvent');
    assert.equal(keys.filter(k => k.type === 'keyDown').length, 3);  // et non 16
    assert.equal(keys.at(-1).type, 'keyUp');
    assert.ok(dom.byId('search').value.length < 'Bonjour le monde'.length);
    // Pendant l'arrêt : actions refusées, lectures permises, débogueurs détachés.
    assert.match((await h.run('click', {tabId: 1, locator: {testId: 'submit-zone'}})).error, /Emergency stop/);
    assert.equal((await h.run('list_tabs', {})).error, undefined);
    assert.ok(h.detached.includes(1));
    assert.ok(h.sessionData.nexusBrowserStopUntil > Date.now());
});

test('arrêt d\'urgence : le glisser en cours s\'arrête et le bouton est relâché', async () => {
    const dp = dragPage();
    let moves = 0;
    let ref = null;
    const h = harness(dp.page, {debuggerSendCommand: (target, method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseMoved' && params.buttons === 1 && ++moves === 2) ref.ctx.emergencyStop({holdMs: 120000});
    }});
    ref = h;
    const res = await h.run('drag_and_drop', {tabId: 1, from_selector: '#source', to_selector: '#zone', steps: 10, delayMs: 0});
    assert.match(res.error, /Emergency stop/);
    const mouse = h.mouse();
    assert.equal(mouse.filter(e => e.type === 'mouseMoved' && e.buttons === 1).length, 2);  // et non 10
    assert.deepEqual([mouse.at(-1).type, mouse.at(-1).buttons], ['mouseReleased', 0]);
    assert.equal(dp.drops, 0);
});

test('arrêt d\'urgence : une attente (chargement) en cours est interrompue', async () => {
    const h = harness({document: {readyState: 'loading', querySelectorAll: () => []}}, {virtualTime: true});
    const waiting = h.run('wait_load', {tabId: 1, timeoutMs: 100000});
    await settle();
    await h.run('emergency_stop', {hold_s: 120}, null);  // commande signée du pont, sans client
    const res = await waiting;
    assert.match(res.error, /Emergency stop/);
});

test('repli windows.create : id de l\'ONGLET créé (relu par tabs.query), jamais celui de la fenêtre', async () => {
    const windows = (id) => ({getLastFocused: async () => ({id: 5, type: 'normal'}), create: async () => ({id})});
    const h = harness({}, {autoOwn: false, windows: windows(12), tabs: {
        create: async () => { throw new Error('No current window'); },
        query: async ({windowId} = {}) => windowId === 12 ? [{id: 121, windowId: 12, url: 'https://x.invalid'}] : []
    }});
    const res = await h.run('create_tab', {url: 'https://x.invalid', group: false}, AGENT_A);
    assert.equal(res.data.id, 121);
    assert.equal(h.owners()['121'].agent, 'Claude');
    assert.equal(h.owners()['12'], undefined);
    const none = harness({}, {autoOwn: false, windows: windows(13), tabs: {create: async () => { throw new Error('x'); }, query: async () => []}});
    assert.match((await none.run('create_tab', {url: 'https://x.invalid', group: false}, AGENT_A)).error, /tab was not found/);
    assert.deepEqual(none.owners(), {});
});

test('capture d\'élément : zone en repère de la PAGE (défilement ajouté), au-delà de la vue', async () => {
    const el = {scrollIntoView() {}, getBoundingClientRect: () => ({x: 10, y: 20, width: 200, height: 100})};
    const h = harness({document: {querySelectorAll: (sel) => sel === '#card' ? [el] : []}}, {
        debuggerSendCommand: (target, method) => method === 'Page.getLayoutMetrics' ? {cssVisualViewport: {pageX: 30, pageY: 1500, clientWidth: 1280, clientHeight: 720}} : undefined
    });
    assert.equal((await h.run('screenshot', {tabId: 1, selector: '#card'})).error, undefined);
    const shot = h.calls.find(c => c.method === 'Page.captureScreenshot');
    assert.deepEqual(plain(shot.params.clip), {x: 40, y: 1520, width: 200, height: 100, scale: 1});
    assert.equal(shot.params.captureBeyondViewport, true);
    // Chrome zoomé à 90 % (vu chez Julien le 18/10) : zone en pixels non zoomés, sinon image blanche.
    const zoomed = harness({document: {querySelectorAll: (sel) => sel === '#card' ? [el] : []}}, {
        debuggerSendCommand: (target, method) => method === 'Page.getLayoutMetrics' ? {cssVisualViewport: {pageX: 30, pageY: 1500, zoom: 0.9}} : undefined
    });
    assert.equal((await zoomed.run('screenshot', {tabId: 1, selector: '#card'})).error, undefined);
    assert.deepEqual(plain(zoomed.calls.find(c => c.method === 'Page.captureScreenshot').params.clip), {x: 36, y: 1368, width: 180, height: 90, scale: 1});
});

test('service worker redémarré, onglet encore attaché : session reprise et iframes de nouveau suivies', async () => {
    const h = harness({}, {attachError: 'Another debugger is already attached to the tab with id: 1.'});
    assert.equal((await h.run('evaluate', {tabId: 1, code: '5'})).data, 5);
    const methods = h.calls.map(c => [c.method, c.params?.autoAttach]);
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) assert.ok(methods.some(([x]) => x === m), m);
    const auto = methods.filter(([m]) => m === 'Target.setAutoAttach').map(([, on]) => on);
    assert.deepEqual(auto, [false, true]);  // coupé puis remis : Chrome annonce de nouveau les cadres ouverts
    await h.emitFrom({tabId: 1}, 'Target.attachedToTarget', {sessionId: 's-9', targetInfo: {targetId: 'F9', type: 'iframe', url: 'https://autre.invalid/'}});
    assert.ok(h.calls.some(c => c.target.sessionId === 's-9' && c.method === 'Target.setAutoAttach'));
});

test('débogueur : compteur de commandes PAR ONGLET, une commande bloquée sur l\'onglet 2 n\'empêche pas de détacher l\'onglet 1', async () => {
    const h = harness({}, {debuggerSendCommand: (target, method) => (method === 'Runtime.evaluate' && target.tabId === 2) ? new Promise(() => {}) : undefined});
    await h.run('evaluate', {tabId: 1, code: '1'});
    h.run('evaluate', {tabId: 2, code: 'bloque'});  // ne se termine jamais
    await settle();
    await h.fireIdleTimers();
    assert.ok(h.detached.includes(1));
    assert.ok(!h.detached.includes(2));
});

test('réseau : débogueur gardé seulement pendant l\'enregistrement demandé (borné), puis arrêt explicite', async () => {
    const h = harness();
    const rec = await h.run('network_record', {tabId: 1, durationS: 99999});
    assert.equal(rec.data.duration_s, 600);
    await h.fireIdleTimers();
    assert.deepEqual(h.detached, []);  // gardé pendant l'enregistrement
    assert.ok((await h.run('network_requests', {tabId: 1})).data.recording_until);
    const stopped = await h.run('network_stop', {tabId: 1});
    assert.equal(stopped.data.detached, true);
    assert.deepEqual(h.detached, [1]);
    await h.run('evaluate', {tabId: 2, code: '1'});
    await h.fireIdleTimers();
    assert.ok(h.detached.includes(2));  // sans enregistrement : détaché à l'inactivité
});

test('monde isolé : une page qui remplace __nexus_som_elements, __nexusBrowserMouse ou __nexusBrowserAx ne fausse plus rien', async () => {
    const {h, dom} = richHarness(formPage);
    const trap = dom.byId('d1');  // « Supprimer »
    const fakeMarks = {get: () => trap, has: () => true, set() {}, clear() {}, size: 99};
    Object.defineProperty(dom.win, '__nexus_som_elements', {get: () => fakeMarks, set() {}, configurable: true});
    const fakeProbe = {el: trap, trusted: 9, untrusted: 0, seen: ['click'], types: [], attached: false};
    dom.win.__nexusBrowserMouse = {probes: {get: () => fakeProbe, set() {}, delete() {}, has: () => true, [Symbol.iterator]: function* () {}}, seq: 0};
    dom.win.__nexusBrowserAx = new Proxy({}, {get: () => [{el: trap, role: 'button', name: 'Valider'}]});
    const map = await h.run('interactive_map', {tabId: 1, viewportOnly: false});
    const v1 = map.data.elements.find(e => e.selector === 'button#v1');
    assert.ok(v1, 'marqueur de #v1');
    const res = await h.run('click', {tabId: 1, mark: v1.mark});
    assert.equal(res.data.id, 'v1');
    assert.equal(res.data.trusted_click, true);
    assert.deepEqual(dom.trusted.filter(t => t.type === 'click').map(t => t.el.id), ['v1']);
    // Les objets de l'extension vivent dans son monde isolé ; ceux de la page sont restés les siens.
    assert.equal(dom.win.__nexus_som_elements, fakeMarks);
    assert.ok(h.isolatedWindow().__nexus_som_elements.size >= 1 && h.isolatedWindow().__nexus_som_elements.get(v1.mark) === dom.byId('v1'));
    assert.ok(h.calls.filter(c => c.method === 'Runtime.evaluate').every(c => h.worlds.has(c.params.contextId)));
});

test('navigation : jamais de fichier local ni de page interne (file://, chrome://, javascript:)', async () => {
    const h = harness();
    for (const url of ['file:///C:/Users/user/.ssh/id_ed25519', 'FILE:///c:/x', 'chrome://settings', 'javascript:alert(1)', 'view-source:https://x.invalid', 'devtools://devtools']) {
        assert.match((await h.run('navigate', {tabId: 1, url})).error, /URL refused/, url);
        assert.match((await h.run('create_tab', {url})).error, /URL refused/, url);
    }
    assert.equal(h.focusCalls.tabs, 0);
    assert.equal((await h.run('navigate', {tabId: 1, url: 'https://example.com/'})).error, undefined);
});

test('poste de contrôle : onglets pilotés par agent, état du débogueur, rendre l\'onglet', async () => {
    let next = 400;
    const h = harness({}, {autoOwn: false, tabs: {
        create: async (p) => ({id: next++, url: p.url, title: 'T', active: false, windowId: 10}),
        query: async () => [{id: 400, title: 'Console', url: 'https://console.cloud.google.com/?authuser=0&token=zzz'}, {id: 401, title: 'Play', url: 'https://play.google.com/'}]
    }});
    await h.run('create_tab', {url: 'https://console.cloud.google.com/', group: false}, AGENT_A);
    await h.run('create_tab', {url: 'https://play.google.com/', group: false}, AGENT_B);
    await h.run('evaluate', {tabId: 400, code: '1'}, AGENT_A);
    const state = await h.sendMessage({target: 'background', getControlState: true});
    assert.deepEqual(plain(state.tabs.map(t => [t.tabId, t.agent, t.debugger])), [[400, 'Claude', true], [401, 'Codex', false]]);
    assert.ok(!JSON.stringify(state).includes('zzz') && !JSON.stringify(state).includes('claude-aaaa1111'));
    const released = await h.sendMessage({target: 'background', panelRelease: 400});
    assert.equal(released.previousOwner, 'Claude');
    assert.ok(h.detached.includes(400));
    assert.match((await h.run('evaluate', {tabId: 400, code: '1'}, AGENT_A)).error, /user's tab/);
    assert.deepEqual(Object.keys(h.owners()), ['401']);
    // Pastille : message de l'extension au cadre principal (jamais un événement de la page).
    assert.ok(h.tabMessages.some(m => m.tabId === 400 && m.message.nexusPill?.agent === 'Claude' && m.options.frameId === 0));
    const stopped = await h.sendMessage({target: 'background', panelStop: true});
    assert.equal(stopped.sentToBridge, false);
    assert.match(stopped.warning, /Pont injoignable/);
    assert.ok((await h.sendMessage({target: 'background', getControlState: true})).stoppedUntil > Date.now());
});

test('poste de contrôle : mise en forme (groupes par agent, badges, arrêt, pont)', () => {
    const view = sidepanelView();
    const now = 1_000_000;
    const tabs = [
        {tabId: 7, agent: 'Codex', title: 'B', url: 'https://b.invalid/x?y=1', session: 'abcd1234', exists: true, debugger: false, commandsInFlight: 0},
        {tabId: 3, agent: 'Claude', title: '', url: 'https://a.invalid/', session: '99999999', exists: true, debugger: true, commandsInFlight: 2, recordingUntil: now + 4200, adopted: true}
    ];
    assert.deepEqual(plain(view.groupByAgent(tabs).map(g => [g.agent, g.tabs.map(t => t.tabId)])), [['Claude', [3]], ['Codex', [7]]]);
    const line = plain(view.describeTab(tabs[1], now));
    assert.equal(line.title, 'Onglet sans titre');
    assert.equal(line.subtitle, '#3 · a.invalid · session …99999999');
    assert.deepEqual(line.badges, ['adopté', 'débogueur attaché', '2 commande(s) en cours', 'réseau enregistré 5 s']);
    assert.equal(view.describeTab(tabs[0], now).subtitle, '#7 · b.invalid · session …abcd1234');  // jamais les paramètres d'URL
    assert.equal(view.stopLabel(null, now), null);
    assert.equal(view.stopLabel(now + 90500, now), "Arrêt d'urgence actif : plus aucune action pendant 91 s");
    assert.deepEqual(plain(view.bridgeLabel({connected: false, authError: 'jeton faux'})), {ok: false, text: 'Pont local non joint : jeton faux'});
    assert.equal(view.bridgeLabel({connected: true}).ok, true);
});

test('panneau Antigravity : discussion qui passe par le pont (jamais d\'action sur la page ici), STOP visible, style propre', () => {
    const html = fs.readFileSync(path.join(__dirname, '../extension/sidepanel.html'), 'utf8');
    const js = fs.readFileSync(path.join(__dirname, '../extension/sidepanel.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '../extension/sidepanel.css'), 'utf8');
    assert.match(html, /<title>Antigravity<\/title>/);
    assert.match(html, /id="btn-stop"/);  // STOP dans l'en-tête, hors des vues : toujours visible
    assert.ok(html.indexOf('id="btn-stop"') < html.indexOf('id="view-chat"'));
    assert.match(html, /id="view-control"[\s\S]*id="tabs-list"/);  // poste de contrôle gardé
    assert.match(html, /<textarea id="prompt"/);
    // Le panneau ne parle qu'au service worker : ni commande de page, ni réseau, ni HTML injecté.
    assert.ok(!/executeAction|sidepanelSubmit|interactive_map|get_cookies|form_fields|screenshot|fetch\(|WebSocket|innerHTML/.test(js));
    assert.match(js, /agyAsk:/);
    // Habillage inspiré, pas copié : ni la marque, ni les couleurs exactes de l'assistant de Google.
    assert.ok(!/gemini|#4285F4|#9B72CB|#D96570|#1A73E8/i.test(html + css), 'marque ou couleurs copiées');
    assert.ok(!fs.existsSync(path.join(__dirname, '../extension/popup.html')) && !fs.existsSync(path.join(__dirname, '../extension/popup.js')));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json'), 'utf8'));
    const key = manifest.commands['toggle-side-panel'].suggested_key;
    // Pris par Chrome : « Rechercher dans les onglets », vue scindée (« Sélectionner un onglet »).
    for (const taken of ['Ctrl+Shift+A', 'Alt+Shift+N']) {
        assert.notEqual(key.default, taken);
        assert.notEqual(key.mac, taken);
    }
    // sidePanel.open exige le geste clavier : appel direct avec l'onglet fourni, sans await avant.
    const bg = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
    const handler = bg.slice(bg.indexOf('chrome.commands.onCommand.addListener'));
    assert.match(handler, /^chrome\.commands\.onCommand\.addListener\(\(command, tab\) =>/);
    assert.ok(!/await/.test(handler.slice(0, handler.indexOf('sidePanel.open'))), 'await avant sidePanel.open');
});

function agyChat() {
    const ctx = vm.createContext({URL});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/agy_chat.js'), 'utf8'), ctx);
    return ctx.AgyChat;
}

test('panneau Antigravity : fil (envoi, déposée, réponse, erreur), idempotent, borné', () => {
    const chat = agyChat();
    assert.equal(chat.checkText('   ').error, 'Demande vide.');
    assert.match(chat.checkText('x'.repeat(6001)).error, /trop longue/);
    // Ni identifiants, ni chemin, ni paramètres vers le relais (relecture de Codex).
    assert.equal(chat.originOf('https://user:pass@a.invalid:8443/reset/SECRET?token=zzz#k=v'), 'https://a.invalid:8443');
    let list = chat.addAsk([], {localId: 'L1', text: 'Remplis', tab: {id: 4, title: 'Form'}, at: 1});
    assert.equal(chat.askStatus(list[0]), 'Envoi…');
    list = chat.applyUpdate(list, {localId: 'L1', status: 'sent', relayId: 'R1', sidecarActive: true});
    assert.equal(chat.pendingAsk(list).localId, 'L1');
    assert.equal(chat.askStatus(list[0]), 'Déposée pour Antigravity');
    const reply = {id: 'A1', from: 'antigravity', reply_to: 'R1', request_id: 'L1', text: 'Fait.', created: '2026-10-18T18:00:00Z'};
    list = chat.applyUpdate(list, {reply});
    list = chat.applyUpdate(list, {reply});  // remise deux fois : une seule réponse
    assert.deepEqual(plain(list.map(e => [e.kind, e.status || e.text])), [['ask', 'answered'], ['reply', 'Fait.']]);
    assert.equal(chat.pendingAsk(list), null);
    list = chat.applyUpdate(list, {localId: 'L1', status: 'error', error: 'x'});  // déjà répondue : inchangée
    list = chat.applyUpdate(list, {localId: 'L1', status: 'sent', relayId: 'R1'});  // « answered » ne recule jamais
    assert.equal(list[0].status, 'answered');
    list = chat.applyUpdate(chat.addAsk(list, {localId: 'L2', text: 'b'}), {localId: 'L2', status: 'error', error: 'Nexus Relay absent'});
    assert.equal(chat.askStatus(list.at(-1)), 'Non transmise : Nexus Relay absent');
    assert.match(chat.askStatus({status: 'sent', sidecarActive: false}), /ne semble pas actif/);
    for (let i = 0; i < 150; i++) list = chat.addAsk(list, {localId: `M${i}`, text: 't'});
    assert.equal(list.length, chat.MAX_ENTRIES);
});

test('panneau Antigravity : réponse avant « déposée », ou « déposée » perdue → la réponse retrouve sa demande par request_id', () => {
    const chat = agyChat();
    let t = chat.addAsk([], {localId: 'L', text: 'test'});
    t = chat.applyUpdate(t, {reply: {id: 'REP', reply_to: 'REQ', text: 'fait'}});
    t = chat.applyUpdate(t, {localId: 'L', status: 'sent', relayId: 'REQ'});
    assert.equal(t[0].status, 'answered');
    // Confirmation « déposée » jamais reçue : la réponse porte l'identifiant de requête.
    let u = chat.addAsk([], {localId: 'L9', text: 'x'});
    u = chat.applyUpdate(u, {reply: {id: 'REP9', reply_to: 'REQ9', request_id: 'L9', text: 'fait'}});
    assert.equal(u[0].status, 'answered');
    assert.equal(u[0].relayId, 'REQ9');
    assert.equal(chat.busyAsk(u), null);
});

test('panneau Antigravity : renvois sans fin avec le même localId ; seuls les envois réels comptent ; abandon et effacement', () => {
    const chat = agyChat();
    let list = chat.addAsk([], {localId: 'L', text: 'x', at: 1000});
    assert.equal(chat.busyAsk(list).localId, 'L');  // une demande en cours bloque la suivante, sans limite de temps
    assert.deepEqual(plain(chat.dueResends(list, 1000).map(e => e.localId)), ['L']);  // jamais envoyée : tout de suite
    list = chat.markSent(list, 'L', 1000);
    assert.equal(chat.dueResends(list, 1000 + chat.RESEND_AFTER_MS - 1).length, 0);
    for (let i = 1; i < chat.SLOW_ATTEMPTS; i++) list = chat.markSent(list, 'L', 1000 + i * chat.RESEND_AFTER_MS);
    assert.match(chat.askStatus(list[0]), /non confirmée.*jamais en double/);
    assert.equal(list[0].status, 'sending');  // pas abandonnée en silence
    assert.equal(chat.dueResends(list, 10_000_000).length, 1);
    // Effacer l'affichage garde la demande en cours ; seul l'abandon explicite libère le panneau.
    list = chat.clearDisplay([...list, {kind: 'reply', id: 'old', text: 'ancienne'}]);
    assert.deepEqual(plain(list.map(e => e.localId || e.id)), ['L']);
    list = chat.abandon(list, 'L');
    assert.equal(list[0].status, 'abandoned');
    assert.equal(chat.busyAsk(list), null);
    list = chat.applyUpdate(list, {localId: 'L', status: 'sent', relayId: 'R'});  // confirmation tardive : reste abandonnée
    assert.equal(list[0].status, 'abandoned');
    list = chat.applyUpdate(list, {reply: {id: 'A', reply_to: 'R', request_id: 'L', text: 'fini quand même'}});
    assert.equal(list[0].status, 'answered');
});

test('panneau Antigravity : demande → événement signé au pont (identité, instance, origine) → déposée → réponse (storage.local)', async () => {
    const bridge = bridgeHarness();
    const {h, server, stop} = bridge;
    try {
        await authenticated(bridge);
        await until(() => server.replies().some(r => r.event === 'agy_hello'), 'instance annoncée');
        const instance = server.replies().find(r => r.event === 'agy_hello').instance;
        const asked = await h.sendMessage({target: 'background', agyAsk: {text: '  Remplis le formulaire  ', tabId: 1}});
        assert.equal(asked.sent, true);
        await until(() => server.replies().some(r => r.event === 'agy_ask'), 'demande au pont');
        const event = server.replies().find(r => r.event === 'agy_ask');
        assert.equal(event.text, 'Remplis le formulaire');
        assert.equal(event.localId, asked.localId);
        assert.equal(event.instance, instance);
        assert.deepEqual(plain(event.tab), {id: 1, title: '', url: 'https://example.invalid'});  // origine seule
        assert.match((await h.sendMessage({target: 'background', agyAsk: {text: 'autre', tabId: 1}})).error, /une demande à la fois/);
        server.send({requestId: 'u1', action: 'agy_panel_update', params: {localId: asked.localId, relayId: 'R1', status: 'sent', sidecarActive: true}});
        await until(() => server.replies().some(r => r.requestId === 'u1'), 'déposée');
        assert.equal(h.localData.agyChat[0].status, 'sent');
        // Un agent ne parle jamais à la place d'Antigravity (commande réservée au pont, sans identité de client).
        server.send({requestId: 'u2', action: 'agy_panel_update', params: {reply: {id: 'X', reply_to: 'R1', text: 'faux'}}, client: TEST_CLIENT});
        await until(() => server.replies().some(r => r.requestId === 'u2'), 'refus');
        assert.match(server.replies().find(r => r.requestId === 'u2').error, /reserved for the bridge/);
        server.send({requestId: 'u3', action: 'agy_panel_update', params: {reply: {id: 'A1', from: 'antigravity', reply_to: 'R1', request_id: asked.localId, text: 'Formulaire rempli.'}}});
        await until(() => server.replies().some(r => r.requestId === 'u3'), 'réponse');
        assert.deepEqual(plain(h.localData.agyChat.map(e => [e.kind, e.status || e.text])), [['ask', 'answered'], ['reply', 'Formulaire rempli.']]);
        assert.equal((await h.sendMessage({target: 'background', agyAsk: {text: ' '}})).error, 'Demande vide.');
        assert.deepEqual(plain(await h.sendMessage({target: 'background', agyClear: true})), {ok: true});
        assert.deepEqual(plain(h.localData.agyChat), []);
        // Jamais depuis une page web ni un script de contenu.
        assert.equal(await h.sendMessage({target: 'background', agyAsk: {text: 'x'}}, {id: EXT_ID, tab: {id: 1}}), undefined);
    } finally { stop(); }
});

test('panneau Antigravity : deux panneaux en même temps → une seule demande acceptée (test et réservation atomiques)', async () => {
    const h = harness();
    const [a, b] = await Promise.all([
        h.sendMessage({target: 'background', agyAsk: {text: 'A', tabId: 8}}),
        h.sendMessage({target: 'background', agyAsk: {text: 'B', tabId: 9}})
    ]);
    assert.equal([a, b].filter(r => r.localId).length, 1);
    assert.equal([a, b].filter(r => /une demande à la fois/.test(r.error || '')).length, 1);
    assert.equal(h.localData.agyChat.length, 1);
    assert.equal(Object.keys(h.sessionData.agyGrants).length, 1);
});

test('panneau Antigravity : pont injoignable → « Envoi… », aucun essai compté, renvoyée avec le même identifiant', async () => {
    const h = harness();
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Résume', tabId: null}});
    assert.equal(asked.sent, false);
    const [entry] = h.localData.agyChat;
    assert.equal(entry.status, 'sending');
    assert.equal(entry.tab, null);  // tabId null : aucune page, jamais l'onglet 0
    assert.equal(entry.attempts, 0);  // un envoi refusé localement ne compte pas
    assert.equal(await h.evalInContext('agyResendPending()'), 0);  // toujours pas de pont
    assert.equal(h.localData.agyChat[0].attempts, 0);
    assert.equal(h.localData.agyChat[0].localId, asked.localId);
});

test('panneau Antigravity : adoption issue du panneau = accord de CETTE demande, sur CET onglet et CETTE page', async () => {
    let url = 'https://dossiers.invalid/app#/fiche/A';
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url, title: 'Fiche', windowId: 10})}});
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7}});
    assert.ok(!JSON.stringify(h.localData.agyChat).includes('fiche/A'));  // l'adresse complète reste dans l'extension
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    const adopt = (params) => h.run('adopt_tab', {tabId: 7, ...params}, agy);
    // Route par fragment : #/fiche/B est un autre dossier.
    url = 'https://dossiers.invalid/app#/fiche/B';
    assert.match((await adopt({panelRequest: asked.localId})).error, /moved to another page/);
    url = 'https://dossiers.invalid/app#/fiche/A';
    assert.match((await adopt({panelRequest: 'autre-demande-0000'})).error, /no pending side panel request/);
    assert.match((await h.run('adopt_tab', {tabId: 8, panelRequest: asked.localId}, agy)).error, /was for tab 7/);
    assert.equal((await adopt({panelRequest: asked.localId})).data.adopted, true);
    // Déjà adopté puis navigation : le contrôle passe avant « already ».
    url = 'https://dossiers.invalid/app#/fiche/B';
    assert.match((await adopt({panelRequest: asked.localId})).error, /moved to another page/);
    // Accord expiré, ou effacé au rechargement de l'extension : refus explicite.
    h.sessionData.agyGrants[asked.localId].until = 0;
    url = 'https://dossiers.invalid/app#/fiche/A';
    assert.match((await adopt({panelRequest: asked.localId})).error, /expired/);
    delete h.sessionData.agyGrants;
    assert.match((await adopt({panelRequest: asked.localId})).error, /no pending side panel request/);
    // Hors panneau (Julien l'a demandé ailleurs) : aucun accord du panneau ne s'en mêle.
    assert.equal((await h.run('adopt_tab', {tabId: 12, julienAsked: true}, agy)).data.adopted, true);
});

test('panneau Antigravity : page changée pendant la frappe → rien ne part ; pendant l\'adoption → refusée et propriété retirée', async () => {
    let url = 'https://dossiers.invalid/fiche?id=A';
    let reads = 0;
    let afterReads = null;  // à partir de cette lecture, l'onglet affiche B (navigation pendant les attentes)
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => {
        reads++;
        return {id, url: afterReads !== null && reads >= afterReads ? 'https://dossiers.invalid/fiche?id=B' : url, title: 'Fiche', windowId: 10};
    }}});
    // Frappe sur A, l'onglet passe sur B avant l'envoi : le panneau envoie la page vue (expectUrl).
    url = 'https://dossiers.invalid/fiche?id=B';
    assert.match((await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: 'https://dossiers.invalid/fiche?id=A'}})).error, /changé de page depuis que vous avez commencé/);
    assert.equal((h.localData.agyChat || []).length, 0);
    url = 'https://dossiers.invalid/fiche?id=A';
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
    assert.ok(asked.localId);
    // Adoption : les premières lectures voient A, la dernière (après l'enregistrement de la propriété) voit B.
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    afterReads = reads + 3;  // résolution, lecture avant l'accord, relecture après l'enregistrement
    const res = await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy);
    assert.match(res.error, /moved to another page/);
    assert.deepEqual(Object.keys(h.owners()), []);  // propriété retirée
});

test('panneau Antigravity : Julien navigue lui-même ailleurs → onglet rendu ; le travail (lien, formulaire) continue', async () => {
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url: 'https://a.invalid/form', title: 'F', windowId: 10})}});
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: 'https://a.invalid/form'}});
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    assert.equal((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy)).data.adopted, true);
    assert.equal(h.owners()['7'].panelRequest, asked.localId);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 0, transitionType: "form_submit", transitionQualifiers: []})'), false);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 0, transitionType: "link", transitionQualifiers: []})'), false);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 1, transitionType: "typed", transitionQualifiers: []})'), false);
    assert.ok(h.owners()['7']);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 0, transitionType: "link", transitionQualifiers: ["forward_back"]})'), true);
    assert.deepEqual(Object.keys(h.owners()), []);
    assert.ok(h.detached.includes(7));
    // Onglet adopté hors panneau : jamais rendu par cette règle.
    assert.equal((await h.run('adopt_tab', {tabId: 9, julienAsked: true}, agy)).data.adopted, true);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 9, frameId: 0, transitionType: "typed", transitionQualifiers: []})'), false);
});

test('panneau Antigravity : identité d\'instance créée une seule fois, même par des appels simultanés', async () => {
    const h = harness();
    const [one, two, three] = await h.evalInContext('Promise.all([agyInstance(), agyInstance(), agyAskEvent({localId: "request-1234", text: "x", tab: null}).then(e => e.instance)])');
    assert.equal(one, two);
    assert.equal(two, three);
    assert.equal(h.localData.agyInstance, one);
});

test('panneau Antigravity : demande sans confirmation → reprise planifiée même panneau fermé', async () => {
    const h = harness();
    await h.sendMessage({target: 'background', agyAsk: {text: 'Résume', tabId: null}});
    assert.equal(h.evalInContext('agyResendTimer !== null'), true);
});

test('pastille et point du clic : seulement sur message de l\'extension, jamais sur un événement de la page', () => {
    const appended = [];
    const windowListeners = {};
    let listener = null;
    const node = () => ({style: {}, appendChild() {}, querySelector: () => ({textContent: ''}), parentNode: null});
    const win = {addEventListener: (type, fn) => { windowListeners[type] = fn; }, dispatchEvent() {}};
    win.top = win;
    const ctx = vm.createContext({
        window: win, document: {documentElement: {appendChild: (n) => appended.push(n)}, getElementById: () => null, createElement: node},
        chrome: {runtime: {id: EXT_ID, lastError: undefined, sendMessage() {}, onMessage: {addListener(fn) { listener = fn; }}}},
        requestAnimationFrame: () => 0, setTimeout: () => 0, clearTimeout() {}
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/content_script.js'), 'utf8'), ctx);
    assert.deepEqual(Object.keys(windowListeners), []);  // aucun écouteur d'événement de la page
    listener({nexusPill: {agent: 'Claude', text: 'Faux'}}, {id: EXT_ID, tab: {id: 3}});  // script de contenu ou page
    listener({nexusRipple: {x: 1, y: 2}}, {id: 'autre-extension'});
    assert.equal(appended.length, 0);
    listener({nexusPill: {agent: 'Claude', text: 'Onglet créé'}}, {id: EXT_ID});
    listener({nexusRipple: {x: 5, y: 6}}, {id: EXT_ID});
    assert.equal(appended.length, 2);
});
// =============================================================================
// Revue d'Antigravity du 17/10 (partie 2) : régressions de la 2.7.0
// =============================================================================
test('2.1 orphelins : processus disparu (signalé par le pont) -> onglets repris par le même agent ; jamais par un autre agent ; session vivante protégée', async () => {
    let next = 500;
    const h = harness({}, {autoOwn: false, tabs: {
        create: async (p) => ({id: next++, url: p.url, active: false, windowId: 10}),
        query: async () => [{id: 1, title: 'Julien'}, {id: 500, title: 'A1'}, {id: 501, title: 'A2'}, {id: 502, title: 'Vivant'}, {id: 503, title: 'Codex'}]
    }});
    const old = {agent: 'Claude', id: 'claude-ancienne-1'};
    const fresh = {agent: 'Claude', id: 'claude-nouvelle-2'};
    const alive = {agent: 'Claude', id: 'claude-vivante-3'};
    for (const client of [old, old, alive, AGENT_B]) await h.run('create_tab', {url: 'https://a.invalid', group: false}, client);
    // Serveur MCP redémarré : le pont signale que le processus de l'ancienne session ne tourne plus.
    const listed = (await h.run('list_tabs', {}, fresh, {gone: ['claude-ancienne-1']})).data;
    assert.deepEqual(plain(listed.map(t => [t.id, t.state, t.mine])),
        [[1, 'user', false], [500, 'orphan', false], [501, 'orphan', false], [502, 'other', false], [503, 'other', false]]);
    assert.ok(!JSON.stringify(listed).includes('claude-ancienne-1'));  // jamais l'identifiant d'une session
    // Un autre agent ne prend, ne ferme ni ne rend jamais l'orphelin de Claude.
    assert.deepEqual(plain((await h.run('list_tabs', {}, AGENT_B)).data.map(t => [t.id, t.state])),
        [[1, 'user'], [500, 'other'], [501, 'other'], [502, 'other'], [503, 'mine']]);
    for (const action of ['adopt_tab', 'close_tab', 'release_tab', 'click']) {
        assert.match((await h.run(action, {tabId: 500, selector: 'b'}, AGENT_B)).error || '', /driven by Claude: refused/, action);
    }
    // Commande de page sur l'orphelin sans le reprendre : refus qui dit comment faire, rien dans Chrome.
    assert.match((await h.run('click', {tabId: 500, selector: 'button'}, fresh)).error, /orphaned.*browser_adopt_tab\(tab_id\)/);
    assert.equal(h.calls.length, 0);
    // Reprise sans julien_asked, puis pilotage normal.
    const reclaimed = (await h.run('adopt_tab', {tabId: 500}, fresh)).data;
    assert.deepEqual(plain([reclaimed.reclaimed, reclaimed.owner, reclaimed.adopted]), [true, 'Claude', false]);
    assert.equal((await h.run('evaluate', {tabId: 500, code: '6 * 7'}, fresh)).data, 42);
    // Fermer ou rendre un orphelin du même agent : permis sans reprise.
    assert.equal((await h.run('release_tab', {tabId: 501}, fresh)).data.released, true);
    assert.deepEqual(Object.keys(h.owners()).sort(), ['500', '502', '503']);
    // Session vivante du même agent (autre conversation) : toujours protégée.
    for (const action of ['adopt_tab', 'close_tab', 'release_tab', 'evaluate']) {
        assert.match((await h.run(action, {tabId: 502, code: '1'}, fresh)).error || '', /Claude in another session: refused/, action);
    }
    assert.equal(h.owners()['502'].client, 'claude-vivante-3');
    // L'onglet de Julien reste soumis à julien_asked.
    assert.match((await h.run('adopt_tab', {tabId: 1}, fresh)).error, /refused by default/);
});

test('2.1 orphelins : fermeture permise, mort retenue après redémarrage du service worker, « gone » jamais lu dans les paramètres', async () => {
    let next = 520;
    const tabs = {create: async (p) => ({id: next++, url: p.url, active: false, windowId: 10}), query: async () => [{id: 520}, {id: 521}]};
    const old = {agent: 'Codex', id: 'codex-ancienne-1'};
    const fresh = {agent: 'Codex', id: 'codex-nouvelle-2'};
    const h = harness({}, {autoOwn: false, tabs});
    await h.run('create_tab', {url: 'https://a.invalid', group: false}, old);
    await h.run('create_tab', {url: 'https://b.invalid', group: false}, old);
    // Paramètre forgé : sans effet (seul le pont pose « gone », à côté de la commande).
    assert.match((await h.run('close_tab', {tabId: 520, gone: ['codex-ancienne-1']}, fresh)).error, /Codex in another session/);
    await h.run('list_tabs', {}, fresh, {gone: ['codex-ancienne-1', 'codex-nouvelle-2']});  // jamais soi-même
    assert.equal((await h.run('close_tab', {tabId: 520}, fresh)).data.closedTabId, 520);
    const restarted = harness({}, {autoOwn: false, tabs, sessionStorage: h.sessionData});
    assert.deepEqual(plain((await restarted.run('list_tabs', {}, fresh)).data.map(t => [t.id, t.state])), [[520, 'user'], [521, 'orphan']]);
    assert.equal((await restarted.run('adopt_tab', {tabId: 521}, fresh)).data.reclaimed, true);
    assert.equal((await restarted.run('evaluate', {tabId: 521, code: '1'}, fresh)).data, 1);
});

test('2.1 orphelins : silence de plus de 1,618 x 60 s -> session morte ; un battement garde la session vivante', async () => {
    const h = harness({}, {autoOwn: false, virtualTime: true, tabs: {
        create: async (p) => ({id: 600, url: p.url, active: false, windowId: 10}), query: async () => [{id: 600}]
    }});
    const quiet = {agent: 'Antigravity', id: 'antigravity-silence-1'};
    const fresh = {agent: 'Antigravity', id: 'antigravity-nouvelle-2'};
    await h.run('create_tab', {url: 'https://a.invalid', group: false}, quiet);
    h.advanceTime(60000);
    assert.match((await h.run('adopt_tab', {tabId: 600}, fresh)).error, /in another session/);
    assert.equal((await h.run('heartbeat', {}, quiet)).data.alive, true);  // battement à 60 s
    h.advanceTime(80000);  // 140 s depuis l'ouverture, 80 s depuis le battement : encore vivante
    assert.match((await h.run('adopt_tab', {tabId: 600}, fresh)).error, /in another session/);
    h.advanceTime(30000);  // 110 s sans signe de vie (plus de 97 s) : morte
    assert.equal((await h.run('list_tabs', {}, fresh)).data[0].state, 'orphan');
    assert.equal((await h.run('adopt_tab', {tabId: 600}, fresh)).data.reclaimed, true);
    assert.equal(h.owners()['600'].client, 'antigravity-nouvelle-2');
    // L'ancienne session qui revient (fausse alerte) ne reprend pas l'onglet d'une session vivante.
    assert.match((await h.run('adopt_tab', {tabId: 600}, quiet)).error, /in another session/);
});

test('2.1 démarrage : le premier battement reprend les orphelins de l\'agent s\'il n\'en a aucun ; jamais ceux d\'un autre agent ni d\'une session vivante', async () => {
    let next = 700;
    const h = harness({}, {autoOwn: false, tabs: {create: async (p) => ({id: next++, url: p.url, active: false, windowId: 10}), query: async () => []}});
    const old = {agent: 'Claude', id: 'claude-ancienne-1'};
    const deadCodex = {agent: 'Codex', id: 'codex-ancienne-9'};
    const alive = {agent: 'Claude', id: 'claude-vivante-3'};
    for (const client of [old, old, deadCodex, alive]) await h.run('create_tab', {url: 'https://a.invalid', group: false}, client);
    await h.run('list_tabs', {}, AGENT_B, {gone: ['codex-ancienne-9']});
    const busy = {agent: 'Claude', id: 'claude-occupee-4'};
    await h.own(710, busy);  // une session qui a déjà un onglet ne reprend rien
    assert.deepEqual(plain((await h.run('heartbeat', {reclaim: true}, busy, {gone: ['claude-ancienne-1']})).data.reclaimed), []);
    const fresh = {agent: 'Claude', id: 'claude-nouvelle-2'};
    const beat = (await h.run('heartbeat', {reclaim: true}, fresh)).data;
    assert.deepEqual(plain(beat.reclaimed), [700, 701]);
    assert.equal(beat.sessionDeadAfterS, 97);
    const owners = h.owners();
    assert.deepEqual(plain([owners['700'].client, owners['701'].client, owners['702'].client, owners['703'].client]),
        ['claude-nouvelle-2', 'claude-nouvelle-2', 'codex-ancienne-9', 'claude-vivante-3']);
    assert.deepEqual(plain((await h.run('heartbeat', {reclaim: true}, {agent: 'Claude', id: 'claude-autre-5'})).data.reclaimed), []);
    // Battement permis pendant l'arrêt d'urgence (aucune action de page).
    await h.sendMessage({target: 'background', panelStop: true});
    assert.equal((await h.run('heartbeat', {}, fresh)).data.alive, true);
    // Poste de contrôle : l'orphelin restant est signalé.
    const state = await h.sendMessage({target: 'background', getControlState: true});
    assert.deepEqual(plain(state.tabs.filter(t => t.orphan).map(t => t.tabId)), [702]);
});

test('2.1 poste de contrôle : badge « orphelin »', () => {
    const view = sidepanelView();
    const line = plain(view.describeTab({tabId: 4, agent: 'Claude', title: 'T', url: 'https://a.invalid/', session: '1', exists: true, debugger: false, orphan: true}));
    assert.ok(line.badges.includes('orphelin (session terminée)'));
});

test('2.2 cdp_send Runtime.evaluate : monde de la PAGE sur demande explicite (world="page"), monde isolé par défaut', async () => {
    const h = harness({window: {dispatchEvent() {}, __INITIAL_STATE__: {user: 'julien'}}});
    const expression = 'typeof window.__INITIAL_STATE__ === "object" ? window.__INITIAL_STATE__.user : "invisible"';
    const isolated = await h.run('cdp_send', {tabId: 1, method: 'Runtime.evaluate', commandParams: {expression, returnByValue: true}});
    assert.equal(isolated.data.result.value, 'invisible');
    const page = await h.run('cdp_send', {tabId: 1, method: 'Runtime.evaluate', world: 'page', commandParams: {
        expression, returnByValue: true, contextId: 1000, uniqueContextId: 'x', includeCommandLineAPI: true
    }});
    assert.equal(page.data.result.value, 'julien');
    assert.equal(page.data.world, 'page');
    const call = h.calls.filter(c => c.method === 'Runtime.evaluate').at(-1);
    assert.equal(call.params.contextId, undefined);  // contexte par défaut du cadre principal : la page
    assert.equal(call.params.uniqueContextId, undefined);
    assert.equal(call.params.includeCommandLineAPI, false);
    assert.match((await h.run('cdp_send', {tabId: 1, method: 'Runtime.evaluate', world: 'main', commandParams: {expression: '1'}})).error, /Invalid world/);
    assert.match((await h.run('cdp_send', {tabId: 1, method: 'DOM.getDocument', world: 'page'})).error, /applies only to Runtime.evaluate/);
    assert.match((await h.run('cdp_send', {tabId: 1, method: 'Page.navigate', world: 'page', commandParams: {url: 'file:///C:/'}})).error, /CDP command refused/);
});

test('2.3 cookies : include_values seulement pour localhost, 127.0.0.1, [::1], *.localhost, *.test ; valeurs des seuls domaines locaux', async () => {
    const jar = [
        {name: 'csrftoken', value: 'csrf-local-1', domain: 'localhost'}, {name: 'dev', value: 'dev-2', domain: '.app.test'},
        {name: 'SID', value: 'google-secret', domain: '.google.com'}
    ];
    let tabUrl = 'http://localhost:8000/app';
    const h = harness({}, {
        tabs: {get: async (id) => ({id, url: tabUrl, windowId: 10})},
        debuggerSendCommand: async (target, method) => method === 'Network.getCookies' ? {cookies: jar} : undefined
    });
    const res = await h.run('get_cookies', {tabId: 1, includeValues: true});
    assert.equal(res.data.valuesIncluded, true);
    assert.deepEqual(plain(res.data.cookies.map(c => [c.name, 'value' in c ? c.value : 'sans valeur'])),
        [['csrftoken', 'csrf-local-1'], ['dev', 'dev-2'], ['SID', 'sans valeur']]);
    assert.ok(!JSON.stringify(res).includes('google-secret'));
    for (const url of ['http://127.0.0.1:5000/', 'http://[::1]:8080/', 'https://api.localhost/', 'http://site.test/x']) {
        assert.equal((await h.run('get_cookies', {tabId: 1, includeValues: true, urls: [url]})).data.valuesIncluded, true, url);
    }
    for (const url of ['https://localhost.evil.com/', 'http://127.0.0.1.nip.io/', 'https://test.example.com/', 'file:///C:/x', 'http://127.0.0.2/']) {
        assert.match((await h.run('get_cookies', {tabId: 1, includeValues: true, urls: [url]})).error, /local development origin/, url);
    }
    tabUrl = 'https://mail.google.com/';
    assert.match((await h.run('get_cookies', {tabId: 1, include_values: true})).error, /local development origin/);
    assert.equal((await h.run('get_cookies', {tabId: 1})).data.valuesIncluded, false);
});

test('2.4 réseau : pagination et compteurs de jetons jamais masqués (Google, OpenAI, Gemini, Anthropic), secrets toujours masqués', async () => {
    const bodies = {
        drive: JSON.stringify({kind: 'drive#fileList', nextPageToken: '~!!~AI9FV7Tp0Wq3bXk1mZ8sYv2cRtNh4LgEe', incompleteSearch: false, files: [{id: '1a', name: 'Rapport'}]}),
        youtube: ")]}'\n" + JSON.stringify({nextPageToken: 'CAUQAA', prevPageToken: 'CAoQAQ', pageInfo: {totalResults: 42}}),
        calendar: JSON.stringify({nextSyncToken: 'CPDAlvWDx70CEPDAlvWDx70CGAU=', items: []}), // gitleaks:allow (fake value)
        aws: JSON.stringify({NextToken: 'eyJleGNsdXNpdmVTdGFydEtleSI6bnVsbH0=', continuation_token: 'c2', cursor: 'abc'}), // gitleaks:allow (fake value)
        openai: JSON.stringify({id: 'chatcmpl-1', usage: {prompt_tokens: 9, completion_tokens: 12, total_tokens: 21,
            prompt_tokens_details: {cached_tokens: 0}, completion_tokens_details: {reasoning_tokens: 4}}, max_tokens: 100}),
        responses: JSON.stringify({usage: {input_tokens: 10, output_tokens: 5, input_tokens_details: {cached_tokens: 2}, cache_read_input_tokens: 0}}),
        gemini: JSON.stringify({usageMetadata: {promptTokenCount: 8, candidatesTokenCount: 20, totalTokenCount: 28}, generationConfig: {maxOutputTokens: 256}}),
        meta: JSON.stringify({tokenizer: 'cl100k_base', token_count: 12, tokens_used: '12', token_type: 'Bearer', expires_at: 1760000000}),
        oauth: JSON.stringify({access_token: 'ya29.a0AfH6SMBSECRETA', expires_in: 3599, refresh_token: '1//0gSECRETB', scope: 'email', // gitleaks:allow (fake value)
            token_type: 'Bearer', id_token: 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.SECRETC'}), // gitleaks:allow (fake value)
        ambiguous: JSON.stringify({resumeToken: 'Zx9Kq2Lm8Np4Rt6Vw1SECRETD', sessionCount: 3, sessionState: {active: true}, // gitleaks:allow (fake value)
            pageToken: 'ghp_SECRETEabcdefghijklmnopqrstuvwxyz01', access_tokens: ['SECRETF'], deviceTokens: ['SECRETG'], token: 'SECRETH'}),
        form: 'pageToken=CAUQAA&max_tokens=100&access_token=SECRETI&nextPageToken=CAoQAQ',
        cut: '{"nextPageToken":"CAUQAA","total_tokens":21,"refresh_token":"SECRETJ","items":[1'
    };
    const mimes = {form: 'application/x-www-form-urlencoded'};
    const h = harness({}, {debuggerSendCommand: (target, method, params) => method === 'Network.getResponseBody' ? {body: bodies[params.requestId], base64Encoded: false} : undefined});
    await h.run('evaluate', {tabId: 1, code: '1'});
    for (const id of Object.keys(bodies)) {
        await h.emit(1, 'Network.requestWillBeSent', {requestId: id, timestamp: 1, request: {url: `https://x.invalid/${id}`, method: 'GET', headers: {}}});
        await h.emit(1, 'Network.responseReceived', {requestId: id, response: {status: 200, mimeType: mimes[id] || 'application/json', headers: {}}});
        await h.emit(1, 'Network.loadingFinished', {requestId: id, timestamp: 2, encodedDataLength: 10});
    }
    const read = async (id) => (await h.run('network_response', {tabId: 1, request_id: id})).data;
    const json = async (id) => { const body = (await read(id)).body; return JSON.parse(body.replace(/^\)\]\}'\n/, '')); };
    for (const id of ['drive', 'youtube', 'calendar', 'aws', 'openai', 'responses', 'gemini', 'meta']) {
        assert.deepEqual(await json(id), JSON.parse(bodies[id].replace(/^\)\]\}'\n/, '')), id);  // intact
        assert.equal((await read(id)).masked, 0, id);
    }
    const oauth = await json('oauth');
    assert.deepEqual(plain([oauth.expires_in, oauth.token_type, oauth.scope]), [3599, 'Bearer', 'email']);
    const ambiguous = await json('ambiguous');
    assert.deepEqual(plain([ambiguous.sessionCount, ambiguous.sessionState]), [3, {active: true}]);
    assert.equal((await read('ambiguous')).masked, 5);  // resumeToken, pageToken (format GitHub), access_tokens, deviceTokens, token
    assert.equal((await read('form')).body, 'pageToken=CAUQAA&max_tokens=100&access_token=[masked]&nextPageToken=CAoQAQ');
    const cut = (await read('cut')).body;
    assert.match(cut, /"nextPageToken":"CAUQAA","total_tokens":21,"refresh_token":"\[masked, 7 chars\]"/);
    for (const id of Object.keys(bodies)) {
        const raw = JSON.stringify(await read(id));
        for (const letter of 'ABCDEFGHIJ') assert.ok(!raw.includes(`SECRET${letter}`), `${id} : SECRET${letter}`);
    }
});

test('2.x capacités annoncées par ping (validation réelle : extension rechargée)', async () => {
    const h = harness();
    const features = (await h.run('ping', {})).data.features;
    for (const f of ['orphan-tabs', 'cdp-page-world', 'local-cookie-values', 'body-masking-allowlist']) assert.ok(features.includes(f), f);
});

// =============================================================================
// 2.8 : valeurs des mots de passe, codes et cartes jamais renvoyées ; aucun script injecté par Page.reload.
// =============================================================================
const SECRET_VALUES = ['MotDePasse!1', 'Visible!2', 'Nouveau!3', 'Otp482913', 'Carte4970101234567890', 'Cvc737'];
const secretPage = (h) => [
    h('label', {for: 'user'}, 'Identifiant'), h('input', {id: 'user', value: 'julien'}),
    h('label', {for: 'pw'}, 'Mot de passe'), h('input', {id: 'pw', type: 'password', value: 'MotDePasse!1'}),
    // Champ passé en type=text par un bouton « afficher » : reconnu par son autocomplete.
    h('label', {for: 'shown'}, 'Mot de passe affiché'), h('input', {id: 'shown', autocomplete: 'current-password', value: 'Visible!2'}),
    h('input', {id: 'new', autocomplete: 'section-a new-password', 'aria-label': 'Nouveau', value: 'Nouveau!3'}),
    h('input', {id: 'otp', autocomplete: 'one-time-code', 'aria-label': 'Code reçu', value: 'Otp482913'}),
    h('input', {id: 'card', autocomplete: 'cc-number', 'aria-label': 'Numéro de carte', value: 'Carte4970101234567890'}),
    h('input', {id: 'cvc', autocomplete: 'billing cc-csc', 'aria-label': 'Cryptogramme', value: 'Cvc737'})
];
const leaks = (res) => SECRET_VALUES.filter(v => JSON.stringify(res).includes(v));

test('2.8 content et vision_inspect : jamais la valeur d\'un mot de passe, d\'un code ou d\'une carte (« [valeur masquée] »)', async () => {
    const {h, dom} = richHarness(secretPage);
    dom.win.location = {href: 'https://compte.example.invalid/connexion'};
    const content = await h.run('get_content', {tabId: 1, mode: 'interactive'});
    assert.deepEqual(leaks(content), []);
    const byId = Object.fromEntries(content.data.elements.map(e => [e.id, e]));
    for (const id of ['pw', 'shown', 'new', 'otp', 'card', 'cvc']) assert.equal(byId[id].value, '[masked value]', id);
    assert.equal(byId.user.text, 'julien');  // champ ordinaire : valeur gardée
    assert.equal(byId.new.text, 'Nouveau');  // libellé à la place de la valeur
    dom.doc.createElement = () => ({style: {}, remove() {}});
    dom.html.appendChild = () => {};
    const vision = await h.run('vision_inspect', {tabId: 1});
    assert.deepEqual(leaks(vision), []);
    assert.ok(vision.data.markers.filter(m => m.value === '[masked value]').length >= 6);
    const found = await h.run('find', {tabId: 1, locator: {label: 'Mot de passe'}});
    assert.equal(found.data.count, 2);
    assert.ok(found.data.candidates.every(c => c.value === '[masked value]'));
    assert.deepEqual(leaks(found), []);
    assert.equal((await h.run('find', {tabId: 1, locator: {label: 'Identifiant'}})).data.candidates[0].value, 'julien');
});

test('2.8 content html : attribut value d\'un champ sensible masqué dans une copie, page intacte', async () => {
    const input = (attrs) => ({tagName: 'INPUT', attrs: {...attrs}, get type() { return this.attrs.type || 'text'; },
        getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, setAttribute(n, v) { this.attrs[n] = String(v); }});
    const page = [input({type: 'password', value: 'MotDePasse!1'}), input({autocomplete: 'cc-csc', value: 'Cvc737'}), input({value: 'julien'})];
    const render = (list) => '<html><body>' + list.map(i => `<input${Object.entries(i.attrs).map(([k, v]) => ` ${k}="${v}"`).join('')}>`).join('') + '</body></html>';
    const copy = page.map(i => input(i.attrs));
    const h = harness({document: {documentElement: {
        get outerHTML() { return render(page); },
        cloneNode: (deep) => ({querySelectorAll: (sel) => (deep && sel === '[value]' ? copy : []), get outerHTML() { return render(copy); }})
    }}});
    const res = await h.run('get_content', {tabId: 1, mode: 'html'});
    assert.deepEqual(leaks(res), []);
    assert.match(res.data, /type="password" value="\[masked value\]"/);
    assert.match(res.data, /value="julien"/);
    assert.equal(page[0].attrs.value, 'MotDePasse!1');  // la page n'est pas modifiée
});

test('2.8 fill dans un mot de passe : frappe réelle et relue, valeur jamais renvoyée (ni attendue, ni repli JavaScript)', async () => {
    const {h, dom} = richHarness(secretPage);
    const res = await h.run('fill', {tabId: 1, selector: '#pw', value: 'NouveauSecret!7'});
    assert.equal(res.data.verified, true);
    assert.equal(res.data.value, '[masked value]');
    assert.equal(dom.byId('pw').value, 'NouveauSecret!7');
    assert.ok(!JSON.stringify(res).includes('NouveauSecret!7'));
    // Valeur réécrite par la page : non vérifiée, ni la valeur relue ni l'attendue ne sortent.
    dom.byId('card').hooks.input = () => { dom.byId('card')._value = dom.byId('card')._value.replace(/\s/g, ''); };
    const card = await h.run('fill', {tabId: 1, selector: '#card', value: '4970 1012'});
    assert.equal(card.data.verified, false);
    assert.equal(card.data.value, '[masked value]');
    assert.equal(card.data.expected, '[masked value]');
    assert.ok(!JSON.stringify(card).includes('4970'));
    const plainField = await h.run('fill', {tabId: 1, selector: '#user', value: 'julien.piron'});
    assert.equal(plainField.data.value, 'julien.piron');  // champ ordinaire : valeur relue renvoyée
    const dom2 = richDom(secretPage);
    const h2 = harness(dom2.page, {attachError: 'Cannot attach to this target.'});
    const fallback = await h2.run('fill', {tabId: 1, selector: '#otp', value: 'Otp999111'});
    assert.equal(fallback.data.method, 'js_fallback');
    assert.equal(fallback.data.value, '[masked value]');
    assert.equal(dom2.byId('otp').value, 'Otp999111');
    assert.ok(!JSON.stringify(fallback).includes('Otp999111'));
});

test('2.8 cdp_send Page.reload : scriptToEvaluateOnLoad refusé avant Chrome, rechargement simple permis', async () => {
    const h = harness();
    for (const script of ['alert(document.cookie)', '', null]) {
        const res = await h.run('cdp_send', {tabId: 1, method: 'Page.reload', commandParams: {ignoreCache: true, scriptToEvaluateOnLoad: script}});
        assert.match(res.error || '', /CDP command refused: Page\.reload with scriptToEvaluateOnLoad/, String(script));
    }
    assert.equal(h.calls.length, 0);  // rien n'a atteint Chrome
    assert.equal((await h.run('cdp_send', {tabId: 1, method: 'Page.reload', commandParams: {ignoreCache: true}})).error, undefined);
    const reload = h.calls.filter(c => c.method === 'Page.reload');
    assert.equal(reload.length, 1);
    assert.deepEqual(plain(reload[0].params), {ignoreCache: true});
});

test('2.8 capacités annoncées par ping : masquage des champs sensibles, Page.reload sans script', async () => {
    const features = (await harness().run('ping', {})).data.features;
    for (const f of ['sensitive-field-masking', 'cdp-reload-no-script', 'ax-value-masking']) assert.ok(features.includes(f), f);
});

test('2.8 axtree : valeur d\'une carte ou d\'un code masquée (Chrome ne masque que les mots de passe), champ ordinaire gardé', async () => {
    const dom = {
        11: {nodeName: 'INPUT', attributes: ['id', 'card', 'autocomplete', 'cc-number']},
        12: {nodeName: 'INPUT', attributes: ['id', 'otp', 'AUTOCOMPLETE', 'one-time-code']},
        13: {nodeName: 'INPUT', attributes: ['id', 'user', 'type', 'text']},
        14: {nodeName: 'INPUT', attributes: ['type', 'PASSWORD']}
    };
    const ax = [
        // Vu dans Chrome : la valeur est répétée comme nom des nœuds de texte du champ (StaticText puis InlineTextBox).
        {nodeId: '1', role: {value: 'textbox'}, name: {value: 'Carte'}, value: {value: 'Carte4970101234567890'}, backendDOMNodeId: 11, childIds: ['1a']},
        {nodeId: '1a', role: {value: 'StaticText'}, name: {value: 'Carte4970101234567890'}, backendDOMNodeId: 21, childIds: ['1b']},
        {nodeId: '1b', role: {value: 'InlineTextBox'}, name: {value: 'Carte4970101234567890'}},
        {nodeId: '3a', role: {value: 'StaticText'}, name: {value: 'Texte de la page'}, backendDOMNodeId: 23},
        {nodeId: '2', role: {value: 'textbox'}, name: {value: 'Code'}, value: {value: 'Otp482913'}, backendDOMNodeId: 12},
        {nodeId: '3', role: {value: 'textbox'}, name: {value: 'Identifiant'}, value: {value: 'julien'}, backendDOMNodeId: 13},
        {nodeId: '4', role: {value: 'textbox'}, name: {value: 'Mot de passe'}, value: {value: 'MotDePasse!1'}, backendDOMNodeId: 14},
        {nodeId: '5', role: {value: 'textbox'}, name: {value: 'Illisible'}, value: {value: 'Cvc737'}, backendDOMNodeId: 99}
    ];
    const h = harness({}, {debuggerSendCommand: async (target, method, params) => {
        if (method === 'Accessibility.getFullAXTree') return {nodes: ax};
        if (method === 'DOM.describeNode') {
            if (!dom[params.backendNodeId]) throw new Error('No node with given id found');
            return {node: dom[params.backendNodeId]};
        }
        return undefined;
    }});
    const res = await h.run('axtree', {tabId: 1});
    assert.deepEqual(leaks(res), []);
    assert.deepEqual(plain(res.data.nodes.filter(n => n.nodeId.startsWith('1')).map(n => [n.role, n.name])),
        [['textbox', 'Carte'], ['StaticText', '[masked value]'], ['InlineTextBox', '[masked value]']]);
    assert.equal(res.data.nodes.find(n => n.nodeId === '3a').name, 'Texte de la page');
    const values = Object.fromEntries(res.data.nodes.filter(n => n.role === 'textbox').map(n => [n.name, n.value]));
    assert.deepEqual(plain(values), {Carte: '[masked value]', Code: '[masked value]', Identifiant: 'julien',
        'Mot de passe': '[masked value]', Illisible: '[masked value]'});
});

test('2.8 revue d\'Antigravity : texte rendu d\'un champ sensible, bouton « afficher » sans autocomplete, composants', async () => {
    const page = (h) => [
        h('textarea', {id: 'ta', autocomplete: 'current-password', 'aria-label': 'Secret'}, 'TexteSecret!4'),
        h('input', {id: 'password', name: 'password', type: 'text', value: 'Affiche!5'}),
        h('input', {id: 'mdp-champ', value: 'Mdp!6'}),
        h('input', {id: 'pass-hint', name: 'passenger', value: 'Julien Voyageur'}),
        h('div', {id: 'zone-password', role: 'button'}, 'Section mot de passe')
    ];
    const {h, dom} = richHarness(page);
    dom.win.location = {href: 'https://compte.example.invalid/'};
    const raw = JSON.stringify(await h.run('get_content', {tabId: 1, mode: 'interactive'}));
    for (const secret of ['TexteSecret!4', 'Affiche!5', 'Mdp!6']) assert.ok(!raw.includes(secret), secret);
    assert.ok(raw.includes('Julien Voyageur'));  // « passenger » n'est pas un mot de passe
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Section mot de passe'}});
    assert.equal(found.data.count, 1);  // un conteneur nommé « password » n'est pas un champ
    // Arbre AX : composant (non-input) porteur d'un autocomplete de carte.
    const ax = [{nodeId: '1', role: {value: 'textbox'}, name: {value: 'Carte'}, value: {value: 'Carte4970101234567890'}, backendDOMNodeId: 7}];
    const h2 = harness({}, {debuggerSendCommand: async (target, method) => {
        if (method === 'Accessibility.getFullAXTree') return {nodes: ax};
        if (method === 'DOM.describeNode') return {node: {nodeName: 'STRIPE-CARD-NUMBER', attributes: ['autocomplete', 'cc-number']}};
        return undefined;
    }});
    assert.equal((await h2.run('axtree', {tabId: 1})).data.nodes[0].value, '[masked value]');
    // HTML : attribut value d'un composant sensible.
    const comp = {tagName: 'X-CARD', attrs: {autocomplete: 'cc-csc', value: 'Cvc737'},
        getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }, setAttribute(n, v) { this.attrs[n] = String(v); }};
    const h3 = harness({document: {documentElement: {cloneNode: () => ({
        querySelectorAll: (sel) => (sel === '[value]' ? [comp] : []), get outerHTML() { return `<x-card value="${comp.attrs.value}">`; }
    })}}});
    assert.equal((await h3.run('get_content', {tabId: 1, mode: 'html'})).data, '<x-card value="[masked value]">');
});

// =============================================================================
// 2.9 : audit du 18/10 (images, noms de champs, console, journal réseau).
// =============================================================================
const kit = vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'extension', 'locator_kit.js'), 'utf8') + ';agyLocatorKit()');

for (const name of ['cardNumber', 'card_number', 'card-number', 'cc_number', 'ccNumber', 'cc-num', 'creditCardNumber',
    'cardCvc', 'cvc', 'CVV', 'cvv2', 'billing_csc', 'otp', 'otpCode', 'totp', 'pin', 'userPIN', 'pinCode', 'pincode',
    'securityCode', 'security_code', 'iban', 'ibanField', 'password', 'mdp', 'motDePasse', 'passcode']) {
    test(`2.9 champ sensible reconnu par son nom : ${name}`, () => {
        assert.equal(kit.sensitiveName(name), true, name);
        assert.equal(kit.sensitiveField({tagName: 'INPUT', type: 'text', getAttribute: (n) => (n === 'name' ? name : null)}), true);
        assert.equal(kit.sensitiveField({tagName: 'INPUT', type: 'text', getAttribute: (n) => (n === 'id' ? name : null)}), true);
    });
}

test('2.9 noms ordinaires jamais pris pour un secret (cc d\'un courriel, spinner, option, passager...)', () => {
    for (const name of ['cc', 'email_cc', 'ccRecipients', 'spinner', 'shipping', 'option', 'footprint', 'opinion',
        'passenger', 'cardHolder', 'card_name', 'pinned', 'pinterest', 'description', 'zipCode', 'codePostal', 'search']) {
        assert.equal(kit.sensitiveName(name), false, name);
    }
});

test('2.9 capture, PDF, vision et cdp_send : champs sensibles en disques pendant l\'image, style d\'origine remis', async () => {
    const page = (h) => [
        h('input', {id: 'shown', name: 'password', type: 'text', value: 'Affiche!5'}),
        h('input', {id: 'card', name: 'cardNumber', value: '4970101234567890'}),
        h('input', {id: 'otp', name: 'otp', value: '482913'}),
        h('input', {id: 'pw', type: 'password', value: 'MotDePasse!1'}),
        h('input', {id: 'user', name: 'username', value: 'julien'})
    ];
    const style = (init = {}) => {
        const props = {...init};
        return {props, getPropertyValue: (p) => (props[p] ? props[p][0] : ''), getPropertyPriority: (p) => (props[p] ? props[p][1] : ''),
            setProperty(p, v, prio = '') { props[p] = [v, prio]; }, removeProperty(p) { delete props[p]; }};
    };
    let seen = [];
    let dom;
    const ids = ['shown', 'card', 'otp', 'pw', 'user'];
    const snapshot = () => Object.fromEntries(ids.map(id => [id, dom.byId(id).style.getPropertyValue('-webkit-text-security')]));
    const r = richHarness(page, {debuggerSendCommand: async (target, method) => {
        if (method === 'Page.captureScreenshot' || method === 'Page.printToPDF') { seen.push([method, snapshot()]); return {data: 'AAAA'}; }
        return undefined;
    }});
    dom = r.dom;
    dom.win.location = {href: 'https://boutique.example.invalid/paiement'};
    for (const id of ['shown', 'otp', 'pw', 'user']) dom.byId(id).style = style();
    dom.byId('card').style = style({'-webkit-text-security': ['circle', '']});
    const masked = {shown: 'disc', card: 'disc', otp: 'disc', pw: '', user: ''};
    const runs = [['screenshot', {}], ['screenshot', {selector: '#card'}], ['pdf', {}], ['vision_inspect', {}],
        ['cdp_send', {method: 'Page.captureScreenshot', commandParams: {}}], ['cdp_send', {method: 'Page.printToPDF', commandParams: {}}]];
    for (const [cmd, params] of runs) {
        seen = [];
        if (cmd === 'vision_inspect') { dom.doc.createElement = () => ({style: {}, remove() {}}); dom.html.appendChild = () => {}; }
        const res = await r.h.run(cmd, {tabId: 1, ...params});
        assert.equal(res.error, undefined, `${cmd} ${JSON.stringify(res.error)}`);
        assert.equal(seen.length, 1, cmd);
        assert.deepEqual(plain(seen[0][1]), masked, cmd);
        assert.deepEqual(plain(snapshot()), {shown: '', card: 'circle', otp: '', pw: '', user: ''}, `${cmd} : style remis`);
    }
});

test('2.9 browser_logs : console masquée (texte, aperçus d\'objets, jetons cités, cartes), messages ordinaires gardés', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.emit(1, 'Runtime.consoleAPICalled', {type: 'log', args: [
        {type: 'string', value: 'Connexion avec Authorization: Bearer abcdefgh12345678 ok'},
        {type: 'string', value: '{"access_token":"SECRETJSON1","user":"julien"}'},
        {type: 'string', value: 'redirection /cb?code=SECRETURL2&state=ok'},
        {type: 'object', preview: {properties: [{name: 'password', type: 'string', value: 'SECRETPW3'},
            {name: 'cardNumber', type: 'string', value: '4970101234567890'}, {name: 'langue', type: 'string', value: 'fr'}]}},
        {type: 'string', value: 'jeton ghp_ABCDEFGHIJKLMNOP1234 visible'}
    ]});
    await h.emit(1, 'Log.entryAdded', {entry: {level: 'info', text: 'Bonjour Julien', url: 'https://x.invalid/a?token=SECRETLOG4&page=2'}});
    const res = await h.run('logs', {tabId: 1});
    const raw = JSON.stringify(res);
    for (const secret of ['abcdefgh12345678', 'SECRETJSON1', 'SECRETURL2', 'SECRETPW3', '4970101234567890', 'ghp_ABCDEFGHIJKLMNOP1234', 'SECRETLOG4']) {
        assert.ok(!raw.includes(secret), secret);
    }
    for (const kept of ['julien', 'state=ok', 'langue', '"fr"', 'Bonjour Julien', 'page=2']) assert.ok(raw.includes(kept), kept);
});

test('2.9 journal réseau : carte, cryptogramme, code et IBAN masqués dans les corps et les URL', async () => {
    const body = JSON.stringify({cardNumber: '4970101234567890', card_cvc: '737', securityCode: '123', otp: '482913',
        iban: 'FR7630006000011234567890189', amount: 42, pin: 1234});
    const h = harness({}, {debuggerSendCommand: (target, method) => method === 'Network.getResponseBody' ? {body, base64Encoded: false} : undefined});
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'pay', timestamp: 1,
        request: {url: 'https://x.invalid/pay?cc_number=4970101234567890&lang=fr', method: 'POST', headers: {}}});
    await h.emit(1, 'Network.responseReceived', {requestId: 'pay', response: {status: 200, mimeType: 'application/json', headers: {}}});
    await h.emit(1, 'Network.loadingFinished', {requestId: 'pay', timestamp: 2, encodedDataLength: 10});
    const read = (await h.run('network_response', {tabId: 1, request_id: 'pay'})).data;
    const parsed = JSON.parse(read.body);
    for (const key of ['cardNumber', 'card_cvc', 'securityCode', 'otp', 'iban', 'pin']) assert.match(String(parsed[key]), /^\[masked/, key);
    assert.equal(parsed.amount, 42);
    const list = (await h.run('network_requests', {tabId: 1})).data.requests;
    assert.equal(list[0].url, 'https://x.invalid/pay?cc_number=[masked]&lang=fr');
});

// =============================================================================
// 4e relecture de Codex (18/10) : cible figée, marqueur du panneau, navigations dans le même document, profils
// =============================================================================
function fakeNode() {
    const listeners = {};
    return {
        listeners, style: {}, dataset: {}, hidden: false, value: '', textContent: '', title: '', disabled: false, scrollHeight: 20,
        classList: {add() {}, remove() {}, toggle() {}, contains: () => false},
        addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
        setAttribute() {}, appendChild(child) { return child; }, append() {}, prepend() {}, replaceChildren() {},
        focus() {}, setSelectionRange() {}, remove() {}, scrollIntoView() {}, scrollTo() {},
        querySelector: () => fakeNode(), querySelectorAll: () => []
    };
}

/** Le vrai panneau (agy_chat.js, sidepanel_view.js, sidepanel.js) avec un DOM et les API Chrome simulés. */
function panelHarness(onAsk) {
    const nodes = {};
    const tabEvents = {};
    const state = {tab: null, asks: []};
    const event = (name) => ({addListener(fn) { tabEvents[name] = fn; }});
    const chrome = {
        runtime: {
            lastError: undefined,
            sendMessage(message, callback) {
                if (message.agyAsk) {
                    state.asks.push(message.agyAsk);
                    Promise.resolve(onAsk(message)).then((res) => callback(res || {}));
                } else callback({});
            }
        },
        storage: {local: {get: async () => ({})}, onChanged: {addListener() {}}},
        tabs: {
            query: async () => (state.tab ? [state.tab] : []),
            get: async (id) => ({...state.tab, id}),
            onActivated: event('activated'), onUpdated: event('updated'), onRemoved: event('removed')
        }
    };
    let ready = null;
    const document = {
        getElementById: (id) => (nodes[id] ||= fakeNode()),
        createElement: () => fakeNode(), createElementNS: () => fakeNode(), querySelectorAll: () => [],
        addEventListener(type, fn) { if (type === 'DOMContentLoaded') ready = fn; }
    };
    const ctx = vm.createContext({document, chrome, URL, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, Date});
    ctx.globalThis = ctx;
    for (const file of ['agy_chat.js', 'sidepanel_view.js', 'sidepanel.js']) {
        vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension', file), 'utf8'), ctx);
    }
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
    return {
        state, nodes, tabEvents, settle,
        start: async () => { ready(); await settle(); },
        fire: async (id, type, eventObject = {preventDefault() {}}) => {
            for (const fn of nodes[id].listeners[type] || []) fn(eventObject);
            await settle();
        }
    };
}

const settleWorker = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };

test('panneau Antigravity (Codex 4e passe, P1) : l\'onglet figé change de page pendant la frappe → l\'URL attendue reste celle de la frappe, refus et aucun dépôt', async () => {
    const A = 'https://dossiers.invalid/fiche?id=A';
    const B = 'https://dossiers.invalid/fiche?id=B';
    let workerUrl = A;
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url: workerUrl, title: 'Fiche', windowId: 10})}});
    const panel = panelHarness((message) => h.sendMessage(message));
    panel.state.tab = {id: 7, url: A, title: 'Fiche', windowId: 10};
    await panel.start();
    panel.nodes.prompt.value = 'Remplis le formulaire A';
    await panel.fire('prompt', 'input');
    assert.match(panel.nodes['tab-context'].textContent, /Fiche \(figé\)/);
    // Même onglet, même titre, autre fiche : onUpdated relu par le panneau.
    panel.state.tab = {id: 7, url: B, title: 'Fiche', windowId: 10};
    workerUrl = B;
    panel.tabEvents.updated(7, {url: B});
    await panel.settle();
    assert.match(panel.nodes['tab-context'].textContent, /page changée depuis/);
    await panel.fire('composer', 'submit');
    assert.equal(panel.state.asks.at(-1).expectUrl, A);  // jamais réécrite par onUpdated
    assert.equal((h.localData.agyChat || []).length, 0);  // le worker a refusé : rien n'est parti
    // Julien vise explicitement la page affichée (clic sur la pastille) : la demande part pour B.
    await panel.fire('tab-context', 'click');
    await panel.fire('composer', 'submit');
    assert.equal(panel.state.asks.at(-1).expectUrl, B);
    assert.equal(h.localData.agyChat.length, 1);
});

test('panneau Antigravity (Codex 4e passe, P1) : reprise d\'un orphelin (battement ou adoption) et onglet déjà à l\'agent gardent le marqueur du panneau', async () => {
    const url = 'https://a.invalid/form';
    const old = {agent: 'Antigravity', id: 'antigravity-ancienne-1'};
    const fresh = {agent: 'Antigravity', id: 'antigravity-nouvelle-2'};
    for (const how of ['heartbeat', 'adopt']) {
        const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url, title: 'F', windowId: 10}), query: async () => [{id: 7}]}});
        const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
        assert.equal((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, old)).data.adopted, true);
        await h.run('list_tabs', {}, fresh, {gone: [old.id]});  // serveur MCP redémarré : ancienne session morte
        if (how === 'heartbeat') assert.deepEqual(plain((await h.run('heartbeat', {reclaim: true}, fresh)).data.reclaimed), [7]);
        else assert.equal((await h.run('adopt_tab', {tabId: 7}, fresh)).data.reclaimed, true);
        assert.equal(h.owners()['7'].client, fresh.id);
        assert.equal(h.owners()['7'].panelRequest, asked.localId, how);
        assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 0, transitionType: "typed", transitionQualifiers: ["from_address_bar"]})'), true);
        assert.deepEqual(Object.keys(h.owners()), [], how);
        assert.ok((await h.run('click', {tabId: 7, selector: 'button'}, fresh)).error, how);
    }
    // Onglet déjà adopté hors panneau par la même session, puis demande du panneau sur lui : marqué aussi.
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url, title: 'F', windowId: 10})}});
    assert.equal((await h.run('adopt_tab', {tabId: 7, julienAsked: true}, fresh)).data.adopted, true);
    assert.equal(h.owners()['7'].panelRequest, undefined);
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
    assert.equal((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, fresh)).data.already, true);
    assert.equal(h.owners()['7'].panelRequest, asked.localId);
    assert.equal(h.owners()['7'].adopted, true);
    assert.equal(await h.evalInContext('agyOnCommitted({tabId: 7, frameId: 0, transitionType: "link", transitionQualifiers: ["forward_back"]})'), true);
    assert.deepEqual(Object.keys(h.owners()), []);
});

test('panneau Antigravity (Codex 4e passe, P1) : fragment et History API surveillés comme une navigation ; le travail (lien, pushState) continue', async () => {
    const listeners = {};
    const bus = Object.fromEntries(['onCommitted', 'onReferenceFragmentUpdated', 'onHistoryStateUpdated']
        .map((name) => [name, {addListener(fn) { (listeners[name] ||= []).push(fn); }}]));
    const url = 'https://dossiers.invalid/app#/fiche/A';
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    for (const [event, julien] of [
        ['onReferenceFragmentUpdated', {transitionType: 'typed', transitionQualifiers: ['from_address_bar']}],
        ['onHistoryStateUpdated', {transitionType: 'link', transitionQualifiers: ['forward_back']}]
    ]) {
        for (const key of Object.keys(listeners)) delete listeners[key];
        const h = harness({}, {autoOwn: false, webNavigation: bus, tabs: {get: async (id) => ({id, url, title: 'F', windowId: 10})}});
        assert.deepEqual(Object.keys(listeners).sort(), ['onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated']);
        const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
        assert.equal((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy)).data.adopted, true);
        // Changement de route du travail (transition « link » sans précédent/suivant) : l'onglet reste à Antigravity.
        listeners[event][0]({tabId: 7, frameId: 0, transitionType: 'link', transitionQualifiers: []});
        await settleWorker();
        assert.ok(h.owners()['7'], event);
        // Julien change lui-même de fiche (barre d'adresse, précédent entre routes) : rendu, plus aucune commande.
        listeners[event][0]({tabId: 7, frameId: 0, ...julien});
        await settleWorker();
        assert.deepEqual(Object.keys(h.owners()), [], event);
        assert.ok((await h.run('click', {tabId: 7, selector: 'button'}, agy)).error, event);
    }
});

test('panneau Antigravity (Codex 4e passe, P2) : demande retenue par le pont (plusieurs profils) → toujours en cours, réservation et reprises gardées', () => {
    const chat = agyChat();
    let list = chat.markSent(chat.addAsk([], {localId: 'L', text: 'x', at: 1000}), 'L', 1000);
    list = chat.applyUpdate(list, {localId: 'L', status: 'held', error: 'Plusieurs profils Chrome sont reliés au pont'});
    assert.equal(list[0].status, 'sending');
    assert.equal(chat.busyAsk(list).localId, 'L');
    assert.equal(chat.dueResends(list, 1000 + chat.RESEND_AFTER_MS).length, 1);
    assert.match(chat.askStatus(list[0]), /^Retenue : Plusieurs profils/);
    // L'autre profil fermé : la reprise retrouve le dépôt antérieur (même localId) et la demande passe « déposée ».
    list = chat.applyUpdate(list, {localId: 'L', status: 'sent', relayId: 'R1', sidecarActive: true});
    assert.equal(list[0].status, 'sent');
    assert.equal(list[0].held, undefined);
});

// 5e relecture de Codex : navigation de Julien PENDANT les attentes de l'adoption du panneau.
function navBus() {
    const listeners = {};
    const bus = Object.fromEntries(['onCommitted', 'onReferenceFragmentUpdated', 'onHistoryStateUpdated']
        .map((name) => [name, {addListener(fn) { (listeners[name] ||= []).push(fn); }}]));
    return {bus, listeners};
}

/** Suspend le n-ième appel de storage.session.<method> qui satisfait match ; rend {hit, release}. */
function gateStorage(h, method, match, nth = 1) {
    const original = h.ctx.chrome.storage.session[method];
    let count = 0;
    let open;
    const gate = {hit: false, release: () => open()};
    h.ctx.chrome.storage.session[method] = async (arg) => {
        if (match(arg) && ++count === nth) {
            gate.hit = true;
            await new Promise((resolve) => { open = resolve; });
        }
        return original(arg);
    };
    return gate;
}

const untilTrue = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await new Promise((resolve) => setImmediate(resolve)); assert.ok(cond()); };
const julienTyped = {frameId: 0, transitionType: 'typed', transitionQualifiers: ['from_address_bar']};

test('panneau Antigravity (Codex 5e passe, P1) : Julien change de page pendant la dernière lecture de l\'accord → adoption refusée, onglet rendu, clic sur B refusé', async () => {
    let url = 'https://dossiers.invalid/fiche?id=A';
    const {bus, listeners} = navBus();
    const h = harness({}, {autoOwn: false, webNavigation: bus, tabs: {get: async (id) => ({id, url, title: 'Fiche', windowId: 10})}});
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
    // Deuxième lecture de l'accord pendant l'adoption = le contrôle final, après la dernière lecture de l'onglet.
    const gate = gateStorage(h, 'get', (key) => key === 'agyGrants', 2);
    const adoption = h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy);
    await untilTrue(() => gate.hit);
    url = 'https://dossiers.invalid/fiche?id=B';
    listeners.onCommitted[0]({tabId: 7, ...julienTyped});
    await settleWorker();
    gate.release();
    assert.match((await adoption).error, /moved to another page during the adoption/);
    assert.deepEqual(Object.keys(h.owners()), []);
    assert.ok((await h.run('click', {tabId: 7, selector: 'button'}, agy)).error);
    assert.equal(h.clicks, 0);
});

test('panneau Antigravity (Codex 5e passe, P1) : reprise d\'un orphelin, navigation de Julien pendant l\'enregistrement → la restitution n\'est jamais annulée', async () => {
    let url = 'https://dossiers.invalid/fiche?id=A';
    const {bus, listeners} = navBus();
    const h = harness({}, {autoOwn: false, webNavigation: bus, tabs: {get: async (id) => ({id, url, title: 'Fiche', windowId: 10}), query: async () => [{id: 7}]}});
    const old = {agent: 'Antigravity', id: 'antigravity-ancienne-1'};
    const fresh = {agent: 'Antigravity', id: 'antigravity-nouvelle-2'};
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
    assert.equal((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, old)).data.adopted, true);
    await h.run('list_tabs', {}, fresh, {gone: [old.id]});
    // Premier enregistrement de la reprise suspendu ; Julien navigue pendant ce temps (le marqueur est déjà posé).
    const ownersKey = h.evalInContext('OWNERS_KEY');
    const gate = gateStorage(h, 'set', (items) => items && ownersKey in items);
    const adoption = h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, fresh);
    await untilTrue(() => gate.hit);
    url = 'https://dossiers.invalid/fiche?id=B';
    listeners.onCommitted[0]({tabId: 7, ...julienTyped});
    await settleWorker();
    gate.release();
    assert.ok((await adoption).error);
    assert.deepEqual(Object.keys(h.owners()), []);  // restitution gardée : aucune propriété recréée
    assert.ok((await h.run('click', {tabId: 7, selector: 'button'}, fresh)).error);
    assert.equal(h.clicks, 0);
});

test('panneau Antigravity (Codex 5e passe, P1) : refus tardif sur un onglet déjà à l\'agent → propriété d\'avant remise telle quelle', async () => {
    let reads = 0;
    let bAfter = Infinity;
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url: ++reads >= bAfter ? 'https://a.invalid/b' : 'https://a.invalid/a', title: 'F', windowId: 10})}});
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    assert.equal((await h.run('adopt_tab', {tabId: 7, julienAsked: true}, agy)).data.adopted, true);
    const before = h.owners()['7'];
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: 'https://a.invalid/a'}});
    bAfter = reads + 3;  // la relecture après l'enregistrement voit une autre page (navigation du travail, pas de Julien)
    assert.match((await h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy)).error, /moved to another page/);
    assert.deepEqual(h.owners()['7'], before);
});

test('panneau Antigravity (Codex 6e passe, P1) : onglet rendu puis adopté par un autre pendant la sauvegarde → l\'ancienne adoption ne restaure ni ne rend rien', async () => {
    let url = 'https://dossiers.invalid/fiche?id=A';
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url, title: 'Fiche', windowId: 10})}});
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    const claude = {agent: 'Claude', id: 'claude-bbbb2222'};
    assert.equal((await h.run('adopt_tab', {tabId: 7, julienAsked: true}, agy)).data.adopted, true);
    const asked = await h.sendMessage({target: 'background', agyAsk: {text: 'Remplis', tabId: 7, expectUrl: url}});
    const ownersKey = h.evalInContext('OWNERS_KEY');
    const gate = gateStorage(h, 'set', (items) => items && ownersKey in items);
    const adoption = h.run('adopt_tab', {tabId: 7, panelRequest: asked.localId}, agy);
    await untilTrue(() => gate.hit);
    // Pendant la sauvegarde : Julien rend l'onglet (poste de contrôle), puis Claude l'adopte (propriété installée,
    // sa propre sauvegarde attend derrière), et le travail de Claude va sur B.
    const released = h.sendMessage({target: 'background', panelRelease: 7});
    await untilTrue(() => !h.owners()['7']);
    const claudeSaved = h.evalInContext(`rememberTabOwner(7, ${JSON.stringify(claude)}, "adopted")`);
    const claudeOwner = h.owners()['7'];
    assert.equal(claudeOwner.client, claude.id);
    url = 'https://dossiers.invalid/fiche?id=B';
    gate.release();
    assert.ok((await adoption).error);
    await released;
    await claudeSaved;
    assert.deepEqual(h.owners()['7'], claudeOwner);  // jamais l'ancienne propriété d'Antigravity remise
    assert.ok((await h.run('click', {tabId: 7, selector: 'button'}, agy)).error);
    assert.equal(h.clicks, 0);
    assert.ok(!(await h.run('click', {tabId: 7, selector: 'button'}, claude)).error);
});

test('panneau Antigravity (Codex 7e passe, P1) : deux restitutions de la même navigation, un autre client adopte entre les deux → la seconde ne supprime pas sa propriété', async () => {
    const h = harness({}, {autoOwn: false, tabs: {get: async (id) => ({id, url: 'https://a.invalid/b', title: 'F', windowId: 10})}});
    const agy = {agent: 'Antigravity', id: 'antigravity-aaaa1111'};
    const claude = {agent: 'Claude', id: 'claude-bbbb2222'};
    assert.equal((await h.run('adopt_tab', {tabId: 7, julienAsked: true}, agy)).data.adopted, true);
    // Détachements suspendus : on choisit l'ordre de leurs retours.
    const pending = [];
    const original = h.ctx.chrome.debugger.detach;
    h.ctx.chrome.debugger.detach = (target) => new Promise((resolve, reject) => pending.push({resolve, reject, target}));
    const agyOwner = 'tabOwners.get(7)';
    const first = h.evalInContext(`releaseTabFromPanel(7, ${agyOwner})`);
    const second = h.evalInContext(`releaseTabFromPanel(7, ${agyOwner})`);
    await untilTrue(() => pending.length === 2);
    pending[0].resolve();
    assert.equal((await first).released, true);
    h.ctx.chrome.debugger.detach = original;
    assert.equal((await h.run('adopt_tab', {tabId: 7, julienAsked: true}, claude)).data.adopted, true);
    const claudeOwner = h.owners()['7'];
    assert.ok(!(await h.run('click', {tabId: 7, selector: 'button'}, claude)).error);
    pending[1].reject(new Error('Debugger is not attached'));
    assert.equal((await second).released, false);
    assert.deepEqual(h.owners()['7'], claudeOwner);
    assert.ok(!(await h.run('click', {tabId: 7, selector: 'button'}, claude)).error);
    // Le bouton « Rendre l'onglet » du poste de contrôle garde son sens : il rend l'onglet de son propriétaire actuel.
    assert.equal((await h.sendMessage({target: 'background', panelRelease: 7})).released, true);
    assert.deepEqual(Object.keys(h.owners()), []);
});
