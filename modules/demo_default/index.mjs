/**
 * Demo Default Module Template (vHiH)
 *
 * Purpose:
 * - Shows the minimal contract a module must implement.
 * - Demonstrates both directions:
 *   (1) Device -> Core (telemetry): runtime.emitTelemetry({ attributeId, value })
 *   (2) Homee -> Device (command): handleCommand({ attributeId, value, data }, runtime)
 *
 * IMPORTANT:
 * - ids.json is loaded once by the Core at startup (in-memory). Modules must NOT read files directly.
 * - Modules should build their own fast lookup index at start() from runtime.store.ids.
 * - Core routing is based on attributeId -> (moduleId, data). `data` is module-defined JSON.
 *
 * Expected ids.json (slim) shape:
 * {
 *   "modules": {
 *     "demo_default": {
 *       "attributes": {
 *         "123": { ...data... }
 *       }
 *     }
 *   }
 * }
 */

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Stable stringify (sorted keys) to build consistent map keys.
 * Keep identical implementation across modules if possible.
 */
function stableStringify(value) {
  const seen = new WeakSet();

  const sortObject = (obj) => {
    if (obj === null || typeof obj !== "object") return obj;
    if (seen.has(obj)) return obj;
    seen.add(obj);

    if (Array.isArray(obj)) return obj.map(sortObject);

    const out = {};
    for (const k of Object.keys(obj).sort()) out[k] = sortObject(obj[k]);
    return out;
  };

  return JSON.stringify(sortObject(value));
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function getCfg(cfg) {
  const c = cfg?.demo_default ?? {};
  return {
    enabled: asBool(c.enabled ?? true),
    pollSec: Number(c.pollSec ?? 10),
  };
}

/**
 * Build an in-memory index: stableStringify(data) -> attributeId
 *
 * Why:
 * - SSE / polling gives you a device event, you translate it into `data` (the same JSON you stored in ids.json),
 * - then you can resolve attributeId in O(1) and emit telemetry.
 */
function buildIndex(ids) {
  const attrs = ids?.modules?.demo_default?.attributes ?? {};
  const map = new Map();
  for (const [attrId, data] of Object.entries(attrs)) {
    map.set(stableStringify(data), Number(attrId));
  }
  return map;
}

/**
 * Device discovery: return discoveredNodes[] for node_store.reconcile().
 *
 * In this template we create:
 * - 1 node with 2 attributes:
 *   - On/Off (type 1)
 *   - Dimming (type 2)
 *
 * Data rules:
 * - attrKey/nodeKey must be stable (used to keep IDs stable across restarts).
 * - `data` is written to ids.json under modules.demo_default.attributes[attrId]
 * - `data` MUST be stable and sufficient for the module to resolve events -> attributeId.
 */
function demoNodeDef() {
  const deviceId = "demo-1";
  const nodeKey = `demo_default|device|${deviceId}`;

  return {
    nodeKey,
    moduleId: "demo_default",
    name: "Demo Device 1",
    profileKey: "CANodeProfileDimmableLight", // example profile
    attributes: [
      {
        attrKey: `${nodeKey}|on`,
        name: "On/Off",
        attrTypeKey: "CAAttributeTypeOnOff", // type 1
        min: 0,
        max: 1,
        step: 1,
        unit: "",
        writable: true,
        currentValue: 0,
        targetValue: 0,
        lastValue: 0,

        // module-defined data (stored in ids.json)
        data: { kind: "demo", deviceId, action: "on" },
      },
      {
        attrKey: `${nodeKey}|dim`,
        name: "Brightness",
        attrTypeKey: "CAAttributeTypeDimmingLevel", // type 2
        min: 0,
        max: 100,
        step: 1,
        unit: "%25",
        writable: true,
        currentValue: 50,
        targetValue: 50,
        lastValue: 50,

        // module-defined data (stored in ids.json)
        data: { kind: "demo", deviceId, action: "bri" },
      },
    ],
  };
}

export default {
  id: "demo_default",
  name: "Demo Default",

  enabled(cfg) {
    return getCfg(cfg).enabled;
  },

  /**
   * Called by Core during discovery.
   * Must return: { discoveredNodes: NodeDef[] }
   */
  async discover(cfg, runtime) {
    if (!this.enabled(cfg)) return { discoveredNodes: [] };
    return { discoveredNodes: [demoNodeDef()] };
  },

  /**
   * Called by Core after discovery + reconcile.
   * Good place to:
   * - build your index from runtime.store.ids
   * - start polling / SSE listeners
   */
  async start(cfg, runtime) {
    if (!this.enabled(cfg)) return;

    this._rt = runtime;
    this._cfg = getCfg(cfg);

    // Build (or rebuild) index from in-memory ids.
    this._index = buildIndex(runtime.store.ids);

    // Example polling loop (replace with real device polling / SSE hook).
    const tick = async () => {
      // Example: toggle a synthetic sensor value (brightness bounces 0..100)
      const t = Date.now();
      const value = Math.floor((Math.sin(t / 5000) + 1) * 50);

      const data = { kind: "demo", deviceId: "demo-1", action: "bri" };
      const aid = this._index.get(stableStringify(data));

      if (aid) {
        runtime.emitTelemetry({
          attributeId: aid,
          value,
          ts: nowSec(),
          source: "demo_poll",
        });
      }
    };

    await tick();
    this._timer = setInterval(tick, Math.max(2, this._cfg.pollSec) * 1000);
  },

  async stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._index = null;
    this._rt = null;
    this._cfg = null;
  },

  /**
   * Homee -> Device direction.
   *
   * Core calls this on PUT:attributes, routing by attributeId -> moduleId + data.
   * payload:
   *   - attributeId: number
   *   - value: target_value
   *   - data: module-defined JSON that was stored in ids.json for that attributeId
   */
  async handleCommand(payload, runtime) {
    const { attributeId, value, data } = payload ?? {};
    if (!data) return;

    // Example: write command to device (replace with HTTP/MQTT/SDK call).
    // data.action tells you what to do.
    if (data.action === "on") {
      const on = Number(value) === 1;

      // pretend device accepted it, then confirm back into Core state
      runtime.emitTelemetry({
        attributeId: Number(attributeId),
        value: on ? 1 : 0,
        ts: nowSec(),
        source: "demo_cmd",
      });
      return;
    }

    if (data.action === "bri") {
      const bri = Math.max(0, Math.min(100, Math.round(Number(value))));

      runtime.emitTelemetry({
        attributeId: Number(attributeId),
        value: bri,
        ts: nowSec(),
        source: "demo_cmd",
      });
      return;
    }
  },
};
