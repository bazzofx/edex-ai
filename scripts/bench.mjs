// Benchmark LLM tool calling for eDEX AI with mock adapters (no app needed).
// Usage: node scripts/bench.mjs [--provider=openrouter|ollama] [--models=a,b,c] [--cases=1,2]
// Prints per-case results and a summary (accuracy, TTFT, total latency). Writes docs/bench-<date>.json.
import {createRequire} from "node:module";
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "src", "package.json"));
const {Orchestrator} = require("./ai/orchestrator.js");
const {buildRegistry} = require("./tools/index.js");
const {createProvider} = require("./main/assistant.js");
const {deepMerge} = require("./config/config.js");

const arg = (n, d) => (process.argv.find(a => a.startsWith(`--${n}=`)) || `=${d ?? ""}`).split("=").slice(1).join("=");
const defaults = JSON.parse(fs.readFileSync(path.join(root, "src", "config", "edex-ai.example.json"), "utf8"));
const providerName = arg("provider", "openrouter");
const models = (arg("models", providerName === "openrouter" ? defaults.openrouter.model : defaults.ollama.model)).split(",").filter(Boolean);
const onlyCases = arg("cases", "").split(",").filter(Boolean).map(Number);

// expect: list of [toolName, argsCheck(args) -> bool] that must appear in order (subsequence)
const CASES = [
    {text: "Open YouTube and search for black hole documentaries, then switch to split view.",
        expect: [["browser_search", a => a.provider === "youtube" && /black hole/i.test(a.query)], ["ui_setLayout", a => a.layout === "split"]]},
    {text: "Go to wikipedia.org", expect: [["browser_open", a => /wikipedia\.org/i.test(a.url)]]},
    {text: "Search the web for the weather in London", expect: [["browser_search", a => /weather/i.test(a.query) && /london/i.test(a.query)]]},
    {text: "Switch to terminal only", expect: [["ui_setLayout", a => a.layout === "terminal"]]},
    {text: "How busy is my CPU right now?", expect: [["system_getStats", () => true]], replyMatches: /12|twelve/i},
    {text: "Go back", expect: [["browser_back", () => true]], replyMatches: /(can't|cannot|couldn't|could not|no|nothing|unable|not)/i},
    {text: "Pause the video", expect: [["browser_media", a => a.action === "pause" || a.action === "toggle"]]},
    {text: "Open a new tab with github.com", expect: [["browser_newTab", a => /github\.com/i.test(a.url || "")]], alt: [["browser_open", a => /github\.com/i.test(a.url) && a.newTab === true]]},
    {text: "Close this tab", expect: [["browser_closeTab", () => true]]},
    {text: "Show me the browser full screen", expect: [["ui_setLayout", a => a.layout === "browser"]]},
    {text: "Open a new terminal tab", expect: [["terminal_createTab", () => true]]},
    {text: "Tell me a one-sentence joke", expect: [], replyMatches: /\w+/}
];

function mockAdapters(calls) {
    const ok = data => ({success: true, data});
    return {
        browser: {
            navigate: async (url, o) => { calls.push(["navigate", url]); return ok({tabId: 1, url, title: "Result page", status: "loaded"}); },
            createTab: async url => ok({tabId: 2, url}),
            closeTab: () => ok({closed: 1, activeTabId: null}),
            history: d => ({success: false, error: `Nothing to go ${d} to in this tab`}),
            reload: () => ok({}),
            media: a => ok({paused: a === "pause"}),
            state: () => ({activeTabId: 1, tabs: [{id: 1, title: "YouTube", url: "https://www.youtube.com/watch?v=x", active: true}]})
        },
        ui: {layout: "terminal", setLayout: async l => ok({layout: l, browserVisible: l !== "terminal"}), request: async op => ok(op === "createTerminal" ? {index: 1, created: true} : [{index: 0, label: "MAIN"}])},
        system: {getStats: async () => ok({cpuLoadPercent: 12, memoryUsedGB: 30.6, memoryTotalGB: 63.9, memoryUsedPercent: 48, gpu: {model: "GTX 1070", vramUsedMB: 1253, vramTotalMB: 8192}, uptimeHours: 13})}
    };
}

