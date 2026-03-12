/**
 * /modules/velux/index.mjs
 *
 * Adapted to the slim ids.json structure:
 * - Core calls discover() at startup -> returns discoveredNodes (nodeKey + attrKey required).
 * - Core persists per-module attribute routing data in ids.json under ids.modules.velux.attributes[attrId] = <data>.
 * - Module builds its own in-memory index at start() from runtime.store.ids (already loaded once at boot).
 * - Telemetry direction (Velux -> Core): runtime.emitTelemetry({ attributeId, value })
 * - Command direction (Core -> Velux): handleCommand({ attributeId, value, deviceRef }, runtime)
 *
 * Notes:
 * - deviceRef received from Core is the stored per-module data (WITHOUT module field).
 * - We use stableStringify(data) as the lookup key (same ordering rules as Core).
 */

import Velux from "./velux.mjs";

function getDataDir() {
  return process.env.DATA_DIR;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clampInt(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(x)));


function extractModulesFromHomesdata(homesdata) {
  // Expected shape: { body: { homes: [ { modules: [...] } ] } }
  const homes = homesdata?.body?.homes;
  if (Array.isArray(homes) && homes.length) {
    const mods = homes[0]?.modules;
    if (Array.isArray(mods)) return mods;
  }
  // Fallbacks seen in some responses
  if (Array.isArray(homesdata?.homes) && homesdata.homes.length) {
    const mods = homesdata.homes[0]?.modules;
    if (Array.isArray(mods)) return mods;
  }
  return [];
}

function extractStatusById(status) {
  // Build Map<moduleId, statusObject>
  const map = new Map();

  const candidates = [
    status?.modules,
    status?.body?.modules,
    status?.body?.home?.modules,
    status?.body?.homes?.[0]?.modules,
    status?.body?.home?.modules_status,
    status?.home?.modules,
  ];

  for (const arr of candidates) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      const id = m?.id ?? m?.module_id ?? m?.device_id;
      if (!id) continue;
      map.set(String(id), m);
    }
    if (map.size) return map;
  }

  // Some APIs return a dict keyed by id
  const dict = status?.body?.home?.modules_by_id ?? status?.modules_by_id ?? null;
  if (dict && typeof dict === "object") {
    for (const [k, v] of Object.entries(dict)) map.set(String(k), v);
  }

  return map;
}

}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function getCfg(cfg) {
  const v = cfg?.velux ?? {};
  const email = v.email ?? cfg?.velux_name ?? "";
  const password = v.password ?? cfg?.velux_pw ?? "";
  const enabled =
    asBool(v.enabled) ||
    (typeof cfg?.velux_name === "string" &&
      cfg.velux_name.length > 0 &&
      typeof cfg?.velux_pw === "string" &&
      cfg.velux_pw.length > 0);
  const pollSec = Number(v.pollSec ?? 30);
  return { enabled, email, password, pollSec: Number.isFinite(pollSec) ? pollSec : 30 };
}

/** Stable stringify with sorted keys (matches Core behavior). */
function stableStringify(value) {
  const seen = new WeakSet();

  const norm = (v) => {
    if (v === null || v === undefined) return v;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map(norm);

    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = norm(v[k]);
    return out;
  };

  return JSON.stringify(norm(value));
}

function mkNodeKey(devId) {
  return `velux|nxo|${devId}`;
}

function mkRef(devId, action) {
  return { kind: "nxo", id: String(devId), action: String(action) };
}

function extractModulesFromHomesdata(hd) {
  // Expected: { body: { homes: [ { modules: [...] } ] } }
  const homes = hd?.body?.homes;
  if (Array.isArray(homes) && homes.length) {
    const mods = homes[0]?.modules;
    return Array.isArray(mods) ? mods : [];
  }
  return [];
}

