"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {buildRegistry} = require("../../src/tools/index.js");
const {ApprovedCommandRunner, buildArgv, loadApprovedCommands} = require("../../src/tools/approvedCommands.js");

function mocks() {
    const calls = [];
    const browser = {
        navigate: async (url, o) => { calls.push(["navigate", url, o]); return {success: true, data: {url, title: "T"}}; },
        createTab: url => { calls.push(["createTab", url]); return {success: true, data: {tabId: 2}}; },
        closeTab: id => ({success: true, data: {closed: id}}),
        history: d => ({success: false, error: `Nothing to go ${d}`}),
        reload: () => ({success: true, data: {}}),
        media: a => ({success: true, data: {action: a}}),
        state: () => ({activeTabId: 1, tabs: [{id: 1, title: "x", url: "https://x.org/"}]})
    };
    const ui = {setLayout: async l => { calls.push(["layout", l]); return {success: true, data: {layout: l}}; }, request: async op => ({success: true, data: op})};
    const system = {getStats: async () => ({success: true, data: {cpuLoadPercent: 5}})};
    const runner = new ApprovedCommandRunner([{id: "echo-test", description: "echo", program: "node", args: ["-e", "console.log('hi {who}')"], params: {who: {pattern: "[a-z]{1,10}"}}}]);
    const reg = buildRegistry({browser, ui, system, terminal: runner, approvedCommands: [...runner.commands.values()], searchProvider: "duckduckgo"});
    return {reg, calls};
}

test("tool definitions are valid OpenAI function specs", () => {
    const {reg} = mocks();
    const tools = reg.toApiTools();
    assert.ok(tools.length >= 14);
    for (const t of tools) {
        assert.match(t.function.name, /^[a-zA-Z0-9_]+$/);
        assert.equal(t.function.parameters.type, "object");
    }
    assert.ok(tools.some(t => t.function.name === "browser_search"));
});

test("browser_search builds the provider URL in code", async () => {
    const {reg, calls} = mocks();
    const r = await reg.execute("browser_search", JSON.stringify({query: "black hole documentaries", provider: "youtube"}));
    assert.equal(r.success, true);
    assert.equal(calls[0][1], "https://www.youtube.com/results?search_query=black%20hole%20documentaries");
});

test("invalid arguments give actionable errors, not success", async () => {
    const {reg} = mocks();
    let r = await reg.execute("ui_setLayout", {layout: "fullscreen"});
    assert.equal(r.success, false);
    assert.match(r.error, /Invalid arguments for ui.setLayout: layout/);
    r = await reg.execute("browser_open", "{not json");
    assert.match(r.error, /not valid JSON/);
    r = await reg.execute("browser_open", {url: "file:///C:/x"});
    assert.equal(r.success, false);
    assert.match(r.error, /scheme/);
    r = await reg.execute("browser_open", {url: "black holes"});
    assert.match(r.error, /browser_search/);
    r = await reg.execute("shell_exec", {cmd: "rm -rf /"});
    assert.match(r.error, /Unknown tool/);
});

test("failed adapter results stay failures", async () => {
    const {reg} = mocks();
    const r = await reg.execute("browser_back", {});
    assert.deepEqual(r, {success: false, error: "Nothing to go back"});
});

test("confirm tools need an explicit yes", async () => {
    const {reg} = mocks();
    let r = await reg.execute("terminal_runApproved", {commandId: "echo-test", arguments: {who: "bob"}});
    assert.match(r.error, /confirmation/);
    r = await reg.execute("terminal_runApproved", {commandId: "echo-test", arguments: {who: "bob"}}, {confirm: async () => false});
    assert.match(r.error, /declined/);
    let seen;
    r = await reg.execute("terminal_runApproved", {commandId: "echo-test", arguments: {who: "bob"}}, {confirm: async req => { seen = req.summary; return true; }});
    assert.equal(r.success, true, JSON.stringify(r));
    assert.match(r.data.output, /hi bob/);
    assert.match(seen, /node -e/);
});

test("approved commands reject unknown ids and bad arguments", async () => {
    const {reg} = mocks();
    let r = await reg.execute("terminal_runApproved", {commandId: "format-c"}, {confirm: async () => true});
    assert.equal(r.success, false);
    r = await reg.execute("terminal_runApproved", {commandId: "echo-test", arguments: {who: "bob; del *"}}, {confirm: async () => true});
    assert.match(r.error, /does not match/);
    assert.throws(() => buildArgv({id: "p", args: ["{host}"], params: {host: {pattern: "[a-z]+"}}}, {host: "-n"}), /does not match/);
});

test("bundled approved command list loads and is valid", () => {
    const list = loadApprovedCommands(null);
    assert.ok(list.length >= 2);
});

test("tool timeouts and cancellation", async () => {
    const {ToolRegistry} = require("../../src/tools/registry.js");
    const {z} = require("../../src/node_modules/zod");
    const reg = new ToolRegistry({defaultTimeoutMs: 50});
    reg.register({name: "x.slow", description: "", schema: z.object({}), policy: "safe", run: () => new Promise(r => setTimeout(r, 1000))});
    let r = await reg.execute("x_slow", {});
    assert.match(r.error, /timed out/);
    const ac = new AbortController();
    reg.register({name: "x.slowTwo", description: "", schema: z.object({}), policy: "safe", timeoutMs: 5000, run: () => new Promise(r => setTimeout(r, 1000))});
    setTimeout(() => ac.abort(), 20);
    r = await reg.execute("x_slowTwo", {}, {signal: ac.signal});
    assert.equal(r.error, "Cancelled");
});
