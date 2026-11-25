// Privileged IPC for the eDEX AI features. Every channel is sender-checked by the guard
// and every payload is validated with zod before it reaches a handler.
"use strict";

const {z} = require("zod");

const Rect = z.object({
    x: z.number().int().min(0).max(20000),
    y: z.number().int().min(0).max(20000),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000)
}).strict();

const BrowserCmd = z.discriminatedUnion("op", [
    z.object({op: z.literal("open"), input: z.string().min(1).max(4096), newTab: z.boolean().optional()}).strict(),
    z.object({op: z.literal("newTab"), input: z.string().max(4096).optional()}).strict(),
    z.object({op: z.literal("close"), tabId: z.number().int().positive().optional()}).strict(),
    z.object({op: z.literal("activate"), tabId: z.number().int().positive()}).strict(),
    z.object({op: z.literal("back")}).strict(),
    z.object({op: z.literal("forward")}).strict(),
    z.object({op: z.literal("reload")}).strict(),
    z.object({op: z.literal("stop")}).strict(),
    z.object({op: z.literal("state")}).strict()
]);

function parseOrError(schema, value) {
    const r = schema.safeParse(value);
    if (r.success) return {ok: true, value: r.data};
    return {ok: false, error: "Invalid request: " + r.error.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")};
}

function registerBrowserIpc(guard, browser) {
    guard.handle("edexai:browser:cmd", async (e, payload) => {
        const p = parseOrError(BrowserCmd, payload);
        if (!p.ok) return {success: false, error: p.error};
        const c = p.value;
        switch (c.op) {
            case "open": return browser.open(c.input, {newTab: c.newTab === true});
            case "newTab": return c.input ? browser.open(c.input, {newTab: true}) : browser.createTab("about:blank");
            case "close": return browser.closeTab(c.tabId ?? null);
            case "activate": return browser.activate(c.tabId);
            case "back": return browser.history("back");
            case "forward": return browser.history("forward");
            case "reload": return browser.reload();
            case "stop": return browser.stop();
            case "state": return {success: true, data: browser.state()};
        }
        return {success: false, error: "Unknown op"};
    });

    guard.on("edexai:browser:bounds", (e, rect) => {
        if (rect === null) { browser.setRect(null); return; }
        const p = parseOrError(Rect, rect);
        if (p.ok) browser.setRect(p.value);
    });

    guard.on("edexai:browser:suppress", (e, v) => browser.setSuppressed(v === true));
}

module.exports = {registerBrowserIpc, schemas: {Rect, BrowserCmd}, parseOrError};
