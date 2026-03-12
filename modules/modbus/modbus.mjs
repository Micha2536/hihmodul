/**
 * /app/modbus.mjs
 *
 * Config-driven Modbus TCP polling (jsmodbus).
 *
 * Supports per-poll:
 * - registerType: holding|input|coil|discrete
 * - register: start register (as in your config)
 * - regBase: 0 or 1 (if docs are 1-based, set 1)
 * - count: number of registers to read
 * - interval: ms
 * - dataType: uint16|int16|uint32|int32|string
 * - wordOrder: be|swap (for 32-bit)
 * - scale/offset: numeric transform
 * - vhih.* metadata for later device creation
 *
 * Emits:
 *  - 'data': { Id, Name, Value, Raw, RegisterType, UnitId, Host, Port, VHIH }
 *  - 'error': { message, error, poll }
 */
import ModbusRTU from "jsmodbus";
import net from "node:net";
import EventEmitter from "node:events";

const SECRET_MASK = "********";

function toNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function regsToBufferU16(regs) {
  const buf = Buffer.alloc(regs.length * 2);
  regs.forEach((r, i) => buf.writeUInt16BE(r & 0xffff, i * 2));
  return buf;
}

function decodeFromRegisters(values, poll) {
  const regs = Array.isArray(values) ? values : [];
  const dataType = String(poll?.dataType ?? "uint16").toLowerCase();
  const wordOrder = String(poll?.wordOrder ?? "be").toLowerCase(); // be|swap
  const index = toNumber(poll?.index, 0) ?? 0;

  if (regs.length === 0) return null;

  const u16 = (v) => v & 0xffff;
  const i16 = (v) => {
    const x = u16(v);
    return x & 0x8000 ? x - 0x10000 : x;
  };

  if (dataType === "uint16" || dataType === "u16") {
    const v = regs[index];
    return v === undefined ? null : u16(v);
  }

  if (dataType === "int16" || dataType === "i16") {
    const v = regs[index];
    return v === undefined ? null : i16(v);
  }

  if (dataType === "uint32" || dataType === "u32" || dataType === "int32" || dataType === "i32") {
    const w1 = regs[index];
    const w2 = regs[index + 1];
    if (w1 === undefined || w2 === undefined) return null;
    let hi = u16(w1);
    let lo = u16(w2);
    if (wordOrder === "swap") [hi, lo] = [lo, hi];
    const b = Buffer.alloc(4);
    b.writeUInt16BE(hi, 0);
    b.writeUInt16BE(lo, 2);
    return dataType.startsWith("u") ? b.readUInt32BE(0) : b.readInt32BE(0);
  }

  if (dataType === "string" || dataType === "str") {
    const words = toNumber(poll?.stringWords, null);
    const slice = Number.isFinite(words) ? regs.slice(index, index + words) : regs.slice(index);
    const buf = regsToBufferU16(slice.map(u16));
    const enc = poll?.stringEncoding ?? "utf8";
    let s = buf.toString(enc);
    const idx0 = s.indexOf("\u0000");
    if (idx0 >= 0) s = s.slice(0, idx0);
    return (poll?.stringTrim ?? true) ? s.trim() : s;
  }

  const v = regs[index];
  return v === undefined ? null : u16(v);
}

function applyTransform(value, scale, offset) {
  if (typeof value !== "number") return value;
  const s = typeof scale === "number" ? scale : 1;
  const o = typeof offset === "number" ? offset : 0;
  return value * s + o;
}

export class Modbus extends EventEmitter {
  constructor(ip, port, deviceId) {
    super();
    this.ip = ip;
    this.port = port;
    this.deviceId = deviceId;
    this.client = null;
    this.socket = null;
    this.pollingIntervals = [];
  }

  async connect() {
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {}
    }

    this.socket = new net.Socket();
    this.client = new ModbusRTU.client.TCP(this.socket, this.deviceId);

