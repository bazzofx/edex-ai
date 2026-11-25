// systeminformation calls for the renderer widgets (IPC "systeminformation-call").
//
// eDEX AI: the upstream cluster of one worker per core is gone; see src/main/siService.js
// for why. The IPC contract with the renderer (window.si proxy in _renderer.js) is unchanged.
"use strict";

const electron = require("electron");
const signale = require("signale");
const {SiService} = require("./main/siService.js");

const ipc = electron.ipcMain;
const service = new SiService({log: msg => signale.debug(msg)});

ipc.on("systeminformation-call", (e, type, id, ...args) => {
    if (typeof type !== "string" || typeof id !== "string" || !service.isAllowed(type)) {
        signale.warn(`Illegal request for systeminformation: ${String(type).slice(0, 40)}`);
        return;
    }
    // The renderer may pass a trailing callback placeholder; it is not serialisable anyway
    const callArgs = args.filter(a => typeof a !== "function" && a !== null && a !== undefined);
    service.call(type, ...callArgs).then(res => {
        if (!e.sender.isDestroyed()) e.sender.send("systeminformation-reply-" + id, res);
    }).catch(err => {
        signale.debug(`systeminformation.${type} failed: ${err.message}`);
    });
});

electron.app.on("will-quit", () => service.release());

signale.success("systeminformation service ready (single process, shared cache)");

module.exports = {siService: service};
