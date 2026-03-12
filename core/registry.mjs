import fs from "node:fs";
import path from "node:path";

/**
 * Persistent registry for stable numeric IDs.
 *
 * - Node IDs start at 1 and increment by 1 for each new node.
 * - Attribute IDs start at 1 and increment by 1 for each new attribute.
 * - Attribute instance numbers are per-node/per-attribute-type, starting at 0.
 *   If multiple attributes of the same type exist in the same node, instance increments.
 *
 * Keys:
 * - nodeKey: stable string unique per physical/logical device (module-defined)
 * - attrKey: stable string unique per attribute (module-defined)
 */
export class Registry {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      version: 1,
      nextNodeId: 1,
      nextAttributeId: 1,
      nodes: {},       // nodeKey -> { id, moduleId, name, profileKey, deleted, createdAt, updatedAt }
      attributes: {},  // attrKey -> { id, nodeKey, nodeId, moduleId, name, attrTypeKey, unit, min,max,step,writable, instance, deviceRef, deleted, createdAt, updatedAt }
    };
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") this.data = { ...this.data, ...parsed };
    } catch (e) {
      // keep defaults
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = this.filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }

  ensureNode({ nodeKey, moduleId, name, profileKey, nodeDeviceRef = null, zigbeeRid = null }) {
    const now = Date.now();
    let n = this.data.nodes[nodeKey];

    if (!n) {
      n = {
        id: this.data.nextNodeId++,
        nodeKey,
        moduleId,
        name,
        profileKey,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        nodeDeviceRef,
        zigbeeRid,
      };
      this.data.nodes[nodeKey] = n;
      return n;
    }

    n.deleted = false;
    if (moduleId != null) n.moduleId = moduleId;
    if (name != null) n.name = name;
    if (profileKey != null) n.profileKey = profileKey;
    if (nodeDeviceRef != null) n.nodeDeviceRef = nodeDeviceRef;
    if (zigbeeRid != null) n.zigbeeRid = zigbeeRid;
    n.updatedAt = now;
    return n;
  }


  _maxInstance(nodeId, attrTypeKey) {
    let max = -1;
    for (const a of Object.values(this.data.attributes)) {
      if (a.deleted) continue;
      if (a.nodeId === nodeId && a.attrTypeKey === attrTypeKey) {
        if (typeof a.instance === "number" && a.instance > max) max = a.instance;
      }
    }
    return max;
  }

  ensureAttribute({
    attrKey,
    nodeKey,
    nodeId,
    moduleId,
    name,
    attrTypeKey,
    unit,
    min,
    max,
    step,
    writable,
    deviceRef,
    currentValue,
    targetValue,
    lastValue,
    lastChanged,
  }) {
    const now = Date.now();
    let a = this.data.attributes[attrKey];
    if (!a) {
      const instance = this._maxInstance(nodeId, attrTypeKey) + 1;
      a = {
        id: this.data.nextAttributeId++,
        attrKey,
        nodeKey,
        nodeId,
        moduleId,
        name,
        attrTypeKey,
        unit: unit ?? "",
        min: typeof min === "number" ? min : 0,
        max: typeof max === "number" ? max : 1,
        step: typeof step === "number" ? step : 1,
        writable: !!writable,
        instance,
        deviceRef: (deviceRef && typeof deviceRef === "object" && !deviceRef.module) ? { module: moduleId, ...deviceRef } : (deviceRef ?? null),
        currentValue: (typeof currentValue === "number" ? currentValue : 0),
        targetValue: (typeof targetValue === "number" ? targetValue : (typeof currentValue === "number" ? currentValue : 0)),
        lastValue: (typeof lastValue === "number" ? lastValue : (typeof currentValue === "number" ? currentValue : 0)),
        lastChanged: (typeof lastChanged === "number" ? lastChanged : Math.floor(now / 1000)),
        deleted: false,
        createdAt: now,
        updatedAt: now,
        nodeDeviceRef,
        zigbeeRid,
      };
      this.data.attributes[attrKey] = a;
    } else {
      a.deleted = false;
      a.nodeKey = nodeKey ?? a.nodeKey;
      a.nodeId = nodeId ?? a.nodeId;
      a.moduleId = moduleId ?? a.moduleId;
      a.name = name ?? a.name;
      a.attrTypeKey = attrTypeKey ?? a.attrTypeKey;
      if (unit !== undefined) a.unit = unit;
      if (typeof min === "number") a.min = min;
      if (typeof max === "number") a.max = max;
      if (typeof step === "number") a.step = step;
      if (writable !== undefined) a.writable = !!writable;
      if (deviceRef !== undefined) a.deviceRef = deviceRef;
      a.updatedAt = now;
    }
    return a;
  }

  /**
   * Reconcile discovered nodes/attributes into registry.
   * discoveredNodes: [{ nodeKey, moduleId, name, profileKey, attributes:[{attrKey,...}] }]
   */
  reconcile(discoveredNodes) {
    const seenNodeKeys = new Set();
    const seenAttrKeys = new Set();

    for (const dn of discoveredNodes) {
      const n = this.ensureNode(dn);
      seenNodeKeys.add(dn.nodeKey);

      for (const da of dn.attributes ?? []) {
        const attr = this.ensureAttribute({
          ...da,
          nodeKey: dn.nodeKey,
          nodeId: n.id,
          moduleId: dn.moduleId,
        });
        seenAttrKeys.add(da.attrKey);
      }
    }

    // Tombstone anything not seen this run (do not delete)
    for (const [k, n] of Object.entries(this.data.nodes)) {
      if (!seenNodeKeys.has(k)) n.deleted = true;
    }
    for (const [k, a] of Object.entries(this.data.attributes)) {
      if (!seenAttrKeys.has(k)) a.deleted = true;
    }
  }

  getAttributeIdByKey(attrKey) {
    const a = this.data.attributes[attrKey];
    return a && !a.deleted ? a.id : null;
  }

  getNodeIdByKey(nodeKey) {
    const n = this.data.nodes[nodeKey];
    return n && !n.deleted ? n.id : null;
  }

  
  resolveNodeId(deviceRef) {
    const refStr = JSON.stringify(deviceRef ?? {});
    for (const n of Object.values(this.data.nodes)) {
      if (n.deleted) continue;
      if (!n.nodeDeviceRef) continue;
      const norm = typeof n.nodeDeviceRef === "object" && !n.nodeDeviceRef.module
        ? { module: n.moduleId, ...n.nodeDeviceRef }
        : n.nodeDeviceRef;
      if (JSON.stringify(norm) === refStr) return n.id;
    }
    return null;
  }

routeTable() {
    const m = new Map();
    for (const a of Object.values(this.data.attributes)) {
      if (a.deleted) continue;
      if (!a.deviceRef || !a.moduleId) continue;
      m.set(a.id, { moduleId: a.moduleId, ref: a.deviceRef });
    }
    return m;
  }
}

export default Registry;