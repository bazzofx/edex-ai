// Embedded browser: a tab manager of sandboxed WebContentsViews layered over the eDEX window.
// Web content gets no preload, no Node, its own session partition, and a strict URL policy.
"use strict";

const {WebContentsView, session} = require("electron");
const {checkNavigation, shouldBlockRequest, normalizeUserInput, searchUrl} = require("../security/urlPolicy.js");

const PARTITION = "persist:web";
const MAX_TABS = 8;
const configuredSessions = new WeakSet();

function result(success, dataOrError) {
    return success ? {success: true, data: dataOrError} : {success: false, error: dataOrError};
}

class BrowserManager {
    constructor(win, {log = () => {}, notify = () => {}, defaultSearch = "duckduckgo"} = {}) {
        this.win = win;
        this.log = log;
        this.notify = notify; // (type, message) -> shown in the UI
        this.defaultSearch = defaultSearch;
        this.tabs = new Map();
        this.order = [];
        this.activeId = null;
        this.nextId = 1;
        this.rect = null;        // placeholder rectangle reported by the renderer (null = hidden)
        this.suppressed = false; // hidden while an eDEX modal is open
        this.htmlFullscreen = false;
        this.session = session.fromPartition(PARTITION);
        this._configureSession(this.session);
        win.on("resize", () => this._layout());
    }

    _configureSession(s) {
        if (configuredSessions.has(s)) return;
        configuredSessions.add(s);

        // Deny every permission except page fullscreen (video players)
        s.setPermissionRequestHandler((wc, permission, callback) => {
            const allow = permission === "fullscreen";
            if (!allow) this.log(`Denied web permission "${permission}"`);
            callback(allow);
        });
        s.setPermissionCheckHandler((wc, permission) => permission === "fullscreen");
        s.setDevicePermissionHandler(() => false);
        s.setDisplayMediaRequestHandler((request, callback) => callback({}));

        // Downloads are blocked in the PoC
        s.on("will-download", (event, item) => {
            event.preventDefault();
            this.notify("warning", `Download blocked: ${item.getFilename()}`);
        });

        // Web content may never reach local services (terminal / voice sockets) or non-web schemes
        s.webRequest.onBeforeRequest((details, callback) => {
            const block = shouldBlockRequest(details.url);
            if (block) this.log(`Blocked web request to ${details.url.slice(0, 120)}`);
            callback({cancel: block});
        });

        // Look like regular Chrome (sites degrade for unknown "Electron" user agents)
        const ua = s.getUserAgent().replace(/\sElectron\/\S+/i, "").replace(/\sedex-ai\/\S+/i, "").replace(/\seDEX AI\/\S+/i, "");
        s.setUserAgent(ua);
    }

    _get(tabId) {
        const id = tabId == null ? this.activeId : tabId;
        return this.tabs.get(id) || null;
    }

    createTab(rawUrl = "about:blank", {activate = true} = {}) {
        if (this.tabs.size >= MAX_TABS) return result(false, `Too many tabs (max ${MAX_TABS}); close one first`);
        const chk = checkNavigation(rawUrl);
        if (!chk.ok) return result(false, chk.error);

        const view = new WebContentsView({
            webPreferences: {
                partition: PARTITION,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
                nodeIntegrationInSubFrames: false,
                nodeIntegrationInWorker: false,
                webSecurity: true,
                allowRunningInsecureContent: false,
                webviewTag: false,
                spellcheck: false,
                safeDialogs: true,
                navigateOnDragDrop: false,
                disableDialogs: false
            }
        });
        view.setBackgroundColor("#000000");
        const id = this.nextId++;
        const tab = {id, view, lastError: null};
        this.tabs.set(id, tab);
        this.order.push(id);
        this._wireContents(tab);
        this.win.contentView.addChildView(view);
        view.setVisible(false);
        if (activate || this.activeId === null) this.activeId = id;
        this._layout();
        view.webContents.loadURL(chk.url).catch(() => { /* reported through did-fail-load */ });
        this.emitState();
        return result(true, {tabId: id, url: chk.url});
    }

