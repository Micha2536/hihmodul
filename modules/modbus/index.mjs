/**
 * /modules/modbus/index.mjs
 *
 * Modbus TCP module (jsmodbus)
 *
 * New mode (decoupled):
 *  - config.modbus.endpoints[]: ip/port/unitId + blocks(type/start/count/interval/base)
 *  - config.nodes[]: nodes/attributes, modbus attributes use:
 *      source: { kind:"modbus", endpointId, blockId, register }
 *
 * Legacy mode (backwards compatible):
 *  - config.modbus.devices[] with nodes/attributes under each device
 */
import Modbus from "./modbus.mjs";

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

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function asStr(v, dflt = "") {
  return (typeof v === "string" && v.trim() !== "") ? v : dflt;
}

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function getCfg(cfg) {
  const c = cfg?.modbus ?? {};
  return {
    enabled: c.enabled ?? true,
    endpoints: Array.isArray(c.endpoints) ? c.endpoints : null,
    devices: Array.isArray(c.devices) ? c.devices : (Array.isArray(cfg?.modbus) ? cfg.modbus : []),
  };
}

function normalizeEndpoints(cfg) {
  const { enabled, endpoints } = getCfg(cfg);
  if (!enabled || !Array.isArray(endpoints)) return [];
  return endpoints
    .map((e) => ({
      id: asStr(e.id, ""),
      enabled: e.enabled ?? true,
      name: asStr(e.name, e.id || "Modbus"),
      ip: asStr(e.ip ?? e.host, ""),
      port: num(e.port, 502) ?? 502,
      unitId: num(e.unitId ?? e.deviceId, 1) ?? 1,
      blocks: Array.isArray(e.blocks) ? e.blocks : [],
    }))
    .filter((e) => e.enabled && e.id && e.ip);
}

function normalizeBlocks(endpoint) {
  const blocks = Array.isArray(endpoint?.blocks) ? endpoint.blocks : [];
  return blocks
    .map((b) => ({
      id: asStr(b.id, ""),
      enabled: b.enabled ?? true,
      type: asStr(b.type ?? b.registerType, "holding").toLowerCase(),
      start: num(b.start ?? b.register, 0) ?? 0,
      count: num(b.count ?? b.quantity, 1) ?? 1,
      interval: num(b.interval, 2000) ?? 2000,
      base: num(b.base ?? b.regBase, 0) ?? 0,
    }))
    .filter((b) => b.enabled && b.id && b.count > 0 && b.interval > 0);
}

function normalizeGlobalNodes(cfg) {
  const nodes = Array.isArray(cfg?.nodes) ? cfg.nodes : [];
  return nodes.map((n, i) => ({
    id: asStr(n.id, `node${i + 1}`),
    name: asStr(n.name, `Node ${i + 1}`),
    profileKey: asStr(n.profileKey, "CANodeProfileOnOffSwitch"),
    attributes: Array.isArray(n.attributes) ? n.attributes : [],
  }));
}

function isModbusAttr(a) {
  return String(a?.source?.kind ?? "").toLowerCase() === "modbus";
}

function mkDataRef(endpoint, block, nodeId, attrId, attr) {
  const register = num(attr?.source?.register, null);
  const index = Number.isFinite(register)
    ? (register - (block.base === 1 ? 1 : 0)) - block.start
    : null;

  return {
    kind: "modbus",
    endpointId: endpoint.id,
    blockId: block.id,
    ip: endpoint.ip,
    port: endpoint.port,
    unitId: endpoint.unitId,
    nodeId,
    attrId,
    registerType: block.type,
    regBase: block.base,
    register,
    index,
    dataType: asStr(attr?.dataType, "uint16"),
    wordOrder: asStr(attr?.wordOrder, "be"),
    scale: num(attr?.scale, 1) ?? 1,
    offset: num(attr?.offset, 0) ?? 0,
  };
}

/* ---------- Legacy helpers ---------- */
function normalizeLegacyDevices(cfg) {
  const { enabled, devices } = getCfg(cfg);
  if (!enabled) return [];
  return (devices ?? [])
    .map((d) => ({
      enabled: d.enabled ?? true,
      name: d.name ?? d.id ?? d.ip ?? "Modbus",
      ip: d.ip ?? d.host,
      port: num(d.port, 502) ?? 502,
      unitId: num(d.unitId ?? d.deviceId, 1) ?? 1,
      nodes: Array.isArray(d.nodes) ? d.nodes : [],
      polls: Array.isArray(d.polls) ? d.polls : [],
    }))
    .filter((d) => d.enabled && d.ip);
}

