// eDEX AI runtime config: <userData>/edex-ai.json merged over the bundled example defaults.
"use strict";

const fs = require("fs");
const path = require("path");
const {execFileSync} = require("child_process");

const DEFAULTS_FILE = path.join(__dirname, "edex-ai.example.json");

function deepMerge(base, over) {
    if (Array.isArray(base) || typeof base !== "object" || base === null) return over === undefined ? base : over;
    const out = {...base};
    for (const [k, v] of Object.entries(over || {})) {
        out[k] = (k in base && typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]) && typeof v === "object" && v !== null && !Array.isArray(v))
            ? deepMerge(base[k], v) : v;
    }
    return out;
}

function loadConfig(userDataDir) {
    const defaults = JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
    const file = path.join(userDataDir, "edex-ai.json");
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, JSON.stringify(defaults, null, 4));
        return {config: defaults, file, created: true};
    }
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        throw new Error(`Cannot parse ${file}: ${e.message}`);
    }
    return {config: deepMerge(defaults, user), file, created: false};
}

// Read a secret from the process environment, or (Windows) from the user's persistent
// environment when this process was started before the variable was set. Never logged.
function readSecretEnv(name) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) return null;
    if (process.env[name]) return process.env[name];
    if (process.platform !== "win32") return null;
    try {
        const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"]});
        const m = out.match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, "mi"));
        return m ? m[1] : null;
    } catch (e) {
        return null;
    }
}

module.exports = {loadConfig, readSecretEnv, deepMerge};