    _wireContents(tab) {
        const wc = tab.view.webContents;
        const guardNav = (event, url) => {
            const target = (event && event.url) || url;
            const chk = checkNavigation(target);
            if (!chk.ok) {
                event.preventDefault();
                this.notify("warning", chk.error);
                this.log(`Blocked navigation in tab ${tab.id}: ${String(target).slice(0, 120)}`);
            }
        };
        wc.on("will-navigate", guardNav);
        wc.on("will-redirect", guardNav);
        wc.on("will-frame-navigate", event => {
            if (!event.isMainFrame) {
                const chk = checkNavigation(event.url);
                if (!chk.ok && event.url !== "about:srcdoc") event.preventDefault();
            }
        });
        wc.setWindowOpenHandler(({url}) => {
            // Popups must name a real http(s) page; javascript:/about:blank popups arrive as about:blank
            const chk = /^https?:/i.test(url) ? checkNavigation(url) : {ok: false, error: `blocked popup URL "${String(url).slice(0, 60)}"`};
            if (chk.ok && this.tabs.size < MAX_TABS) {
                setImmediate(() => this.createTab(chk.url));
            } else {
                this.notify("warning", chk.ok ? "Popup blocked: too many tabs" : `Popup blocked: ${chk.error}`);
            }
            return {action: "deny"};
        });
        wc.on("will-attach-webview", e => e.preventDefault());

        const emit = () => this.emitState();
        ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-start-loading", "did-stop-loading"].forEach(ev => wc.on(ev, emit));
        wc.on("did-fail-load", (e, code, desc, url, isMainFrame) => {
            if (!isMainFrame || code === -3) return; // -3 = aborted (normal when navigating away)
            tab.lastError = `${desc} (${code})`;
            this.notify("error", `Page failed to load: ${desc}`);
            emit();
        });
        wc.on("did-start-loading", () => { tab.lastError = null; });
        wc.on("enter-html-full-screen", () => { this.htmlFullscreen = true; this._layout(); });
        wc.on("leave-html-full-screen", () => { this.htmlFullscreen = false; this._layout(); });
        wc.on("render-process-gone", (e, details) => {
            tab.lastError = `Page crashed (${details.reason})`;
            this.notify("error", tab.lastError);
            emit();
        });
    }

    // Open a URL or a search in the active tab (creates one if needed).
    // input: a URL, a bare domain, or free text (searched with the default provider).
    async open(input, {tabId = null, newTab = false, waitMs = 6000} = {}) {
        let norm = normalizeUserInput(input);
        if (!norm.ok && norm.search) norm = searchUrl(this.defaultSearch, norm.query);
        if (!norm.ok) return result(false, norm.error);
        return this.navigate(norm.url, {tabId, newTab, waitMs});
    }

    async navigate(url, {tabId = null, newTab = false, waitMs = 6000} = {}) {
        const chk = checkNavigation(url);
        if (!chk.ok) return result(false, chk.error);
        let tab = newTab ? null : this._get(tabId);
        if (tabId != null && !tab) return result(false, `No tab with id ${tabId}`);
        if (!tab) {
            const r = this.createTab(chk.url);
            if (!r.success) return r;
            tab = this.tabs.get(r.data.tabId);
        } else {
            this.activate(tab.id);
            tab.view.webContents.loadURL(chk.url).catch(() => {});
        }
        return this._waitForLoad(tab, waitMs);
    }