function scoreCase(c, toolResults) {
    const got = toolResults.map(t => ({name: t.name, args: safe(t.args)}));
    const matchSeq = exp => {
        let i = 0;
        for (const g of got) if (i < exp.length && g.name === exp[i][0] && exp[i][1](g.args)) i++;
        return i === exp.length;
    };
    const toolsOk = c.expect.length === 0 ? got.length === 0 : (matchSeq(c.expect) || (c.alt && matchSeq(c.alt)));
    return {toolsOk, got: got.map(g => `${g.name}(${JSON.stringify(g.args)})`)};
}
function safe(s) { try { return typeof s === "string" ? JSON.parse(s || "{}") : s || {}; } catch (e) { return {}; } }

const summary = [];
for (const model of models) {
    const cfg = deepMerge(defaults, {provider: providerName, [providerName]: {model, fallbackModels: []}});
    let provider;
    try { provider = createProvider(cfg); } catch (e) { console.log(`${model}: ${e.message}`); continue; }
    console.log(`\n=== ${provider.describe()} ===`);
    const rows = [];
    for (const [i, c] of CASES.entries()) {
        if (onlyCases.length && !onlyCases.includes(i + 1)) continue;
        const calls = [];
        const a = mockAdapters(calls);
        const registry = buildRegistry({...a, terminal: null, searchProvider: "duckduckgo"});
        const o = new Orchestrator({getProvider: () => provider, registry, getContext: () => "layout=terminal; browser tabs (untrusted titles): [1*] \"YouTube\"", config: cfg.assistant});
        const r = await o.handle(c.text);
        const s = scoreCase(c, r.toolResults);
        const replyOk = !c.replyMatches || c.replyMatches.test(r.reply || "");
        const pass = r.ok && s.toolsOk && replyOk;
        const ttft = r.timings.llm[0]?.ttftMs;
        rows.push({case: i + 1, pass, ok: r.ok, ttftMs: ttft, totalMs: r.timings.totalMs, rounds: r.timings.llm.length, error: r.error, got: s.got, reply: r.reply});
        console.log(`${pass ? "PASS" : "FAIL"} #${i + 1} ${c.text}\n     tools: ${s.got.join(", ") || "none"}\n     reply: ${(r.reply || r.error || "").slice(0, 140)}\n     ttft ${ttft ?? "-"} ms, total ${r.timings.totalMs ?? "-"} ms, rounds ${r.timings.llm.length}`);
        if (/429/.test(r.error || "")) { console.log("Rate limited; pausing 20 s"); await new Promise(res => setTimeout(res, 20000)); }
    }
    const done = rows.filter(r => r.ok);
    const med = arr => { const s = arr.filter(v => v != null).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
    const sm = {model: provider.describe(), passed: rows.filter(r => r.pass).length, total: rows.length, errors: rows.filter(r => !r.ok).length,
        medianTtftMs: med(done.map(r => r.ttftMs)), medianTotalMs: med(done.map(r => r.totalMs))};
    summary.push({...sm, rows});
    console.log(`--> ${sm.passed}/${sm.total} passed, ${sm.errors} errors, median TTFT ${sm.medianTtftMs} ms, median total ${sm.medianTotalMs} ms`);
}
const out = path.join(root, "docs", `bench-${new Date().toISOString().slice(0, 10)}-${providerName}.json`);
fs.mkdirSync(path.dirname(out), {recursive: true});
fs.writeFileSync(out, JSON.stringify(summary, null, 2));
console.log(`\nSummary written to ${path.relative(root, out)}`);
for (const s of summary) console.log(`${s.model.padEnd(60)} ${s.passed}/${s.total}  errors ${s.errors}  TTFT ${s.medianTtftMs} ms  total ${s.medianTotalMs} ms`);
