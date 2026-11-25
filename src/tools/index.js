// The eDEX AI tool set. Adapters are injected so tests can use mocks.
//   browser: BrowserManager-like  (open, navigate, createTab, closeTab, history, reload, media, state)
//   ui:      UiController-like    (setLayout, request)
//   system:  {getStats()}
//   terminal:{runApproved(commandId, args)} + approvedCommands list
"use strict";

const {z} = require("zod");
const {ToolRegistry} = require("./registry.js");
const {normalizeUserInput, searchUrl, SEARCH_PROVIDERS} = require("../security/urlPolicy.js");

function buildRegistry({browser, ui, system, terminal, approvedCommands = [], searchProvider = "duckduckgo", toolTimeoutMs = 12000}) {
    const reg = new ToolRegistry({defaultTimeoutMs: toolTimeoutMs});
    const providers = Object.keys(SEARCH_PROVIDERS);

    reg.register({
        name: "browser.open",
        description: "Open a web page (http/https URL or domain such as youtube.com) in the current browser tab. Does not search; use browser_search for search terms.",
        schema: z.object({
            url: z.string().min(1).max(2048).describe("Full URL or bare domain, e.g. https://www.youtube.com or wikipedia.org"),
            newTab: z.boolean().optional().describe("Open in a new tab instead of the current one")
        }),
        policy: "safe",
        run: async ({url, newTab}) => {
            const n = normalizeUserInput(url);
            if (!n.ok) return {success: false, error: n.search ? `"${url}" is not a URL; use browser_search for search terms` : n.error};
            return browser.navigate(n.url, {newTab: newTab === true});
        }
    });

    reg.register({
        name: "browser.search",
        description: `Search the web or a site. provider: ${providers.join(", ")} (use youtube for videos). Opens the results page.`,
        schema: z.object({
            query: z.string().min(1).max(500),
            provider: z.enum(providers).optional().describe(`Defaults to ${searchProvider}`),
            newTab: z.boolean().optional()
        }),
        policy: "safe",
        run: async ({query, provider, newTab}) => {
            const s = searchUrl(provider || searchProvider, query);
            if (!s.ok) return {success: false, error: s.error};
            return browser.navigate(s.url, {newTab: newTab === true});
        }
    });

    reg.register({
        name: "browser.back",
        description: "Go back to the previous page in the current tab.",
        schema: z.object({}),
        policy: "safe",
        run: () => browser.history("back")
    });

    reg.register({
        name: "browser.forward",
        description: "Go forward in the current tab's history.",
        schema: z.object({}),
        policy: "safe",
        run: () => browser.history("forward")
    });

    reg.register({
        name: "browser.reload",
        description: "Reload the current page.",
        schema: z.object({}),
        policy: "safe",
        run: () => browser.reload()
    });

    reg.register({
        name: "browser.media",
        description: "Control the main video or audio on the current page (best effort; works once a video page is open).",
        schema: z.object({action: z.enum(["play", "pause", "toggle", "mute", "unmute"])}),
        policy: "safe",
        run: ({action}) => browser.media(action)
    });

    reg.register({
        name: "browser.newTab",
        description: "Open a new browser tab, optionally with a URL.",
        schema: z.object({url: z.string().min(1).max(2048).optional()}),
        policy: "safe",
        run: async ({url}) => {
            if (!url) return browser.createTab("about:blank");
            const n = normalizeUserInput(url);
            if (!n.ok) return {success: false, error: n.search ? `"${url}" is not a URL; use browser_search` : n.error};
            return browser.navigate(n.url, {newTab: true});
        }
    });

    reg.register({
        name: "browser.closeTab",
        description: "Close a browser tab by id (from browser_listTabs), or the current tab if no id is given.",
        schema: z.object({tabId: z.number().int().positive().optional()}),
        policy: "safe",
        run: ({tabId}) => browser.closeTab(tabId ?? null)
    });

    reg.register({
        name: "browser.listTabs",
        description: "List open browser tabs with ids, titles and URLs.",
        schema: z.object({}),
        policy: "safe",
        run: () => {
            const s = browser.state();
            return {success: true, data: {activeTabId: s.activeTabId, tabs: s.tabs.map(t => ({id: t.id, title: t.title.slice(0, 80), url: t.url.slice(0, 200)}))}};
        }
    });

    reg.register({
        name: "ui.setLayout",
        description: "Change the workspace layout: terminal (terminal only), browser (browser only) or split (side by side).",
        schema: z.object({layout: z.enum(["terminal", "browser", "split"])}),
        policy: "safe",
        run: ({layout}) => ui.setLayout(layout)
    });

    reg.register({
        name: "system.getStats",
        description: "Read current system metrics: CPU load, memory, GPU, uptime, disk and battery.",
        schema: z.object({}),
        policy: "safe",
        timeoutMs: 15000,
        run: () => system.getStats()
    });

    reg.register({
        name: "terminal.listTabs",
        description: "List the open terminal tabs.",
        schema: z.object({}),
        policy: "safe",
        run: () => ui.request("listTerminals")
    });

    reg.register({
        name: "terminal.createTab",
        description: "Open a new terminal tab (shell session).",
        schema: z.object({}),
        policy: "safe",
        run: () => ui.request("createTerminal", {}, 5000)
    });

    if (approvedCommands.length) {
        const ids = approvedCommands.map(c => c.id);
        reg.register({
            name: "terminal.runApproved",
            description: "Run one pre-approved command (the user must confirm it). Commands: " +
                approvedCommands.map(c => `${c.id} (${c.description}${c.params ? "; args: " + Object.keys(c.params).join(", ") : ""})`).join("; "),
            schema: z.object({
                commandId: z.enum(ids),
                arguments: z.record(z.string(), z.string().max(200)).optional()
            }),
            policy: "confirm",
            timeoutMs: 70000, // includes the time the user takes to confirm
            summarize: ({commandId, arguments: a}) => terminal.describe(commandId, a || {}),
            run: ({commandId, arguments: a}) => terminal.runApproved(commandId, a || {})
        });
    }

    return reg;
}

module.exports = {buildRegistry};
