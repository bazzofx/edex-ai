// Voice service: manages the Python sidecar (voice/sidecar.py) over stdin/stdout JSON lines.
// No network socket. Push-to-talk -> transcript -> orchestrator; replies -> Piper.
"use strict";

const {spawn} = require("child_process");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const {EventEmitter} = require("events");
const {z} = require("zod");

const SIDECAR = path.join(__dirname, "..", "..", "voice", "sidecar.py");

class VoiceService extends EventEmitter {
    constructor({config, userDataDir, log = () => {}}) {
        super();
        this.cfg = config;
        this.userDataDir = userDataDir;
        this.log = log;
        this.proc = null;
        this.state = "off";        // off | loading | ready | error
        this.detail = "";
        this.recording = false;
        this.muted = false;
        this.pendingSpeech = new Map(); // id -> {resolve, firstAudioMs}
        this.pendingTranscript = null;  // {resolve, timer}
        this.restarts = 0;
    }

    status() {
        return {state: this.state, ready: this.state === "ready", detail: this.detail, recording: this.recording, muted: this.muted};
    }

    start() {
        if (this.proc) return;
        if (!fs.existsSync(SIDECAR)) {
            this._setState("error", `Voice sidecar not found at ${SIDECAR}`);
            return;
        }
        const c = this.cfg;
        const args = ["-u", SIDECAR,
            "--whisper-model", c.whisperModel || "base",
            "--whisper-device", c.whisperDevice || "cpu",
            "--compute-type", c.whisperComputeType || "int8",
            "--language", c.language || "en",
            "--voice", c.piperVoice || "",
            "--voice-dir", path.join(this.userDataDir, "voices")];
        if (c.inputDevice != null) args.push("--input-device", String(c.inputDevice));
        if (c.outputDevice != null) args.push("--output-device", String(c.outputDevice));

        this._setState("loading", "starting the voice engine");
        const env = {...process.env, PYTHONIOENCODING: "utf-8", HF_HUB_OFFLINE: c.allowModelDownload ? "0" : "1"};
        let proc;
        try {
            proc = spawn(c.python || "python", args, {stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env});
        } catch (e) {
            this._setState("error", `Cannot start Python (${c.python || "python"}): ${e.message}`);
            return;
        }
        this.proc = proc;
        proc.on("error", e => this._setState("error", `Cannot start Python (${c.python || "python"}): ${e.message}. Set voice.python in edex-ai.json`));
        let buf = "";
        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", d => {
            buf += d;
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch (e) { this.log(`voice: bad line ${line.slice(0, 120)}`); continue; }
                this._onEvent(msg);
            }
        });
        let errTail = "";
        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", d => {
            errTail = (errTail + d).slice(-2000);
            d.split(/\r?\n/).filter(l => /\[voice\]|Error|Traceback/.test(l)).forEach(l => this.log(l.replace("[voice] ", "").trim()));
        });
        proc.on("exit", code => {
            this.proc = null;
            this.recording = false;
            for (const p of this.pendingSpeech.values()) p.resolve({error: "voice engine stopped"});
            this.pendingSpeech.clear();
            if (this.pendingTranscript) this.pendingTranscript.resolve({error: "voice engine stopped"});
            if (this._quitting) return;
            const reason = (errTail.match(/(\w+Error: .+)/g) || []).pop() || `exit code ${code}`;
            this._setState("error", `Voice engine stopped: ${reason}`);
        });
    }

    _setState(state, detail) {
        this.state = state;
        this.detail = detail || "";
        this.emit("status", this.status());
    }

    _send(obj) {
        if (!this.proc || !this.proc.stdin.writable) return false;
        this.proc.stdin.write(JSON.stringify(obj) + "\n");
        return true;
    }

    _onEvent(msg) {
        switch (msg.event) {
            case "status":
                this._setState(msg.state, msg.state === "ready"
                    ? `STT ${msg.stt || "off"}, voice ${msg.tts || "off"}${msg.detail && !/^loaded|^ready/.test(msg.detail) ? " — " + msg.detail : ""}`
                    : msg.detail);
                break;
            case "recording":
                this.recording = msg.on === true;
                this.emit("status", this.status());
                break;
            case "transcript":
                if (this.pendingTranscript) {
                    clearTimeout(this.pendingTranscript.timer);
                    this.pendingTranscript.resolve(msg);
                    this.pendingTranscript = null;
                }
                break;
            case "speak_start": {
                const p = this.pendingSpeech.get(msg.id);
                if (p) p.firstAudioMs = msg.firstAudioMs;
                break;
            }
            case "speak_done": {
                const p = this.pendingSpeech.get(msg.id);
                if (p) {
                    this.pendingSpeech.delete(msg.id);
                    p.resolve({firstAudioMs: p.firstAudioMs ?? null, interrupted: msg.interrupted, error: msg.error || null});
                }
                break;
            }
            case "error":
                this.emit("notice", msg.message);
                if (this.pendingTranscript && /muted|not available/.test(msg.message)) {
                    clearTimeout(this.pendingTranscript.timer);
                    this.pendingTranscript.resolve({error: msg.message});
                    this.pendingTranscript = null;
                }
                break;
        }
    }

    pttStart() {
        if (this.muted) return {success: false, error: "Microphone is muted"};
        if (this.state !== "ready") return {success: false, error: `Voice is not ready (${this.state}${this.detail ? ": " + this.detail : ""})`};
        this._send({cmd: "ptt_start"});
        return {success: true};
    }

    // Resolves with {text, sttMs, audioSec} or {error}
    pttStop() {
        if (this.state !== "ready") return Promise.resolve({error: "Voice is not ready"});
        return new Promise(resolve => {
            if (this.pendingTranscript) this.pendingTranscript.resolve({error: "superseded"});
            const timer = setTimeout(() => {
                this.pendingTranscript = null;
                resolve({error: "Transcription timed out"});
            }, 30000);
            this.pendingTranscript = {resolve, timer};
            if (!this._send({cmd: "ptt_stop"})) {
                clearTimeout(timer);
                this.pendingTranscript = null;
                resolve({error: "Voice engine is not running"});
            }
        });
    }

    setMuted(m) {
        this.muted = m === true;
        this._send({cmd: "mute", muted: this.muted});
        this.emit("status", this.status());
    }

    stopSpeaking() {
        this._send({cmd: "stop"});
    }

    // Speech adapter for the orchestrator
    speech() {
        return {
            speak: (text, signal) => {
                if (this.state !== "ready") return Promise.resolve({error: "voice output is not ready"});
                const id = crypto.randomUUID();
                return new Promise(resolve => {
                    this.pendingSpeech.set(id, {resolve});
                    if (signal) signal.addEventListener("abort", () => this.stopSpeaking(), {once: true});
                    if (!this._send({cmd: "speak", id, text})) {
                        this.pendingSpeech.delete(id);
                        resolve({error: "voice engine is not running"});
                    }
                });
            },
            stop: () => this.stopSpeaking()
        };
    }

    shutdown() {
        this._quitting = true;
        if (this.proc) {
            this._send({cmd: "quit"});
            const p = this.proc;
            setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, 2000);
        }
    }
}

