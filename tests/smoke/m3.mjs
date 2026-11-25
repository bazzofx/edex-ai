// M3 smoke checks: voice sidecar inside the app, push-to-talk, spoken replies, barge-in.
export async function run({cdp, check, sleep, waitFor, screenshot}) {
    const ready = await waitFor(() => cdp.eval(`window.assistantPanel.bridge.assistant.status().then(r => r.data.voice && (r.data.voice.state === "ready" || r.data.voice.state === "error") ? r.data.voice : null)`), 120000, 1000);
    check("voice engine loads", ready && ready.state === "ready", JSON.stringify(ready));
    if (!ready || ready.state !== "ready") return;

    const pttEnabled = await cdp.eval(`!document.getElementById("assistant_ptt").disabled`);
    check("HOLD TO TALK button is enabled", pttEnabled);

    // Real microphone: ~1.5 s of whatever is in the room, then release
    const start = await cdp.eval(`window.assistantPanel.bridge.assistant.pttStart()`);
    await sleep(400);
    const recOn = await cdp.eval(`document.getElementById("assistant_rec").dataset.on === "1" && window.assistantPanel.state === "listening"`);
    check("push-to-talk records with a visible REC indicator and LISTENING state", start.success && recOn, JSON.stringify(start));
    await sleep(1200);
    const stop = await cdp.eval(`window.assistantPanel.bridge.assistant.pttStop()`);
    const recOff = await cdp.eval(`document.getElementById("assistant_rec").dataset.on !== "1"`);
    check("release stops recording and returns a transcript", stop.success && recOff && typeof stop.data.text === "string", JSON.stringify(stop));
    if (stop.data && stop.data.text) {
        // Something was heard; let that turn finish so it doesn't interfere
        await waitFor(() => cdp.eval(`window.assistantPanel.state === "idle" || window.assistantPanel.state === "error" ? true : null`), 60000, 500);
    }

    // Full spoken turn without a mic: LLM -> tools -> Piper
    await cdp.eval(`window.browserPanel.setLayout("terminal").then(() => true)`);
    const turn = await cdp.eval(`require("electron").ipcRenderer.invoke("edexai:test:voice-turn", {text: "Switch to split view and open wikipedia.org"})`);
    check("voice turn runs tools and speaks the result", turn.ok && turn.tools.length > 0 && turn.tools.every(t => t.success) && turn.timings.ttsFirstAudioMs > 0,
        `${turn.reply} | tools ${JSON.stringify(turn.tools)} | timings ${JSON.stringify(turn.timings)}`);
    const layout = await cdp.eval("window.browserPanel.layout");
    check("spoken command really changed the layout", layout === "split", layout);

    // Barge-in: start a long spoken reply, then press push-to-talk
    const p = cdp.eval(`require("electron").ipcRenderer.invoke("edexai:test:voice-turn", {text: "In about four sentences, describe what a black hole is."})`);
    const speaking = await waitFor(() => cdp.eval(`window.assistantPanel.state === "speaking" ? true : null`), 60000, 200);
    if (speaking) {
        await sleep(1200);
        await cdp.eval(`window.assistantPanel.bridge.assistant.pttStart()`);
        const listening = await waitFor(() => cdp.eval(`window.assistantPanel.state === "listening" ? true : null`), 3000, 100);
        await cdp.eval(`require("electron").ipcRenderer.invoke("edexai:voice:ptt", {action: "cancel"})`);
        const r = await p;
        check("push-to-talk interrupts speech (barge-in)", listening && r.timings.speechInterrupted === true, JSON.stringify({listening, interrupted: r.timings.speechInterrupted}));
    } else {
        check("push-to-talk interrupts speech (barge-in)", false, "reply never reached the speaking state");
    }

    // Mute
    await cdp.eval(`window.assistantPanel.toggleMute(); true`);
    const muted = await cdp.eval(`window.assistantPanel.bridge.assistant.pttStart()`);
    await cdp.eval(`window.assistantPanel.toggleMute(); true`);
    check("muted microphone refuses push-to-talk", muted.success === false && /muted/i.test(muted.error), JSON.stringify(muted));

    check("screenshot (M3)", await screenshot(cdp, "m3-voice.png"));
}
