import fs from "node:fs";
import path from "node:path";

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

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fallback;
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/**
 * NodeStore persists the *full* node list (including attributes) as the source of truth,
 * plus a separate ids/index file for stable IDs and routing lookups.
 *
 * - nodes.json: complete node structure (debuggable)
 * - ids.json: counters + indices (nodeKey->id, attrKey->id, deviceRef->attrId, nodeDeviceRef->nodeId)
 */
export default class NodeStore {
  /**
   * @param {{ dataDir: string, profileId:(k:string)=>number, attributeTypeId:(k:string)=>number, NodeClass:any, AttributeClass:any }} opts
   */
  constructor({ dataDir, profileId, attributeTypeId, NodeClass, AttributeClass }) {
    this.dataDir = dataDir;
    this.profileId = profileId;
    this.attributeTypeId = attributeTypeId;
    this.NodeClass = NodeClass;
    this.AttributeClass = AttributeClass;

    this.nodesPath = path.join(dataDir, "nodes.json");
    this.idsPath = path.join(dataDir, "ids.json");

    this.nodes = [];
    this.ids = {
      version: 1,
      nextNodeId: 1,
      nextAttributeId: 1,
      modules: {}, // moduleId -> { nodeKeyToNodeId, attrKeyToAttrId, nodes, attributes }
    };
  }


_bucket(moduleId) {
  const id = String(moduleId || "");
  if (!id) throw new Error("moduleId required");
  this.ids.modules ??= {};
  this.ids.modules[id] ??= { nodeKeyToNodeId: {}, attrKeyToAttrId: {}, nodes: {}, attributes: {} };
  return this.ids.modules[id];
}

_stripModule(ref) {
  if (!ref || typeof ref !== "object") return ref;
  const { module, moduleId, provider, ...rest } = ref;
  return rest;
}

_ensureAttrIndex(moduleId) {
  this._attrIndex ??= {};
  if (this._attrIndex[moduleId]) return this._attrIndex[moduleId];

  const bucket = this._bucket(moduleId);
  const idx = new Map();
  for (const [attrId, data] of Object.entries(bucket.attributes ?? {})) {
    idx.set(stableStringify(data), Number(attrId));
  }
  this._attrIndex[moduleId] = idx;
  return idx;
}

  _maxInstance(nodeId, attrTypeIdNum) {
    let max = -1;
    for (const n of this.nodes) {
      if (Number(n?.id) !== Number(nodeId)) continue;
      for (const a of n?.attributes ?? []) {
        if (Number(a?.type) !== Number(attrTypeIdNum)) continue;
        const inst = Number(a?.instance);
        if (Number.isFinite(inst) && inst > max) max = inst;
      }
      break;
    }
    return max;
  }

  load() {
    this.nodes = readJsonSafe(this.nodesPath, []);
    this.ids = { ...this.ids, ...readJsonSafe(this.idsPath, {}) };
    this.ids.modules ??= {};
// Migration from legacy flat ids.json -> per-module buckets (best-effort).
if (!this.ids.modules || Object.keys(this.ids.modules).length === 0) {
  const legacyNodeMap = this.ids.nodeKeyToNodeId;
  const legacyAttrMap = this.ids.attrKeyToAttrId;
  if (legacyNodeMap && typeof legacyNodeMap === "object") {
    for (const [nodeKey, nodeId] of Object.entries(legacyNodeMap)) {
      const moduleId = String(nodeKey).split("|")[0] || "unknown";
      const b = this._bucket(moduleId);
      b.nodeKeyToNodeId[String(nodeKey)] = Number(nodeId);
    }
  }
  if (legacyAttrMap && typeof legacyAttrMap === "object") {
    for (const [attrKey, attrId] of Object.entries(legacyAttrMap)) {
      const moduleId = String(attrKey).split("|")[0] || "unknown";
      const b = this._bucket(moduleId);
      b.attrKeyToAttrId[String(attrKey)] = Number(attrId);
    }
  }
  delete this.ids.nodeKeyToNodeId;
  delete this.ids.attrKeyToAttrId;
  delete this.ids.deviceRefToAttrId;
  delete this.ids.nodeRefToNodeId;
  delete this.ids.nodeMetaById;
  delete this.ids.attrMetaById;
}


    this._attrIndex = {};
    this._rebuildCountersFromNodes();
  }

  save() {
    writeAtomic(this.nodesPath, JSON.stringify(this.nodes, null, 2) + "\n");
    writeAtomic(this.idsPath, JSON.stringify(this.ids, null, 2) + "\n");
  }

