// system.getStats adapter: compact metrics for the model to read out.
// systeminformation spawns PowerShell/WMI on Windows and competes with the eDEX widgets,
// so each call has its own time limit and slow, rarely-changing values are cached.
"use strict";

function withTimeout(promise, ms) {
    let t;
    return Promise.race([
        promise.catch(() => null),
        new Promise(res => { t = setTimeout(() => res(null), ms); })
    ]).finally(() => clearTimeout(t));
}

function createSystemAdapter(si, {callTimeoutMs = 4000, cacheMs = 60000} = {}) {
    const gb = b => Math.round((b / 1073741824) * 10) / 10;
    const cache = new Map(); // name -> {at, value}

    const cached = async (name, fn) => {
        const hit = cache.get(name);
        if (hit && Date.now() - hit.at < cacheMs) return hit.value;
        const value = await withTimeout(fn(), callTimeoutMs);
        if (value !== null) cache.set(name, {at: Date.now(), value});
        return value ?? (hit ? hit.value : null);
    };

    const adapter = {
        // Fill the cache in the background so the first question is fast
        warm() {
            ["graphics", "fsSize", "battery", "cpuTemperature"].forEach(n => cached(n, () => si[n]()));
        },
        async getStats() {
            const [load, mem, graphics, fs, battery, temp] = await Promise.all([
                withTimeout(si.currentLoad(), callTimeoutMs),
                withTimeout(si.mem(), callTimeoutMs),
                cached("graphics", () => si.graphics()),
                cached("fsSize", () => si.fsSize()),
                cached("battery", () => si.battery()),
                cached("cpuTemperature", () => si.cpuTemperature())
            ]);
            const time = (await Promise.resolve(si.time())) || {uptime: 0};
            if (!load && !mem) return {success: false, error: "System metrics are not available right now (the metrics backend did not answer in time)"};
            const gpu = graphics && graphics.controllers ? graphics.controllers.find(c => /nvidia|amd|radeon|intel/i.test(c.vendor || c.model || "")) : null;
            const sysDisk = Array.isArray(fs) ? (fs.find(d => /^C:/i.test(d.mount)) || fs[0]) : null;
            return {
                success: true,
                data: {
                    cpuLoadPercent: load ? Math.round(load.currentLoad) : null,
                    cpuTemperatureC: temp && temp.main ? Math.round(temp.main) : null,
                    memoryUsedGB: mem ? gb(mem.active) : null,
                    memoryTotalGB: mem ? gb(mem.total) : null,
                    memoryUsedPercent: mem ? Math.round((mem.active / mem.total) * 100) : null,
                    gpu: gpu ? {
                        model: gpu.model,
                        utilizationPercent: gpu.utilizationGpu ?? null,
                        vramUsedMB: gpu.memoryUsed ?? null,
                        vramTotalMB: gpu.memoryTotal ?? gpu.vram ?? null,
                        temperatureC: gpu.temperatureGpu ?? null
                    } : null,
                    uptimeHours: Math.round((time.uptime / 3600) * 10) / 10,
                    systemDisk: sysDisk ? {mount: sysDisk.mount, usedPercent: Math.round(sysDisk.use), freeGB: gb(sysDisk.available)} : null,
                    battery: battery && battery.hasBattery ? {percent: battery.percent, charging: battery.isCharging} : null,
                    note: "GPU, disk, battery and temperature values may be up to a minute old"
                }
            };
        }
    };
    return adapter;
}

module.exports = {createSystemAdapter, withTimeout};
