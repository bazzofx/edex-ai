// Smoke test: launch eDEX AI, drive it over the Chrome DevTools Protocol (loopback only,
// enabled only here), check terminal + telemetry + security, save a screenshot.
// Usage: node tests/smoke/launch.mjs [--keep] [--only=m0,m1,m2]
import {spawn, execSync} from "node:child_process";
import {createRequire} from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(path.join(root, "src", "package.json"));
const WS = require("ws");

const PORT = 9333;
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const only = (args.find(a => a.startsWith("--only=")) || "--only=m0,m1,m2").slice(7).split(",");
const outDir = path.join(root, "tests", "smoke", "out");
fs.mkdirSync(outDir, {recursive: true});

const home = fs.mkdtempSync(path.join(os.tmpdir(), "edexai-smoke-"));
// Pre-seed settings so the test never touches the user's own profile
fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({
    shell: process.platform === "win32" ? "powershell.exe" : "bash",
    shellArgs: process.platform === "win32" ? "-NoLogo -NoProfile" : "",
    cwd: home, keyboard: "en-US", theme: "tron", termFontSize: 15,
    audio: false, audioVolume: 0, disableFeedbackAudio: true, clockHours: 24,
    pingAddr: "1.1.1.1", port: 3100, nointro: true, nocursor: false,
    forceFullscreen: false, allowWindowed: true, excludeThreadsFromToplist: true,
    hideDotfiles: false, fsListView: false, experimentalGlobeFeatures: false,
    experimentalFeatures: false, updateCheck: false, externalIpLookup: false,
    ...(process.env.EDEXAI_SMOKE_SETTINGS ? JSON.parse(process.env.EDEXAI_SMOKE_SETTINGS) : {})
}, null, 4));