function iterLegacyNodeDefs(device) {
  const out = [];
  const nodes = Array.isArray(device.nodes) ? device.nodes : [];
  for (const n of nodes) {
    out.push({
      device,
      node: {
        name: n.name ?? "Modbus Node",
        profileKey: n.profileKey ?? n.profile ?? "CANodeProfileOnOffSwitch",
      },
      attributes: Array.isArray(n.attributes) ? n.attributes : [],
    });
  }
  if (out.length === 0 && Array.isArray(device.polls) && device.polls.length) {
    out.push({
      device,
      node: { name: device.name ?? "Modbus", profileKey: "CANodeProfileOnOffSwitch" },
      attributes: device.polls,
    });
  }
  return out;
}

function mkLegacyRef(device, nodeName, attr) {
  return {
    kind: "modbus",
    ip: device.ip,
    port: device.port,
    unitId: device.unitId,
    node: nodeName,
    registerType: asStr(attr.registerType, "holding"),
    register: num(attr.register, 0) ?? 0,
    regBase: num(attr.regBase, 0) ?? 0,
    count: num(attr.count ?? attr.quantity, 1) ?? 1,
    index: num(attr.index, 0) ?? 0,
    dataType: asStr(attr.dataType, "uint16"),
    wordOrder: asStr(attr.wordOrder, "be"),
    scale: num(attr.scale, 1) ?? 1,
    offset: num(attr.offset, 0) ?? 0,
  };
}

