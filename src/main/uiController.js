// Main -> renderer requests with replies (e.g. "set layout", answered once the DOM changed).
"use strict";

const crypto = require("crypto");

class UiController {
    constructor(getWindow, guard) {
        this.getWindow = getWindow;
        this.pending = new Map();
        this.layout = "terminal";
        guard.on("edexai:ui:response", (e, msg) => {
            if (!msg || typeof msg.reqId !== "string") return;
            const p = this.pending.get(msg.reqId);
            if (!p) return;
            this.pending.delete(msg.reqId);
            clearTimeout(p.timer);
            p.resolve(msg.ok === true
                ? {success: true, data: msg.data}
                : {success: false, error: String(msg.error || "UI request failed")});
        });
        guard.on("edexai:layout:changed", (e, layout) => {
            if (["terminal", "browser", "split"].includes(layout)) this.layout = layout;
        });
    }

    request(op, payload = {}, timeoutMs = 4000) {
        const win = this.getWindow();
        if (!win || win.isDestroyed()) return Promise.resolve({success: false, error: "UI window is not available"});
        const reqId = crypto.randomUUID();
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pending.delete(reqId);
                resolve({success: false, error: `UI did not answer "${op}" within ${timeoutMs} ms (is the UI still booting?)`});
            }, timeoutMs);
            this.pending.set(reqId, {resolve, timer});
            win.webContents.send("edexai:ui:request", {reqId, op, payload});
        });
    }

    async setLayout(layout) {
        const r = await this.request("setLayout", {layout});
        if (r.success) this.layout = layout;
        return r;
    }
}

module.exports = {UiController};