    return new Promise((resolve, reject) => {
      this.socket.once("connect", () => {
        console.log(`[modbus] connected ${this.ip}:${this.port} unitId=${this.deviceId}`);
        resolve();
      });
      this.socket.once("error", (err) => {
        console.error(`[modbus] connect error ${this.ip}:${this.port}:`, err?.message ?? err);
        try {
          this.socket.destroy();
        } catch {}
        reject(err);
      });

      this.socket.connect({ host: this.ip, port: this.port });
    });
  }

  async connectWithRetry() {
    const loop = async () => {
      try {
        await this.connect();
      } catch (err) {
        console.error(
          `[modbus] retry connect in 2s (${this.ip}:${this.port} unitId=${this.deviceId}):`,
          err?.message ?? err
        );
        setTimeout(loop, 2000);
      }
    };
    await loop();
  }

  async readRegisters(registerType, startAddress, quantity) {
    const rt = String(registerType ?? "holding").toLowerCase();
    let response;
    switch (rt) {
      case "holding":
        response = await this.client.readHoldingRegisters(startAddress, quantity);
        break;
      case "input":
        response = await this.client.readInputRegisters(startAddress, quantity);
        break;
      case "coil":
        response = await this.client.readCoils(startAddress, quantity);
        break;
      case "discrete":
        response = await this.client.readDiscreteInputs(startAddress, quantity);
        break;
      default:
        throw new Error("Unknown registerType: " + rt);
    }

    const values = response?.response?._body?._valuesAsArray;
    if (!Array.isArray(values)) {
      throw new Error("Unexpected modbus response (missing values array)");
    }
    return values;
  }

  startPolling(poll) {
    const registerType = String(poll.registerType ?? poll.fc ?? "holding").toLowerCase();
    const register = toNumber(poll.register ?? poll.startAddress, 0);
    const count = toNumber(poll.count ?? poll.quantity, 1);
    const interval = toNumber(poll.interval, 1000);
    const regBase = toNumber(poll.regBase, 0);
    const dataType = poll.dataType ?? "uint16";
    const wordOrder = poll.wordOrder ?? "be";
    const scale = typeof poll.scale === "number" ? poll.scale : toNumber(poll.scale, null);
    const offset = typeof poll.offset === "number" ? poll.offset : toNumber(poll.offset, null);

    const startAddress = register - (regBase === 1 ? 1 : 0);
    if (!Number.isFinite(startAddress) || startAddress < 0) {
      const msg = `Invalid startAddress computed from register=${register}, regBase=${regBase}`;
      this.emit("error", { message: msg, error: msg, poll });
      return;
    }

    const name = poll.name ?? poll.vhih?.node?.name ?? poll.vhih_node_name ?? null;

    const vhih = poll.vhih ?? {
      node: { name: poll.vhih_node_name },
      profil: { typ: poll.vhih_profil_typ },
      attribut: {
        typ: poll.vhih_attribut_typ,
        unit: poll.vhih_attribut_unit,
        min: poll.vhih_attribut_min,
        max: poll.vhih_attribut_max,
        current_value: poll.vhih_attribut_current_value,
        step: poll.vhih_attribut_step,
      },
    };

    const timer = setInterval(async () => {
      try {
        const regs = await this.readRegisters(registerType, startAddress, count);

        // Fanout: one block read -> multiple attribute values
        const fanout = Array.isArray(poll.fanout) ? poll.fanout : null;
        if (fanout && fanout.length) {
          for (const f of fanout) {
            const fName = f.name ?? name;
            const fDataType = String(f.dataType ?? dataType);
            const fWordOrder = String(f.wordOrder ?? wordOrder);
            const fScale = (f.scale ?? scale);
            const fOffset = (f.offset ?? offset);

            const rawVal = decodeFromRegisters(regs, { ...poll, ...f, dataType: fDataType, wordOrder: fWordOrder });
            const val = applyTransform(rawVal, fScale ?? 1, fOffset ?? 0);

            this.emit("data", {
              Id: (f.registerId ?? f.attributeRegisterId ?? f.register ?? poll.registerId ?? poll.attributeRegisterId ?? register),
              Register: (f.register ?? register),
              RegisterId: (f.registerId ?? f.attributeRegisterId ?? null),
              Index: (f.index ?? poll.index ?? 0),
              Name: fName,
              Value: val,
              Raw: regs,
              RawDecoded: rawVal,
              DataType: fDataType,
              RegisterType: registerType,
              UnitId: this.deviceId,
              Port: this.port,
              Host: this.ip,
              VHIH: { ...vhih, ...(f.vhih ?? {}) },
            });
          }
          return;
        }


        const decodedRaw = decodeFromRegisters(regs, { ...poll, dataType, wordOrder });
        const decoded = applyTransform(decodedRaw, scale ?? 1, offset ?? 0);

        this.emit("data", {
          Id: (poll.registerId ?? poll.attributeRegisterId ?? register),
          Register: register,
          RegisterId: (poll.registerId ?? poll.attributeRegisterId ?? null),
          Index: (poll.index ?? 0),
          Name: name,
          Value: decoded,
          Raw: regs,
          RawDecoded: decodedRaw,
          DataType: dataType,
          RegisterType: registerType,
          UnitId: this.deviceId,
          Port: this.port,
          Host: this.ip,
          VHIH: vhih,
        });
      } catch (err) {
        const msg = `Read failed ${registerType} ${this.ip}:${this.port} unitId=${this.deviceId} start=${startAddress} count=${count}`;
        this.emit("error", {
          message: msg,
          error: err?.message ?? String(err),
          poll: { ...poll, registerType, register, count, interval, regBase, startAddress },
        });
      }
    }, interval);

    this.pollingIntervals.push(timer);
  }

  stopPolling() {
    this.pollingIntervals.forEach(clearInterval);
    this.pollingIntervals = [];
  }

  start(polls) {
    const list = Array.isArray(polls) ? polls : [];
    this.connectWithRetry()
      .then(() => list.forEach((p) => this.startPolling(p)))
      .catch((err) => {
        this.emit("error", { message: "init failed", error: err?.message ?? String(err) });
      });
  }
}

export default Modbus;
