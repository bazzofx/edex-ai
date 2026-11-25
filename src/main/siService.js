// Shared systeminformation access for the eDEX widgets and the assistant.
//
// eDEX AI change: upstream forked one worker per CPU core and every worker started its own
// PowerShell/WMI sessions. With systeminformation 5.33 on Windows that pinned all cores at
// 100% (about 30 powershell.exe plus WUDFHost/WMI load). Now: one process, one persistent
// PowerShell session, de-duplicated in-flight calls and a minimum refresh interval per call.
"use strict";

const si = require("systeminformation");

// Minimum ms between real calls (results are shared within this window). 0 = no caching.
const MIN_INTERVAL = {
    currentLoad: 450,
    mem: 900,
    processes: 1900,
    networkStats: 900,
    networkInterfaces: 4000,
    networkConnections: 4000,
    cpu: 30000,
    cpuCurrentSpeed: 900,
    cpuTemperature: 10000,
    fsSize: 10000,
    blockDevices: 10000,
    battery: 60000,
    system: Infinity,
    chassis: Infinity,
    graphics: 30000,
    time: 0
};
const ALLOWED = new Set(Object.keys(MIN_INTERVAL));

class SiService {
    constructor({log = () => {}} = {}) {
        this.log = log;
        this.cache = new Map();     // key -> {at, value}
        this.inflight = new Map();  // key -> promise
        this.calls = 0;
        if (process.platform === "win32" && typeof si.powerShellStart === "function") {
            si.powerShellStart();
            this.persistentShell = true;
        }
    }

    isAllowed(fn) {
        return ALLOWED.has(fn) && typeof si[fn] === "function";
    }

    call(fn, ...args) {
        if (!this.isAllowed(fn)) return Promise.reject(new Error(`systeminformation.${fn} is not allowed`));
        const key = fn + JSON.stringify(args);
        const min = MIN_INTERVAL[fn];
        const hit = this.cache.get(key);
        if (hit && min > 0 && Date.now() - hit.at < min) return Promise.resolve(hit.value);
        if (this.inflight.has(key)) return this.inflight.get(key);
        this.calls++;
        const p = Promise.resolve(si[fn](...args)).then(value => {
            this.cache.set(key, {at: Date.now(), value});
            return value;
        }).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        return p;
    }

    // si-like facade for adapters that expect the systeminformation API
    facade() {
        const self = this;
        return new Proxy({}, {
            get: (t, fn) => (...args) => self.call(fn, ...args)
        });
    }

    release() {
        if (this.persistentShell) {
            try { si.powerShellRelease(); } catch (e) { /* already gone */ }
        }
    }
}

module.exports = {SiService, MIN_INTERVAL};