export default {
  id: "modbus",
  name: "Modbus",

  enabled(cfg) {
    const { enabled } = getCfg(cfg);
    if (!enabled) return false;

    // new mode: must have endpoints and at least one modbus attr
    const eps = normalizeEndpoints(cfg);
    const nodes = normalizeGlobalNodes(cfg);
    const hasAttrs = nodes.some((n) => n.attributes.some(isModbusAttr));
    if (eps.length && hasAttrs) return true;

    // legacy fallback
    return normalizeLegacyDevices(cfg).length > 0;
  },

  async discover(cfg, rt) {
    const endpoints = normalizeEndpoints(cfg);
    const nodes = normalizeGlobalNodes(cfg);

    const discoveredNodes = [];

    if (endpoints.length) {
      for (const n of nodes) {
        const mbAttrs = n.attributes.filter(isModbusAttr);
        if (!mbAttrs.length) continue;

        const nodeKey = `modbus|node|${n.id}`;
        const attrs = [];

        for (const a of mbAttrs) {
          const src = a.source ?? {};
          const endpointId = asStr(src.endpointId, "");
          const blockId = asStr(src.blockId, "");
          const reg = num(src.register, null);

          const ep = endpoints.find((x) => x.id === endpointId);
          const blk = ep ? normalizeBlocks(ep).find((b) => b.id === blockId) : null;
          if (!ep || !blk || !Number.isFinite(reg)) continue;

          const name = asStr(a.name, `Reg ${reg}`);
          const attrKey = `${nodeKey}|attr|${a.id ?? name}|${endpointId}|${blockId}|${reg}`;

          const ref = mkDataRef(ep, blk, n.id, asStr(a.id, name), a);

          attrs.push({
            attrKey,
            moduleId: "modbus",
            name,
            attrTypeKey: asStr(a.attrTypeKey, "CAAttributeTypeOnOff"),
            unit: asStr(a.unit, ""),
            min: num(a.min, 0) ?? 0,
            max: num(a.max, 100) ?? 100,
            step: num(a.step, 1) ?? 1,
            writable: !!a.writable && blk.type === "holding" && a.writable === true,
            deviceRef: ref,
          });
        }

        if (attrs.length) {
          discoveredNodes.push({
            nodeKey,
            moduleId: "modbus",
            name: n.name,
            profileKey: n.profileKey,
            attributes: attrs,
          });
        }
      }

      return { discoveredNodes };
    }

    // legacy discovery
    const devices = normalizeLegacyDevices(cfg);
    for (const dev of devices) {
      for (const nd of iterLegacyNodeDefs(dev)) {
        const nodeName = nd.node.name;
        const nodeKey = `modbus|${dev.ip}:${dev.port}:${dev.unitId}|node|${nodeName}`;
        const attrs = [];

        for (const a of nd.attributes) {
          const attrName = a.name ?? a.label ?? `Reg ${a.register}`;
          const attrKey = `${nodeKey}|attr|${attrName}|${a.registerType ?? "holding"}|${a.register}`;

          const registerType = asStr(a.registerType, "holding").toLowerCase();
          const writable = !!a.writable && registerType === "holding";

          const ref = mkLegacyRef(dev, nodeName, a);

          attrs.push({
            attrKey,
            moduleId: "modbus",
            name: attrName,
            attrTypeKey: asStr(a.attrTypeKey, "CAAttributeTypeOnOff"),
            unit: asStr(a.unit, ""),
            min: num(a.min, 0) ?? 0,
            max: num(a.max, 100) ?? 100,
            step: num(a.step, 1) ?? 1,
            writable,
            deviceRef: ref,
          });
        }

        discoveredNodes.push({
          nodeKey,
          moduleId: "modbus",
          name: nodeName,
          profileKey: nd.node.profileKey,
          attributes: attrs,
        });
      }
    }

    return { discoveredNodes };
  },

  async start(cfg, rt) {
    // Build attrId index from persisted ids
    const idx = new Map();
    const idsAttrs = rt?.store?.ids?.modules?.modbus?.attributes ?? {};
    for (const [attrId, data] of Object.entries(idsAttrs)) idx.set(stableStringify(data), Number(attrId));
    this._attrIndex = idx;

    this._clients = [];

    const endpoints = normalizeEndpoints(cfg);
    const nodes = normalizeGlobalNodes(cfg);

    if (endpoints.length) {
      // Prepare map endpointId|blockId -> list of attrs
      const attrsByBlock = new Map();
      for (const n of nodes) {
        for (const a of n.attributes.filter(isModbusAttr)) {
          const src = a.source ?? {};
          const endpointId = asStr(src.endpointId, "");
          const blockId = asStr(src.blockId, "");
          const reg = num(src.register, null);
          if (!endpointId || !blockId || !Number.isFinite(reg)) continue;
          const key = `${endpointId}|${blockId}`;
          if (!attrsByBlock.has(key)) attrsByBlock.set(key, []);
          attrsByBlock.get(key).push({ node: n, attr: a, reg });
        }
      }

      for (const ep of endpoints) {
        const client = new Modbus(ep.ip, ep.port, ep.unitId);
        this._clients.push(client);

        client.on("data", (m) => {
          const ref = m?.VHIH?.dataRef;
          if (!ref) return;
          const aid = this._attrIndex.get(stableStringify(ref));
          if (!aid) return;
          rt.emitTelemetry({ attributeId: aid, value: m.Value ?? m.value });
        });

        client.on("error", (e) => {
          console.warn("[modbus] error", e?.message ?? e);
        });

        const polls = [];
        for (const blk of normalizeBlocks(ep)) {
          const key = `${ep.id}|${blk.id}`;
          const mapped = attrsByBlock.get(key) ?? [];
          if (!mapped.length) continue;

          const fanout = [];
          for (const { node, attr, reg } of mapped) {
            const index = (reg - (blk.base === 1 ? 1 : 0)) - blk.start;
            if (index < 0 || index >= blk.count) continue;

            const ref = mkDataRef(ep, blk, node.id, asStr(attr.id, attr.name ?? ""), attr);

            fanout.push({
              name: asStr(attr.name, `Reg ${reg}`),
              register: reg,
              index,
              dataType: asStr(attr.dataType, "uint16"),
              wordOrder: asStr(attr.wordOrder, "be"),
              scale: num(attr.scale, 1) ?? 1,
              offset: num(attr.offset, 0) ?? 0,
              registerId: stableStringify(ref),
              vhih: { dataRef: ref },
            });
          }

          if (!fanout.length) continue;

          polls.push({
            registerType: blk.type,
            register: blk.start,
            regBase: blk.base,
            count: blk.count,
            interval: blk.interval,
            dataType: "uint16",
            wordOrder: "be",
            fanout,
            registerId: `block:${ep.id}|${blk.id}`,
            vhih: { dataRef: { kind: "modbus", endpointId: ep.id, blockId: blk.id } },
          });
        }

        client.start(polls);
      }

      return;
    }

    // legacy polling
    const devices = normalizeLegacyDevices(cfg);
    for (const dev of devices) {
      const client = new Modbus(dev.ip, dev.port, dev.unitId);
      this._clients.push(client);

      client.on("data", (m) => {
        const ref = m?.VHIH?.dataRef;
        if (!ref) return;
        const aid = this._attrIndex.get(stableStringify(ref));
        if (!aid) return;
        rt.emitTelemetry({ attributeId: aid, value: m.Value ?? m.value });
      });

      client.on("error", (e) => console.warn("[modbus] error", e?.message ?? e));

      const polls = [];
      for (const nd of iterLegacyNodeDefs(dev)) {
        const nodeName = nd.node.name;
        for (const a of nd.attributes) {
          const ref = mkLegacyRef(dev, nodeName, a);
          polls.push({
            registerType: String(ref.registerType).toLowerCase(),
            register: ref.register,
            regBase: ref.regBase,
            count: ref.count,
            interval: num(a.interval, 2000) ?? 2000,
            dataType: ref.dataType,
            wordOrder: ref.wordOrder,
            index: ref.index,
            scale: ref.scale,
            offset: ref.offset,
            registerId: stableStringify(ref),
            vhih: { dataRef: ref },
          });
        }
      }
      client.start(polls);
    }
  },

  async stop() {
    for (const c of (this._clients ?? [])) {
      try { c.stop?.(); } catch {}
      try { await c.close?.(); } catch {}
    }
    this._clients = [];
    this._attrIndex = null;
  },

  async handleCommand(cmd, rt) {
    // Optional future: writes for holding regs.
    console.warn("[modbus] write not implemented:", cmd.attributeId, cmd.value);
  },
};