    _waitForLoad(tab, waitMs) {
        const wc = tab.view.webContents;
        return new Promise(resolve => {
            let done = false;
            const finish = status => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                wc.removeListener("did-stop-loading", onStop);
                wc.removeListener("dom-ready", onStop);
                if (wc.isDestroyed()) { resolve(result(false, "Tab was closed")); return; }
                if (tab.lastError) { resolve(result(false, `Navigation failed: ${tab.lastError}`)); return; }
                resolve(result(true, {tabId: tab.id, url: wc.getURL(), title: wc.getTitle(), status}));
            };
            // DOM ready is enough to report the page (heavy sites keep loading for seconds)
            const onStop = () => setTimeout(() => finish(wc.isLoading() ? "dom ready" : "loaded"), 50);
            const timer = setTimeout(() => finish("still loading"), waitMs);
            wc.on("did-stop-loading", onStop);
            wc.once("dom-ready", onStop);
        });
    }

    activate(tabId) {
        if (!this.tabs.has(tabId)) return result(false, `No tab with id ${tabId}`);
        this.activeId = tabId;
        this._layout();
        this.emitState();
        return result(true, {tabId});
    }

    closeTab(tabId = null) {
        const tab = this._get(tabId);
        if (!tab) return result(false, tabId == null ? "No open tab" : `No tab with id ${tabId}`);
        const idx = this.order.indexOf(tab.id);
        this.order.splice(idx, 1);
        this.tabs.delete(tab.id);
        try { this.win.contentView.removeChildView(tab.view); } catch (e) { /* window closing */ }
        try { tab.view.webContents.close(); } catch (e) { /* already gone */ }
        if (this.activeId === tab.id) {
            this.activeId = this.order[Math.max(0, idx - 1)] ?? null;
            this.htmlFullscreen = false;
        }
        this._layout();
        this.emitState();
        return result(true, {closed: tab.id, activeTabId: this.activeId});
    }

    history(direction) {
        const tab = this._get();
        if (!tab) return result(false, "No open tab");
        const nav = tab.view.webContents.navigationHistory;
        if (direction === "back") {
            if (!nav.canGoBack()) return result(false, "Nothing to go back to in this tab");
            nav.goBack();
        } else {
            if (!nav.canGoForward()) return result(false, "Nothing to go forward to in this tab");
            nav.goForward();
        }
        return this._waitForLoad(tab, 4000);
    }

    reload() {
        const tab = this._get();
        if (!tab) return result(false, "No open tab");
        tab.view.webContents.reload();
        return result(true, {tabId: tab.id});
    }

    stop() {
        const tab = this._get();
        if (!tab) return result(false, "No open tab");
        tab.view.webContents.stop();
        return result(true, {tabId: tab.id});
    }

    // Best-effort media control on the largest <video>/<audio> of the active tab.
    // Runs in an isolated world so the page cannot intercept it.
    async media(action) {
        const tab = this._get();
        if (!tab) return result(false, "No open tab");
        const allowed = ["play", "pause", "toggle", "mute", "unmute"];
        if (!allowed.includes(action)) return result(false, `Unknown media action "${action}"`);
        const code = `(async () => {
            const els = Array.from(document.querySelectorAll("video, audio"));
            if (!els.length) return {found: false};
            const m = els.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
            const action = ${JSON.stringify(action)};
            let error = null;
            try {
                if (action === "play" || (action === "toggle" && m.paused)) await m.play();
                else if (action === "pause" || action === "toggle") m.pause();
                else if (action === "mute") m.muted = true;
                else if (action === "unmute") m.muted = false;
            } catch (e) { error = String(e && e.message || e); }
            return {found: true, paused: m.paused, muted: m.muted, error};
        })()`;
        try {
            const r = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{code}], true);
            if (!r || !r.found) return result(false, "No video or audio element on the current page");
            if (r.error) return result(false, `Media ${action} failed: ${r.error}`);
            return result(true, {paused: r.paused, muted: r.muted});
        } catch (e) {
            return result(false, `Media control failed: ${e.message}`);
        }
    }

    setRect(rect) {
        this.rect = rect;
        this._layout();
    }

    setSuppressed(v) {
        this.suppressed = v === true;
        this._layout();
    }

    _layout() {
        if (this.win.isDestroyed()) return;
        const visible = !!this.rect && !this.suppressed;
        for (const [id, tab] of this.tabs) {
            const show = visible && id === this.activeId;
            if (show) {
                if (this.htmlFullscreen) {
                    const [w, h] = this.win.getContentSize();
                    tab.view.setBounds({x: 0, y: 0, width: w, height: h});
                } else {
                    tab.view.setBounds(this.rect);
                }
            }
            tab.view.setVisible(show);
        }
    }

    state() {
        return {
            activeTabId: this.activeId,
            visible: !!this.rect && !this.suppressed,
            tabs: this.order.map(id => {
                const tab = this.tabs.get(id);
                const wc = tab.view.webContents;
                return {
                    id,
                    title: wc.getTitle() || "",
                    url: wc.getURL() || "",
                    loading: wc.isLoading(),
                    canGoBack: wc.navigationHistory.canGoBack(),
                    canGoForward: wc.navigationHistory.canGoForward(),
                    error: tab.lastError,
                    active: id === this.activeId
                };
            })
        };
    }

    emitState() {
        if (this.win.isDestroyed()) return;
        this.win.webContents.send("edexai:browser:state", this.state());
    }

    destroy() {
        for (const id of [...this.order]) this.closeTab(id);
    }
}

module.exports = {BrowserManager, PARTITION, MAX_TABS};
