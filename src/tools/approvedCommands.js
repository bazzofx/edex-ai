// Allowlisted commands for terminal.runApproved. No shell: execFile with a fixed program,
// fixed argument template and per-parameter regex validation. Always confirmed by the user.
"use strict";

const {execFile} = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_FILE = path.join(__dirname, "..", "config", "approved-commands.json");

function loadApprovedCommands(userDataDir) {
    const userFile = userDataDir ? path.join(userDataDir, "approved-commands.json") : null;
    const file = userFile && fs.existsSync(userFile) ? userFile : DEFAULT_FILE;
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const c of list) validateDefinition(c);
    return list.filter(c => !c.platforms || c.platforms.includes(process.platform));
}

function validateDefinition(c) {
    if (!/^[a-z0-9-]{1,40}$/.test(c.id)) throw new Error(`approved command id "${c.id}" is invalid`);
    if (typeof c.program !== "string" || /[\s"'`|&;<>]/.test(c.program)) throw new Error(`approved command ${c.id}: program must be a bare executable name`);
    if (!Array.isArray(c.args)) throw new Error(`approved command ${c.id}: args must be an array`);
    for (const [name, p] of Object.entries(c.params || {})) {
        if (!p.pattern) throw new Error(`approved command ${c.id}: param ${name} needs a pattern`);
    }
}

function buildArgv(def, values) {
    const params = def.params || {};
    for (const k of Object.keys(values)) {
        if (!(k in params)) throw new Error(`Unknown argument "${k}" for ${def.id}`);
    }
    for (const [name, p] of Object.entries(params)) {
        const v = values[name] ?? p.default;
        if (v === undefined) throw new Error(`Missing argument "${name}" for ${def.id}`);
        if (!new RegExp(`^(?:${p.pattern})$`).test(String(v))) throw new Error(`Argument "${name}" for ${def.id} does not match ${p.pattern}`);
    }
    return def.args.map(a => a.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, name) => String(values[name] ?? params[name].default)));
}

class ApprovedCommandRunner {
    constructor(commands, {maxOutput = 4000, timeoutMs = 20000} = {}) {
        this.commands = new Map(commands.map(c => [c.id, c]));
        this.maxOutput = maxOutput;
        this.timeoutMs = timeoutMs;
    }

    describe(id, values) {
        const def = this.commands.get(id);
        if (!def) return `Unknown command ${id}`;
        try {
            return `Run: ${def.program} ${buildArgv(def, values).join(" ")}  (${def.description})`;
        } catch (e) {
            return `Run ${id}: ${e.message}`;
        }
    }

    runApproved(id, values) {
        const def = this.commands.get(id);
        if (!def) return Promise.resolve({success: false, error: `Command "${id}" is not on the approved list`});
        let argv;
        try { argv = buildArgv(def, values); } catch (e) { return Promise.resolve({success: false, error: e.message}); }
        return new Promise(resolve => {
            execFile(def.program, argv, {timeout: this.timeoutMs, windowsHide: true, shell: false, maxBuffer: 1024 * 1024}, (err, stdout, stderr) => {
                const out = (String(stdout) + (stderr ? "\n" + String(stderr) : "")).trim();
                const clipped = out.length > this.maxOutput ? out.slice(0, this.maxOutput) + "\n…(truncated)" : out;
                if (err && err.killed) return resolve({success: false, error: `${id} timed out after ${this.timeoutMs} ms`});
                if (err && typeof err.code !== "number") return resolve({success: false, error: `${id} could not start: ${err.message}`});
                resolve({success: !err, ...(err ? {error: `${id} exited with code ${err.code}: ${clipped.slice(0, 500)}`} : {data: {commandId: id, exitCode: 0, output: clipped}})});
            });
        });
    }
}

module.exports = {loadApprovedCommands, ApprovedCommandRunner, buildArgv, validateDefinition};
