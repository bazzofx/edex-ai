// Assistant service: builds provider + tools + orchestrator and exposes them over IPC.
"use strict";

const {z} = require("zod");
const {Orchestrator} = require("../ai/orchestrator.js");
const {OpenRouterProvider} = require("../ai/providers/openrouter.js");
const {OllamaProvider} = require("../ai/providers/ollama.js");
const {buildRegistry} = require("../tools/index.js");
const {createSystemAdapter} = require("../tools/system.js");
const {loadApprovedCommands, ApprovedCommandRunner} = require("../tools/approvedCommands.js");
const {readSecretEnv} = require("../config/config.js");

const SendSchema = z.object({text: z.string().min(1).max(2000)}).strict();
const ConfirmSchema = z.object({confirmId: z.string().uuid(), approved: z.boolean()}).strict();

function createProvider(config) {
    if (config.provider === "ollama") {
        return new OllamaProvider(config.ollama);
    }
    if (config.provider === "openrouter") {
        const o = config.openrouter;
        let cached = null;
        return new OpenRouterProvider({
            ...o,
            getApiKey: () => (cached = cached || readSecretEnv(o.apiKeyEnv))
        });
    }
    throw new Error(`Unknown provider "${config.provider}" in edex-ai.json (use "openrouter" or "ollama")`);
}

function createAssistant({config, userDataDir, browser, ui, getWindow, guard, log = () => {}}) {
    const approved = loadApprovedCommands(userDataDir);
    const runner = new ApprovedCommandRunner(approved);
    // Shares the widgets' single-process, cached systeminformation service
    const system = createSystemAdapter(require("../_multithread.js").siService.facade());
    setTimeout(() => system.warm(), 8000);
    const registry = buildRegistry({
        browser, ui,
        system,
        terminal: runner,
        approvedCommands: approved,
        searchProvider: config.searchProvider,
        toolTimeoutMs: config.assistant.toolTimeoutMs
    });

    let provider = null;
    const getProvider = () => (provider = provider || createProvider(config));

    const getContext = () => {
        const s = browser.state();
        const tabs = s.tabs.slice(0, 8).map(t => `[${t.id}${t.active ? "*" : ""}] ${JSON.stringify(t.title.slice(0, 60))}`).join(" ");
        return `layout=${ui.layout}; browser tabs (untrusted titles): ${tabs || "none"}`;
    };

    const orchestrator = new Orchestrator({
        getProvider, registry, getContext,
        config: config.assistant
    });

    const send = evt => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send("edexai:assistant:event", evt);
    };
    orchestrator.on("event", evt => {
        send(evt);
        if (evt.type === "turn-done") log(`turn ${evt.record.ok ? "ok" : "failed"}: ${JSON.stringify(evt.record.timings)}`);
        if (evt.type === "error") log(`assistant error: ${evt.text}`);
    });

    guard.handle("edexai:assistant:send", async (e, payload) => {
        const p = SendSchema.safeParse(payload);
        if (!p.success) return {success: false, error: "Invalid command"};
        // Don't await: progress arrives as events
        orchestrator.handle(p.data.text, {source: "typed", speak: config.assistant.speakTypedReplies === true})
            .catch(err => send({type: "error", text: err.message}));
        return {success: true};
    });
    guard.handle("edexai:assistant:cancel", async () => ({success: true, data: {cancelled: orchestrator.cancel("user")}}));
    guard.handle("edexai:assistant:confirm", async (e, payload) => {
        const p = ConfirmSchema.safeParse(payload);
        if (!p.success) return {success: false, error: "Invalid confirmation"};
        return {success: orchestrator.answerConfirm(p.data.confirmId, p.data.approved)};
    });
    guard.handle("edexai:assistant:status", async () => {
        let providerInfo;
        try {
            providerInfo = getProvider().describe();
        } catch (e) {
            providerInfo = `unavailable: ${e.message}`;
        }
        return {success: true, data: {state: orchestrator.state, provider: providerInfo, tools: registry.list().map(t => t.name)}};
    });

    return {orchestrator, registry, getProvider};
}

module.exports = {createAssistant, createProvider};
