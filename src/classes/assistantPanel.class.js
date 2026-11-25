// eDEX AI: assistant panel (transcript, state, typed commands, push-to-talk, confirmations).
// Shares the on-screen keyboard's slot; a toggle switches between the two.
class AssistantPanel {
    constructor() {
        this.bridge = require("./bridge/edexai.js");
        this.state = "idle";
        this.micMuted = false;
        this.pttActive = false;
        this.voiceAvailable = false;
        this.visible = true;

        document.body.insertAdjacentHTML("beforeend", `
            <section id="assistant_panel" data-visible="1" augmented-ui="tr-clip bl-clip exe">
                <div id="assistant_header">
                    <h1>ASSISTANT<i id="assistant_provider"></i></h1>
                    <span id="assistant_state" data-state="idle">IDLE</span>
                    <span id="assistant_rec" title="Microphone is recording">&#x25CF; REC</span>
                </div>
                <div id="assistant_log"></div>
                <div id="assistant_confirm" data-visible="0">
                    <p id="assistant_confirm_text"></p>
                    <button class="assistant_btn" id="assistant_confirm_yes">APPROVE</button>
                    <button class="assistant_btn" id="assistant_confirm_no">DENY</button>
                </div>
                <div id="assistant_controls">
                    <input id="assistant_input" type="text" spellcheck="false" placeholder="TYPE A COMMAND, OR HOLD F8 TO TALK" />
                    <button class="assistant_btn" id="assistant_send">SEND</button>
                    <button class="assistant_btn" id="assistant_ptt" title="Hold to talk (or hold F8)">HOLD TO TALK</button>
                    <button class="assistant_btn" id="assistant_mute" title="Mute the microphone">MIC ON</button>
                    <button class="assistant_btn" id="assistant_cancel" title="Stop the current action and speech">CANCEL</button>
                    <button class="assistant_btn" id="assistant_kbd" title="Show the on-screen keyboard">KEYBOARD</button>
                </div>
            </section>
            <button id="assistant_show" class="assistant_btn" data-visible="0" title="Show the assistant">ASSISTANT</button>`);

        this.el = document.getElementById("assistant_panel");
        this.log = document.getElementById("assistant_log");
        this.input = document.getElementById("assistant_input");
        this.stateEl = document.getElementById("assistant_state");
        this.recEl = document.getElementById("assistant_rec");
        this.confirmEl = document.getElementById("assistant_confirm");
        this.showBtn = document.getElementById("assistant_show");
        this.pendingConfirmId = null;

        // Position over the keyboard section, and keep it there
        this.keyboardEl = document.getElementById("keyboard");
        const place = () => this.place();
        new ResizeObserver(place).observe(this.keyboardEl);
        window.addEventListener("resize", place);
        setTimeout(place, 50);

        document.getElementById("assistant_send").addEventListener("click", () => this.submit());
        document.getElementById("assistant_cancel").addEventListener("click", () => this.cancel());
        document.getElementById("assistant_kbd").addEventListener("click", () => this.setVisible(false));
        this.showBtn.addEventListener("click", () => this.setVisible(true));
        document.getElementById("assistant_mute").addEventListener("click", () => this.toggleMute());
        document.getElementById("assistant_confirm_yes").addEventListener("click", () => this.answerConfirm(true));
        document.getElementById("assistant_confirm_no").addEventListener("click", () => this.answerConfirm(false));

        const ptt = document.getElementById("assistant_ptt");
        ptt.addEventListener("mousedown", e => { e.preventDefault(); this.pttStart(); });
        ptt.addEventListener("mouseup", () => this.pttStop());
        ptt.addEventListener("mouseleave", () => { if (this.pttActive) this.pttStop(); });

        // Typing here must not go to the terminal
        this.input.addEventListener("focus", () => window.keyboard.detach());
        this.input.addEventListener("blur", () => window.keyboard.attach());
        this.input.addEventListener("keydown", e => {
            if (e.key === "Enter") { e.preventDefault(); this.submit(); }
            if (e.key === "Escape") this.input.blur();
        });

        // Push-to-talk key (held), Escape cancels
        this.pttKey = "F8";
        document.addEventListener("keydown", e => {
            if (e.key === this.pttKey && !e.repeat) { e.preventDefault(); this.pttStart(); }
        }, true);
        document.addEventListener("keyup", e => {
            if (e.key === this.pttKey) { e.preventDefault(); this.pttStop(); }
        }, true);

        this.bridge.assistant.onEvent(evt => this.onEvent(evt));
        this.bridge.assistant.status().then(r => {
            if (!r || !r.success) return;
            document.getElementById("assistant_provider").textContent = r.data.provider;
            this.voiceAvailable = !!r.data.voice;
            if (r.data.voice) this.onVoiceStatus(r.data.voice);
            if (r.data.pttKey) this.pttKey = r.data.pttKey;
        }).catch(() => {
            this.addLine("error", "SYSTEM", "Assistant service is not available (see the app log)");
        });
        this.addLine("info", "SYSTEM", "Assistant ready. Type a command or hold F8 / HOLD TO TALK.");
    }

