// M2 smoke checks: typed commands drive real tools through the configured LLM provider.
export async function run({cdp, check, sleep, waitFor, screenshot}) {
    const ready = await waitFor(() => cdp.eval("!!window.assistantPanel"), 20000);
    check("assistant panel initialised", ready);
    if (!ready) return;

    const status = await cdp.eval("window.assistantPanel.bridge.assistant.status()");
    check("assistant service reports provider and tools", status && status.success && status.data.tools.length >= 14, status && JSON.stringify({provider: status.data.provider, tools: status.data.tools.length}));

    await cdp.eval("window.browserPanel.setLayout('terminal').then(() => true)");

    async function typed(text, timeoutMs = 60000) {
        await cdp.eval(`window.assistantPanel.lastTurn = null; window.assistantPanel.input.value = ${JSON.stringify(text)}; window.assistantPanel.submit(); true`);
        return waitFor(() => cdp.eval("window.assistantPanel.lastTurn"), timeoutMs, 300);
    }

    const t1 = await typed("Open YouTube and search for black hole documentaries, then switch to split view.");
    check("typed example command completes", t1 && t1.ok, t1 ? `${t1.reply} | ${JSON.stringify(t1.timings)}` : "no turn");
    if (t1) {
        const names = t1.toolResults.map(t => `${t.name}:${t.success ? "ok" : "fail " + t.error}`);
        check("example used search + layout tools successfully", names.some(n => n.startsWith("browser_search:ok") || n.startsWith("browser_open:ok")) && names.includes("ui_setLayout:ok"), names.join(", "));
    }
    const st = await cdp.eval("window.browserPanel.bridge.browser.cmd('state')");
    const active = st.data.tabs.find(t => t.active);
    check("browser really shows YouTube results", active && /youtube\.com\/results\?search_query=black/i.test(active.url), active && active.url);
    const layout = await cdp.eval("window.browserPanel.layout");
    check("layout really changed to split", layout === "split", layout);
    check("screenshot (M2 after example command)", await screenshot(cdp, "m2-example.png"));

    const t2 = await typed("What is my current CPU and memory usage?");
    check("system stats question answered from a tool", t2 && t2.ok && t2.toolResults.some(t => t.name === "system_getStats" && t.success), t2 && t2.reply);

    const t3 = await typed("Open file:///C:/Windows/win.ini in the browser");
    const blocked = t3 && t3.toolResults.length > 0 && t3.toolResults.every(t => !t.success);
    const stillSafe = (await cdp.eval("window.browserPanel.bridge.browser.cmd('state')")).data.tabs.every(t => !t.url.startsWith("file:"));
    check("file:// request is refused, not reported as success", (blocked || (t3 && t3.toolResults.length === 0)) && stillSafe, t3 && `${t3.reply} | tools: ${JSON.stringify(t3.toolResults)}`);

    // Cancel during a turn
    await cdp.eval(`window.assistantPanel.lastTurn = null; window.assistantPanel.input.value = "Search wikipedia for neutron stars"; window.assistantPanel.submit(); true`);
    await sleep(300);
    await cdp.eval("window.assistantPanel.cancel(); true");
    const idle = await waitFor(() => cdp.eval("window.assistantPanel.state === 'idle' ? true : null"), 10000, 200);
    const logText = await cdp.eval("document.getElementById('assistant_log').innerText");
    check("cancel returns the assistant to idle", idle && /Cancelled/.test(logText), idle ? "idle" : await cdp.eval("window.assistantPanel.state"));

    check("screenshot (M2 assistant panel)", await screenshot(cdp, "m2-assistant.png"));
}
