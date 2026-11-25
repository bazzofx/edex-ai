"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../../src/security/urlPolicy.js");

test("allows normal http(s) pages", () => {
    assert.equal(p.checkNavigation("https://www.youtube.com/").ok, true);
    assert.equal(p.checkNavigation("http://example.com/a?b=c").ok, true);
    assert.equal(p.checkNavigation("about:blank").ok, true);
});

test("blocks dangerous schemes", () => {
    for (const u of ["file:///C:/Windows/win.ini", "javascript:alert(1)", "data:text/html,<b>x</b>",
        "ms-settings:", "vscode://x", "chrome://settings", "devtools://devtools/bundled/x.html", "ftp://x.org"]) {
        assert.equal(p.checkNavigation(u).ok, false, u);
    }
});

test("blocks loopback in all common spellings", () => {
    for (const u of ["http://localhost:3000/", "http://127.0.0.1:3000", "http://127.1.2.3/", "http://[::1]:3000/",
        "http://0.0.0.0:3000", "http://2130706433/", "http://0x7f000001/", "http://foo.localhost/", "http://[::ffff:127.0.0.1]/"]) {
        assert.equal(p.checkNavigation(u).ok, false, u);
    }
});

test("blocks embedded credentials", () => {
    assert.equal(p.checkNavigation("https://user:pw@example.com").ok, false);
});

test("normalizes user input", () => {
    assert.equal(p.normalizeUserInput("youtube.com").url, "https://youtube.com/");
    assert.equal(p.normalizeUserInput("en.wikipedia.org/wiki/Black_hole").url, "https://en.wikipedia.org/wiki/Black_hole");
    const s = p.normalizeUserInput("black hole documentaries");
    assert.equal(s.ok, false);
    assert.equal(s.search, true);
    assert.equal(p.normalizeUserInput("file:///etc/passwd").ok, false);
    assert.equal(p.normalizeUserInput("").ok, false);
});

test("blocks web requests to loopback and odd schemes", () => {
    assert.equal(p.shouldBlockRequest("ws://127.0.0.1:3000/?token=x"), true);
    assert.equal(p.shouldBlockRequest("http://localhost:8765/"), true);
    assert.equal(p.shouldBlockRequest("file:///C:/x"), true);
    assert.equal(p.shouldBlockRequest("https://i.ytimg.com/x.jpg"), false);
    assert.equal(p.shouldBlockRequest("data:image/png;base64,AAAA"), false);
    assert.equal(p.shouldBlockRequest("blob:https://www.youtube.com/abc"), false);
});

test("builds search URLs", () => {
    assert.equal(p.searchUrl("youtube", "black hole documentaries").url,
        "https://www.youtube.com/results?search_query=black%20hole%20documentaries");
    assert.equal(p.searchUrl("bing", "x").ok, false);
    assert.equal(p.searchUrl("google", "  ").ok, false);
});
