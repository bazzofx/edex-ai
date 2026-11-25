// Minimal server-sent-events reader for fetch() response bodies (OpenAI-style "data: {...}").
"use strict";

async function readSseStream(body, onEvent, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            if (signal && signal.aborted) throw new Error("aborted");
            const {done, value} = await reader.read();
            if (done) break;
            buf += decoder.decode(value, {stream: true});
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).replace(/\r$/, "");
                buf = buf.slice(nl + 1);
                if (!line.startsWith("data:")) continue; // comments (": OPENROUTER PROCESSING") and blanks
                const data = line.slice(5).trim();
                if (data === "[DONE]") return;
                let evt;
                try { evt = JSON.parse(data); } catch (e) { continue; }
                onEvent(evt);
            }
        }
    } finally {
        try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
}

// Newline-delimited JSON (Ollama)
async function readNdjsonStream(body, onEvent, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
        for (;;) {
            if (signal && signal.aborted) throw new Error("aborted");
            const {done, value} = await reader.read();
            if (done) break;
            buf += decoder.decode(value, {stream: true});
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                onEvent(JSON.parse(line));
            }
        }
        if (buf.trim()) onEvent(JSON.parse(buf.trim()));
    } finally {
        try { reader.releaseLock(); } catch (e) { /* ignore */ }
    }
}

module.exports = {readSseStream, readNdjsonStream};