    place() {
        const r = this.keyboardEl.getBoundingClientRect();
        if (r.width < 10) return;
        Object.assign(this.el.style, {left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px"});
        this.showBtn.style.left = (r.right - 140) + "px";
        this.showBtn.style.top = (r.top - 4) + "px";
    }

    setVisible(v) {
        this.visible = v;
        this.el.dataset.visible = v ? "1" : "0";
        this.showBtn.dataset.visible = v ? "0" : "1";
        this.keyboardEl.style.visibility = v ? "hidden" : "";
        if (v) this.place();
        window.audioManager.folder.play();
    }

    submit() {
        const text = this.input.value.trim();
        if (!text) return;
        this.input.value = "";
        this.bridge.assistant.send(text).then(r => {
            if (r && !r.success) this.addLine("error", "SYSTEM", r.error);
        });
    }

    cancel() {
        this.bridge.assistant.cancel();
        this.bridge.assistant.stopSpeaking().catch(() => {});
    }

    toggleMute() {
        this.micMuted = !this.micMuted;
        document.getElementById("assistant_mute").textContent = this.micMuted ? "MIC MUTED" : "MIC ON";
        document.getElementById("assistant_mute").dataset.on = this.micMuted ? "1" : "0";
        this.bridge.assistant.setMicMuted(this.micMuted).catch(() => {});
        if (this.micMuted && this.pttActive) this.pttStop();
    }

    pttStart() {
        if (this.pttActive) return;
        if (this.micMuted) { this.addLine("info", "SYSTEM", "Microphone is muted"); return; }
        this.pttActive = true;
        document.getElementById("assistant_ptt").dataset.on = "1";
        this.bridge.assistant.pttStart().then(r => {
            if (r && !r.success) {
                this.pttActive = false;
                document.getElementById("assistant_ptt").dataset.on = "0";
                this.addLine("error", "VOICE", r.error);
            }
        });
    }

    pttStop() {
        if (!this.pttActive) return;
        this.pttActive = false;
        document.getElementById("assistant_ptt").dataset.on = "0";
        this.bridge.assistant.pttStop().then(r => {
            if (r && !r.success) this.addLine("error", "VOICE", r.error);
        });
    }

    answerConfirm(approved) {
        if (!this.pendingConfirmId) return;
        this.bridge.assistant.confirm(this.pendingConfirmId, approved);
    }

    onVoiceStatus(v) {
        this.recEl.dataset.on = v.recording ? "1" : "0";
        document.getElementById("assistant_ptt").disabled = !v.ready;
        document.getElementById("assistant_ptt").title = v.ready ? "Hold to talk (or hold F8)" : `Voice not ready: ${v.detail || v.state}`;
    }

    onEvent(evt) {
        switch (evt.type) {
            case "state":
                this.state = evt.state;
                this.stateEl.dataset.state = evt.state;
                this.stateEl.textContent = evt.state.toUpperCase() + (evt.state === "executing" && evt.detail ? ": " + evt.detail.replace(/_/, ".").toUpperCase() : "");
                break;
            case "user":
                this.addLine("user", evt.source === "voice" ? "YOU (VOICE)" : "YOU", evt.text);
                break;
            case "tool-result": {
                const r = evt.result;
                const name = evt.name.replace(/_/, ".");
                this.addLine(r.success ? "tool" : "toolfail", r.success ? "OK" : "FAILED",
                    `${name}${r.success ? describeData(r.data) : " — " + r.error} (${evt.ms} ms)`);
                break;
            }
            case "reply":
                this.addLine("reply", "EDEX", evt.text);
                break;
            case "error":
                this.addLine("error", "ERROR", evt.text);
                break;
            case "notice":
                this.addLine(evt.level === "warning" ? "error" : "info", "SYSTEM", evt.text);
                break;
            case "cancelled":
                this.addLine("info", "SYSTEM", "Cancelled. Actions that already ran are not undone.");
                break;
            case "confirm":
                this.pendingConfirmId = evt.confirmId;
                document.getElementById("assistant_confirm_text").textContent = "CONFIRM: " + evt.summary;
                this.confirmEl.dataset.visible = "1";
                window.audioManager.alarm && window.audioManager.alarm.play();
                if (!this.visible) this.setVisible(true);
                break;
            case "confirm-closed":
                if (evt.confirmId === this.pendingConfirmId) {
                    this.pendingConfirmId = null;
                    this.confirmEl.dataset.visible = "0";
                    this.addLine("info", "SYSTEM", evt.approved ? "Approved." : "Not approved.");
                }
                break;
            case "transcript":
                // voice transcript arrives as a "user" event from the orchestrator; this one is informational
                break;
            case "voice-status":
                this.onVoiceStatus(evt);
                break;
            case "turn-done":
                this.lastTurn = evt.record;
                break;
        }
    }

    addLine(kind, who, text) {
        const line = document.createElement("p");
        line.className = "assistant_line assistant_" + kind;
        const w = document.createElement("b");
        w.textContent = who + ": ";
        const t = document.createElement("span");
        t.textContent = text;
        line.append(w, t);
        this.log.append(line);
        while (this.log.children.length > 200) this.log.firstChild.remove();
        this.log.scrollTop = this.log.scrollHeight;
    }
}

function describeData(d) {
    if (!d || typeof d !== "object") return "";
    if (d.title) return ` — ${String(d.title).slice(0, 60)}`;
    if (d.layout) return ` — ${d.layout}`;
    if (typeof d.cpuLoadPercent === "number") return ` — CPU ${d.cpuLoadPercent}%, RAM ${d.memoryUsedPercent}%`;
    if (d.output) return ` — ${String(d.output).split("\n")[0].slice(0, 60)}`;
    return "";
}

module.exports = {
    AssistantPanel
};
