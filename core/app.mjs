import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

import { profileId, attributeTypeId } from "./mapping.mjs";
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const CURRENT_LOG_LEVEL =
  LOG_LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LOG_LEVELS.info;

function stableStringify(obj) {
  return JSON.stringify((function stable(o){
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

function coreLog(level, ...args) {
  const lv = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (lv > CURRENT_LOG_LEVEL) return;
  const prefix = `[core][${level}]`;
  if (level === "error") console.error(prefix, ...args);
  else if (level === "warn") console.warn(prefix, ...args);
  else console.log(prefix, ...args);
}

import HomeeAPI from "./homeeAPI.mjs";
import Node from "./node.mjs";
import Attribute from "./attribute.mjs";
import NodeStore from "./node_store.mjs";
import { ensureStateFiles, writeNodeFile, writeIdsFile, writeRouteTable } from "./state_writer.mjs";

const require = createRequire(import.meta.url);
const ENUMS = require("./enums.cjs");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
ensureStateFiles(DATA_DIR);

const CONFIG_PATH = process.env.CONFIG_PATH ?? path.join(DATA_DIR, "config.json");
const LEGACY_CONFIG_PATH = path.join(__dirname, "..", "config.json");

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function loadConfig() {
  const cfg = readJsonSafe(CONFIG_PATH) ?? readJsonSafe(LEGACY_CONFIG_PATH) ?? {};
  if (!fs.existsSync(CONFIG_PATH)) writeJsonAtomic(CONFIG_PATH, cfg);
  return cfg;
}

async function loadModules() {
  const modulesDir = path.join(__dirname, "..", "modules");
  const entries = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const loaded = [];
  for (const name of entries) {
    const p = path.join(modulesDir, name, "index.mjs");
    if (!fs.existsSync(p)) continue;

    const mod = await import(pathToFileURL(p).href);
    let def = mod.default ?? mod;
    if (typeof def === "function") def = def();
    loaded.push({ name, def });
  }
  return loaded;
}

function updateAttributeValue(attr, value) {
  const num = typeof value === "number" ? value : Number(value);
  attr.last_value = attr.current_value;
  attr.current_value = Number.isFinite(num) ? num : attr.current_value;
  attr.target_value = attr.current_value;
  attr.last_changed = Math.floor(Date.now() / 1000);
}


(async () => {
  const config = loadConfig();

  const store = new NodeStore({
    dataDir: DATA_DIR,
    profileId,
    attributeTypeId,
    NodeClass: Node,
    AttributeClass: Attribute,
  });
  store.load();

  const api = new HomeeAPI(config?.homeeId ?? config?.homeeID ?? 1357036795);

  const runtime = {
    config,
    DATA_DIR,
    enums: ENUMS,
    profileId,
    attributeTypeId,
    Node,
    Attribute,
    store,
    stableId: (s) => String(s),
    emitTelemetry: null,
    log: (...args) => coreLog("info", ...args),
    debug: (...args) => coreLog("debug", ...args),
    trace: (...args) => coreLog("trace", ...args),
    warn: (...args) => coreLog("warn", ...args),
    error: (...args) => coreLog("error", ...args),
    resolveAttributeId: (deviceRef) => {
      return store.resolveAttributeId(deviceRef);
    },
    resolveNodeId: (deviceRef) => {
      return store.resolveNodeId(deviceRef);
    },
    getAttributeCurrentValue: (attributeId) => {
      return store.getAttributeCurrentValue(attributeId);
    },
    setNodeState: (nodeId, state) => {
      const n = store.setNodeState(nodeId, state);
      if (!n) return;
      scheduleWrite();
      try { api.send(JSON.stringify({ node: n })); } catch {}
    },
  };

  const modules = await loadModules();
  const activeModules = [];
  const discoveredNodes = [];

  for (const { name, def } of modules) {
    try {
      if (!def || typeof def.discover !== "function") {
        console.error("[core] invalid module export (needs discover):", name);
        continue;
      }

      const enabled =
        typeof def.enabled === "function"
          ? def.enabled(config)
          : (config?.[def.id]?.enabled ?? true);

      if (!enabled) {
        runtime.log("module disabled:", def.id ?? name);
        continue;
      }

      const discovery = await def.discover(config, runtime);
      const dn = discovery?.discoveredNodes ?? [];
      runtime.log(`[${def.id}] discoveredNodes=${dn.length}`);
      for (const x of dn) discoveredNodes.push(x);

      activeModules.push(def);
      runtime.log("module loaded:", def.id);
    } catch (e) {
      console.error("[core] module discover failed:", def?.id ?? name, e?.message ?? e);
    }
  }

  store.reconcile(discoveredNodes);

  let nodes = store.nodes;
  const attrRoute = store.routeTable();
  runtime.debug(`routeTable entries=${Object.keys(attrRoute).length}`);
  runtime.trace('routeTable sample', Object.entries(attrRoute).slice(0, 5));

  // Persist node/attribute state for external consumers
  let pendingWrite = false;
  const scheduleWrite = () => {
    if (pendingWrite) return;
    pendingWrite = true;
    setTimeout(() => {
      pendingWrite = false;
      try {
        writeNodeFile(DATA_DIR, nodes);
        writeIdsFile(DATA_DIR, store.ids);
        writeRouteTable(DATA_DIR, attrRoute);
      } catch (e) {
        console.warn("[core] state write failed:", e?.message ?? e);
      }
    }, 250);
  };

  scheduleWrite();

  api.setNodes(nodes);
  api.start();

  runtime.emitTelemetry = (u) => {
    const attrId = Number(u.attributeId);
    if (!Number.isFinite(attrId)) return;

    const a = store.findAttributeById(attrId);
    if (!a) return;

    // Update in-memory node/attribute (store.nodes is the source of truth)
    updateAttributeValue(a, u.value);

    const n = store.nodes.find((x) => (x.attributes ?? []).some((aa) => aa.id === attrId));
    if (n) n.state_changed = a.last_changed;

    store.save();
    scheduleWrite();

    try { api.send(JSON.stringify({ attribute: a })); } catch {}
    try { if (n) api.send(JSON.stringify({ node: n })); } catch {}
  };

  api.on("PUT:attributes", async (id, _nodesCmd, targetValue, parsed) => {
    const attrId = Number(id);
    if (!Number.isFinite(attrId)) return;
    const route = attrRoute.get(attrId);
    if (!route) return;

    const mod = activeModules.find((mm) => mm && mm.id === route.moduleId);
    if (!mod || typeof mod.handleCommand !== "function") {
      console.warn("[core] no handleCommand for module", route.moduleId, "attr", attrId);
      return;
    }

    try {
      runtime.log("[core] route", { attrId, moduleId: route.moduleId, deviceRef: route.ref });
      const vNum = typeof targetValue === "number" ? targetValue : Number(targetValue);
      const value = Number.isFinite(vNum) ? vNum : targetValue;
      await mod.handleCommand({ attributeId: attrId, value, deviceRef: route.ref, parsed }, runtime);
    } catch (e) {
      console.warn("[core] command failed", route.moduleId, attrId, e?.message ?? e);
    }
  });


// Handle node rename: PUT:nodes/<id>?name=<newName>
api.on("put", (parsed) => {
  try {
    if (parsed?.target !== "nodes") return;
    const nodeId = Number(parsed?.commands?.nodes);
    if (!Number.isFinite(nodeId) || nodeId <= 0) return;

    const newName = parsed?.parameters?.name;
    if (typeof newName !== "string") return;

    const n = store.setNodeName(nodeId, newName);
    if (!n) return;

    scheduleWrite();
    api.send(JSON.stringify({ node: n }));
    coreLog("info", "[core] node renamed", { nodeId, name: n.name });
  } catch (e) {
    coreLog("warn", "[core] node rename failed", { error: e?.message ?? String(e) });
  }
});


  for (const m of activeModules) {
    try {
      await m.start(config, runtime);
    } catch (e) {
      console.error("[core] module start failed:", m?.id, e?.message ?? e);
    }
  }

  runtime.log("started. nodes:", nodes.length, "attrs:", nodes.reduce((a, n) => a + (n.attributes?.length || 0), 0));
})();