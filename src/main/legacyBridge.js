// Main-process side of the legacy remote replacement (see src/bridge/legacyRemote.js).
// Replaces the subset of @electron/remote / electron.remote that the eDEX renderer used,
// with a fixed list of IPC channels and validated arguments.
"use strict";

const {app, screen, globalShortcut} = require("electron");

function registerLegacyBridge(guard, getMainWindow, info) {
    const win = () => {
        const w = getMainWindow();
        return (w && !w.isDestroyed()) ? w : null;
    };

    // Synchronous info the renderer needs at startup
    guard.on("edexai:legacy-info", event => {
        event.returnValue = {
            userData: app.getPath("userData"),
            version: info.version,
            argv: process.argv.slice(),
            terminalToken: info.terminalToken,
            dev: info.dev
        };
    });

    guard.on("edexai:displays", event => {
        event.returnValue = screen.getAllDisplays().map(d => ({id: d.id, bounds: d.bounds}));
    });

    guard.on("edexai:app", (event, action) => {
        switch (action) {
            case "focus": app.focus({steal: true}); break;
            case "relaunch": app.relaunch(); app.quit(); break;
            case "quit": app.quit(); break;
            default: break;
        }
    });

    // Window control. Getters are sync (sendSync), setters async.
    guard.on("edexai:win-get", (event, prop) => {
        const w = win();
        if (!w) { event.returnValue = null; return; }
        switch (prop) {
            case "isFullScreen": event.returnValue = w.isFullScreen(); break;
            case "isMaximized": event.returnValue = w.isMaximized(); break;
            case "getSize": event.returnValue = w.getSize(); break;
            default: event.returnValue = null;
        }
    });

    guard.on("edexai:win-set", (event, action, ...args) => {
        const w = win();
        if (!w) return;
        switch (action) {
            case "setFullScreen": w.setFullScreen(args[0] === true); break;
            case "minimize": w.minimize(); break;
            case "unmaximize": w.unmaximize(); break;
            case "setSize": {
                const [width, height] = args.map(Number);
                if (Number.isInteger(width) && Number.isInteger(height) && width > 200 && height > 150 && width < 20000 && height < 20000) {
                    w.setSize(width, height);
                }
                break;
            }
            case "toggleDevTools": w.webContents.toggleDevTools(); break;
            default: break;
        }
    });

    // Global shortcuts registered on behalf of the renderer (it re-registers on focus, clears on blur)
    guard.on("edexai:shortcut-register", (event, id, trigger) => {
        if (!Number.isInteger(id) || typeof trigger !== "string" || trigger.length > 64) return;
        try {
            globalShortcut.register(trigger, () => {
                const w = win();
                if (w) w.webContents.send("edexai:shortcut", id);
            });
        } catch (e) {
            // invalid accelerator, ignore like upstream did
        }
    });
    guard.on("edexai:shortcut-unregister-all", () => {
        globalShortcut.unregisterAll();
    });

    app.on("will-quit", () => globalShortcut.unregisterAll());
}

// Forward window events the renderer listens to.
function forwardWindowEvents(w) {
    ["resize", "leave-full-screen", "enter-full-screen"].forEach(evt => {
        w.on(evt, () => {
            if (!w.isDestroyed()) w.webContents.send("edexai:win-event", evt);
        });
    });
}

module.exports = {registerLegacyBridge, forwardWindowEvents};
