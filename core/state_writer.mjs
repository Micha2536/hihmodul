import fs from "node:fs";
import path from "node:path";

function writeAtomic(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUnit(unit) {
  if (unit === undefined || unit === null) return "";
  const u = String(unit);
  // homee uses URL-encoded unit strings (e.g. "%" -> "%25")
  return encodeURIComponent(u);
}

function defaultAttrOptions(attr) {
  // Minimal options shape compatible with homee clients.
  // Extend later if needed.
  const type = Number(attr.type);
  if (type === 1) {
    return {
      can_observe: [300],
      automations: ["toggle"],
      history: { day: 35, week: 5, month: 1, stepped: true },
    };
  }
  if (type === 2) {
    return { automations: ["step"] };
  }
  return {};
}

function normalizeAttribute(a, sec) {
  const out = { ...a };

  out.unit = normalizeUnit(out.unit);

  if (!("state" in out)) out.state = 1;
  if (!("last_changed" in out) || !Number.isFinite(out.last_changed) || out.last_changed < 1000000000) {
    out.last_changed = sec;
  }
  if (!("changed_by" in out)) out.changed_by = 1;
  if (!("changed_by_id" in out)) out.changed_by_id = 0;
  if (!("based_on" in out)) out.based_on = 1;
  if (!("name" in out)) out.name = "";

  // Do not leak internal routing/deviceRef via homee attribute 'data' field.
// Keep 'data' homee-compatible. Routing is persisted separately (registry/RouteTable).
// Only CAAttributeTypeColor (23) may carry a palette/preset string; everything else must stay empty.
if ("deviceRef" in out) delete out.deviceRef;
for (const k of ["moduleId", "module", "ref", "route"]) {
  if (k in out) delete out[k];
}

const t = Number(out.type);
const rawData = (typeof out.data === "string") ? out.data : "";
if (t === 23) {
  // Allow only palette-like strings (URL-encoded "num;num;..."), otherwise clear.
  const okPalette = /^[0-9]+(%3B[0-9]+)*$/.test(rawData);
  out.data = okPalette ? rawData : "";
} else {
  out.data = "";
}
  // Remove other internal fields if present
  for (const k of ["moduleId", "module", "ref", "route"]) {
    if (k in out) delete out[k];
  }

  // homee uses "editable" (int 0/1)
  if (!("editable" in out) && "writable" in out) out.editable = out.writable ? 1 : 0;

  // Ensure numbers for numeric fields
  for (const k of ["minimum", "maximum", "current_value", "target_value", "last_value", "step_value", "type", "instance"]) {
    if (k in out && typeof out[k] === "string" && out[k].trim() !== "" && !Number.isNaN(Number(out[k]))) {
      out[k] = Number(out[k]);
    }
  }

  if (!("options" in out) || out.options === null) out.options = defaultAttrOptions(out);

  return out;
}

function normalizeNode(n, sec) {
  const out = { ...n };

  if (!("image" in out)) out.image = "default";
  if (!("favorite" in out)) out.favorite = 0;
  if (!("order" in out)) out.order = out.id ?? 0;

  // Keep whatever protocol you already use, but ensure fields exist
  if (!("protocol" in out)) out.protocol = 1;
  if (!("sub_protocol" in out)) out.sub_protocol = 1;
  if (!("routing" in out)) out.routing = 1;
  if (!("state" in out)) out.state = 1;

  if (!("state_changed" in out) || !Number.isFinite(out.state_changed) || out.state_changed < 1000000000) {
    out.state_changed = sec;
  }
  if (!("added" in out) || !Number.isFinite(out.added) || out.added < 1000000000) {
    out.added = sec;
  }

  if (!("history" in out)) out.history = 1;
  if (!("cube_type" in out)) out.cube_type = 8;
  if (!("note" in out)) out.note = "";
  if (!("services" in out)) out.services = 0;
  if (!("phonetic_name" in out)) out.phonetic_name = "";
  if (!("owner" in out)) out.owner = 0;
  if (!("security" in out)) out.security = 0;

  const attrs = Array.isArray(out.attributes) ? out.attributes : [];
  out.attributes = attrs.map((a) => normalizeAttribute(a, sec));

  return out;
}

export function writeNodeFile(dataDir, nodes) {
  const p = path.join(dataDir, "NodeFile.js");
  const sec = nowSec();
  const normalized = (Array.isArray(nodes) ? nodes : []).map((n) => normalizeNode(n, sec));
  const content = JSON.stringify(normalized, null, 2) + "\n";
  writeAtomic(p, content);
}

export function writeNodeIdFile(dataDir, nodes) {
  const p = path.join(dataDir, "NodeIdFile.js");
  const list = (Array.isArray(nodes) ? nodes : []).map((n) => ({ id: n.id, name: n.name, profile: n.profile }));
  const content = JSON.stringify(list, null, 2) + "\n";
  writeAtomic(p, content);
}

export function writeRouteTable(dataDir, attrRoute) {
  const p = path.join(dataDir, "RouteTable.json");
  const obj = {};
  for (const [attrId, route] of attrRoute.entries()) {
    obj[String(attrId)] = route;
  }
  writeAtomic(p, JSON.stringify(obj, null, 2) + "\n");
}

export function ensureStateFiles(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const ensure = (name, defaultContent) => {
    const p = path.join(dataDir, name);
    if (!fs.existsSync(p)) fs.writeFileSync(p, defaultContent, "utf-8");
  };

  // Keep legacy filenames for compatibility, but store valid JSON by default.
  ensure("NodeFile.js", "[]\n");
  ensure("NodeIdFile.js", "[]\n");
  ensure("ServiceFile.js", "[]\n");

  // New flat store files
  ensure("nodes.json", "[]\n");
  ensure("ids.json", "{}\n");
}

export function writeRegistryDump(dataDir, registry) {
  const p = path.join(dataDir, "Registry.json");
  writeAtomic(p, JSON.stringify(registry, null, 2) + "\n");
}

export function writeIdsFile(dataDir, ids) {
  const p = path.join(dataDir, "ids.json");
  writeAtomic(p, JSON.stringify(ids ?? {}, null, 2) + "\n");
}
