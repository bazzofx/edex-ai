"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {Orchestrator, classifyYesNo} = require("../../src/ai/orchestrator.js");
const {buildRegistry} = require("../../src/tools/index.js");

// Scripted mock provider: each call returns the next scripted response
function scripted(steps) {
    let i = 0;
    const seen = [];
    return {
        seen,
        describe: () => "mock",
        chat: async ({messages, tools, signal}) => {
            seen.push({messages: JSON.parse(JSON.stringify(messages)), tools: !!tools});
            const step = steps[Math.min(i++, steps.length - 1)];
            if (step.wait) {
                await new Promise((res, rej) => {
                    const t = setTimeout(res, step.wait);
                    signal.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("Cancelled"), {cancelled: true})); });
                });
            }
            if (step.throw) throw new Error(step.throw);
            return {content: step.content || "", toolCalls: step.toolCalls || [], model: "mock", timings: {ttftMs: 1, totalMs: 2}};
        }
    };
}

function registry(log) {
    return buildRegistry({
        browser: {
            navigate: async url => { log.push(url); return {success: true, data: {url, title: "Results"}}; },
            history: () => ({success: false, error: "Nothing to go back to"}),
            state: () => ({tabs: []})
        },
        ui: {setLayout: async l => { log.push("layout:" + l); return {success: true, data: {layout: l}}; }, request: async () => ({success: true})},
        system: {getStats: async () => ({success: true, data: {cpuLoadPercent: 12}})},
        terminal: null
    });
}

const call = (name, args, id = name) => ({id, name, arguments: JSON.stringify(args)});

test("runs the YouTube + split view example with real tool results", async () => {
    const log = [];
    const provider = scripted([
        {toolCalls: [call("browser_search", {query: "black hole documentaries", provider: "youtube"}), call("ui_setLayout", {layout: "split"})]},
        {content: "Searching YouTube for black hole documentaries, now in split view."}
    ]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry(log)});
    const states = [];
    o.on("event", e => { if (e.type === "state") states.push(e.state); });
    const r = await o.handle("Open YouTube and search for black hole documentaries, then switch to split view.");
    assert.equal(r.ok, true);
    assert.deepEqual(log, ["https://www.youtube.com/results?search_query=black%20hole%20documentaries", "layout:split"]);
    assert.equal(r.toolResults.length, 2);
    assert.ok(r.toolResults.every(t => t.result.success));
    // The model saw the tool results before answering
    const toolMsgs = provider.seen[1].messages.filter(m => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    assert.match(toolMsgs[0].content, /"success":true/);
    assert.deepEqual(states, ["thinking", "executing", "executing", "thinking", "idle"]);
});

test("tool loop is bounded", async () => {
    const provider = scripted([{toolCalls: [call("browser_back", {})]}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([]), config: {maxToolRounds: 3}});
    const r = await o.handle("go back forever");
    assert.equal(provider.seen.length, 4); // 3 rounds with tools + 1 final without tools
    assert.equal(provider.seen[3].tools, false);
    assert.equal(r.toolResults.length, 3);
});

test("empty final reply falls back to a truthful summary of failures", async () => {
    const provider = scripted([{toolCalls: [call("browser_back", {})]}, {content: ""}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([])});
    const r = await o.handle("go back");
    assert.match(r.reply, /did not fully work: Nothing to go back to/);
});

test("unavailable provider gives an actionable error, not success", async () => {
    const o = new Orchestrator({getProvider: () => { throw new Error("No OpenRouter API key: set apiOpenRouterEDEXAI"); }, registry: registry([])});
    const errors = [];
    o.on("event", e => { if (e.type === "error") errors.push(e.text); });
    const r = await o.handle("hello");
    assert.equal(r.ok, false);
    assert.match(errors[0], /apiOpenRouterEDEXAI/);
    assert.equal(o.state, "error");

    const o2 = new Orchestrator({getProvider: () => scripted([{throw: "OpenRouter free-tier rate limit reached (429)"}]), registry: registry([])});
    const r2 = await o2.handle("hello");
    assert.equal(r2.ok, false);
    assert.match(r2.error, /429/);
});

test("cancel aborts inference and returns to idle", async () => {
    const provider = scripted([{wait: 2000, content: "late"}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([])});
    const p = o.handle("slow");
    setTimeout(() => o.cancel(), 30);
    const r = await p;
    assert.equal(r.error, "Cancelled");
    assert.equal(o.state, "idle");
});

test("a new command supersedes the running one", async () => {
    const provider = scripted([{wait: 2000, content: "first"}, {content: "second"}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([])});
    const p1 = o.handle("one");
    await new Promise(r => setTimeout(r, 20));
    const r2 = await o.handle("two");
    const r1 = await p1;
    assert.equal(r1.error, "Cancelled");
    assert.equal(r2.reply, "second");
});

test("speaks only voice turns, after the result", async () => {
    const spoken = [];
    const speech = {speak: async t => { spoken.push(t); return {firstAudioMs: 5}; }, stop: () => {}};
    const provider = scripted([{content: "Hello."}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([]), speech});
    await o.handle("hi", {source: "typed"});
    assert.equal(spoken.length, 0);
    const r = await o.handle("hi", {source: "voice"});
    assert.deepEqual(spoken, ["Hello."]);
    assert.equal(r.timings.ttsFirstAudioMs, 5);
});

test("history is bounded", async () => {
    const provider = scripted([{content: "ok"}]);
    const o = new Orchestrator({getProvider: () => provider, registry: registry([]), config: {historyTurns: 2}});
    for (let i = 0; i < 5; i++) await o.handle("msg " + i);
    assert.equal(o.history.length, 4);
    assert.equal(provider.seen[4].messages.length, 1 + 4 + 1);
});

test("spoken yes/no classification", () => {
    assert.equal(classifyYesNo("yes"), true);
    assert.equal(classifyYesNo("Yes, please go ahead"), true);
    assert.equal(classifyYesNo("no, cancel that"), false);
    assert.equal(classifyYesNo("yes no"), null);
    assert.equal(classifyYesNo("open youtube"), null);
});