  _rebuildCountersFromNodes() {
    let maxNodeId = 0;
    let maxAttrId = 0;
    for (const n of this.nodes ?? []) {
      if (typeof n?.id === "number") maxNodeId = Math.max(maxNodeId, n.id);
      for (const a of n?.attributes ?? []) {
        if (typeof a?.id === "number") maxAttrId = Math.max(maxAttrId, a.id);
      }
    }
    if (!Number.isFinite(this.ids.nextNodeId)) this.ids.nextNodeId = 1;
    if (!Number.isFinite(this.ids.nextAttributeId)) this.ids.nextAttributeId = 1;
    this.ids.nextNodeId = Math.max(this.ids.nextNodeId, maxNodeId + 1);
    this.ids.nextAttributeId = Math.max(this.ids.nextAttributeId, maxAttrId + 1);
  }

  // Backwards-compatible alias (older code called this).
  _repairCounters() {
    this._rebuildCountersFromNodes();
  }


  
  _indexDeviceRef(moduleId, deviceRef, attrId) {
    // No-op: routing indices are built per-module via _ensureAttrIndex()
    // (kept for backwards compatibility).
  }

  _indexNodeRef(moduleId, nodeDeviceRef, nodeId) {
    // No-op for now (can be added later if needed).
  }


  /**
   * Reconcile discovered nodes into the full persisted nodes list.
   * Modules can keep emitting the existing discoveredNodes format:
   *  dn: { nodeKey, moduleId, name, profileKey, nodeDeviceRef?, attributes:[{attrKey, moduleId?, name?, attrTypeKey, ... , deviceRef}] }
   *
   * @param {Array<any>} discoveredNodes
   * @returns {Array<any>} full nodes array
   */
  
  reconcile(discoveredNodes) {
    const now = nowSec();

    const seenNodeKeys = new Set();
    const seenAttrIds = new Set();

    const nodeById = new Map();
    for (const n of this.nodes) {
      if (typeof n?.id === "number") nodeById.set(n.id, n);
      if (!Array.isArray(n?.attributes)) n.attributes = [];
    }

    for (const dn of Array.isArray(discoveredNodes) ? discoveredNodes : []) {
      if (!dn?.nodeKey) continue;

      const nodeKey = String(dn.nodeKey);
      seenNodeKeys.add(nodeKey);
const moduleId = String(dn.moduleId || "");
if (!moduleId) continue;
const bucket = this._bucket(moduleId);

let nodeId = bucket.nodeKeyToNodeId[nodeKey];
if (!Number.isFinite(Number(nodeId))) nodeId = null;

if (!nodeId) {
  nodeId = this.ids.nextNodeId++;
  bucket.nodeKeyToNodeId[nodeKey] = nodeId;
}

bucket.nodes[String(nodeId)] = { nodeKey };


      let node = nodeById.get(Number(nodeId)) ?? null;
      if (!node) {
        node = new this.NodeClass(dn.name ?? nodeKey, Number(nodeId), this.profileId(dn.profileKey), []);
        node.added = node.added && node.added > 1000000000 ? node.added : now;
        node.state_changed = node.state_changed && node.state_changed > 1000000000 ? node.state_changed : now;

        nodeById.set(Number(nodeId), node);
        this.nodes.push(node);
      } else {
        if (dn.name != null) node.name = dn.name;
        if (dn.profileKey != null) node.profile = this.profileId(dn.profileKey);
        node.state_changed = now;
      }

      const keepAttrIdsForNode = new Set();

      for (const da of Array.isArray(dn.attributes) ? dn.attributes : []) {
        if (!da?.attrKey) continue;

        
const attrKey = String(da.attrKey);
let attrId = bucket.attrKeyToAttrId[attrKey];
if (!Number.isFinite(Number(attrId))) attrId = null;

if (!attrId) {
  attrId = this.ids.nextAttributeId++;
  bucket.attrKeyToAttrId[attrKey] = attrId;
}

// Persist minimal routing data per module.
if (da.deviceRef) {
  const stripped = this._stripModule(da.deviceRef);
  bucket.attributes[String(attrId)] = stripped;
} else if (da.data) {
  bucket.attributes[String(attrId)] = da.data;
}

// Invalidate index cache for this module if ids changed.
this._attrIndex = {};


        let attr = (node.attributes ?? []).find((a) => Number(a?.id) === Number(attrId)) ?? null;
        if (!attr) {
          const typeNum = this.attributeTypeId(da.attrTypeKey);
          const instance = this._maxInstance(node.id, typeNum) + 1;

          attr = new this.AttributeClass(
            Number(attrId),
            node.id,
            instance,
            da.min ?? 0,
            da.max ?? 1,
            da.currentValue ?? 0,
            da.targetValue ?? (da.currentValue ?? 0),
            da.lastValue ?? (da.currentValue ?? 0),
            da.unit ?? "",
            da.step ?? 1,
            da.writable ? 1 : 0,
            typeNum,
            ""
          );

          if (da.name != null) attr.name = da.name;
          attr.last_changed = now;

          node.attributes ??= [];
          node.attributes.push(attr);
        } else {
          if (da.name != null) attr.name = da.name;
          if (da.unit != null) attr.unit = da.unit;
          if (da.min != null) attr.minimum = da.min;
          if (da.max != null) attr.maximum = da.max;
          if (da.step != null) attr.step_value = da.step;
          if (da.writable !== undefined) attr.editable = da.writable ? 1 : 0;
        }

        // internal routing/meta stored separately

        keepAttrIdsForNode.add(Number(attr.id));
        seenAttrIds.add(Number(attr.id));
      }

      // remove attributes that are no longer discovered for this node
      if (keepAttrIdsForNode.size > 0) {
        node.attributes = (node.attributes ?? []).filter((a) => keepAttrIdsForNode.has(Number(a?.id)));
      }
    }

    this._rebuildCountersFromNodes();
    this.save();
    return this.nodes;
  }


