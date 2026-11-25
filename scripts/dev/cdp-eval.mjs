// Dev helper: evaluate a JS expression in a running eDEX AI started with
// `node tests/smoke/launch.mjs --keep` (CDP on 127.0.0.1:9333).
// Usage: node scripts/dev/cdp-eval.mjs "<expression>"
const expr = process.argv[2];
const targets = await (await fetch("http://127.0.0.1:9333/json")).json();
const ui = targets.find(t => t.type === "page" && t.url.endsWith("ui.html"));
const ws = new WebSocket(ui.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({id: 1, method: "Runtime.evaluate", params: {expression: expr, awaitPromise: true, returnByValue: true}}));
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id !== 1) return;
    const r = m.result;
    console.log(r.exceptionDetails ? "ERROR " + JSON.stringify(r.exceptionDetails.exception?.description) : JSON.stringify(r.result.value, null, 1));
    ws.close();
};
