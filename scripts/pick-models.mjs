// List OpenRouter's free models that support tool calling (public endpoint, no API key needed).
// Usage: node scripts/pick-models.mjs   then benchmark candidates with scripts/bench.mjs
const res = await fetch("https://openrouter.ai/api/v1/models");
if (!res.ok) {
    console.error(`OpenRouter model list failed: HTTP ${res.status}`);
    process.exit(1);
}
const {data} = await res.json();
const free = data
    .filter(m => m.id.endsWith(":free") && (m.supported_parameters || []).includes("tools"))
    .sort((a, b) => a.id.localeCompare(b.id));
console.log(`${free.length} free models with tool calling:\n`);
for (const m of free) console.log(`${m.id.padEnd(60)} context ${m.context_length}`);
console.log(`\nBenchmark some with:\n  node scripts/bench.mjs --provider=openrouter --models=${free.slice(0, 3).map(m => m.id).join(",")}`);
console.log(`Then set "openrouter.model" in <userData>/edex-ai.json (see README).`);
