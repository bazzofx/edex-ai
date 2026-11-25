// Local Ollama chat adapter (offline fallback). Loopback only.
"use strict";

const {readNdjsonStream} = require("./sse.js");

class OllamaProvider {
    constructor({host = "http://127.0.0.1:11434", model, timeoutMs = 90000}) {
        const u = new URL(host);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
            throw new Error(`Ollama host must be on loopback (got ${u.hostname})`);
        }
        this.name = "ollama";
        this.host = host.replace(/\/$/, "");
        this.model = model;
        this.timeoutMs = timeoutMs;
    }

    describe() {
        return `Ollama ${this.model} (local)`;
    }

    async chat({messages, tools, signal, onTextDelta}) {
        // Ollama wants tool-call arguments as objects and tool results without ids
        const msgs = messages.map(m => {
            if (m.role === "assistant" && m.tool_calls) {
                return {role: "assistant", content: m.content || "", tool_calls: m.tool_calls.map(tc => ({
                    function: {name: tc.function.name, arguments: safeJson(tc.function.arguments)}
                }))};
            }
            if (m.role === "tool") return {role: "tool", content: m.content};
            return {role: m.role, content: m.content};
        });
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
        const t0 = performance.now();
        let res;
        try {
            res = await fetch(`${this.host}/api/chat`, {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({model: this.model, messages: msgs, tools, stream: true, think: false, options: {temperature: 0.2}}),
                signal: sig
            });
        } catch (e) {
            if (signal && signal.aborted) throw Object.assign(new Error("Cancelled"), {cancelled: true});
            throw new Error(`Cannot reach Ollama at ${this.host} (${e.cause?.code || e.message}). Start Ollama or switch "provider" to "openrouter"`);
        }
        if (!res.ok) {
            const t = await res.text().catch(() => "");
            if (res.status === 404) throw new Error(`Ollama model "${this.model}" is not installed (run: ollama pull ${this.model})`);
            if (/does not support tools/i.test(t)) throw new Error(`Ollama model "${this.model}" does not support tool calling`);
            throw new Error(`Ollama error ${res.status}: ${t.slice(0, 200)}`);
        }
        let ttftMs = null;
        let content = "";
        const calls = [];
        try {
            await readNdjsonStream(res.body, evt => {
                if (evt.error) throw new Error(`Ollama: ${evt.error}`);
                const m = evt.message || {};
                if ((m.content || m.tool_calls) && ttftMs === null) ttftMs = performance.now() - t0;
                if (m.content) {
                    content += m.content;
                    if (onTextDelta) onTextDelta(m.content);
                }
                for (const tc of m.tool_calls || []) {
                    calls.push({id: `call_${calls.length}`, name: tc.function.name, arguments: JSON.stringify(tc.function.arguments || {})});
                }
            }, sig);
        } catch (e) {
            if (signal && signal.aborted) throw Object.assign(new Error("Cancelled"), {cancelled: true});
            if (timeout.aborted) throw new Error(`Ollama did not finish within ${Math.round(this.timeoutMs / 1000)} s`);
            throw e;
        }
        return {content: content.trim(), toolCalls: calls, model: this.model, timings: {ttftMs, totalMs: performance.now() - t0}};
    }
}

function safeJson(s) {
    if (typeof s !== "string") return s || {};
    try { return JSON.parse(s); } catch (e) { return {}; }
}

module.exports = {OllamaProvider};