const PttSchema = z.object({action: z.enum(["start", "stop", "cancel"])}).strict();
const MuteSchema = z.object({muted: z.boolean()}).strict();

// Connects the voice service to the orchestrator, the UI and IPC.
function registerVoice({voice, orchestrator, guard, sendEvent, log = () => {}}) {
    orchestrator.speech = voice.speech();

    voice.on("status", s => sendEvent({type: "voice-status", ...s}));
    voice.on("notice", text => sendEvent({type: "notice", level: "warning", text: `Voice: ${text}`}));

    guard.handle("edexai:voice:ptt", async (e, payload) => {
        const p = PttSchema.safeParse(payload);
        if (!p.success) return {success: false, error: "Invalid push-to-talk request"};
        if (p.data.action === "start") {
            // Barge-in: stop speech and any running turn's audio before listening
            voice.stopSpeaking();
            const r = voice.pttStart();
            if (r.success) orchestrator.setState("listening");
            return r;
        }
        if (p.data.action === "cancel") {
            voice._send({cmd: "ptt_cancel"});
            orchestrator.setState("idle");
            return {success: true};
        }
        orchestrator.setState("transcribing");
        const t = await voice.pttStop();
        if (t.error) {
            orchestrator.setState("error", t.error);
            return {success: false, error: t.error};
        }
        const text = (t.text || "").trim();
        log(`transcript (${t.sttMs} ms for ${t.audioSec} s): ${JSON.stringify(text)}`);
        sendEvent({type: "transcript", text, sttMs: t.sttMs, audioSec: t.audioSec});
        if (!text) {
            orchestrator.setState("idle", "nothing heard");
            sendEvent({type: "notice", level: "info", text: "Didn't catch that (no speech detected)."});
            return {success: true, data: {text: ""}};
        }
        if (orchestrator.answerPendingByVoice(text)) {
            return {success: true, data: {text, usedFor: "confirmation"}};
        }
        orchestrator.handle(text, {source: "voice", extraTimings: {sttMs: t.sttMs, audioSec: t.audioSec}})
            .catch(err => sendEvent({type: "error", text: err.message}));
        return {success: true, data: {text}};
    });

    guard.handle("edexai:voice:mute", async (e, payload) => {
        const p = MuteSchema.safeParse(payload);
        if (!p.success) return {success: false, error: "Invalid mute request"};
        voice.setMuted(p.data.muted);
        return {success: true};
    });

    guard.handle("edexai:voice:stop", async () => {
        voice.stopSpeaking();
        return {success: true};
    });

    // Test-only: run a "voice" turn from text (LLM -> tools -> Piper) without a microphone.
    // Registered only when the smoke runner sets EDEXAI_TEST=1.
    if (process.env.EDEXAI_TEST === "1") {
        guard.handle("edexai:test:voice-turn", async (e, payload) => {
            const text = String(payload && payload.text || "").slice(0, 500);
            const r = await orchestrator.handle(text, {source: "voice", extraTimings: {sttMs: null}});
            return {ok: r.ok, reply: r.reply, error: r.error, timings: r.timings, tools: r.toolResults.map(t => ({name: t.name, success: t.result.success}))};
        });
    }
}

module.exports = {VoiceService, registerVoice};
