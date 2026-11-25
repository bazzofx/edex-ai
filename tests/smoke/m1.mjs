// M1 smoke checks: embedded browser, layouts, web content isolation.
export async function run({cdp, check, sleep, waitFor, screenshot, getTargets, CDP}) {
    const ready = await waitFor(() => cdp.eval("!!window.browserPanel"), 20000);
    check("browser panel initialised", ready);
    if (!ready) return;

    await cdp.eval(`window.browserPanel.setLayout("split").then(() => true)`);
    const split = await cdp.eval(`(() => {
        const t = document.getElementById("main_shell_innercontainer").getBoundingClientRect();
        const b = document.getElementById("browser_panel").getBoundingClientRect();
        return {term: Math.round(t.width), browser: Math.round(b.width), visible: getComputedStyle(document.getElementById("browser_panel")).display};
    })()`);
    check("split layout: terminal and browser side by side", split.visible === "flex" && split.browser > 200 && Math.abs(split.term - split.browser) < 60, JSON.stringify(split));

    const open = await cdp.eval(`window.browserPanel.bridge.browser.cmd("open", {input: "example.com"})`);
    check("open example.com in the browser", open && open.success && /Example Domain/i.test(open.data.title), JSON.stringify(open));

    const web = await waitFor(async () => (await getTargets()).find(t => t.type === "page" && t.url.includes("example.com")), 10000);
    check("page runs in its own web contents", web, web ? web.url : "");
    if (web) {
        const w = new CDP(web.webSocketDebuggerUrl);
        await w.open();
        const iso = await w.eval(`({require: typeof require, process: typeof process, module: typeof module, electron: typeof window.electron, bridge: typeof window.edexai})`);
        check("web page has no Node / Electron access", Object.values(iso).every(v => v === "undefined"), JSON.stringify(iso));

        const sock = await w.eval(`new Promise(r => { try { const s = new WebSocket("ws://127.0.0.1:3100/"); s.onopen = () => r("open"); s.onerror = () => r("blocked"); setTimeout(() => r("timeout"), 3000); } catch (e) { r("blocked: " + e.message); } })`);
        check("web page cannot reach the terminal socket", sock.startsWith("blocked"), sock);
        const http = await w.eval(`fetch("http://localhost:3100/").then(() => "reached", e => "blocked")`);
        check("web page cannot fetch localhost", http === "blocked", http);

        await w.eval(`location.href = "file:///C:/Windows/win.ini"; true`).catch(() => {});
        await sleep(1500);
        const afterFile = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state")`);
        check("navigation to file:// is blocked", afterFile.success && afterFile.data.tabs.every(t => !t.url.startsWith("file:")), JSON.stringify(afterFile.data.tabs.map(t => t.url)));

        const popup = await w.eval(`(() => { const p = window.open("javascript:alert(1)"); return p === null ? "denied" : "opened"; })()`);
        await sleep(800);
        const tabsAfterPopup = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state").then(r => r.data.tabs.length)`);
        check("javascript: popup is denied", popup === "denied" && tabsAfterPopup === 1, `${popup}, tabs=${tabsAfterPopup}`);
        w.close();
    }

    const httpsPopup = await cdp.eval(`window.browserPanel.bridge.browser.cmd("newTab", {input: "https://www.wikipedia.org/"})`);
    check("second tab opens", httpsPopup && httpsPopup.success, JSON.stringify(httpsPopup).slice(0, 200));
    const twoTabs = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state").then(r => r.data.tabs.length)`);
    check("tab list has two tabs", twoTabs === 2, String(twoTabs));
    const closed = await cdp.eval(`window.browserPanel.bridge.browser.cmd("close")`);
    check("close active tab", closed && closed.success, JSON.stringify(closed));

    const bad = await cdp.eval(`window.browserPanel.bridge.browser.cmd("open", {input: "javascript:alert(1)"})`);
    check("URL bar rejects javascript: with an actionable error", bad && bad.success === false && /scheme/i.test(bad.error), bad && bad.error);
    const badArg = await cdp.eval(`window.browserPanel.bridge.browser.cmd("activate", {tabId: "x"})`);
    check("IPC rejects invalid arguments", badArg && badArg.success === false && /Invalid request/.test(badArg.error), badArg && badArg.error);

    // Non-DRM video
    const vid = await cdp.eval(`window.browserPanel.bridge.browser.cmd("open", {input: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm"})`);
    check("open a WebM video", vid && vid.success, JSON.stringify(vid).slice(0, 200));
    const vt = await waitFor(async () => (await getTargets()).find(t => t.type === "page" && t.url.includes("flower.webm")), 8000);
    if (vt) {
        const v = new CDP(vt.webSocketDebuggerUrl);
        await v.open();
        const played = await v.eval(`new Promise(async r => { const el = document.querySelector("video"); if (!el) return r("no video"); el.muted = true; try { await el.play(); } catch (e) { return r("play failed: " + e.message); } setTimeout(() => r(el.currentTime > 0.5 ? "playing " + el.currentTime.toFixed(1) + "s" : "stuck at " + el.currentTime), 2500); })`);
        check("WebM video plays", played.startsWith("playing"), played);
        const mp4 = await v.eval(`new Promise(r => { const el = document.createElement("video"); r({h264: el.canPlayType('video/mp4; codecs="avc1.42E01E"'), vp9: el.canPlayType('video/webm; codecs="vp9"'), av1: el.canPlayType('video/mp4; codecs="av01.0.05M.08"')}); })`);
        check("codec support reported", true, JSON.stringify(mp4));
        v.close();
    }

    await cdp.eval(`window.browserPanel.setLayout("browser").then(() => true)`);
    const st = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state")`);
    check("browser layout shows the page view", st.success && st.data.visible === true, JSON.stringify({visible: st.data.visible}));
    check("screenshot (M1 browser layout, UI layer)", await screenshot(cdp, "m1-browser.png"));

    // Modal suppression: native view hides while an eDEX modal is open
    await cdp.eval(`new Modal({type: "info", title: "Test", message: "smoke"}); true`);
    await sleep(500);
    const hidden = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state").then(r => r.data.visible)`);
    await cdp.eval(`Object.values(window.modals).forEach(m => m.close && m.close()); true`);
    await sleep(800);
    const shown = await cdp.eval(`window.browserPanel.bridge.browser.cmd("state").then(r => r.data.visible)`);
    check("page view hides while an eDEX modal is open", hidden === false && shown === true, `open=${hidden} closed=${shown}`);

    await cdp.eval(`window.browserPanel.setLayout("split").then(() => true)`);
    check("screenshot (M1 split, UI layer)", await screenshot(cdp, "m1-split.png"));
}
