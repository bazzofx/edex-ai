// OpenRouter chat adapter (OpenAI-compatible, streaming, tool calls).
"use strict";

const {readSseStream} = require("./sse.js");

class OpenRouterProvider {
    constructor({baseUrl, model, fallbackModels = [], timeoutMs = 45000, getApiKey, apiKeyEnv}) {
        this.name = "openrouter";
        this.baseUrl = baseUrl.replace(/\/$/, "");
        this.model = model;
        this.fallbackModels = fallbackModels;
        this.timeoutMs = timeoutMs;
        this.getApiKey = getApiKey;
        this.apiKeyEnv = apiKeyEnv;
    }

    describe() {
        return `OpenRouter ${this.model}`;
    }

    async chat({messages, tools, signal, onTextDelta}) {
        const key = this.getApiKey();
        if (!key) {
            throw new Error(`No OpenRouter API key: set the environment variable ${this.apiKeyEnv} and restart eDEX AI`);
        }
        const body = {
            model: this.model,
            messages,
            stream: true,
            temperature: 0.2,
            max_tokens: 500
        };
        if (this.fallbackModels.length) body.models = [this.model, ...this.fallbackModels];
        if (tools && tools.length) {
            body.tools = tools;
            body.tool_choice = "auto";
        }

        const timeout = AbortSignal.timeout(this.timeoutMs);
        const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const t0 = performance.now();
        let res;
        try {
            res = await fetch(`${this.baseUrl}/chat/completions`, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${key}`,
                    "Content-Type": "application/json",
                    "X-Title": "eDEX AI"
                },
                body: JSON.stringify(body),
                signal: sig
            });
        } catch (e) {
            if (signal && signal.aborted) throw Object.assign(new Error("Cancelled"), {cancelled: true});
            if (timeout.aborted) throw new Error(`OpenRouter did not answer within ${Math.round(this.timeoutMs / 1000)} s`);
            throw new Error(`Cannot reach openrouter.ai (${e.cause?.code || e.message}). Check the internet connection, or switch "provider" to "ollama" in edex-ai.json`);
        }
        if (!res.ok) {
            let detail = "";
            try { const j = await res.json(); detail = j.error?.message || JSON.stringify(j).slice(0, 200); } catch (e) { /* not json */ }
            throw new Error(describeHttpError(res.status, detail, this.apiKeyEnv, this.model));
        }

        let ttftMs = null;
        let content = "";
        let usedModel = this.model;
        const calls = [];
        try {
            await readSseStream(res.body, evt => {
                if (evt.error) throw new Error(`OpenRouter stream error: ${evt.error.message || JSON.stringify(evt.error)}`);
                if (evt.model) usedModel = evt.model;
                const choice = evt.choices && evt.choices[0];
                if (!choice) return;
                const d = choice.delta || {};
                if ((d.content || d.tool_calls) && ttftMs === null) ttftMs = performance.now() - t0;
                if (d.content) {
                    content += d.content;
                    if (onTextDelta) onTextDelta(d.content);
                }
                for (const tc of d.tool_calls || []) {
                    const i = tc.index ?? calls.length;
                    calls[i] = calls[i] || {id: "", name: "", arguments: ""};
                    if (tc.id) calls[i].id = tc.id;
                    if (tc.function?.name) calls[i].name += tc.function.name;
                    if (tc.function?.arguments) calls[i].arguments += tc.function.arguments;
                }
            }, sig);
        } catch (e) {
            if (signal && signal.aborted) throw Object.assign(new Error("Cancelled"), {cancelled: true});
            if (timeout.aborted) throw new Error(`OpenRouter stream timed out after ${Math.round(this.timeoutMs / 1000)} s`);
            throw e;
        }

        return {
            content: content.trim(),
            toolCalls: calls.filter(Boolean).map((c, i) => ({id: c.id || `call_${i}`, name: c.name, arguments: c.arguments})),
            model: usedModel,
            timings: {ttftMs, totalMs: performance.now() - t0}
        };
    }
}

function describeHttpError(status, detail, apiKeyEnv, model) {
    switch (status) {
        case 400: return `OpenRouter rejected the request (400): ${detail}`;
        case 401: return `OpenRouter rejected the API key (401). Check the ${apiKeyEnv} environment variable`;
        case 402: return `OpenRouter says the account has no credit for this model (402): ${detail}`;
        case 404: return `Model "${model}" is unavailable or has no provider that supports tools (404). Run "npm run pick-models"`;
        case 429: return `OpenRouter free-tier rate limit reached for ${model} (429${detail ? ": " + detail.slice(0, 160) : ""}). Wait a minute, pick another free model, or use the local Ollama provider`;
        default: return `OpenRouter error ${status}: ${detail}`;
    }
}

module.exports = {OpenRouterProvider, describeHttpError};
