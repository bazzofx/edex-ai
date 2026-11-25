// Tool registry: typed, allowlisted tools the model may call.
// The model proposes; this code validates, applies policy, runs with a timeout and
// always returns {success, data} or {success:false, error}.
"use strict";

const {z} = require("zod");

const toApiName = name => name.replace(/\./g, "_");

class ToolRegistry {
    constructor({defaultTimeoutMs = 12000} = {}) {
        this.tools = new Map();       // name -> def
        this.byApiName = new Map();   // api name -> def
        this.defaultTimeoutMs = defaultTimeoutMs;
    }

    register(def) {
        if (!/^[a-z]+\.[a-zA-Z]+$/.test(def.name)) throw new Error(`Bad tool name ${def.name}`);
        if (!(def.schema instanceof z.ZodType)) throw new Error(`Tool ${def.name} needs a zod schema`);
        if (!["safe", "confirm"].includes(def.policy)) throw new Error(`Tool ${def.name} needs policy safe|confirm`);
        this.tools.set(def.name, def);
        this.byApiName.set(toApiName(def.name), def);
        return this;
    }

    list() {
        return [...this.tools.values()];
    }

    // OpenAI-style tool definitions
    toApiTools() {
        return this.list().map(def => {
            const params = z.toJSONSchema(def.schema, {target: "draft-7"});
            delete params.$schema;
            return {
                type: "function",
                function: {name: toApiName(def.name), description: def.description, parameters: params}
            };
        });
    }

    // ctx: {signal, confirm(request) -> Promise<boolean>, onEvent}
    async execute(apiName, rawArgs, ctx = {}) {
        const def = this.byApiName.get(apiName) || this.tools.get(apiName);
        if (!def) {
            return {success: false, error: `Unknown tool "${apiName}". Available: ${[...this.byApiName.keys()].join(", ")}`};
        }
        let args = rawArgs;
        if (typeof rawArgs === "string") {
            const s = rawArgs.trim();
            try {
                args = s ? JSON.parse(s) : {};
            } catch (e) {
                return {success: false, error: `Arguments for ${def.name} are not valid JSON`};
            }
        }
        if (args === null || typeof args !== "object" || Array.isArray(args)) args = {};

        const parsed = def.schema.safeParse(args);
        if (!parsed.success) {
            const issues = parsed.error.issues.map(i => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ");
            return {success: false, error: `Invalid arguments for ${def.name}: ${issues}`};
        }

        if (def.policy === "confirm") {
            const summary = def.summarize ? def.summarize(parsed.data) : `${def.name} ${JSON.stringify(parsed.data)}`;
            if (typeof ctx.confirm !== "function") {
                return {success: false, error: `${def.name} needs user confirmation, which is not available here`};
            }
            const approved = await ctx.confirm({tool: def.name, args: parsed.data, summary});
            if (!approved) return {success: false, error: "The user declined (or did not confirm) this action"};
        }

        if (ctx.signal && ctx.signal.aborted) return {success: false, error: "Cancelled"};
        const timeoutMs = def.timeoutMs || this.defaultTimeoutMs;
        let timer;
        try {
            const out = await Promise.race([
                Promise.resolve().then(() => def.run(parsed.data, ctx)),
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${def.name} timed out after ${timeoutMs} ms`)), timeoutMs); }),
                new Promise((_, rej) => {
                    if (ctx.signal) ctx.signal.addEventListener("abort", () => rej(new Error("Cancelled")), {once: true});
                })
            ]);
            return normalizeResult(out);
        } catch (e) {
            return {success: false, error: e.message || String(e)};
        } finally {
            clearTimeout(timer);
        }
    }
}

function normalizeResult(out) {
    if (out && typeof out === "object" && typeof out.success === "boolean") {
        return out.success ? {success: true, data: out.data ?? null} : {success: false, error: String(out.error || "Failed")};
    }
    return {success: true, data: out ?? null};
}

module.exports = {ToolRegistry, toApiName, normalizeResult};
