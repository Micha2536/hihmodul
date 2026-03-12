import http from "node:http";
import https from "node:https";
import WebSocket from "ws";

const SHELLY_MODULE_VERSION = "2026-03-08-v2";

/**
 * Shelly module (Gen2+/Gen3).
 *
 * - Config in cfg.shelly
 * - Selected devices become discovered nodes.
 * - Control via RPC (HTTP POST /rpc)
 * - Status via polling + optional inbound websocket (ws://<ip>/rpc) to receive NotifyStatus frames.
 *
 * Notes:
 * - For BLU realtime, you typically need MQTT or Outbound WebSocket; inbound WS is best-effort.
 */

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function stableStringify(obj) {
  return JSON.stringify((function stable(o) {
    if (o === null || o === undefined) return o;
    if (Array.isArray(o)) return o.map(stable);
    if (typeof o === "object") {
      const out = {};
      for (const k of Object.keys(o).sort()) out[k] = stable(o[k]);
      return out;
    }
    return o;
  })(obj));
}

function log(rt, ...args) {
  try { rt?.log?.(...args); } catch { console.log(...args); }
}

function httpJson({ method, host, path, body, timeoutMs = 4000, headers = {} }) {
  return new Promise((resolve, reject) => {
    const isHttps = String(host).startsWith("https://");
    const urlHost = String(host).replace(/^https?:\/\//, "");
    const req = (isHttps ? https : http).request(
      {
        method,
        host: urlHost,
        path,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          ...(body ? { "content-length": Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          try { resolve(raw ? JSON.parse(raw) : {}); }
          catch { reject(new Error(`Invalid JSON: ${raw.slice(0, 200)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function rpcCall(ip, method, params = {}, { timeoutMs = 4000 } = {}) {
  const payload = JSON.stringify({ id: Date.now(), src: "vhih", method, params });
  return httpJson({ method: "POST", host: ip, path: "/rpc", body: payload, timeoutMs });
}

function getCfg(cfg) {
  const s = cfg?.shelly ?? {};
  return {
    enabled: asBool(s.enabled),
    realtimeWs: s.realtimeWs ?? true,
    pollMs: num(s.pollMs, 5000) ?? 5000,
    devices: Array.isArray(s.devices) ? s.devices : [],
  };
}

function buildAttrIndexFromIds(rt) {
  const m = new Map();
  const attrs = rt?.store?.ids?.modules?.shelly?.attributes ?? {};
  for (const [attrId, data] of Object.entries(attrs)) {
    m.set(stableStringify(data), Number(attrId));
  }
  return m;
}

function deviceKey(dev) {
  return String(dev?.deviceId || dev?.id || dev?.name || dev?.ip || "").trim();
}

function mkDeviceRef(ip, kind, id) {
  return { kind: "shelly", ip, type: kind, id: Number(id) || 0 };
}

function mkAttr(nodeKey, suffix, name, attrTypeKey, deviceRef, extra = {}) {
  return {
    attrKey: `${nodeKey}|${suffix}`,
    moduleId: "shelly",
    name,
    attrTypeKey,
    deviceRef,
    ...extra,
  };
}

function buildNodes(cfg) {
  const { devices } = getCfg(cfg);
  const discoveredNodes = [];

  for (const dev of devices) {
    if (!asBool(dev?.enabled)) continue;
    const ip = String(dev?.ip ?? "").trim();
    if (!ip) continue;

    const key = deviceKey(dev) || ip;
    const nodeKey = `shelly|${key}`;
    const name = dev?.name || dev?.deviceId || ip;

    // One node per Shelly device; multi-channel devices add attributes per channel.
    const profileKey = normalizeProfileKey(dev?.profileKey ?? dev?.profile, { defaultKey: "CANodeProfileMeteringPlug" });

    const switchIds = Array.isArray(dev?.switchIds)
      ? dev.switchIds.map((x) => num(x, null)).filter((x) => Number.isFinite(x))
      : (Number.isFinite(num(dev?.channels, null))
          ? Array.from({ length: Math.max(1, num(dev.channels, 1)) }, (_, i) => i)
          : [num(dev?.switchId, 0) ?? 0]);

    const attrs = [];

    for (const sid of switchIds) {
      const ch = Number(sid) || 0;

      // On/Off
      attrs.push(
        mkAttr(nodeKey, `switch:${ch}:on`, `On (ch${ch})`, "CAAttributeTypeOnOff",
          mkDeviceRef(ip, "switch", ch),
          { unit: "", min: 0, max: 1, step: 1, writable: true }
        )
      );

      // Power split into consumption/production.
      if (asBool(dev?.includePower)) {
        attrs.push(
          mkAttr(nodeKey, `switch:${ch}:pwr_in`, `Power Consumption (ch${ch})`, "CAAttributeTypePowerLoad",
            mkDeviceRef(ip, "pwr_in", ch),
            { unit: "W", min: 0, max: 5000, step: 1, writable: false }
          )
        );
        attrs.push(
          mkAttr(nodeKey, `switch:${ch}:pwr_out`, `Power Production (ch${ch})`, "CAAttributeTypePowerLoad",
            mkDeviceRef(ip, "pwr_out", ch),
            { unit: "W", min: 0, max: 5000, step: 1, writable: false }
          )
        );
      }

      // Energy split into consumption/production.
      if (asBool(dev?.includeEnergy)) {
        attrs.push(
          mkAttr(nodeKey, `switch:${ch}:eng_in`, `Energy Consumption (ch${ch})`, "CAAttributeTypeAccumulatedEnergyUse",
            mkDeviceRef(ip, "eng_in", ch),
            { unit: "Wh", min: 0, max: 1000000000, step: 1, writable: false }
          )
        );
        attrs.push(
          mkAttr(nodeKey, `switch:${ch}:eng_out`, `Energy Production (ch${ch})`, "CAAttributeTypeAccumulatedEnergyUse",
            mkDeviceRef(ip, "eng_out", ch),
            { unit: "Wh", min: 0, max: 1000000000, step: 1, writable: false }
          )
        );
      }
    }

    discoveredNodes.push({
      nodeKey,
      moduleId: "shelly",
      name,
      profileKey,
      attributes: attrs,
    });
  }

  return discoveredNodes;
}


function updateFromStatus(ip, result, emit) {
  const entries = Object.entries(result ?? {});
  for (const [k, v] of entries) {
    if (k.startsWith("switch:")) {
      const id = Number(k.split(":")[1]) || 0;

      if (typeof v?.output === "boolean") {
        emit(mkDeviceRef(ip, "switch", id), v.output ? 1 : 0);
      }

      // Instant power: positive = consumption, negative = production
      if (v?.apower != null) {
        const p = Number(v.apower) || 0;
        emit(mkDeviceRef(ip, "pwr_in", id), Math.max(0, p));
        emit(mkDeviceRef(ip, "pwr_out", id), Math.max(0, -p));
      }

      // Energy totals (Wh)
      const eIn = v?.aenergy?.total ?? v?.aenergy_total ?? null;
      if (eIn != null) {
        emit(mkDeviceRef(ip, "eng_in", id), Number(eIn) || 0);
      }

      const eOut = v?.ret_aenergy?.total ?? v?.ret_aenergy_total ?? null;
      if (eOut != null) {
        emit(mkDeviceRef(ip, "eng_out", id), Number(eOut) || 0);
      }
    }

    // Some firmwares expose power meter as pm1:<id>
    if (k.startsWith("pm1:")) {
      const id = Number(k.split(":")[1]) || 0;
      if (v?.apower != null) {
        const p = Number(v.apower) || 0;
        emit(mkDeviceRef(ip, "pwr_in", id), Math.max(0, p));
        emit(mkDeviceRef(ip, "pwr_out", id), Math.max(0, -p));
      }
      const eIn = v?.aenergy?.total ?? v?.aenergy_total ?? null;
      if (eIn != null) emit(mkDeviceRef(ip, "eng_in", id), Number(eIn) || 0);
      const eOut = v?.ret_aenergy?.total ?? v?.ret_aenergy_total ?? null;
      if (eOut != null) emit(mkDeviceRef(ip, "eng_out", id), Number(eOut) || 0);
    }

    // Energy meter devices (e.g. 3EM) expose em:<id>
    if (k.startsWith("em:")) {
      const id = Number(k.split(":")[1]) || 0;
      if (v?.a_act_power != null) {
        const p = Number(v.a_act_power) || 0;
        emit(mkDeviceRef(ip, "pwr_in", id), Math.max(0, p));
        emit(mkDeviceRef(ip, "pwr_out", id), Math.max(0, -p));
      }
      if (v?.a_total_act_energy != null) emit(mkDeviceRef(ip, "eng_in", id), Number(v.a_total_act_energy) || 0);
    }
  }
}


function ensureRuntime(rt) {
  rt._shelly = rt._shelly ?? { ws: new Map(), timers: new Map() };
  return rt._shelly;
}

async function ensureWs(dev, rt, emit) {
  const state = ensureRuntime(rt);
  const ip = dev.ip;
  const key = deviceKey(dev) || ip;

  const existing = state.ws.get(key);
  if (existing && existing.readyState === 1) return;

  const ws = new WebSocket(`ws://${ip}/rpc`, { handshakeTimeout: 4000 });
  state.ws.set(key, ws);

  ws.on("open", () => {
    log(rt, `[shelly] ws connected ${ip}`);
    try { ws.send(JSON.stringify({ id: 1, src: "vhih", method: "Shelly.GetStatus", params: {} })); } catch {}
  });

  ws.on("message", (buf) => {
    try {
      const msg = JSON.parse(String(buf));
      if (msg?.method === "NotifyStatus" || msg?.method === "NotifyEvent") {
        updateFromStatus(ip, msg?.params, emit);
      } else if (msg?.result) {
        updateFromStatus(ip, msg.result, emit);
      }
    } catch {}
  });

  ws.on("close", () => {
    log(rt, `[shelly] ws closed ${ip}`);
    state.ws.delete(key);
  });

  ws.on("error", (e) => {
    log(rt, `[shelly] ws error ${ip}:`, e?.message ?? e);
  });
}

export default {
  id: "shelly",
  name: "Shelly",

  enabled(cfg) {
    return getCfg(cfg).enabled;
  },

  async discover(cfg, rt) {
    log(rt, `[shelly] module version ${SHELLY_MODULE_VERSION}`);

    return { discoveredNodes: buildNodes(cfg) };
  },

  async start(cfg, rt) {
    this._attrIndex = buildAttrIndexFromIds(rt);
    const { devices, pollMs, realtimeWs } = getCfg(cfg);
    const state = ensureRuntime(rt);

    const emit = (deviceRef, value) => {
      const aid = this._attrIndex.get(stableStringify(deviceRef));
      if (!aid) return;
      rt.emitTelemetry({ attributeId: aid, value });
    };

    // polling timers
    for (const dev of devices) {
      if (!asBool(dev?.enabled)) continue;
      const ip = String(dev.ip ?? "").trim();
      if (!ip) continue;

      const key = deviceKey(dev) || ip;

      // websocket best-effort
      if (asBool(realtimeWs)) ensureWs(dev, rt, emit);

      // polling
      if (state.timers.has(key)) continue;
      const t = setInterval(async () => {
        try {
          const r = await rpcCall(ip, "Shelly.GetStatus", {});
          updateFromStatus(ip, r?.result ?? r, emit);
        } catch (e) {
          log(rt, `[shelly] poll error ${ip}:`, e?.message ?? e);
        }
      }, Math.max(1000, pollMs));
      state.timers.set(key, t);
    }
  },

  async stop() {
    // Nothing hard-stopped; core restart recreates runtime. Best-effort cleanup could be added.
  },

  async handleCommand(cmd, rt) {
    const ref = cmd?.deviceRef;
    if (!ref?.ip) throw new Error("missing deviceRef.ip");
    const ip = ref.ip;

    if (ref.type === "switch") {
      const on = cmd.value === true || cmd.value === 1 || cmd.value === "1" || cmd.value === "true";
      await rpcCall(ip, "Switch.Set", { id: Number(ref.id) || 0, on });
      return;
    }

    throw new Error(`unsupported shelly type ${ref.type}`);
  },
};
function normalizeProfileKey(v, opts = {}) {
  const s = String(v ?? "").trim();
  if (!s) return opts.defaultKey ?? "CANodeProfileOnOffSwitch";
  if (s.startsWith("CANodeProfile")) return s;
  switch (s.toLowerCase()) {
    case "switch": return "CANodeProfileOnOffSwitch";
    case "plug": return "CANodeProfileMeteringPlug";
    case "metering_plug": return "CANodeProfileMeteringPlug";
    case "onoff_plug": return "CANodeProfileOnOffPlug";
    case "roller":
    case "roller_shutter":
    case "cover":
    case "shutter": return "CANodeProfileShutterPositionSwitch";
    case "sensor":
    case "th": return "CANodeProfileTemperatureAndHumiditySensor";
    default: return opts.defaultKey ?? "CANodeProfileOnOffSwitch";
  }
}

