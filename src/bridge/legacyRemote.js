// Renderer-side replacement for the removed @electron/remote module.
// Exposes only what the legacy eDEX renderer used, backed by fixed IPC channels
// handled (and sender-checked) in src/main/legacyBridge.js.
"use strict";

const {ipcRenderer, clipboard} = require("electron");

const info = ipcRenderer.sendSync("edexai:legacy-info") || {};

const shortcutHandlers = new Map();
let nextShortcutId = 1;
ipcRenderer.on("edexai:shortcut", (e, id) => {
    const fn = shortcutHandlers.get(id);
    if (fn) fn();
});

const winListeners = {};
ipcRenderer.on("edexai:win-event", (e, evt) => {
    (winListeners[evt] || []).forEach(fn => fn());
});

const currentWindow = {
    isFullScreen: () => ipcRenderer.sendSync("edexai:win-get", "isFullScreen"),
    isMaximized: () => ipcRenderer.sendSync("edexai:win-get", "isMaximized"),
    getSize: () => ipcRenderer.sendSync("edexai:win-get", "getSize"),
    setFullScreen: v => ipcRenderer.send("edexai:win-set", "setFullScreen", v === true),
    minimize: () => ipcRenderer.send("edexai:win-set", "minimize"),
    unmaximize: () => ipcRenderer.send("edexai:win-set", "unmaximize"),
    setSize: (w, h) => ipcRenderer.send("edexai:win-set", "setSize", w, h),
    on: (evt, fn) => {
        (winListeners[evt] = winListeners[evt] || []).push(fn);
    },
    webContents: {
        toggleDevTools: () => ipcRenderer.send("edexai:win-set", "toggleDevTools")
    }
};

module.exports = {
    app: {
        getPath: name => {
            if (name === "userData") return info.userData;
            throw new Error(`legacyRemote: app.getPath("${name}") is not available`);
        },
        getVersion: () => info.version,
        focus: () => ipcRenderer.send("edexai:app", "focus"),
        relaunch: () => ipcRenderer.send("edexai:app", "relaunch"),
        quit: () => ipcRenderer.send("edexai:app", "quit")
    },
    process: {
        argv: info.argv || []
    },
    screen: {
        getAllDisplays: () => ipcRenderer.sendSync("edexai:displays") || []
    },
    clipboard,
    globalShortcut: {
        register: (trigger, fn) => {
            const id = nextShortcutId++;
            shortcutHandlers.set(id, fn);
            ipcRenderer.send("edexai:shortcut-register", id, trigger);
        },
        unregisterAll: () => {
            shortcutHandlers.clear();
            ipcRenderer.send("edexai:shortcut-unregister-all");
        }
    },
    getCurrentWindow: () => currentWindow,
    terminalToken: info.terminalToken,
    dev: info.dev === true
};
