// URL policy for the embedded browser. Pure functions, unit tested.
"use strict";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_SPECIAL = new Set(["about:blank"]);

function isLoopbackHost(hostname) {
    const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (h === "localhost" || h.endsWith(".localhost")) return true;
    if (h === "::1" || h === "0:0:0:0:0:0:0:1" || h === "::" ) return true;
    if (h.startsWith("::ffff:")) {
        const rest = h.slice(7);
        // IPv4-mapped in hex form, e.g. ::ffff:7f00:1 == 127.0.0.1
        if (/^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(rest)) return true;
        return isLoopbackHost(rest);
    }
    if (/^127(\.\d{1,3}){3}$/.test(h)) return true;
    if (h === "0.0.0.0" || /^0+$/.test(h)) return true;
    // Decimal / hex encodings of 127.x (e.g. 2130706433, 0x7f000001) are normalised by URL()
    return false;
}

// Is this URL allowed to be loaded as a top-level page in a browser tab?
function checkNavigation(rawUrl) {
    if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 8192) {
        return {ok: false, error: "URL is empty or too long"};
    }
    if (SAFE_SPECIAL.has(rawUrl)) return {ok: true, url: rawUrl};
    let u;
    try {
        u = new URL(rawUrl);
    } catch (e) {
        return {ok: false, error: `Not a valid URL: ${rawUrl.slice(0, 200)}`};
    }
    if (!ALLOWED_PROTOCOLS.has(u.protocol)) {
        return {ok: false, error: `Blocked URL scheme "${u.protocol}" (only http and https are allowed)`};
    }
    if (u.username || u.password) {
        return {ok: false, error: "URLs with embedded credentials are blocked"};
    }
    if (isLoopbackHost(u.hostname)) {
        return {ok: false, error: "Local addresses (localhost / 127.x) are blocked in the embedded browser"};
    }
    return {ok: true, url: u.href};
}

// Turn what a user typed (or a model produced) into a URL, or say it is a search.
function normalizeUserInput(input) {
    const text = String(input || "").trim();
    if (!text) return {ok: false, error: "Nothing to open"};
    if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^:\s]+:\d+(\/|$)/.test(text)) {
        // Has a scheme (but not "host:port")
        return checkNavigation(text);
    }
    if (!/\s/.test(text) && /^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) {
        return checkNavigation("https://" + text);
    }
    return {ok: false, search: true, query: text, error: "Not a URL"};
}

// Should a subresource / any request from web content be blocked?
// Blocks loopback (protects the terminal and voice sockets) and non-web schemes.
function shouldBlockRequest(rawUrl) {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return true; }
    if (["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return isLoopbackHost(u.hostname);
    if (["data:", "blob:", "about:", "chrome-extension:", "devtools:"].includes(u.protocol)) return false;
    return true;
}

const SEARCH_PROVIDERS = {
    google: q => "https://www.google.com/search?q=" + encodeURIComponent(q),
    duckduckgo: q => "https://duckduckgo.com/?q=" + encodeURIComponent(q),
    youtube: q => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q),
    wikipedia: q => "https://en.wikipedia.org/w/index.php?search=" + encodeURIComponent(q)
};

function searchUrl(provider, query) {
    const fn = SEARCH_PROVIDERS[provider];
    if (!fn) return {ok: false, error: `Unknown search provider "${provider}". Use one of: ${Object.keys(SEARCH_PROVIDERS).join(", ")}`};
    const q = String(query || "").trim();
    if (!q) return {ok: false, error: "Search query is empty"};
    if (q.length > 500) return {ok: false, error: "Search query is too long (max 500 characters)"};
    return {ok: true, url: fn(q)};
}

module.exports = {checkNavigation, normalizeUserInput, shouldBlockRequest, searchUrl, isLoopbackHost, SEARCH_PROVIDERS};
