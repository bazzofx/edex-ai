// eDEX AI: browser panel inside the main shell (toolbar, tabs, placeholder for the native view)
// and the workspace layouts: terminal / split / browser.
class BrowserPanel {
    constructor() {
        this.bridge = require("./bridge/edexai.js");
        this.layout = "terminal";
        this.state = {tabs: [], activeTabId: null};
        this.lastRectKey = null;
        this.suppressed = false;

        this.shell = document.getElementById("main_shell");
        this.shell.classList.add("edexai-shell");

        // "BROWSER" entry in the terminal tab strip (works without voice)
        const tabs = document.getElementById("main_shell_tabs");
        tabs.insertAdjacentHTML("beforeend", `<li id="shell_tab_browser" title="Show / hide the browser"><p>BROWSER</p></li>`);
        this.toggleTab = document.getElementById("shell_tab_browser");
        this.toggleTab.addEventListener("click", () => {
            window.audioManager.folder.play();
            this.setLayout(this.layout === "terminal" ? "split" : "terminal");
        });

        this.shell.insertAdjacentHTML("beforeend", `
            <div id="browser_panel" data-visible="0">
                <div id="browser_toolbar">
                    <button class="browser_btn" data-op="back" title="Back">&#x25C2;</button>
                    <button class="browser_btn" data-op="forward" title="Forward">&#x25B8;</button>
                    <button class="browser_btn" data-op="reload" title="Reload">&#x21BB;</button>
                    <input id="browser_url" type="text" spellcheck="false" placeholder="URL OR SEARCH" />
                    <div id="browser_layouts">
                        <button class="browser_btn" data-layout="terminal" title="Terminal only">TERM</button>
                        <button class="browser_btn" data-layout="split" title="Split view">SPLIT</button>
                        <button class="browser_btn" data-layout="browser" title="Browser only">WEB</button>
                    </div>
                </div>
                <ul id="browser_tabs"></ul>
                <div id="browser_area">
                    <h2 id="browser_placeholder">NO PAGE OPEN<br><i>Type a URL or search above</i></h2>
                </div>
                <p id="browser_notice"></p>
            </div>`);
        this.panel = document.getElementById("browser_panel");
        this.area = document.getElementById("browser_area");
        this.urlInput = document.getElementById("browser_url");
        this.tabList = document.getElementById("browser_tabs");
        this.noticeEl = document.getElementById("browser_notice");
        this.placeholder = document.getElementById("browser_placeholder");

        this.panel.querySelectorAll("button[data-op]").forEach(b => b.addEventListener("click", () => this.cmd(b.dataset.op)));
        this.panel.querySelectorAll("button[data-layout]").forEach(b => b.addEventListener("click", () => this.setLayout(b.dataset.layout)));

        // Typing in the URL bar must not go to the terminal
        this.urlInput.addEventListener("focus", () => window.keyboard.detach());
        this.urlInput.addEventListener("blur", () => window.keyboard.attach());
        const submit = () => {
            const v = this.urlInput.value.trim();
            if (!v) return;
            this.cmd("open", {input: v});
            this.urlInput.blur();
        };
        this.urlInput.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            if (e.key === "Escape") this.urlInput.blur();
        });
        this.urlInput.addEventListener("change", e => { if (e.detail === "enter") submit(); }); // on-screen keyboard

        this.bridge.browser.onState(s => this.renderState(s));
        this.bridge.browser.onNotice(n => this.showNotice(n.type, n.message));
        this.bridge.ui.onRequest((op, payload) => this.handleUiRequest(op, payload));

        // Keep the native view glued to the placeholder
        this.ro = new ResizeObserver(() => this.syncBounds());
        this.ro.observe(this.area);
        window.addEventListener("resize", () => this.syncBounds());
        setInterval(() => this.syncBounds(), 400);

        // Hide the native view while eDEX modals / the fuzzy finder are open (it draws above HTML)
        this.mo = new MutationObserver(() => this.checkSuppression());
        this.mo.observe(document.body, {childList: true});

        this.bridge.browser.cmd("state").then(r => { if (r && r.success) this.renderState(r.data); });
        this.applyLayout();
    }

    async cmd(op, args = {}) {
        const r = await this.bridge.browser.cmd(op, args);
        if (r && !r.success) this.showNotice("error", r.error);
        return r;
    }

    handleUiRequest(op, payload) {
        switch (op) {
            case "setLayout":
                if (!["terminal", "split", "browser"].includes(payload.layout)) throw new Error(`Unknown layout "${payload.layout}"`);
                return this.setLayout(payload.layout).then(() => ({layout: this.layout, browserVisible: this.isBrowserVisible()}));
            case "getLayout":
                return {layout: this.layout, browserVisible: this.isBrowserVisible()};
            case "listTerminals":
                return Object.keys(window.term).filter(k => window.term[k]).map(k => ({
                    index: Number(k),
                    label: (document.getElementById("shell_tab" + k)?.innerText || "").trim(),
                    active: Number(k) === window.currentTerm
                }));
            case "createTerminal": {
                for (let i = 1; i <= 4; i++) {
                    if (!window.term[i]) {
                        window.focusShellTab(i);
                        return new Promise(resolve => setTimeout(() => resolve({index: i, created: !!window.term[i]}), 1500));
                    }
                }
                throw new Error("All 5 terminal tabs are in use");
            }
            case "notice":
                this.showNotice(payload.type || "info", String(payload.message || ""));
                return true;
            default:
                throw new Error(`Unknown UI request "${op}"`);
        }
    }

    isBrowserVisible() {
        return this.layout !== "terminal" && !this.suppressed;
    }

    setLayout(layout) {
        if (!["terminal", "split", "browser"].includes(layout)) return Promise.resolve();
        this.layout = layout;
        this.applyLayout();
        this.bridge.ui.layoutChanged(layout);
        // Wait for the CSS transition, then refit the terminal
        return new Promise(resolve => setTimeout(() => {
            this.refitTerminal();
            this.syncBounds();
            resolve();
        }, 350));
    }

    applyLayout() {
        this.shell.dataset.layout = this.layout;
        this.toggleTab.dataset.on = this.layout === "terminal" ? "0" : "1";
        this.panel.dataset.visible = this.layout === "terminal" ? "0" : "1";
        this.panel.querySelectorAll("button[data-layout]").forEach(b => {
            b.dataset.on = b.dataset.layout === this.layout ? "1" : "0";
        });
        const tabs = document.getElementById("main_shell_tabs");
        this.panel.style.top = (tabs.offsetTop + tabs.offsetHeight + 4) + "px";
        this.syncBounds();
    }

    refitTerminal() {
        try {
            if (window.term && window.term[window.currentTerm]) window.term[window.currentTerm].fit();
        } catch (e) { /* terminal not ready */ }
    }

    checkSuppression() {
        const s = Object.keys(window.modals || {}).length > 0 || !!document.getElementById("fuzzyFinder");
        if (s !== this.suppressed) {
            this.suppressed = s;
            this.bridge.browser.setSuppressed(s);
            this.panel.dataset.suppressed = s ? "1" : "0";
        }
    }

    syncBounds() {
        let rect = null;
        if (this.layout !== "terminal" && this.state.tabs.length > 0) {
            const r = this.area.getBoundingClientRect();
            if (r.width > 20 && r.height > 20) {
                rect = {x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)};
            }
        }
        const key = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : "none";
        if (key === this.lastRectKey) return;
        this.lastRectKey = key;
        this.bridge.browser.setBounds(rect);
    }

    renderState(s) {
        this.state = s;
        const active = s.tabs.find(t => t.active);
        if (document.activeElement !== this.urlInput) {
            this.urlInput.value = active && active.url !== "about:blank" ? active.url : "";
        }
        this.placeholder.style.display = s.tabs.length ? "none" : "";
        this.panel.querySelector('button[data-op="back"]').disabled = !(active && active.canGoBack);
        this.panel.querySelector('button[data-op="forward"]').disabled = !(active && active.canGoForward);

        this.tabList.innerHTML = s.tabs.map(t => {
            const label = window._escapeHtml((t.title || t.url || "NEW TAB").slice(0, 40));
            return `<li data-id="${t.id}" class="${t.active ? "active" : ""} ${t.loading ? "loading" : ""}" title="${window._escapeHtml(t.url)}">
                <p>${t.loading ? "&#x25CC; " : ""}${label}</p><span class="browser_tab_close" data-close="${t.id}">&#x2715;</span></li>`;
        }).join("") + `<li id="browser_tab_new" title="New tab"><p>+</p></li>`;

        this.tabList.querySelectorAll("li[data-id]").forEach(li => li.addEventListener("click", e => {
            if (e.target.dataset.close) this.cmd("close", {tabId: Number(e.target.dataset.close)});
            else this.cmd("activate", {tabId: Number(li.dataset.id)});
        }));
        document.getElementById("browser_tab_new").addEventListener("click", () => {
            this.cmd("newTab").then(() => this.urlInput.focus());
        });
        this.syncBounds();
    }

    showNotice(type, message) {
        this.noticeEl.textContent = message;
        this.noticeEl.dataset.type = type;
        this.noticeEl.dataset.show = "1";
        clearTimeout(this._noticeTimer);
        this._noticeTimer = setTimeout(() => { this.noticeEl.dataset.show = "0"; }, 5000);
    }
}

module.exports = {
    BrowserPanel
};