function extractStatusById(status) {
  // Try common paths: status.body.home.modules OR status.body.modules OR status.modules
  const mods =
    (Array.isArray(status?.body?.home?.modules) && status.body.home.modules) ||
    (Array.isArray(status?.body?.modules) && status.body.modules) ||
    (Array.isArray(status?.modules) && status.modules) ||
    [];
  const m = new Map();
  for (const x of mods) {
    const id = x?.id ?? x?.module_id ?? x?.device_id;
    if (id) m.set(String(id), x);
  }
  return m;
}

function extractVeluxModules(status) {
  const out = [];
  const pushArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const x of arr) if (x && typeof x === "object") out.push(x);
  };

  pushArr(status?.modules);
  pushArr(status?.body?.modules);
  pushArr(status?.body?.home?.modules);
  pushArr(status?.body?.homes?.[0]?.modules);
  pushArr(status?.body?.homesdata?.homes?.[0]?.modules);

  // Some responses nest deeper:
  pushArr(status?.body?.home?.rooms?.flatMap?.((r) => r?.modules ?? []));

  // Deduplicate by id if present
  const seen = new Set();
  return out.filter((m) => {
    const id = m?.id ?? m?.module_id ?? m?.device_id;
    const key = id != null ? String(id) : JSON.stringify(m).slice(0, 64);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isVeluxNxoModule(m) {
  // Be permissive: accept NXO by type OR by presence of position fields.
  const t = String(m?.type ?? m?.module_type ?? "").toUpperCase();
  if (t === "NXO") return true;
  if (m?.current_position != null) return true;
  if (m?.position != null) return true;
  if (m?.states?.current_position != null) return true;
  return false;
}

function readCurrentPosition(m) {
  // Prefer known fields.
  const v = (m?.current_position ?? m?.position ?? m?.states?.current_position ?? m?.states?.position);
  return clampInt(v, 0, 100);
}

function buildIndexFromIds(runtime) {
  const bucket = runtime?.store?.ids?.modules?.velux ?? null;
  const attrs = bucket?.attributes ?? {};
  const m = new Map();
  for (const [attrIdStr, data] of Object.entries(attrs)) {
    const attrId = Number(attrIdStr);
    if (!Number.isFinite(attrId)) continue;
    if (!data || typeof data !== "object") continue;
    m.set(stableStringify(data), attrId);
  }
  return m;
}

export default {
  id: "velux",
  name: "Velux",

  enabled(cfg) {
    const v = getCfg(cfg);
    return v.enabled && !!v.email && !!v.password;
  },

  async discover(cfg) {
    const v = getCfg(cfg);
    if (!this.enabled(cfg)) return { discoveredNodes: [] };

    this._client = this._client ?? new Velux(v.email, v.password, { dataDir: process.env.DATA_DIR });

    // Load tokenfile and auth before API calls.
    await this._client._loadTokensFromFile?.();
    await this._client.ensureAuth();

    // Homesdata contains the device list with proper names and types.
    const homesdata = await this._client.veluxHomeData();
    const homeModules = extractModulesFromHomesdata(homesdata);

    // Status contains current positions.
    const status = await this._client.veluxHomeStatus();
    const statusById = extractStatusById(status);

    const discoveredNodes = [];

    for (const mod of homeModules) {
      if (mod?.type !== "NXO") continue;

      const devId = String(mod.id);
      const nodeKey = mkNodeKey(devId);

      const st = statusById.get(devId) ?? {};
      const veluxPosRaw =
        st?.current_position ??
        st?.position ??
        st?.states?.current_position ??
        st?.states?.position ??
        null;

      const veluxPos = clampInt(veluxPosRaw, 0, 100);
      const pos = 100 - veluxPos; // Velux: 100=open -> homee: 0

      discoveredNodes.push({
        nodeKey,
        moduleId: "velux",
        name: mod?.name ?? "VeluxDevice",
        profileKey: "CANodeProfileElectricMotorMeteringSwitch",
        attributes: [
          {
            attrKey: `${nodeKey}|pos`,
            moduleId: "velux",
            name: "Position",
            attrTypeKey: "CAAttributeTypePosition",
            unit: "%25",
            min: 0,
            max: 100,
            step: 1,
            writable: true,
            currentValue: pos,
            targetValue: pos,
            lastValue: pos,
            deviceRef: mkRef(devId, "pos"),
          },
          {
            attrKey: `${nodeKey}|updown`,
            moduleId: "velux",
            name: "UpDown",
            attrTypeKey: "CAAttributeTypeUpDown",
            unit: "",
            min: 0,
            max: 2,
            step: 1,
            writable: true,
            currentValue: 0,
            targetValue: 0,
            lastValue: 0,
            deviceRef: mkRef(devId, "updown"),
          },
        ],
      });
    }

    return { discoveredNodes };
  },

  async start(cfg, runtime) {
    const v = getCfg(cfg);
    if (!this.enabled(cfg)) return;

    this._runtime = runtime;
    this._index = buildIndexFromIds(runtime);

    this._client = this._client ?? new Velux(v.email, v.password, { dataDir: process.env.DATA_DIR });
    await this._client.start({ pollMs: v.pollSec * 1000 });

    const pollOnce = async () => {
      try {
        const status = await this._client.veluxHomeStatus();
        console.log(status);
        const modules = extractVeluxModules(status);

        for (const m of modules) {
          if (!isVeluxNxoModule(m)) continue;
          const devId = String(m.id ?? m.module_id ?? m.device_id);

          const veluxPos = readCurrentPosition(m);
          const pos = 100 - veluxPos;

          const aid = this._index.get(stableStringify(mkRef(devId, "pos")));
          if (aid) runtime.emitTelemetry({ attributeId: aid, value: pos });
        }
      } catch (e) {
        runtime?.debug?.("[velux] poll failed:", e?.message ?? e);
      }
    };

    await pollOnce();
    this._pollTimer = setInterval(pollOnce, Math.max(5, v.pollSec) * 1000);
  },

  async stop() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
    this._client = null;
    this._runtime = null;
    this._index = null;
  },

  async handleCommand(payload, runtime) {
    const ref = payload?.deviceRef; // stored per-module ref (no module field)
    if (!ref || ref.kind !== "nxo") return;
    if (!this._client) return;

    // Keep index fresh if ids changed (e.g. after new discover).
    if (!this._index) this._index = buildIndexFromIds(runtime);

    if (ref.action === "pos") {
      const targetHomee = clampInt(payload.value, 0, 100);
      const targetVelux = 100 - targetHomee;

      const resp = await this._client.setState(ref.id, targetVelux);
      if (resp?.error) throw new Error(resp.error?.message ?? "velux setState failed");

      // Positive feedback -> confirm to Core/homee
      const aid = this._index.get(stableStringify(mkRef(ref.id, "pos")));
      if (aid) runtime.emitTelemetry({ attributeId: aid, value: targetHomee });
      return;
    }

    if (ref.action === "updown") {
      const v = clampInt(payload.value, 0, 2);

      const posAid = this._index.get(stableStringify(mkRef(ref.id, "pos")));

      // Homee semantics:
      // 0 = open  -> homee pos 0 -> velux 100
      // 1 = close -> homee pos 100 -> velux 0
      // 2 = stop  -> send current value as target
      if (v === 0) {
        const resp = await this._client.setState(ref.id, 100);
        if (resp?.error) throw new Error(resp.error?.message ?? "velux setState failed");
        if (posAid) runtime.emitTelemetry({ attributeId: posAid, value: 0 });
      } else if (v === 1) {
        const resp = await this._client.setState(ref.id, 0);
        if (resp?.error) throw new Error(resp.error?.message ?? "velux setState failed");
        if (posAid) runtime.emitTelemetry({ attributeId: posAid, value: 100 });
      } else {
        const curHomee = posAid ? runtime.store?.getAttributeCurrentValue?.(posAid) : null;
        const curHomeeInt = clampInt(curHomee, 0, 100);
        const curVelux = 100 - curHomeeInt;
        const resp = await this._client.setState(ref.id, curVelux);
        if (resp?.error) throw new Error(resp.error?.message ?? "velux setState failed");
      }
    }
  },
};
