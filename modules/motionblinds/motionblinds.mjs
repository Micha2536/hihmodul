/**
 * MotionBlinds UDP client (ESM).
 *
 * Network:
 * - Send commands to multicast 238.0.0.18:32100 (device gateway listens here)
 * - Receive general multicast on 238.0.0.18:32101
 * - Receive direct responses on a fixed response port (default 32200)
 *
 * Auth:
 * - GetDeviceList is sent WITHOUT accessToken.
 * - GetDeviceListAck returns a `token`.
 * - accessToken is derived from token + secretKey (MD5 hex upper).
 */

import dgram from "node:dgram";
import os from "node:os";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export default class MotionBlinds {
  constructor() {
    
    this._bus = new EventEmitter();
this.ip = "";
    this.secretKey = "";
    this.multicastIp = "238.0.0.18";
    this.sendIp = ""; // unicast bridge ip (required for commands)
    this.sendPort = 32100;
    this.listenPort = 32101;
    this.responsePort = 32200;

    this.sendSocket = null;        // unicast responsePort listener + sender
    this.multicastClient = null;  // multicast listener
    this._listeners = new Set();

    this.token = "";
    this.accessToken = "";

    this._pending = new Map(); // key -> {resolve,reject,timer,matchFn}
  }

  on(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit(msg, source) {
    this._bus.emit("msg", msg, source);
    for (const cb of this._listeners) {
      try { cb({ payload: msg, source }); } catch {}
    }
  }

  

_logInboundRaw(buf, rinfo, source) {
  try {
    const s = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf);
    let parsed = null;
    try {
      parsed = JSON.parse(s);
    } catch {
      // ignore
    }
    const msg = parsed?.payload ?? parsed ?? null;
    const meta = msg
      ? { msgType: msg.msgType, mac: msg.mac, msgID: msg.msgID, deviceType: msg.deviceType }
      : {};
    console.log("[motionblinds] IN", source, { from: `${rinfo.address}:${rinfo.port}`, len: Buffer.isBuffer(buf) ? buf.length : undefined, ...meta });
    // Uncomment next line if you also want full payload (can be noisy)
    // console.log("[motionblinds] IN_RAW", source, s);
  } catch (e) {
    console.log("[motionblinds] IN", source, { from: `${rinfo.address}:${rinfo.port}`, err: e?.message ?? String(e) });
  }
}

_parseJson(message, source) {
    try {
      const raw = Buffer.isBuffer(message) ? message.toString("utf8") : String(message ?? "");
      const obj = JSON.parse(raw);
      // Sometimes upstream wraps messages as {payload:{...}, ...}
      return obj?.payload ?? obj;
    } catch (e) {
      // ignore parse errors
      return null;
    }
  }

  generateAccessToken(token, key) {
    const keyBuf = Buffer.from(String(key ?? ""), "utf8");
    const tokenBuf = Buffer.from(String(token ?? ""), "utf8");

    // AES-128-ECB expects 16-byte key. We pad/truncate to 16 bytes.
    const k = Buffer.alloc(16, 0);
    keyBuf.copy(k, 0, 0, Math.min(16, keyBuf.length));

    const cipher = crypto.createCipheriv("aes-128-ecb", k, null);
    cipher.setAutoPadding(true); // PKCS7
    const encrypted = Buffer.concat([cipher.update(tokenBuf), cipher.final()]);
    const hex = encrypted.toString("hex").toUpperCase();
    return hex.substring(0, 32);
  }


  async start(ip, secretKey, opts = {}) {
    this.ip = ip;
    this.secretKey = secretKey;
    this.multicastIp = opts.multicastIp ?? this.multicastIp;
    this.sendIp = (opts.sendIp || this.ip);
    if (!this.sendIp) throw new Error("MotionBlinds bridge ip required for sending commands");
    this.sendPort = opts.sendPort ?? this.sendPort;
    this.listenPort = opts.listenPort ?? this.listenPort;
    this.responsePort = (opts.responsePort ?? this.responsePort);

    await this._bindSockets();
  }

  async stop() {
    for (const p of this._pending.values()) clearTimeout(p.timer);
    this._pending.clear();

    if (this.sendSocket) {
      try { this.sendSocket.close(); } catch {}
      this.sendSocket = null;
    }
    if (this.multicastClient) {
      try { this.multicastClient.close(); } catch {}
      this.multicastClient = null;
    }
    if (this.multicastReplyClient) {
      try { this.multicastReplyClient.close(); } catch {}
      this.multicastReplyClient = null;
    }
  }

  
_pickIfaceFor(ip) {
  try {
    const prefix = (typeof ip === "string" && ip.includes(".")) ? ip.split(".").slice(0, 3).join(".") + "." : null;
    const ifaces = os.networkInterfaces();
    for (const addrs of Object.values(ifaces)) {
      for (const a of addrs ?? []) {
        if (a.family === "IPv4" && !a.internal) {
          if (!prefix || a.address.startsWith(prefix)) return a.address;
        }
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

async _bindSockets() {
  if (this.sendSocket && this.multicastClient && this.multicastReplyClient) return;

  this.sendSocket = dgram.createSocket({ type: "udp4", reuseAddr: true });


await new Promise((resolve, reject) => {
  this.sendSocket.once("error", reject);
  // Bind send socket to responsePort so the gateway replies to the expected port (Node-RED behavior).
  this.sendSocket.bind(this.responsePort, "0.0.0.0", () => {
    this.sendSocket.off("error", reject);
    try {
      const a = this.sendSocket.address();
      console.log("[motionblinds][send] bound", a);
      try { this.sendSocket.setBroadcast(true); } catch {}
    } catch {}
    resolve();
  });
});


  // General multicast (Heartbeat/Report)
  this.multicastClient = dgram.createSocket({ type: "udp4", reuseAddr: true });

  // Reply multicast (individual response port)
  this.multicastReplyClient = dgram.createSocket({ type: "udp4", reuseAddr: true });

  const iface = this._pickIfaceFor(this.sendIp || this.ip);

  await new Promise((resolve, reject) => {
    this.multicastClient.once("error", reject);
    this.multicastClient.bind(this.listenPort, "0.0.0.0", () => {
      this.multicastClient.off("error", reject);
      try {
        this.multicastClient.addMembership(this.multicastIp, iface);
      } catch (e) {
        console.log("[motionblinds][mcast] addMembership failed", e?.message ?? e);
      }
      console.log("[motionblinds][mcast] bound", this.multicastClient.address(), "group", this.multicastIp, "iface", iface);
      resolve();
    });
  });

  await new Promise((resolve, reject) => {
    this.multicastReplyClient.once("error", reject);
    this.multicastReplyClient.bind(this.responsePort, "0.0.0.0", () => {
      this.multicastReplyClient.off("error", reject);
      try {
        this.multicastReplyClient.addMembership(this.multicastIp, iface);
      } catch (e) {
        console.log("[motionblinds][mcast_reply] addMembership failed", e?.message ?? e);
      }
      console.log("[motionblinds][mcast_reply] bound", this.multicastReplyClient.address(), "group", this.multicastIp, "iface", iface);
      resolve();
    });
  });

  try {
    this.multicastClient.setMulticastLoopback(true);
    this.multicastClient.setMulticastTTL(128);
    this.multicastReplyClient.setMulticastLoopback(true);
    this.multicastReplyClient.setMulticastTTL(128);
  } catch {}

  this.multicastClient.on("message", (message, rinfo) => {
    this._logInboundRaw(message, rinfo, "multicast");
    const data = this._parseJson(message, "multicast");
    if (data) {
      console.log("[motionblinds] IN multicast", {
        from: `${rinfo.address}:${rinfo.port}`,
        len: message.length,
        msgType: data.msgType,
        mac: data.mac,
        msgID: data.msgID,
        deviceType: data.deviceType,
      });
    }
    if (!data) return;
    this._handleIncoming(data, "multicast");
  });

  this.multicastReplyClient.on("message", (message, rinfo) => {
    this._logInboundRaw(message, rinfo, "multicast_reply");
    const data = this._parseJson(message, "multicast_reply");
    if (data) {
      console.log("[motionblinds] IN multicast_reply", {
        from: `${rinfo.address}:${rinfo.port}`,
        len: message.length,
        msgType: data.msgType,
        mac: data.mac,
        msgID: data.msgID,
        deviceType: data.deviceType,
      });
    }
    if (!data) return;
    this._handleIncoming(data, "multicast_reply");
  });
  }

_handleIncoming(msg, source) {
    // resolve pending requests first
    for (const [key, p] of this._pending.entries()) {
      try {
        if (p.matchFn(msg)) {
          clearTimeout(p.timer);
          this._pending.delete(key);
          p.resolve(msg);
          // do not break; allow also emit to listeners
          break;
        }
      } catch {}
    }
    this._emit(msg, source);
  }

_sendRaw(obj) {
  const buf = Buffer.from(JSON.stringify(obj), "utf8");
  // Node-RED style debug: payload as byte array
  console.log("[motionblinds] send raw", {
    _msgid: String(obj?.msgID ?? ""),
    payload: Array.from(buf),
    port: this.sendPort,
    ip: this.sendIp,
    len: buf.length,
  });
  return new Promise((resolve, reject) => {
    this.sendSocket.send(buf, 0, buf.length, this.sendPort, this.sendIp, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

  _awaitResponse({ key, timeoutMs, matchFn }) {
    if (this._pending.has(key)) {
      // replace previous
      const prev = this._pending.get(key);
      clearTimeout(prev.timer);
      this._pending.delete(key);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(key);
        reject(new Error("No response received within timeout period"));
      }, timeoutMs);

      this._pending.set(key, { resolve, reject, timer, matchFn });
    });
  }

_waitForAck({ ackType, msgID, mac, timeoutMs = 2500 }) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      this._bus.removeListener("msg", onMsg);
      reject(new Error("No response received within timeout period"));
    }, timeoutMs);

    const onMsg = (msg) => {
      const m = msg?.payload ?? msg;
      if (!m || m.msgType !== ackType) return;
      if (mac && m.mac && String(m.mac) !== String(mac)) return;
      if (msgID && m.msgID && String(m.msgID) !== String(msgID)) return;

      clearTimeout(t);
      this._bus.removeListener("msg", onMsg);
      resolve(m);
    };

    this._bus.on("msg", onMsg);
  });
}


  async getDeviceList({ timeoutMs = 5000, retries = 3, retryDelayMs = 700 } = {}) {
    await this._bindSockets();

    for (let attempt = 0; attempt < retries; attempt++) {
      const msgID = Date.now().toString();
      const req = { msgType: "GetDeviceList", msgID };
      const wait = this._awaitResponse({
        key: `GetDeviceListAck:${msgID}:${attempt}`,
        timeoutMs,
        matchFn: (m) => m?.msgType === "GetDeviceListAck" && Array.isArray(m?.data),
      });

      await this._sendRaw(req);
      try {
        const ack = await wait;
        if (ack?.token) {
          this.token = String(ack.token);
          this.accessToken = this.generateAccessToken(this.token, this.secretKey);
        }
        return ack;
      } catch (e) {
        if (attempt === retries - 1) throw e;
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    throw new Error("No response received within timeout period");
  }

  async readDevice(mac, { timeoutMs = 4000 } = {}) {
    if (!this.accessToken) await this.getDeviceList();
    const msgID = Date.now().toString();
    const req = {
      msgType: "ReadDevice",
      mac: String(mac),
      deviceType: "10000000",
      msgID,
      accessToken: this.accessToken,
    };
    const wait = this._awaitResponse({
      key: `ReadDeviceAck:${mac}:${msgID}`,
      timeoutMs,
      matchFn: (m) => m?.msgType === "ReadDeviceAck" && String(m?.mac) === String(mac),
    });
    await this._sendRaw(req);
    return wait;
  }


  async writeDevicePosition(mac, targetPosition, { timeoutMs = 6000, awaitAck = false } = {}) {
  if (!this.secretKey) throw new Error("secretKey missing");
  if (!this.token) await this.getDeviceList();
  if (!this.accessToken) this.accessToken = this.generateAccessToken(this.token, this.secretKey);

  const msgID = Date.now().toString();
  const req = {
    msgType: "WriteDevice",
    mac: String(mac),
    deviceType: "10000000",
    msgID,
    accessToken: this.accessToken,
    data: { targetPosition: Number(targetPosition) },
  };

  let wait = null;
  if (awaitAck) {
    wait = this._waitForAck(
      (m) =>
        m?.msgType === "WriteDeviceAck" &&
        String(m?.mac) === String(mac) &&
        String(m?.msgID) === String(msgID),
      timeoutMs
    );
  }

  await this._sendRaw(req);
  return wait ? await wait : { sent: true, msgID };
}

async writeDeviceOperation(mac, operation, { timeoutMs = 6000, awaitAck = false } = {}) {
  if (!this.secretKey) throw new Error("secretKey missing");
  if (!this.token) await this.getDeviceList();
  if (!this.accessToken) this.accessToken = this.generateAccessToken(this.token, this.secretKey);

  const msgID = Date.now().toString();
  const req = {
    msgType: "WriteDevice",
    mac: String(mac),
    deviceType: "10000000",
    msgID,
    accessToken: this.accessToken,
    data: { operation: Number(operation) },
  };

  let wait = null;
  if (awaitAck) {
    wait = this._waitForAck(
      (m) =>
        m?.msgType === "WriteDeviceAck" &&
        String(m?.mac) === String(mac) &&
        String(m?.msgID) === String(msgID),
      timeoutMs
    );
  }

  await this._sendRaw(req);
  return wait ? await wait : { sent: true, msgID };
}

}