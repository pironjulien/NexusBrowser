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
        get now() { return now; }
    };
}

function harness(pageOverrides = {}, chromeOverrides = {}) {
    let clicks = 0;
    let found = true;
    let failure = false;
    const calls = [];
    const mouseLog = [];
    const mouseState = {nativeDrag: chromeOverrides.nativeDrag !== false};
    const scriptCalls = [];
    const focusCalls = {tabs: 0, windows: 0};
    const element = {
        scrollIntoView() {}, focus() {}, getBoundingClientRect: () => ({x: 0, y: 0, width: 10, height: 10}),
        dispatchEvent() { clicks++; }, click() { clicks++; }, tagName: 'BUTTON', innerText: 'Test',
        parentNode: null,
        onTrusted(type) { if (type === 'click') clicks++; }
    };
    const page = {
        document: listenable({
            querySelectorAll: () => found ? [element] : [],
            elementFromPoint: (x, y) => (found && x >= 0 && x <= 10 && y >= 0 && y <= 10) ? element : null
        }),
        window: {dispatchEvent() {}, __antigravity_som_elements: new Map([[1, element]])},
        CustomEvent: class {}, MouseEvent: class {}, Event: class {},
        ...pageOverrides
    };
    let onEvent;
    let onMessage;
    let onRemoved;
    const detached = [];
    const idleTimers = [];
    const sessionData = {...(chromeOverrides.sessionStorage || {})};
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
            onRemoved: {addListener(fn) { onRemoved = fn; }},
            ...(chromeOverrides.tabs || {})
        },
        windows: {
            update: async () => { focusCalls.windows++; },
            ...(chromeOverrides.windows || {})
        },
        downloads: chromeOverrides.downloads || {search: async () => [], erase: async () => []},
        scripting: {
            async executeScript({target, world, func, args}) {
                scriptCalls.push({target, world, name: func.name, args});
                if (chromeOverrides.scriptingError) throw new Error(chromeOverrides.scriptingError);
                const value = vm.runInNewContext(`(${func.toString()})(...${JSON.stringify(args || [])})`, page);
                return [{frameId: 0, result: value === undefined ? null : JSON.parse(JSON.stringify(value))}];
            }
        },
        storage: {
            session: {
                get: async (key) => (key in sessionData ? {[key]: sessionData[key]} : {}),
                set: async (items) => { Object.assign(sessionData, items); },
                remove: async (key) => { delete sessionData[key]; }
            }
        },
        debugger: {
            onEvent: {addListener(fn) { onEvent = fn; }}, onDetach: event,
            attach: async () => {
                if (chromeOverrides.attachError) throw new Error(chromeOverrides.attachError);
            },
            detach: async (target) => { detached.push(target.tabId); },
            async sendCommand(target, method, params) {
                calls.push({target, method, params});
                if (chromeOverrides.debuggerSendCommand) {
                    const custom = await chromeOverrides.debuggerSendCommand(target, method, params);
                    if (custom !== undefined) return custom;
                }
                if (method === 'Runtime.evaluate') {
                    if (failure) return {exceptionDetails: {text: 'Script failed'}};
                    const evalVal = vm.runInNewContext(params.expression, page);
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
    return {
        run: (action, params) => ctx.handleCommand({action, params}),
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
        sessionData, detached, idleTimers,
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
    const h = harness({
        window: {
            dispatchEvent() {},
            __antigravity_som_elements: new Map([[5, inputElement]])
        }
    });
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
    const res1 = await h.run('semantic_fill', { tabId: 1, label: 'Votre message', value: 'NexusAGY SOTA' });
    assert.equal(res1.data.success, true);
    assert.equal(textVal, 'NexusAGY SOTA');

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
            querySelectorAll: (sel) => (typeof sel === 'string' && sel.includes('__antigravity_som_marker')) ? [] : [btn],
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

test('sidepanel messaging routes getActiveTab and executeAction correctly', async () => {
    const h = harness();
    const activeTabRes = await h.sendMessage({ target: 'background', getActiveTab: true });
    assert.equal(activeTabRes.data.id, 1);
    assert.equal(activeTabRes.data.url, 'https://example.invalid');

    const clickRes = await h.sendMessage({
        target: 'background',
        executeAction: true,
        action: 'click',
        params: { tabId: 1, selector: 'button' }
    });
    assert.equal(clickRes.data.success, true);
    assert.equal(h.clicks, 1);
});

test('create_tab opens in background and automatically creates Antigravity tab group', async () => {
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

test('group_tabs explicitly groups specified tabs with custom color and title', async () => {
    const h = harness({}, {
        tabGroups: {
            query: async () => [],
            update: async (id, p) => ({ id, ...p })
        }
    });
    const res = await h.run('group_tabs', { tabIds: [1, 2], title: 'Antigravity', color: 'purple', collapsed: true });
    assert.equal(res.data.groupId, 101);
    assert.equal(res.data.title, 'Antigravity');
    assert.equal(res.data.color, 'purple');
    assert.equal(res.data.collapsed, true);
    assert.equal(res.data.tabIds[0], 1);
    assert.equal(res.data.tabIds[1], 2);
});

test('smart tab resolution sticks to created agent tab without disrupting active tab', async () => {
    const h = harness({}, {
        tabs: {
            create: async (p) => ({ id: 88, url: p.url, active: false, windowId: 10 }),
            get: async (id) => ({ id, url: 'https://example.invalid', windowId: 10 })
        }
    });

    // Create an agent tab
    await h.run('create_tab', { url: 'https://example.com/isolated' });

    // Subsequent action without tabId should target tab 88, not active tab 1
    await h.run('click', { selector: 'button' });
    const lastTargetCall = h.calls.find(c => c.method === 'Runtime.evaluate');
    assert.equal(lastTargetCall.target.tabId, 88);
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
    return {document: dom.document, window: {dispatchEvent() {}, __antigravity_som_elements: new Map()}};
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
    assert.match((await h.run('close_tab', {})).error, /Aucun onglet de l'agent/);
    assert.match((await h.run('navigate', {url: 'https://example.com'})).error, /tab_id/);
    assert.match((await h.run('reload', {})).error, /new_tab/);
    assert.equal(removed + updated + reloaded, 0);
    // Les lectures peuvent toujours viser l'onglet actif
    const content = await h.run('get_content', {mode: 'text'});
    assert.equal(content.error, undefined);
    assert.equal(h.calls.find(c => c.method === 'Runtime.evaluate').target.tabId, 1);
});

test('l\'onglet de l\'agent est persisté et survit au redémarrage du service worker', async () => {
    const first = harness();
    await first.run('create_tab', {url: 'https://example.com/agent'});
    assert.equal(first.sessionData.nexusagyAgentTabId, 99);

    let navigated = null;
    const restarted = harness({}, {
        sessionStorage: {nexusagyAgentTabId: 77},
        tabs: {
            get: async (id) => ({id, url: 'https://example.invalid', windowId: 10}),
            update: async (id, p) => { navigated = id; return {id, ...p}; }
        }
    });
    const res = await restarted.run('navigate', {url: 'https://example.com/next'});
    assert.equal(res.error, undefined);
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
    const active = await h.run('active_tab', {});
    assert.equal(active.data.pendingDialogs[0].message, 'Supprimer définitivement ?');

    const handled = await h.run('handle_dialog', {accept: false});
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
    assert.match((await h.run('click', {tabId: 1, selector: 'button', button: 'sideways'})).error, /Bouton de souris inconnu/);
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
    const button = h.page.window.__antigravity_som_elements.get(1);
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
    assert.match(res.error, /couvert par <div#overlay\.modal\.backdrop>/);
    assert.match(res.error, /aucune action souris envoyée/);
    assert.equal(h.mouse().length, 0);
    assert.equal(h.clicks, 0);
    const hover = await h.run('hover', {tabId: 1, selector: 'button', timeoutMs: 0});
    assert.match(hover.error, /couvert/);
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
    assert.ok(h.scriptCalls.length > 0 && h.scriptCalls.every(c => c.world === 'MAIN' && c.target.tabId === 1));
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
    assert.match(res.error, /Débogueur indisponible .*Protected internal URL.*injection JavaScript refusée/);
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
        dispatchEvent() {}, innerWidth: 1280, innerHeight: 4000, __antigravity_som_elements: new Map(),
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
                if (v === 'true' || v === '') return true;
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
    assert.match(res.error, /Localisateur ambigu/);
    assert.match(res.error, /2 éléments/);
    assert.match(res.error, /« Valider »/);
    assert.match(res.error, /« Valider le panier »/);
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
    assert.match((await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Supprimer', nth: 5}})).error, /hors limites/);
});

test('localisateur introuvable : erreur claire, masqués signalés, includeHidden les inclut', async () => {
    const {h} = richHarness(formPage);
    const res = await h.run('click', {tabId: 1, locator: {role: 'button', name: 'Publier'}, timeoutMs: 50});
    assert.match(res.error, /Aucun élément ne correspond au localisateur/);
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Valider', exact: true}});
    assert.equal(found.data.count, 1);
    assert.equal(found.data.hidden, 1);
    assert.equal(found.data.unique, true);
    const withHidden = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Valider', exact: true, includeHidden: true}});
    assert.equal(withHidden.data.count, 2);
    assert.equal(withHidden.data.candidates[1].visible, false);
    assert.match((await h.run('click', {tabId: 1, locator: {role: 'button'}, timeoutMs: 0})).error, /ambigu/);
    assert.match((await h.run('click', {tabId: 1, locator: {exact: true}})).error, /sans critère/);
    assert.match((await h.run('click', {tabId: 1, locator: '{pas du json'})).error, /locator illisible/);
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
            if (method === 'DOM.resolveNode') { objects.set('n' + params.backendNodeId, ref.byId('send')); return {object: {objectId: 'n' + params.backendNodeId}}; }
            if (method === 'Runtime.callFunctionOn' && objects.has(params.objectId)) {
                const value = vm.runInNewContext(`(${params.functionDeclaration}).apply(el, args)`, {el: objects.get(params.objectId), args: params.arguments.map(a => a.value)});
                return {result: {value}};
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
    assert.match((await h.run('press_key', {tabId: 1, key: 'Hyper+K'})).error, /Modificateur inconnu/);
    assert.match((await h.run('press_key', {tabId: 1, key: 'Foo'})).error, /Touche inconnue/);
});

test('champ qui ignore le clavier : repli setter natif signalé ; mode trusted : jamais de repli', async () => {
    const {h, dom} = richHarness(formPage);
    dom.byId('cp').__ignoreKeyboard = true;
    const res = await h.run('fill', {tabId: 1, locator: {label: 'Code postal'}, value: '69001'});
    assert.equal(res.data.method, 'native_setter_fallback');
    assert.match(res.data.fallback_reason, /aucun effet/);
    assert.match(res.data.warning, /isTrusted=false/);
    assert.equal(res.data.verified, true);
    assert.equal(dom.byId('cp').value, '69001');
    dom.byId('cp')._value = '';
    const strict = await h.run('fill', {tabId: 1, locator: {label: 'Code postal'}, value: '75001', mode: 'trusted'});
    assert.equal(strict.data.method, 'cdp');
    assert.equal(strict.data.verified, false);
    assert.match(strict.data.warning, /différente/);
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
    assert.match((await h2.run('fill', {tabId: 1, locator: {role: 'heading'}, value: 'x'})).error, /n'est pas un champ de saisie/);
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
    assert.match((await h.run('select_option', {tabId: 1, locator: {label: 'Formule'}, text: 'Inconnue'})).error, /Aucune option/);
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
            if (method === 'Page.createIsolatedWorld') { assert.equal(params.frameId, 'F1'); return {executionContextId: 77}; }
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
        assert.match(res.data.frame, oopif ? /localhost:2 \(iframe hors processus\)/ : /127\.0\.0\.1:2 \(iframe d'une autre origine\)/);
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
    assert.match(res.error, /2 éléments/);
    assert.match(res.error, /cadre top/);
    assert.match(res.error, /cadre http:\/\/127\.0\.0\.1:2/);
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Action cadre'}});
    assert.deepEqual(plain(found.data.candidates.map(c => c.frame)), ['top', "http://127.0.0.1:2 (iframe d'une autre origine)"]);
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
    assert.match(res.error, /couvert par <div#cover>/);
    assert.equal(h.mouse().length, 0);
    assert.equal(frame.trusted.length, 0);
});

test('lecture : content et interactive_map indiquent le cadre ; marqueur d\'un cadre cliquable', async () => {
    const {h, frame, attach} = crossOriginHarness();
    await attach();
    const content = await h.run('content', {tabId: 1, mode: 'text'});
    assert.match(content.data, /--- cadre http:\/\/127\.0\.0\.1:2 \(iframe d'une autre origine\) ---/);
    const map = await h.run('interactive_map', {tabId: 1, viewportOnly: false});
    const framed = map.data.elements.filter(e => e.crossOriginFrame);
    assert.ok(framed.length >= 2);
    const target = framed.find(e => e.label === 'Action cadre');
    assert.equal(target.rect.x, 112);
    const click = await h.run('click', {tabId: 1, mark: target.mark});
    assert.equal(click.data.crossOriginFrame, true);
    assert.deepEqual(frame.trusted.filter(t => t.type === 'click').map(t => t.el.id), ['act']);
});

test('iframe srcdoc same-origin annoncée avec une origine étrange : parcourue une seule fois', async () => {
    const {h, calls, attach} = crossOriginHarness({sameOriginDocument: true});
    await attach();
    const found = await h.run('find', {tabId: 1, locator: {role: 'button', name: 'Action cadre'}});
    // contentDocument lisible depuis le parent : le cadre est parcouru par le script de la page, pas en double.
    assert.equal(found.data.count, 2);
    assert.deepEqual(plain(found.data.candidates.map(c => c.frame)), ['top', 'iframe#frame']);
    assert.ok(calls.some(c => c.method === 'Runtime.callFunctionOn' && /contentDocument/.test(c.params.functionDeclaration)));
    assert.equal(calls.filter(c => c.method === 'Page.createIsolatedWorld').length, 0);
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
    assert.match(withHeaders.data.requests[0].requestHeaders.Authorization, /^\[masqué, 19 caractères\]$/);
    assert.match(withHeaders.data.requests[0].requestHeaders.Cookie, /^\[masqué/);
    assert.match(withHeaders.data.requests[0].responseHeaders['Set-Cookie'], /^\[masqué/);
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
    assert.equal(list.data.requests[0].frame, 'iframe hors processus');
    const text = await h.run('network_response', {tabId: 1, request_id: list.data.requests[0].request_id});
    assert.equal(text.data.body, 'Bonjour éàü');
    assert.deepEqual(seen, [null, null, null, 'child-9']);
    assert.match((await h.run('network_response', {tabId: 1, request_id: 'inconnu'})).error, /absente du journal/);
});

test('réseau : corps refusé clairement après détachement du débogueur', async () => {
    const h = harness();
    await h.run('evaluate', {tabId: 1, code: '1'});
    await h.emit(1, 'Network.requestWillBeSent', {requestId: 'old', timestamp: 1, request: {url: 'https://x.invalid/', method: 'GET', headers: {}}});
    await h.emit(1, 'Network.loadingFinished', {requestId: 'old', timestamp: 2, encodedDataLength: 1});
    await h.fireIdleTimers();
    const res = await h.run('network_response', {tabId: 1, request_id: 'old'});
    assert.match(res.error, /détaché puis rattaché/);
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
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 500})).error, /interrompu \(NETWORK_FAILED\)/);
    h = harness({}, {tabs, virtualTime: true, downloads: downloadsMock([[{...base, state: 'in_progress', danger: 'dangerousFile'}]]).api});
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 300})).error, /dangerousFile.*jamais acceptée/);
    h = harness({}, {tabs, virtualTime: true, downloads: downloadsMock([[]]).api});
    assert.match((await h.run('wait_download', {tabId: 1, timeoutMs: 300})).error, /Aucun téléchargement venant de http:\/\/127\.0\.0\.1:5/);
});


// -----------------------------------------------------------------------------
// Pont local authentifié (bridge_link.js) : l'extension n'exécute rien d'un serveur qui ne prouve pas le jeton.
// Serveur et hôte natif simulés avec node:crypto, même protocole que native-host/bridge_auth.py.
// -----------------------------------------------------------------------------
const nodeCrypto = require('node:crypto');
const BRIDGE_PROTOCOL = 'nexusagy-bridge/1';
const TEST_TOKEN = 'jeton-de-test-'.padEnd(64, 'x');
const EXT_ID = 'ljgneacjmkmiopjfacahdpcigiofnngo';
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
        ws.deliver({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}});
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
        ws.deliver(server.frame({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1'}}));
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
            const command = {requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}};
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
        server.send({requestId: 'r1', action: 'evaluate', params: {tabId: 1, code: '1 + 1'}});
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

test('panneau : demande transmise par la liaison authentifiée, réponse et lecture rattachées, jamais sans pont', async () => {
    const bridge = bridgeHarness();
    const {h, server, stop} = bridge;
    const tab = {id: 1, title: 'Ex', url: 'https://example.invalid'};
    try {
        // Pont non authentifié : rien n'est transmis, et le panneau le dit.
        const refused = await h.sendMessage({target: 'background', sidepanelSubmit: {text: 'Résume la page', tab}});
        assert.equal(refused.data.status, 'not_sent');
        assert.match(refused.error, /non authentifié/);
        await authenticated(bridge);
        const sent = await h.sendMessage({target: 'background', sidepanelSubmit: {text: 'Résume la page', tab}});
        assert.equal(sent.data.status, 'sent');
        await until(() => server.replies().some(r => r.event === 'sidepanel_request'), 'événement');
        const event = server.replies().find(r => r.event === 'sidepanel_request');
        assert.equal(event.request.id, sent.data.id);
        assert.equal(event.request.text, 'Résume la page');
        assert.deepEqual(plain(event.request.tab), tab);
        // Le pont signale la lecture, puis l'agent répond.
        server.send({requestId: 'm1', action: 'sidepanel_mark_read', params: {ids: [sent.data.id]}});
        await until(() => server.replies().some(r => r.requestId === 'm1'), 'accusé de lecture');
        let thread = h.sessionData.nexusagySidepanelThread;
        assert.equal(thread.find(e => e.id === sent.data.id).status, 'read');
        server.send({requestId: 'a1', action: 'sidepanel_reply', params: {request_id: sent.data.id, text: 'Voici le résumé.'}});
        await until(() => server.replies().some(r => r.requestId === 'a1'), 'réponse affichée');
        thread = h.sessionData.nexusagySidepanelThread;
        assert.equal(thread.find(e => e.id === sent.data.id).status, 'answered');
        assert.deepEqual(plain(thread.filter(e => e.kind === 'reply').map(e => [e.text, e.request_id])), [['Voici le résumé.', sent.data.id]]);
        assert.equal(thread.find(e => e.id === refused.data.id).status, 'not_sent');
    } finally { stop(); }
});

test('panneau : un script de contenu ne peut ni exécuter d\'action ni obtenir de preuve du pont', async () => {
    const {h, host, evaluations, stop} = bridgeHarness();
    try {
        const fromPage = {id: EXT_ID, tab: {id: 1}};
        assert.equal(await h.sendMessage({target: 'background', executeAction: true, action: 'evaluate', params: {tabId: 1, code: '1'}}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', bridgeProve: {op: 'handshake'}}, fromPage), undefined);
        assert.equal(await h.sendMessage({target: 'background', sidepanelSubmit: {text: 'x'}}, fromPage), undefined);
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
    // Événement à signer pour le service worker (demande du panneau) : seulement depuis une page de l'extension.
    let reply = null;
    listener({target: 'offscreen', bridgeEvent: {event: 'sidepanel_request', request: {id: 'x', text: 't'}}}, {id: EXT_ID}, (r) => { reply = r; });
    assert.deepEqual(plain(reply), {sent: true});
    reply = null;
    listener({target: 'offscreen', bridgeEvent: {event: 'sidepanel_request'}}, {id: EXT_ID, tab: {id: 3}}, (r) => { reply = r; });
    assert.equal(reply, null);
    vm.runInContext('if (link) link.close();', ctx);
});

// -----------------------------------------------------------------------------
// Panneau latéral : cookies sans valeur, champs sans valeur, éléments cliquables seulement
// -----------------------------------------------------------------------------
function sidepanelView() {
    const ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/sidepanel_view.js'), 'utf8'), ctx);
    return ctx.AgySidepanelView;
}

test('cookies du panneau : jamais de valeur (service worker includeValues false, résumé noms et domaines)', async () => {
    const jar = [{name: 'SID', value: 'secret-session-123', domain: '.example.invalid'}, {name: 'pref', value: 'v2', domain: 'example.invalid'}];
    const h = harness({}, {debuggerSendCommand: async (target, method) => method === 'Network.getCookies' ? {cookies: jar} : undefined});
    const res = await h.run('get_cookies', {tabId: 1, includeValues: false});
    assert.equal(res.data.cookieCount, 2);
    assert.equal(res.data.valuesIncluded, false);
    assert.ok(!JSON.stringify(res).includes('secret-session-123'));
    assert.ok(res.data.cookies.every(c => !('value' in c)));
    // Le chemin de l'agent (outil MCP browser_get_cookies) garde les valeurs.
    assert.equal((await h.run('get_cookies', {tabId: 1})).data.cookies[0].value, 'secret-session-123');
    const summary = plain(sidepanelView().summarizeCookies(jar));
    assert.deepEqual(summary, {count: 2, domains: [{domain: '.example.invalid', count: 1, names: ['SID']}, {domain: 'example.invalid', count: 1, names: ['pref']}]});
    assert.ok(!JSON.stringify(summary).includes('secret'));
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
    assert.match(sidepanelView().describeField(res.data.fields[1]), /Mot de passe — <input password> \(rempli\)/);
});

test('carte du panneau : boutons et liens seulement ; jamais la valeur d\'un champ comme libellé', async () => {
    const view = sidepanelView();
    const elements = [{mark: 1, tag: 'button'}, {mark: 2, tag: 'input', type: 'text'}, {mark: 3, tag: 'a'}, {mark: 4, tag: 'input', type: 'submit'}, {mark: 5, tag: 'div', role: 'tab'}, {mark: 6, tag: 'select'}];
    assert.deepEqual(plain(view.clickableElements(elements).map(e => e.mark)), [1, 3, 4, 5]);
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
