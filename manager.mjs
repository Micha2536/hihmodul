/**
 * /app/manager.mjs
 *
 * Small supervisor that:
 * - serves a config/control UI on port 8100
 * - persists config.json in DATA_DIR (defaults to /app/data)
 * - starts/stops/restarts the main app (app.mjs)
 *
 * Run the container with --network host if you rely on UDP multicast/broadcast.
 */
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { spawn } from "node:child_process";
import ModbusRTU from "jsmodbus";
import net from "node:net";
import https from "node:https";

const DATA_DIR = process.env.DATA_DIR ?? "/app/data";
const UI_PORT = Number(process.env.UI_PORT ?? "8100");
const APP_ENTRY = process.env.APP_ENTRY ?? "/app/core/app.mjs";
const APP_DIR = process.env.APP_DIR ?? path.dirname(path.dirname(APP_ENTRY));

const STATE_PATH = path.join(DATA_DIR, "manager-state.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const APP_CONFIG_PATH = "/app/config.json";

let child = null;
let enabled = true;

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readJsonFile(p, fallback) {
  try {
    const txt = await fs.readFile(p, "utf-8");
    return JSON.parse(txt);
  } catch (e) {
    return fallback;
  }
}

function hueV2Request(ip, appKey, pathName) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      path: pathName,
      method: "GET",
      rejectUnauthorized: false,
      headers: { "hue-application-key": appKey },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        try {
          const json = JSON.parse(text);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`Hue v2 HTTP ${res.statusCode}: ${text}`));
        } catch (e) {
          reject(new Error(`Hue v2 invalid JSON: ${text}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}


async function writeJsonFile(p, obj) {
  const txt = JSON.stringify(obj, null, 2) + "\n";
  await fs.writeFile(p, txt, "utf-8");
}

function decodeFromRegisters(values, opts) {
  const regs = Array.isArray(values) ? values : [];
  const dataType = String(opts?.dataType ?? "uint16").toLowerCase();
  const wordOrder = String(opts?.wordOrder ?? "be").toLowerCase(); // be|swap
  const index = Number.isFinite(Number(opts?.index)) ? Number(opts.index) : 0;

  if (regs.length === 0) return null;

  const u16 = (v) => v & 0xffff;
  const i16 = (v) => {
    const x = u16(v);
    return x & 0x8000 ? x - 0x10000 : x;
  };

  if (dataType === "uint16" || dataType === "u16") return regs[index] === undefined ? null : u16(regs[index]);
  if (dataType === "int16" || dataType === "i16") return regs[index] === undefined ? null : i16(regs[index]);

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
    const words = Number.isFinite(Number(opts?.stringWords)) ? Number(opts.stringWords) : (regs.length - index);
    const slice = regs.slice(index, index + words);
    const buf = Buffer.alloc(slice.length * 2);
    slice.forEach((r, i) => buf.writeUInt16BE(u16(r), i * 2));
    let s = buf.toString(opts?.stringEncoding ?? "utf8");
    const idx0 = s.indexOf("\u0000");
    if (idx0 >= 0) s = s.slice(0, idx0);
    return (opts?.stringTrim ?? true) ? s.trim() : s;
  }

  return regs[index] === undefined ? null : u16(regs[index]);
}

function applyNumericTransform(v, opts) {
  if (typeof v !== "number") return v;
  const scale = opts?.scale === undefined ? 1 : Number(opts.scale);
  const offset = opts?.offset === undefined ? 0 : Number(opts.offset);
  return v * (Number.isFinite(scale) ? scale : 1) + (Number.isFinite(offset) ? offset : 0);
}

const SECRET_MASK = "********";

function maskSecrets(cfg) {
  const c = JSON.parse(JSON.stringify(cfg ?? {}));
  if (c?.hue?.key) c.hue.key = SECRET_MASK;
  if (c?.velux?.password) c.velux.password = SECRET_MASK;
  if (c?.motionblinds?.secretKey) c.motionblinds.secretKey = SECRET_MASK;
  return c;
}

function mergeSecrets(existing, incoming) {
  const out = JSON.parse(JSON.stringify(incoming ?? {}));

  const keep = (pathArr) => {
    let ex = existing;
    let cur = out;
    for (let i = 0; i < pathArr.length - 1; i++) {
      ex = ex?.[pathArr[i]];
      if (cur[pathArr[i]] === undefined) cur[pathArr[i]] = {};
      cur = cur[pathArr[i]];
    }
    const k = pathArr[pathArr.length - 1];
    if (cur?.[k] === SECRET_MASK) {
      if (ex?.[k] !== undefined) cur[k] = ex[k];
      else delete cur[k];
    }
  };

  keep(["hue", "key"]);
  keep(["velux", "password"]);
  keep(["motionblinds", "secretKey"]);
  return out;
}

async function loadConfigRaw() {
  return await readJsonFile(CONFIG_PATH, {});
}

async function saveConfigRaw(cfg) {
  await writeJsonFile(CONFIG_PATH, cfg);
  await fs.writeFile(APP_CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
}

async function loadState() {
  const s = await readJsonFile(STATE_PATH, { enabled: true });
  enabled = !!s.enabled;
}

async function saveState() {
  await writeJsonFile(STATE_PATH, { enabled });
}

async function ensureConfig() {
  await ensureDir(DATA_DIR);

  try {
    await fs.access(CONFIG_PATH);
  } catch {
    // seed from bundled /app/config.json if present
    const seed = await readJsonFile(APP_CONFIG_PATH, {});
    await saveConfigRaw(seed);
  }

  const cfg = await loadConfigRaw();
  await saveConfigRaw(cfg);
}

function startApp() {
  if (!enabled) {
    console.log("[manager] start requested, but app is disabled");
    return;
  }
  if (child && !child.killed) {
    console.log("[manager] app already running (pid=%s)", child.pid);
    return;
  }

  console.log("[manager] starting app:", APP_ENTRY);
  child = spawn(process.execPath, [APP_ENTRY], {
    stdio: "inherit",
    env: { ...process.env, DATA_DIR },
  });

  child.on("exit", (code, signal) => {
    console.log("[manager] app exited:", { code, signal });
    child = null;

    // If enabled, let Docker restart policy handle hard crashes,
    // but we also optionally auto-restart here for soft exits.
    if (enabled) {
      const auto = (process.env.AUTO_RESTART ?? "1") === "1";
      if (auto) {
        console.log("[manager] auto-restart in 1s…");
        setTimeout(() => startApp(), 1000);
      }
    }
  });
}

async function stopApp() {
  if (!child) return;
  console.log("[manager] stopping app (pid=%s)…", child.pid);

  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));

  if (child) {
    child.kill("SIGKILL");
  }
}

async function restartApp() {
  await stopApp();
  await new Promise((r) => setTimeout(r, 300));
  await ensureConfig();
  startApp();
}

async function main() {
  await ensureDir(DATA_DIR);
  await loadState();
  await ensureConfig();

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));


// List installed modules (folder names under /app/modules with index.mjs)
app.get("/api/modules", async (req, res) => {
  try {
    const modulesDir = path.join(APP_DIR, "modules");
    const entries = await fs.readdir(modulesDir, { withFileTypes: true });
    const mods = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const id = e.name;
      try {
        await fs.stat(path.join(modulesDir, id, "index.mjs"));
        const hasWebui = await fs.stat(path.join(modulesDir, id, "webui", "settings.html")).then(() => true).catch(() => false);
        mods.push({ id, hasWebui });
      } catch {
        // ignore
      }
    }
    mods.sort((a, b) => a.id.localeCompare(b.id));
    res.json({ ok: true, modules: mods });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});


// Enums for WebUI (profiles + attribute types)
app.get("/api/enums", async (_req, res) => {
  try {
    const enumsPath = path.join(APP_DIR, "enums.js");
    const src = await fs.readFile(enumsPath, "utf8");
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(src, ctx, { filename: "enums.js" });
    const ENUMS = ctx.ENUMS ?? {};
    return res.json({
      ok: true,
      profiles: ENUMS.CANodeProfile ?? {},
      attrTypes: ENUMS.CAAttributeType ?? {},
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});



  app.get("/api/status", (req, res) => {
    res.json({
      running: !!child,
      pid: child?.pid ?? null,
      enabled,
      dataDir: DATA_DIR,
      uiPort: UI_PORT,
    });
  })


  app.get("/api/config", async (req, res) => {
    const cfg = await loadConfigRaw();
    res.json(maskSecrets(cfg));
  });

  app.post("/api/config", async (req, res) => {
    let cfg = req.body?.config ?? req.body;
    if (typeof cfg === "string") {
      try { cfg = JSON.parse(cfg); } catch {}
    }
    if (!cfg || typeof cfg !== "object") {
      res.status(400).json({ error: "config object required" });
      return;
    }
    const existing = await loadConfigRaw();
    const merged = mergeSecrets(existing, cfg);
        if (merged?.modbus && Array.isArray(merged.modbus._nodes)) {
      merged.nodes = merged.modbus._nodes;
      delete merged.modbus._nodes;
    }
await saveConfigRaw(merged);
    res.json({ ok: true });
  });

  
  app.post("/api/shelly/scan", async (req, res) => {
    try {
      const timeoutMs = Number(req.body?.timeoutMs) || 2500;
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileP = promisify(execFile);

      let out = "";
      try {
        const r = await execFileP("avahi-browse", ["-rtp", "_shelly._tcp"], { timeout: timeoutMs });
        out = String(r.stdout || "");
      } catch {
        return res.json({ devices: [], warning: "avahi-browse not available" });
      }

      const devices = [];
      for (const line of out.split("\n")) {
        const parts = line.split(";");
        if (parts.length < 9) continue;
        const name = parts[3];
        const ip = parts[7];
        if (!ip || !name) continue;
        if (!String(name).toLowerCase().includes("shelly")) continue;
        if (devices.some((d) => d.ip === ip)) continue;
        devices.push({ name, ip, host: name });
      }

      res.json({ devices });
    } catch (e) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

app.post("/api/hue/link", async (req, res) => {
    try {
      const ip = String(req.body?.ip ?? "").trim();
      if (!ip) return res.status(400).json({ ok: false, error: "ip required" });

      const r = await fetch(`http://${ip}/api`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ devicetype: "HUEVHIH" }),
      });
      const text = await r.text();
      let j;
      try { j = JSON.parse(text); } catch { j = null; }

      const username = Array.isArray(j)
        ? j.map((e) => e?.success?.username).find(Boolean)
        : null;

      if (!username) {
        return res.status(200).json({
          ok: false,
          error: "No username returned. Press the link button on the Hue Bridge, then try again.",
          raw: j ?? text,
        });
      }

      const cfg = await loadConfigRaw();
      cfg.hue = cfg.hue ?? {};
      cfg.hue.ip = ip;
      cfg.hue.key = username;
      cfg.hue.enabled = cfg.hue.enabled ?? true;
      await saveConfigRaw(cfg);

      res.json({ ok: true, username });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/hue/groups", async (req, res) => {
    try {
      const cfg = await loadConfigRaw();
      const ip = cfg?.hue?.ip;
      const key = cfg?.hue?.key;
      if (!ip || !key) return res.status(400).json({ ok: false, error: "Hue ip/key not configured" });

      const r = await fetch(`http://${ip}/api/${key}/groups`, { method: "GET" });
      const groups = await r.json();

      const rooms = [];
      const zones = [];
      for (const [id, g] of Object.entries(groups ?? {})) {
        const type = g?.type;
        if (type === "Room") rooms.push({ id, name: g?.name ?? id });
        if (type === "Zone") zones.push({ id, name: g?.name ?? id });
      }

      res.json({ ok: true, rooms, zones });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.post("/api/hue/group", async (req, res) => {
    try {
      const kind = String(req.body?.kind ?? "").toLowerCase(); // rooms|zones
      const id = String(req.body?.id ?? "");
      const enabledFlag = !!req.body?.enabled;

      if (!["rooms", "zones"].includes(kind)) return res.status(400).json({ ok: false, error: "kind must be rooms|zones" });
      if (!id) return res.status(400).json({ ok: false, error: "id required" });

      const cfg = await loadConfigRaw();
      cfg.hue = cfg.hue ?? {};
      cfg.hue[kind] = cfg.hue[kind] ?? {};
      cfg.hue[kind][id] = enabledFlag;
      await saveConfigRaw(cfg);

      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

  app.get("/api/hue/lights", async (req, res) => {
    try {
      const cfg = await loadConfigRaw();
      const ip = cfg?.hue?.ip;
      const key = cfg?.hue?.key;
      if (!ip || !key) return res.status(400).json({ ok: false, error: "Hue ip/key not configured" });

      const r = await fetch(`http://${ip}/api/${key}/lights`, { method: "GET" });
      const lights = await r.json();

      const out = [];
      for (const [id, l] of Object.entries(lights ?? {})) {
        out.push({
          id,
          name: l?.name ?? id,
          type: l?.type ?? "",
          modelid: l?.modelid ?? "",
          hasCt: !!l?.state?.ct || !!l?.capabilities?.control?.ct,
          hasColor: !!l?.state?.hue || !!l?.state?.sat,
        });
      }

      res.json({ ok: true, lights: out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });




  
  // Hue v2: list sensor devices (one device can have multiple services)
  app.get("/api/hue/sensor_devices", async (req, res) => {
    try {
       const cfg = await loadConfigRaw();
      const ip = cfg?.hue?.ip;
      const key = cfg?.hue?.key;
      if (!ip || !key) return res.json({ ok: false, error: "missing hue.ip/key" });

      const r = await hueV2Request(ip, key, "/clip/v2/resource/device");
      const relevantRtypes = new Set([
        "zigbee_connectivity",
        "motion",
        "device_power",
        "light_level",
        "temperature",
        "button",
        "device_software_update"
      ]);

      const devices = (r?.data ?? [])
        .filter((d) => Array.isArray(d?.services) && d.services.some((s) => relevantRtypes.has(s?.rtype)))
        .map((d) => ({
          id: d.id,
          id_v1: d.id_v1,
          name: d?.metadata?.name ?? d?.product_data?.product_name ?? d.id,
          product_name: d?.product_data?.product_name ?? "",
          model_id: d?.product_data?.model_id ?? "",
          services: (d.services ?? [])
            .filter((s) => relevantRtypes.has(s?.rtype))
            .map((s) => ({ rid: s.rid, rtype: s.rtype })),
        }));

      return res.json({ ok: true, devices });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });

app.get("/api/hue/extras", async (req, res) => {
    try {
      const cfg = await loadConfigRaw();
      const ip = cfg?.hue?.ip;
      const key = cfg?.hue?.key;
      if (!ip || !key) return res.status(400).json({ ok: false, error: "Hue ip/key not configured" });

      const payload = await hueV2Request(ip, key, "/clip/v2/resource");
      const data = payload?.data ?? [];
      const allowed = new Set(["button","motion","temperature","light_level","device_power","zigbee_connectivity"]);
      const out = [];
      for (const r of data) {
        if (!allowed.has(r?.type)) continue;
        const name = r?.metadata?.name ?? r?.id ?? "";
        out.push({
          rid: r.id,
          type: r.type,
          name,
          ownerRid: r?.owner?.rid ?? null,
          ownerType: r?.owner?.rtype ?? null,
        });
      }
      res.json({ ok: true, extras: out });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message ?? String(e) });
    }
  });
app.post("/api/hue/poll_extras", async (req, res) => {
  try {
    const dataDir = process.env.DATA_DIR || "/app/data";
    const fs = await import("node:fs");
    fs.writeFileSync(`${dataDir}/hue_poll_extras.trigger`, String(Date.now()));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});



  app.post("/api/control", async (req, res) => {
    const action = String(req.body?.action ?? "").toLowerCase();
    try {
      if (action === "start") {
        await ensureConfig();
        startApp();
      } else if (action === "stop") {
        await stopApp();
      } else if (action === "restart") {
        await restartApp();
      } else if (action === "enable") {
        enabled = true;
        await saveState();
        startApp();
      } else if (action === "disable") {
        enabled = false;
        await saveState();
        await stopApp();
      } else {
        res.status(400).json({ error: "Unknown action" });
        return;
      }
      res.json({ ok: true, enabled, running: !!child, pid: child?.pid ?? null });
    } catch (e) {
      res.status(500).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/modbus/test", async (req, res) => {
    const body = req.body ?? {};
    const host = String(body.host ?? "").trim();
    const port = Number(body.port ?? 502);
    const unitId = Number(body.unitId ?? 1);
    const registerType = String(body.registerType ?? "holding").toLowerCase();
    const register = Number(body.register ?? 0);
    const count = Number(body.count ?? 1);
    const regBase = Number(body.regBase ?? 0);
    const timeoutMs = Number(body.timeoutMs ?? 3000);
    const dataType = body.dataType ?? "uint16";
    const wordOrder = body.wordOrder ?? "be";
    const index = body.index ?? 0;
    const scale = body.scale;
    const offset = body.offset;

    if (!host) {
      res.status(400).json({ error: "host required" });
      return;
    }
    if (!Number.isFinite(port) || port <= 0) {
      res.status(400).json({ error: "invalid port" });
      return;
    }
    if (!Number.isFinite(unitId) || unitId < 0 || unitId > 255) {
      res.status(400).json({ error: "invalid unitId" });
      return;
    }
    if (!Number.isFinite(register) || register < 0) {
      res.status(400).json({ error: "invalid register" });
      return;
    }
    if (!Number.isFinite(count) || count <= 0 || count > 125) {
      res.status(400).json({ error: "invalid count (1..125)" });
      return;
    }
    if (![0, 1].includes(regBase)) {
      res.status(400).json({ error: "invalid regBase (0 or 1)" });
      return;
    }
    if (!["holding", "input"].includes(registerType)) {
      res.status(400).json({ error: "registerType must be holding|input" });
      return;
    }

    const address = register - (regBase === 1 ? 1 : 0);

    const socket = new net.Socket();
    const client = new ModbusRTU.client.TCP(socket, unitId);

    let done = false;
    const finish = (status, payload) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch {}
      res.status(status).json(payload);
    };

    socket.setTimeout(timeoutMs);

    socket.on("timeout", () => finish(504, { error: "timeout" }));
    socket.on("error", (e) => finish(502, { error: e?.message ?? String(e) }));

    socket.connect({ host, port }, async () => {
      try {
        const resp =
          registerType === "input"
            ? await client.readInputRegisters(address, count)
            : await client.readHoldingRegisters(address, count);

        const values = resp?.response?._body?._valuesAsArray;
        if (!Array.isArray(values)) {
          finish(500, { error: "unexpected modbus response", raw: resp });
          return;
        }

        const decodedRaw = decodeFromRegisters(values, { dataType, wordOrder, index });
        const decoded = applyNumericTransform(decodedRaw, { scale, offset });

        finish(200, {
          ok: true,
          host,
          port,
          unitId,
          registerType,
          register,
          regBase,
          address,
          count,
          values,
          decodedRaw,
          decoded,
          decode: { dataType, wordOrder, index, scale, offset },
        });
      } catch (e) {
        const respBody = e?.response?._body ?? e?.response ?? null;
        const exc = respBody?._code ?? respBody?.exceptionCode ?? null;
        finish(200, {
          ok: false,
          error: e?.message ?? String(e),
          exceptionCode: exc,
          responseBody: respBody,
        });
      }
    });
  });

  app.use("/", express.static("/app/webui", { etag: false, maxAge: 0 }));


// Serve module assets (including webui fragments)
app.use("/modules", express.static(path.join(APP_DIR, "modules")));


  app.listen(UI_PORT, "0.0.0.0", () => {
    console.log(`[manager] UI listening on 0.0.0.0:${UI_PORT}`);
    console.log(`[manager] DATA_DIR=${DATA_DIR} CONFIG_PATH=${CONFIG_PATH}`);
  });

  if (enabled) startApp();
  else console.log("[manager] app disabled; not starting");
}

main().catch((e) => {
  console.error("[manager] fatal:", e);
  process.exit(1);
});