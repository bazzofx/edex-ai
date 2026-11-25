// Decides whether a WebSocket client may attach to a terminal (pty) server.
// Pure function so it can be unit tested without Electron.
"use strict";

const crypto = require("crypto");

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function isTerminalClientAllowed({token, reqUrl, origin, remoteAddress}) {
    // Server must have been given a token
    if (typeof token !== "string" || token.length < 32) return false;
    // Loopback only
    if (!LOOPBACK.has(String(remoteAddress))) return false;
    // Only the bundled UI (file://) may connect; web pages send their http(s) origin
    if (origin !== "file://") return false;

    let supplied = null;
    try {
        supplied = new URL(String(reqUrl || "/"), "ws://127.0.0.1").searchParams.get("token");
    } catch (e) {
        return false;
    }
    if (!supplied) return false;
    return safeEqual(supplied, token);
}

module.exports = {isTerminalClientAllowed};
