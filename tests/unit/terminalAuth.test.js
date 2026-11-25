"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {isTerminalClientAllowed} = require("../../src/security/terminalAuth.js");

const token = "a".repeat(48);
const ok = {token, reqUrl: `/?token=${token}`, origin: "file://", remoteAddress: "127.0.0.1"};

test("accepts the bundled UI with the right token", () => {
    assert.equal(isTerminalClientAllowed(ok), true);
    assert.equal(isTerminalClientAllowed({...ok, remoteAddress: "::ffff:127.0.0.1"}), true);
});

test("rejects a missing or wrong token", () => {
    assert.equal(isTerminalClientAllowed({...ok, reqUrl: "/"}), false);
    assert.equal(isTerminalClientAllowed({...ok, reqUrl: "/?token=" + "b".repeat(48)}), false);
    assert.equal(isTerminalClientAllowed({...ok, reqUrl: "/?token=short"}), false);
});

test("rejects web origins and missing origin", () => {
    assert.equal(isTerminalClientAllowed({...ok, origin: "https://evil.example"}), false);
    assert.equal(isTerminalClientAllowed({...ok, origin: "null"}), false);
    assert.equal(isTerminalClientAllowed({...ok, origin: undefined}), false);
});

test("rejects non-loopback peers", () => {
    assert.equal(isTerminalClientAllowed({...ok, remoteAddress: "192.168.1.20"}), false);
});

test("rejects when the server has no usable token", () => {
    assert.equal(isTerminalClientAllowed({...ok, token: undefined}), false);
    assert.equal(isTerminalClientAllowed({...ok, token: "x", reqUrl: "/?token=x"}), false);
});