  /**
   * Returns Map(attrId -> { moduleId, ref }) used by Core for Homee PUT routing.
   */
  
routeTable() {
  const m = new Map();
  const modules = this.ids.modules ?? {};
  for (const [moduleId, bucket] of Object.entries(modules)) {
    const attrs = bucket?.attributes ?? {};
    for (const [attrIdStr, data] of Object.entries(attrs)) {
      const attrId = Number(attrIdStr);
      if (!Number.isFinite(attrId)) continue;
      m.set(attrId, { moduleId, ref: data ?? null });
    }
  }
  return m;
}


  /**
   * Resolve attributeId by deviceRef (used for SSE routing).
   * @param {string} moduleId
   * @param {any} deviceRef
   * @returns {number|null}
   */

  /**
   * Resolve attributeId by deviceRef (used for SSE routing).
   *
   * Supports both call styles:
   *  - 
resolveAttributeId(moduleIdOrRef, deviceRef) {
  if (!moduleIdOrRef) return null;

  let moduleId = moduleIdOrRef;
  let ref = deviceRef;
  if (ref === undefined && typeof moduleIdOrRef === "object") {
    ref = moduleIdOrRef;
    moduleId = ref.module || ref.moduleId || ref.provider;
  }
  if (!moduleId || !ref) return null;

  const key = stableStringify(this._stripModule(ref));
  const idx = this._ensureAttrIndex(String(moduleId));
  const id = idx.get(key);
  return Number.isFinite(Number(id)) ? Number(id) : null;
}


  /**
   * Resolve nodeId by nodeDeviceRef (used for connectivity/state updates).
   * @param {string} moduleId
   * @param {any} nodeDeviceRef
   * @returns {number|null}
   */

  /**
   * Resolve nodeId by nodeDeviceRef (used for connectivity/state updates).
   *
   * Supports both call styles:
   *  - resolveNodeId(nodeDeviceRefObject)
   *  - resolveNodeId(moduleId, nodeDeviceRefObject)
   *
   * @param {string|object} moduleIdOrRef
   * @param {any} [nodeDeviceRef]
   * @returns {number|null}
   */

resolveNodeId() {
  return null;
}




  findAttributeById(attributeId) {
    const id = Number(attributeId);
    for (const n of this.nodes) {
      for (const a of n?.attributes ?? []) if (Number(a.id) === id) return a;
    }
    return null;
  }

  getAttributeCurrentValue(attributeId) {
    const a = this.findAttributeById(attributeId);
    return a ? a.current_value : null;
  }


setNodeName(nodeId, name) {
  const now = nowSec();
  const id = Number(nodeId);
  const n = this.nodes.find((x) => Number(x.id) === id);
  if (!n) return null;

  n.name = String(name ?? "");
  n.state_changed = now;
  return n;
}

  setNodeState(nodeId, state) {
    const now = nowSec();
    const id = Number(nodeId);
    const n = this.nodes.find((x) => Number(x.id) === id);
    if (!n) return null;
    n.state = state;
    n.state_changed = now;
    this.save();
    return n;
  }
}