const results = [];
function check(name, ok, detail = "") {
    results.push({name, ok: !!ok, detail});
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const electronBin = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const app = spawn(electronBin, ["src", "--nointro", "--dev", `--remote-debugging-port=${PORT}`, "--remote-debugging-address=127.0.0.1"], {
    cwd: root,
    env: {...process.env, EDEXAI_HOME: home, EDEXAI_TEST: "1"},
    stdio: ["ignore", "pipe", "pipe"]
});
let appLog = "";
app.stdout.on("data", d => { appLog += d; });
app.stderr.on("data", d => { appLog += d; });

async function getTargets() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`);
    return r.json();
}

class CDP {
    constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
    open() {
        return new Promise((res, rej) => {
            this.ws = new WebSocket(this.url);
            this.ws.onopen = res;
            this.ws.onerror = rej;
            this.ws.onmessage = ev => {
                const msg = JSON.parse(ev.data);
                if (msg.id && this.pending.has(msg.id)) {
                    this.pending.get(msg.id)(msg);
                    this.pending.delete(msg.id);
                }
            };
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({id, method, params}));
        return new Promise(res => this.pending.set(id, res));
    }
    async eval(expr) {
        const r = await this.send("Runtime.evaluate", {expression: expr, awaitPromise: true, returnByValue: true});
        if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
        return r.result?.result?.value;
    }
    close() { try { this.ws.close(); } catch (e) { /* ignore */ } }
}

async function waitFor(fn, timeoutMs, stepMs = 500) {
    const end = Date.now() + timeoutMs;
    let last;
    while (Date.now() < end) {
        try { last = await fn(); if (last) return last; } catch (e) { last = e; }
        await sleep(stepMs);
    }
    return null;
}

async function screenshot(cdp, name) {
    const r = await cdp.send("Page.captureScreenshot", {format: "png"});
    const file = path.join(outDir, name);
    fs.writeFileSync(file, Buffer.from(r.result.data, "base64"));
    return file;
}

function wsAttempt(url, headers) {
    return new Promise(resolve => {
        const s = new WS(url, {headers});
        const t = setTimeout(() => { s.terminate(); resolve("timeout"); }, 3000);
        s.on("open", () => { clearTimeout(t); s.close(); resolve("open"); });
        s.on("error", e => { clearTimeout(t); resolve("rejected: " + e.message); });
        s.on("unexpected-response", (req, res) => { clearTimeout(t); resolve("rejected: HTTP " + res.statusCode); });
    });
}

async function termText(cdp, n = 0) {
    return cdp.eval(`(() => { const b = window.term[${n}].term.buffer.active; let s = ""; for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + "\\n"; } return s; })()`);
}

let cdp;
try {
    const ui = await waitFor(async () => (await getTargets()).find(t => t.type === "page" && t.url.startsWith("file:") && t.url.endsWith("ui.html")), 60000);
    check("app window starts", ui, ui ? ui.url : "no ui.html target");
    if (!ui) throw new Error("no UI target");
    cdp = new CDP(ui.webSocketDebuggerUrl);
    await cdp.open();

    if (only.includes("m0")) {
        const ready = await waitFor(() => cdp.eval("!!(window.term && window.term[0] && window.mods && window.mods.cpuinfo)"), 40000);
        check("UI initialised (terminal + modules)", ready);

        const prompt = await waitFor(async () => /PS .*>/.test(await termText(cdp)), 30000);
        check("terminal shows a shell prompt", prompt);

        // The typed line contains 'EDEXAI_'+'SMOKE_OK', so only real output matches the joined word
        await cdp.eval(`window.term[0].writelr("echo ('EDEXAI_'+'SMOKE_OK')"); true`);
        const echoed = await waitFor(async () => (await termText(cdp)).includes("EDEXAI_SMOKE_OK"), 15000);
        check("terminal runs a command and shows its output", echoed);

        const telem = await waitFor(() => cdp.eval(`(() => {
            const cpu = document.querySelector("#mod_cpuinfo")?.innerText || "";
            const ram = document.querySelector("#mod_ramwatcher")?.innerText || "";
            const clock = document.querySelector("#mod_clock")?.innerText || "";
            const top = document.querySelector("#mod_toplist")?.innerText || "";
            return /\\d+%/.test(cpu) && /\\d/.test(ram) && /\\d/.test(clock) && top.trim().length > 20 ? {cpu: cpu.slice(0, 60)} : null;
        })()`), 30000);
        check("telemetry widgets show live values", telem, telem ? JSON.stringify(telem) : "");

        const noToken = await wsAttempt("ws://127.0.0.1:3100/", {Origin: "file://"});
        check("terminal socket rejects missing token", noToken.startsWith("rejected"), noToken);
        const token = await cdp.eval(`remote.terminalToken`);
        const evilOrigin = await wsAttempt(`ws://127.0.0.1:3100/?token=${token}`, {Origin: "https://evil.example"});
        check("terminal socket rejects web origins even with token", evilOrigin.startsWith("rejected"), evilOrigin);
        let lanAddr = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
        if (lanAddr) {
            const lan = await wsAttempt(`ws://${lanAddr.address}:3100/?token=${token}`, {Origin: "file://"});
            check("terminal socket not reachable on LAN address", lan !== "open", lan);
        }
        const remoteGone = await cdp.eval(`(() => { try { require("@electron/remote"); return false; } catch (e) { return true; } })()`);
        check("@electron/remote is not installed", remoteGone);

        check("screenshot (M0)", await screenshot(cdp, "m0.png"));
    }

    if (only.includes("m1") && fs.existsSync(path.join(root, "tests", "smoke", "m1.mjs"))) {
        const m1 = await import("./m1.mjs");
        await m1.run({cdp, check, sleep, waitFor, screenshot, getTargets, CDP, wsAttempt});
    }
    if (only.includes("m2") && fs.existsSync(path.join(root, "tests", "smoke", "m2.mjs"))) {
        const m2 = await import("./m2.mjs");
        await m2.run({cdp, check, sleep, waitFor, screenshot, getTargets, CDP, termText});
    }
} catch (e) {
    check("smoke run completed without exceptions", false, e.message);
} finally {
    if (!keep) {
        try { await cdp?.eval("remote.app.quit(); true"); } catch (e) { /* closing */ }
        await sleep(2500);
        if (app.exitCode === null) {
            try { process.platform === "win32" ? execSync(`taskkill /pid ${app.pid} /T /F`, {stdio: "ignore"}) : app.kill(); } catch (e) { /* gone */ }
        }
        cdp?.close();
    }
    fs.writeFileSync(path.join(outDir, "app.log"), appLog);
    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed. App log: tests/smoke/out/app.log`);
    if (keep) {
        console.log("--keep: app left running (CDP on 127.0.0.1:" + PORT + "); stop with Ctrl+C");
        process.on("SIGINT", () => { try { execSync(`taskkill /pid ${app.pid} /T /F`, {stdio: "ignore"}); } catch (e) { /* gone */ } process.exit(0); });
        app.on("exit", () => process.exit(0));
    } else {
        try { fs.rmSync(home, {recursive: true, force: true}); } catch (e) { /* locked files */ }
        process.exit(failed.length ? 1 : 0);
    }
}
