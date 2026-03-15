/**
 * /modules/mqtt/index.mjs
 *
 * MQTT module (subscribe + optional publish)
 *
 * Config:
 *  - config.mqtt.enabled: boolean
 *  - config.mqtt.brokers[]: { id, enabled, name, host, port, username, password, protocol }
 *  - config.mqtt.nodes[]: nodes/attributes, MQTT attributes use:
 *      source: { kind:"mqtt", brokerId, topic, jsonPath?, valueType?, qos?, retain?, writeTopic? }
 *
 * Phase 1:
 *  - reading only: subscribe + emitTelemetry
 * Phase 2:
 *  - writing: attribute.writable=true + optional source.writeTopic
 */
import mqtt from "mqtt";

const SECRET_MASK = "********";

function formatErr(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  try {
    const props = Object.getOwnPropertyNames(err);
    const obj = {};
    for (const p of props) obj[p] = err[p];
    return stableStringify(obj);
  } catch {
    return String(err);
  }
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

function asStr(v, dflt = "") {
  return (typeof v === "string" && v.trim() !== "") ? v : dflt;
}

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function topicMatches(sub, topic) {
  // MQTT wildcard matching: + (single), # (multi)
  if (sub === topic) return true;

  const subParts = String(sub ?? "").split("/");
  const tParts = String(topic ?? "").split("/");

  for (let i = 0, j = 0; i < subParts.length; i++, j++) {
    const s = subParts[i];

    if (s === "#") return true;
    if (j >= tParts.length) return false;

    if (s === "+") continue;
    if (s !== tParts[j]) return false;
  }

  return subParts[subParts.length - 1] === "#" || subParts.length === tParts.length;
}

function extractJsonPath(obj, path) {
  let cur = obj;
  for (const part of String(path ?? "").split(".")) {
    if (!part) continue;
    if (cur && typeof cur === "object" && part in cur) cur = cur[part];
    else throw new Error(`jsonPath not found: ${path}`);
  }
  return cur;
}

function castValue(v, valueType) {
  const t = String(valueType ?? "string").toLowerCase();
  if (t === "json") return v;
  if (t === "string") return String(v);

  if (t === "int" || t === "i32" || t === "int32") {
    if (typeof v === "boolean") return v ? 1 : 0;
    return Number.isFinite(Number(v)) ? parseInt(Number(v), 10) : null;
  }

  if (t === "float" || t === "f32" || t === "float32" || t === "number") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  if (t === "bool" || t === "boolean") {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    const s = String(v).trim().toLowerCase();
    return ["1", "true", "yes", "y", "on"].includes(s);
  }

  return String(v);
}

function getCfg(cfg) {
  const c = cfg?.mqtt ?? {};
  return {
    enabled: asBool(c.enabled ?? true),
    brokers: Array.isArray(c.brokers) ? c.brokers : [],
  };
}

function normalizeBrokers(cfg) {
  const { enabled, brokers } = getCfg(cfg);
  if (!enabled) return [];
  return (brokers ?? [])
    .map((b) => ({
      id: asStr(b.id, ""),
      enabled: b.enabled ?? true,
      name: asStr(b.name, b.id || "MQTT"),
      protocol: asStr(b.protocol, "mqtt"), // mqtt|mqtts|ws|wss
      host: asStr(b.host ?? b.ip, ""),
      port: num(b.port, null),
      username: asStr(b.username, ""),
      password: asStr(b.password, ""),
      clientId: asStr(b.clientId, ""),
      clean: b.clean ?? true,
      keepalive: num(b.keepalive, 30) ?? 30,
      rejectUnauthorized: b.rejectUnauthorized ?? true,
    }))
    .filter((b) => b.enabled && b.id && b.host);
}

function normalizeMqttNodes(cfg) {
  const nodes = Array.isArray(cfg?.mqtt?.nodes) ? cfg.mqtt.nodes : [];
  return nodes.map((n, i) => ({
    id: asStr(n.id, `node${i + 1}`),
    name: asStr(n.name, `Node ${i + 1}`),
    profileKey: asStr(n.profileKey, "CANodeProfileOnOffSwitch"),
    attributes: Array.isArray(n.attributes) ? n.attributes : [],
  }));
}

function isMqttAttr(a) {
  return String(a?.source?.kind ?? "").toLowerCase() === "mqtt";
}

function mkRef(broker, nodeId, attrId, a) {
  const src = a?.source ?? {};
  return {
    kind: "mqtt",
    brokerId: broker.id,
    host: broker.host,
    port: broker.port,
    protocol: broker.protocol,
    nodeId,
    attrId,
    topic: asStr(src.topic, ""),
    qos: num(src.qos, 0) ?? 0,
    jsonPath: asStr(src.jsonPath, ""),
    valueType: asStr(src.valueType, "string"),
    retain: asBool(src.retain ?? false),
    writeTopic: asStr(src.writeTopic, ""),
    writable: !!a.writable,
  };
}

export default {
  id: "mqtt",
  name: "MQTT",

  enabled(cfg) {
    const { enabled } = getCfg(cfg);
    return !!enabled;
  },

  async discover(cfg, rt) {
    const brokers = normalizeBrokers(cfg);
    const nodes = normalizeMqttNodes(cfg);

    const discoveredNodes = [];

    for (const n of nodes) {
      const attrs = [];
      const mqttAttrs = n.attributes.filter(isMqttAttr);
      if (!mqttAttrs.length) continue;

      const nodeKey = `mqtt|node|${n.id}`;

      for (const a of mqttAttrs) {
        const src = a?.source ?? {};
        const brokerId = asStr(src.brokerId, "");
        const topic = asStr(src.topic, "");

        const broker = brokers.find((b) => b.id === brokerId);
        if (!broker || !topic) continue;

        const name = asStr(a.name, topic);
        const attrKey = `${nodeKey}|attr|${a.id ?? name}|${brokerId}|${topic}`;

        const ref = mkRef(broker, n.id, asStr(a.id, name), a);

        attrs.push({
          attrKey,
          moduleId: "mqtt",
          name,
          attrTypeKey: asStr(a.attrTypeKey, "CAAttributeTypeOnOff"),
          unit: asStr(a.unit, ""),
          min: num(a.min, 0) ?? 0,
          max: num(a.max, 100) ?? 100,
          step: num(a.step, 1) ?? 1,
          writable: !!a.writable,
          deviceRef: ref,
        });
      }

      if (attrs.length) {
        discoveredNodes.push({
          nodeKey,
          moduleId: "mqtt",
          name: n.name,
          profileKey: n.profileKey,
          attributes: attrs,
        });
      }
    }

    return { discoveredNodes };
  },

  async start(cfg, rt) {
    const brokers = normalizeBrokers(cfg);

    this._clients = new Map(); // brokerId -> mqtt client
    this._subs = new Map(); // brokerId -> Map(subTopic -> [{attrId, ref}...])
    this._attrById = new Map(); // attributeId -> ref
    this._attrIndex = null;

    const ids = rt?.store?.ids;
    const bucket = ids?.modules?.mqtt ?? {};
    const attrs = bucket?.attributes ?? {};

    for (const [attrIdStr, ref] of Object.entries(attrs)) {
      const attrId = Number(attrIdStr);
      if (!Number.isFinite(attrId)) continue;
      const r = ref ?? {};
      if (String(r.kind).toLowerCase() !== "mqtt") continue;

      this._attrById.set(attrId, r);

      const brokerId = asStr(r.brokerId, "");
      const subTopic = asStr(r.topic, "");
      if (!brokerId || !subTopic) continue;

      if (!this._subs.has(brokerId)) this._subs.set(brokerId, new Map());
      const m = this._subs.get(brokerId);
      if (!m.has(subTopic)) m.set(subTopic, []);
      m.get(subTopic).push({ attrId, ref: r });
    }

    for (const b of brokers) {
      const subMap = this._subs.get(b.id);
      if (!subMap || subMap.size === 0) continue;

      const url = (() => {
        const proto = asStr(b.protocol, "mqtt");
        const port = Number.isFinite(Number(b.port))
          ? Number(b.port)
          : (proto === "mqtts" ? 8883 : 1883);
        return `${proto}://${b.host}:${port}`;
      })();

      const opts = {
        clientId: b.clientId || `vhih-${rt?.store?.ids?.uid ?? "mqtt"}-${b.id}-${Math.random().toString(16).slice(2)}`,
        username: b.username || undefined,
        password: b.password || undefined,
        clean: b.clean ?? true,
        keepalive: b.keepalive ?? 30,
        reconnectPeriod: 2000,
        connectTimeout: 10_000,
        rejectUnauthorized: b.rejectUnauthorized ?? true,
      };

      const client = mqtt.connect(url, opts);
      this._clients.set(b.id, client);

      client.on("connect", () => {
        rt.log?.(`[mqtt] connected broker=${b.id} ${url}`);
        for (const [topic, list] of subMap.entries()) {
          const qos = Math.max(...list.map((x) => num(x.ref?.qos, 0) ?? 0));
          client.subscribe(topic, { qos }, (err) => {
            if (err) rt.warn?.(`[mqtt] subscribe failed broker=${b.id} topic=${topic}: ${err.message ?? err}`);
            else rt.debug?.(`[mqtt] subscribed broker=${b.id} topic=${topic} qos=${qos}`);
          });
        }
      });

      client.on("reconnect", () => rt.debug?.(`[mqtt] reconnect broker=${b.id}`));
      client.on("close", () => rt.warn?.(`[mqtt] closed broker=${b.id} url=${url}`));
      client.on("error", (err) => rt.warn?.(`[mqtt] error broker=${b.id}: ${formatErr(err)}`));

      client.on("message", (topic, payload) => {
        const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? "");
        const subMap2 = this._subs.get(b.id);
        if (!subMap2) return;

        for (const [sub, list] of subMap2.entries()) {
          if (!topicMatches(sub, topic)) continue;

          for (const { attrId, ref } of list) {
            try {
              const v = decodePayload(p, ref);
              rt.emitTelemetry({ attributeId: attrId, value: v });
            } catch (e) {
              rt.warn?.(`[mqtt] decode failed broker=${b.id} topic=${topic} attrId=${attrId}: ${e?.message ?? e}`);
            }
          }
        }
      });
    }
  },

  async stop() {
    for (const c of (this._clients?.values?.() ?? [])) {
      try { c.end(true); } catch {}
    }
    this._clients = null;
    this._subs = null;
    this._attrById = null;
  },

  async handleCommand(cmd, rt) {
    const attributeId = Number(cmd?.attributeId);
    if (!Number.isFinite(attributeId)) return;

    const ref = this._attrById?.get(attributeId);
    if (!ref) {
      rt.warn?.(`[mqtt] command for unknown attributeId=${attributeId}`);
      return;
    }

    if (!ref.writable) {
      rt.warn?.(`[mqtt] write rejected (not writable) attributeId=${attributeId}`);
      return;
    }

    const brokerId = asStr(ref.brokerId, "");
    const client = this._clients?.get(brokerId);
    if (!client || !client.connected) {
      rt.warn?.(`[mqtt] broker not connected brokerId=${brokerId}`);
      return;
    }

    const topic = asStr(ref.writeTopic, "") || asStr(ref.topic, "");
    if (!topic || topic.includes("+") || topic.includes("#")) {
      rt.warn?.(`[mqtt] invalid publish topic for attributeId=${attributeId}`);
      return;
    }

    const qos = num(ref.qos, 0) ?? 0;
    const retain = asBool(ref.retain ?? false);

    const payload = encodePayload(cmd?.value, ref);
    client.publish(topic, payload, { qos, retain }, (err) => {
      if (err) rt.warn?.(`[mqtt] publish failed attributeId=${attributeId}: ${err?.message ?? err}`);
    });
  },
};

function decodePayload(buf, ref) {
  const jsonPath = asStr(ref?.jsonPath, "");
  const valueType = asStr(ref?.valueType, "string");

  if (valueType === "json" || jsonPath) {
    const obj = JSON.parse(buf.toString("utf8"));
    const picked = jsonPath ? extractJsonPath(obj, jsonPath) : obj;
    return castValue(picked, valueType);
  }

  const s = buf.toString("utf8").trim();
  return castValue(s, valueType);
}

function encodePayload(value, ref) {
  const valueType = asStr(ref?.valueType, "string");
  if (valueType === "json") return Buffer.from(JSON.stringify(value), "utf8");
  return Buffer.from(String(value), "utf8");
}
