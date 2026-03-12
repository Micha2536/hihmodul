/**
 * modules/motionblinds/index.mjs
 *
 * Slim ids.json model:
 * - module stores per-attribute `data` in ids.modules.motionblinds.attributes[attrId]
 * - module builds an in-memory map: stableStringify(data) -> attrId
 * - runtime.emitTelemetry({attributeId,value}) for all updates
 */

import dgram from "node:dgram";
import os from "node:os";
import MotionBlinds from "./motionblinds.mjs";

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}


function pickInterfaceAddr(targetIp) {
  try {
    const t = String(targetIp || "");
    const parts = t.split(".");
    if (parts.length !== 4) return undefined;
    const prefix = parts.slice(0, 3).join(".") + ".";
    const ifaces = os.networkInterfaces();
    for (const infos of Object.values(ifaces)) {
      for (const info of infos ?? []) {
        if (info?.family === "IPv4" && !info.internal && typeof info.address === "string") {
          if (info.address.startsWith(prefix)) return info.address;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}


function getCfg(cfg) {
  const m = cfg?.motionblinds ?? {};
  const enabled = m.enabled === true || (cfg?.motionblinds_ip && cfg?.motionblindssecretKey);
  return {
    enabled,
    ip: m.ip ?? cfg?.motionblinds_ip ?? "",
    secretKey: m.secretKey ?? cfg?.motionblindssecretKey ?? "",
    responsePort: Number(m.responsePort ?? 32200),
    sendPort: Number(m.sendPort ?? 32100),
    listenPort: Number(m.listenPort ?? 32101),
    multicastIp: m.multicastIp ?? "238.0.0.18",
    pollSec: Number(m.pollSec ?? 1800), // 30min
  };
}

function isBlindDevice(d) {
  return d && d.deviceType === "10000000" && typeof d.mac === "string";
}

function mvToVolt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // MotionBlinds uses centivolt (1267 -> 12.67)
  return n > 100 ? Math.round((n / 100) * 100) / 100 : Math.round(n * 100) / 100;
}

export default {
  id: "motionblinds",
  name: "MotionBlinds",

  _client: null,
  _started: false,
  _rt: null,
  _index: null,

  enabled(cfg) {
    const c = getCfg(cfg);
    return c.enabled && !!c.ip && !!c.secretKey;
  },

async discover(cfg) {
  const c = getCfg(cfg);
  if (!this.enabled(cfg)) return { discoveredNodes: [] };

  // Minimal discovery: use a short-lived UDP socket bound to responsePort and joined to multicast group.
  // No long-running sockets/intervals are created here; `start()` will create the runtime client.
  const iface = pickInterfaceAddr(c.ip);

  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const bindPort = Number.isFinite(c.responsePort) && c.responsePort > 0 ? c.responsePort : 0;
  await new Promise((resolve, reject) => {
    sock.once("error", reject);
    sock.bind(bindPort, "0.0.0.0", () => {
      sock.off("error", reject);
      resolve();
    });
  });

  const effectivePort = sock.address().port;

  try {
    sock.addMembership(c.multicastIp, iface);
  } catch {
    // ignore (some environments don't require/allow explicit iface)
    try { sock.addMembership(c.multicastIp); } catch {}
  }

  const sendOnce = (msgID) => {
    const obj = { msgType: "GetDeviceList", msgID: String(msgID) };
    const buf = Buffer.from(JSON.stringify(obj), "utf8");
    return new Promise((resolve, reject) => {
      sock.send(buf, c.sendPort, c.ip, (err) => (err ? reject(err) : resolve()));
    });
  };

  const waitAck = (timeoutMs) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        sock.off("message", onMsg);
        resolve(null);
      }, timeoutMs);

      function onMsg(message) {
        try {
          const raw = JSON.parse(message.toString("utf8"));
          const msg = raw?.payload ?? raw;
          if (msg?.msgType === "GetDeviceListAck") {
            clearTimeout(timer);
            sock.off("message", onMsg);
            resolve(msg);
          }
        } catch {
          // ignore
        }
      }

      sock.on("message", onMsg);
    });

  let ack = null;
  for (let i = 0; i < 3 && !ack; i += 1) {
    const msgID = Date.now().toString();
    await sendOnce(msgID);
    ack = await waitAck(2500);
  }

  try { sock.close(); } catch {}

  if (!ack) {
    throw new Error("motionblinds No response received within timeout period");
  }

  const devices = (ack?.data ?? []).filter(isBlindDevice);

  const discoveredNodes = devices.map((d) => {
    const mac = d.mac;
    const nodeKey = `motionblinds|blind|${mac}`;
    return {
      nodeKey,
      moduleId: "motionblinds",
      name: `Blind ${mac.slice(-4)}`,
      profileKey: "CANodeProfileShutterPositionSwitch",
      attributes: [
        {
          attrKey: `${nodeKey}|pos`,
          moduleId: "motionblinds",
          name: "Position",
          attrTypeKey: "CAAttributeTypePosition",
          unit: "%25",
          min: 0,
          max: 100,
          step: 1,
          writable: true,
          currentValue: 0,
          targetValue: 0,
          lastValue: 0,
          data: { kind: "blind", mac, action: "pos" },
        },
        {
          attrKey: `${nodeKey}|updown`,
          moduleId: "motionblinds",
          name: "Up/Down",
          attrTypeKey: "CAAttributeTypeUpDown",
          unit: "",
          min: 0,
          max: 2,
          step: 1,
          writable: true,
          currentValue: 2,
          targetValue: 2,
          lastValue: 2,
          data: { kind: "blind", mac, action: "updown" },
        },
        {
          attrKey: `${nodeKey}|voltage`,
          moduleId: "motionblinds",
          name: "Voltage",
          attrTypeKey: "CAAttributeTypeVoltage",
          unit: "V",
          min: 0,
          max: 30,
          step: 0.01,
          writable: false,
          currentValue: 0,
          targetValue: 0,
          lastValue: 0,
          data: { kind: "blind", mac, action: "voltage" },
        },
        {
          attrKey: `${nodeKey}|charging`,
          moduleId: "motionblinds",
          name: "Charging",
          attrTypeKey: "CAAttributeTypeOnOff",
          unit: "",
          min: 0,
          max: 1,
          step: 1,
          writable: false,
          currentValue: 0,
          targetValue: 0,
          lastValue: 0,
          data: "",
        },
        {
          attrKey: `${nodeKey}|rssi`,
          moduleId: "motionblinds",
          name: "RSSI",
          attrTypeKey: "CAAttributeTypeVoltage",
          unit: "dBm",
          min: -120,
          max: 0,
          step: 1,
          writable: false,
          currentValue: -120,
          targetValue: -120,
          lastValue: -120,
          data: "",
        },
      ],
    };
  });

  return { discoveredNodes };
},
  async start(cfg, runtime) {
    const c = getCfg(cfg);
    if (!this.enabled(cfg)) return;

    if (this._started) return;
    this._started = true;

    this._rt = runtime;
    if (!this._client) this._client = new MotionBlinds();
    await this._client.start(c.ip, c.secretKey, { responsePort: c.responsePort });

    // Build stableStringify(data)->attrId map from already-loaded ids.json
    this._index = new Map();
    const ids = runtime?.store?.ids;
    const attrs = ids?.modules?.motionblinds?.attributes ?? {};
    for (const [attrId, data] of Object.entries(attrs)) {
      this._index.set(stableStringify(data), Number(attrId));
    }

    const pushTelemetryFromMsg = (msg) => {
      const mac = msg?.mac;
      const d = msg?.data ?? {};
      if (!mac || typeof mac !== "string") return;

      // Position (0=open)
      if (d.currentPosition != null) {
        const aid = this._index.get(stableStringify({ kind: "blind", mac, action: "pos" }));
        if (aid) runtime.emitTelemetry({ attributeId: aid, value: Number(d.currentPosition) });
      }
      // Voltage
      if (d.batteryLevel != null) {
        const aid = this._index.get(stableStringify({ kind: "blind", mac, action: "voltage" }));
        if (aid) runtime.emitTelemetry({ attributeId: aid, value: mvToVolt(d.batteryLevel) });
      }
      // RSSI
      if (d.RSSI != null) {
        const aid = this._index.get(stableStringify({ kind: "blind", mac, action: "rssi" }));
        if (aid) runtime.emitTelemetry({ attributeId: aid, value: Number(d.RSSI) });
      }
      // Charging
      if (d.chargingState != null) {
        const aid = this._index.get(stableStringify({ kind: "blind", mac, action: "charging" }));
        if (aid) runtime.emitTelemetry({ attributeId: aid, value: Number(d.chargingState) ? 1 : 0 });
      }
    };

    this._client.on(({ payload }) => {
      const t = payload?.msgType;
    console.log("[motionblinds][mcast] parsed", { msgType: t, mac: payload?.mac, msgID: payload?.msgID });
      if (t === "Report" || t === "ReadDeviceAck" || t === "WriteDeviceAck") pushTelemetryFromMsg(payload);
    });


  },
  async stop() {
    this._started = false;
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
await this._client?.stop();
    this._client = null;
    this._rt = null;
    this._index = null;
    if (this._client) {
      try { await this._client.stop(); } catch {}
      this._client = null;
    }
    this._index = null;
    this._rt = null;

  },

  async handleCommand(payload, runtime) {
    const data = payload?.deviceRef ?? payload?.data;
    if (!data) return;

    const mac = data.mac;
    if (!mac) return;

    if (data.action === "pos") {
      const pos = Math.max(0, Math.min(100, Math.round(Number(payload.value))));
      try {
        await this._client.writeDevicePosition(mac, pos, { awaitAck: false });
      } catch {
        // ignore: reports/heartbeat will correct state
      }
      runtime.emitTelemetry({ attributeId: payload.attributeId, value: pos });
      return;
    }

    if (data.action === "updown") {
      // Homee semantics given by user:
      // 0=open, 1=close, 2=stop
      const v = Number(payload.value);
      const op = v === 2 ? 2 : (v === 1 ? 0 : 1);
      try {
        await this._client.writeDeviceOperation(mac, op, { awaitAck: false });
      } catch {
        // ignore
      }
      // optional: update position attribute optimistically
      const posAid = this._index?.get(stableStringify({ kind: "blind", mac, action: "pos" }));
      if (posAid && v !== 2) runtime.emitTelemetry({ attributeId: posAid, value: v === 0 ? 0 : 100 });
      return;
    }
  },
};
