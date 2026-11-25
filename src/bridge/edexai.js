// The single renderer-side entry point to eDEX AI features. Fixed channel list.
// (Becomes the contextBridge preload once the legacy renderer runs with contextIsolation.)
"use strict";

const {ipcRenderer} = require("electron");

const RECEIVE = new Set([
    "edexai:browser:state",
    "edexai:browser:notice",
    "edexai:ui:request",
    "edexai:assistant:event"
]);

function on(channel, fn) {
    if (!RECEIVE.has(channel)) throw new Error(`edexai bridge: channel ${channel} is not allowed`);
    const listener = (e, ...args) => fn(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

module.exports = {
    browser: {
        cmd: (op, args = {}) => ipcRenderer.invoke("edexai:browser:cmd", {op, ...args}),
        setBounds: rect => ipcRenderer.send("edexai:browser:bounds", rect),
        setSuppressed: v => ipcRenderer.send("edexai:browser:suppress", v === true),
        onState: fn => on("edexai:browser:state", fn),
        onNotice: fn => on("edexai:browser:notice", fn)
    },
    ui: {
        // handler(op, payload) -> data (or throws)
        onRequest: handler => on("edexai:ui:request", async msg => {
            try {
                const data = await handler(msg.op, msg.payload || {});
                ipcRenderer.send("edexai:ui:response", {reqId: msg.reqId, ok: true, data});
            } catch (err) {
                ipcRenderer.send("edexai:ui:response", {reqId: msg.reqId, ok: false, error: String(err && err.message || err)});
            }
        }),
        layoutChanged: layout => ipcRenderer.send("edexai:layout:changed", layout)
    },
    assistant: {
        send: text => ipcRenderer.invoke("edexai:assistant:send", {text}),
        cancel: () => ipcRenderer.invoke("edexai:assistant:cancel"),
        confirm: (confirmId, approved) => ipcRenderer.invoke("edexai:assistant:confirm", {confirmId, approved: approved === true}),
        status: () => ipcRenderer.invoke("edexai:assistant:status"),
        pttStart: () => ipcRenderer.invoke("edexai:voice:ptt", {action: "start"}),
        pttStop: () => ipcRenderer.invoke("edexai:voice:ptt", {action: "stop"}),
        setMicMuted: muted => ipcRenderer.invoke("edexai:voice:mute", {muted: muted === true}),
        stopSpeaking: () => ipcRenderer.invoke("edexai:voice:stop"),
        onEvent: fn => on("edexai:assistant:event", fn)
    }
};
