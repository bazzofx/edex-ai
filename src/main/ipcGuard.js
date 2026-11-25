// Sender validation for privileged IPC.
// Only the top frame of the main eDEX window, showing the bundled ui.html, may call
// privileged channels. Web pages in the embedded browser have no preload and no Node,
// so they cannot reach ipcRenderer at all; this check is defense in depth.
"use strict";

const path = require("path");
const {pathToFileURL} = require("url");

const UI_URL = pathToFileURL(path.join(__dirname, "..", "ui.html")).href;

function normalize(u) {
    let s = String(u || "").split("#")[0].split("?")[0];
    try { s = decodeURI(s); } catch (e) { /* keep raw */ }
    return process.platform === "win32" ? s.toLowerCase() : s;
}

function createGuard(ipcMain, getMainWindow, log = () => {}) {
    const uiUrl = normalize(UI_URL);

    function isTrusted(event) {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return false;
        if (event.sender !== win.webContents) return false;
        const frame = event.senderFrame;
        if (!frame || frame.parent) return false;
        return normalize(frame.url) === uiUrl;
    }

    function reject(channel, event) {
        let url = "unknown";
        try { url = event.senderFrame ? event.senderFrame.url : "no frame"; } catch (e) { /* frame gone */ }
        log(`Rejected IPC "${channel}" from untrusted sender (${url})`);
    }

    return {
        isTrusted,
        on(channel, handler) {
            ipcMain.on(channel, (event, ...args) => {
                if (!isTrusted(event)) { reject(channel, event); event.returnValue = null; return; }
                handler(event, ...args);
            });
        },
        handle(channel, handler) {
            ipcMain.handle(channel, async (event, ...args) => {
                if (!isTrusted(event)) { reject(channel, event); throw new Error("Untrusted IPC sender"); }
                return handler(event, ...args);
            });
        }
    };
}

module.exports = {createGuard, UI_URL, normalize};
