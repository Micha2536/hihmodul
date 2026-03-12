function ensureBadgeStyles() {
  if (document.getElementById("vhihBadgeStyles")) return;
  const s = document.createElement("style");
  s.id = "vhihBadgeStyles";
  s.textContent = `
    .vhihBadgeWrap{display:block}
    .vhihBadge{display:inline-flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;border:2px solid #1f2a37;cursor:pointer;user-select:none}
    .vhihBadgeDot{width:10px;height:10px;border-radius:50%}
    .vhihBadge.ok{border-color:#2ea043}
    .vhihBadge.ok .vhihBadgeDot{background:#2ea043}
    .vhihBadge.bad{border-color:#f85149}
    .vhihBadge.bad .vhihBadgeDot{background:#f85149}
    .vhihBadgeBody{margin-top:12px;display:none}
    .vhihBadgeWrap.expanded .vhihBadgeBody{display:block}
  `;
  document.head.appendChild(s);
}

function setBadgeState(badgeEl, enabled) {
  badgeEl.classList.toggle("ok", !!enabled);
  badgeEl.classList.toggle("bad", !enabled);
  const txt = badgeEl.querySelector("[data-badge-text]");
  if (txt) txt.textContent = enabled ? "aktiv" : "inaktiv";
}

/**
 * ctx: WebUI ctx
 * enabledSelector: e.g. "#demo_enabled"
 * title: shown on badge
 */
function wrapWithBadge(ctx, enabledSelector, title) {
  ensureBadgeStyles();

  const root = ctx.el;
  if (!root || root.dataset.vhihBadgeWrapped === "1") return;
  root.dataset.vhihBadgeWrapped = "1";

  const enabledEl = root.querySelector(enabledSelector);
  const enabled = !!enabledEl?.checked;

  const wrap = document.createElement("div");
  wrap.className = "vhihBadgeWrap"; // collapsed by default

  const badge = document.createElement("div");
  badge.className = "vhihBadge " + (enabled ? "ok" : "bad");

  const dot = document.createElement("span");
  dot.className = "vhihBadgeDot";

  const name = document.createElement("strong");
  name.textContent = title || "Modul";

  const state = document.createElement("span");
  state.className = "muted";
  state.setAttribute("data-badge-text", "1");
  state.textContent = enabled ? "aktiv" : "inaktiv";

  badge.append(dot, name, state);

  const body = document.createElement("div");
  body.className = "vhihBadgeBody";

  while (root.firstChild) body.appendChild(root.firstChild);

  wrap.append(badge, body);
  root.appendChild(wrap);

  badge.addEventListener("click", () => wrap.classList.toggle("expanded"));

  if (enabledEl) {
    const sync = () => setBadgeState(badge, enabledEl.checked);
    enabledEl.addEventListener("change", sync);
    sync();
  }
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v !== undefined) e.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

async function ensureEnumsLoaded() {
  if (window.ENUMS) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "../../../enums.js";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Failed to load enums.js"));
    document.head.appendChild(s);
  });
}

function enumKeyOptions(enumName) {
  const src = window.ENUMS?.[enumName];
  if (!src || typeof src !== "object") return [];
  return Object.keys(src)
    .filter((k) => Object.prototype.hasOwnProperty.call(src, k))
    .map((k) => ({ key: k, order: Number(src[k]) }))
    .sort((a, b) =>
      (Number.isFinite(a.order) && Number.isFinite(b.order))
        ? a.order - b.order
        : a.key.localeCompare(b.key)
    )
    .map(({ key }) => key);
}

function splitCamel(s) {
  // Keep acronyms together: "StatusLED" => ["Status", "LED"]
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function humanizeEnumKey(enumName, key) {
  const prefix = String(enumName || "");
  const raw = String(key || "");
  const stripped = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  const parts = splitCamel(stripped);
  return parts.join(" ");
}

function enumGroup(enumName, humanLabel) {
  const t = String(humanLabel || "");
  if (!t || t === "None") return "Allgemein";

  const has = (w) => new RegExp(`\\b${w}\\b`, "i").test(t);

  if (enumName === "CANodeProfile") {
    if (has("Remote") || has("Button")) return "Fernbedienungen";
    if (has("Sensor") || has("Alarm") || has("Input") || has("Temperature") || has("Humidity") || has("Flood") || has("Smoke") || has("Watch")) return "Sensoren";
    if (has("Plug")) return "Plugs";
    if (has("Switch")) return "Schalter";
    if (has("Metering") || has("Dimmable") || has("Color")) return "Licht & Leistung";
    return "Sonstiges";
  }

  if (enumName === "CAAttributeType") {
    if (has("On") || has("Off") || has("Dimming") || has("Open") || has("Close") || has("Position") || has("Target")) return "Steuerung";
    if (has("Temperature") || has("Humidity") || has("Brightness") || has("Battery") || has("Energy") || has("Current") || has("Pressure") || has("Valve")) return "Messwerte";
    if (has("Alarm") || has("Siren") || has("Flood") || has("Smoke") || has("Blackout")) return "Alarme";
    if (has("LED") || has("Status")) return "Status";
    return "Sonstiges";
  }

  return "Sonstiges";
}

function selectEnum(enumName, value, onChange, placeholder = "") {
  const keys = enumKeyOptions(enumName);
  if (!keys.length) return inputText(value ?? "", onChange, placeholder);

  const byGroup = new Map();
  for (const k of keys) {
    const label = humanizeEnumKey(enumName, k);
    const group = enumGroup(enumName, label);
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push({ key: k, label });
  }

  const groupOrder = Array.from(byGroup.keys()).sort((a, b) => {
    if (a === "Allgemein") return -1;
    if (b === "Allgemein") return 1;
    return a.localeCompare(b);
  });

  const s = el("select", { class: "input" });
  if (placeholder) s.appendChild(el("option", { value: "", text: placeholder }));

  for (const g of groupOrder) {
    const og = el("optgroup", { label: g });
    for (const item of byGroup.get(g)) {
      og.appendChild(el("option", { value: item.key, text: item.label }));
    }
    s.appendChild(og);
  }

  if (value && !keys.includes(value)) s.appendChild(el("option", { value, text: value }));
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function num(v, dflt = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function asStr(v, dflt = "") {
  return (typeof v === "string" && v.trim() !== "") ? v : dflt;
}

function kv(label, control) {
  return el("div", { class: "kv" }, el("label", { text: label }), control);
}
/*
function checkbox(value, onChange) {
  const i = el("input", { type: "checkbox" });
  i.checked = !!value;
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}
*/
function checkbox(value, onChange, id = null) {
  const i = el("input", { type: "checkbox" });
  if (id) i.id = id;              // 👈 hier wird die ID gesetzt
  i.checked = !!value;
  i.addEventListener("change", () => onChange(i.checked));
  return i;
}

function inputText(value, onChange, placeholder = "") {
  const i = el("input", { type: "text", value: value ?? "", placeholder });
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function inputNumber(value, onChange, min = null) {
  const i = el("input", { type: "number", value: String(num(value, 0) ?? 0) });
  if (min !== null) i.min = String(min);
  i.addEventListener("input", () => onChange(num(i.value, 0) ?? 0));
  return i;
}

function selectEl(options, value, onChange, placeholder = "(bitte wählen)") {
  const s = el("select", {});
  s.appendChild(el("option", { value: "", text: placeholder }));
  for (const o of options) s.appendChild(el("option", { value: o.value, text: o.label }));
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value || null));
  return s;
}

function ensureModbus(cfg) {
  if (!cfg.modbus || typeof cfg.modbus !== "object" || Array.isArray(cfg.modbus)) {
    cfg.modbus = { enabled: true, endpoints: [] };
  }
  cfg.modbus.enabled = cfg.modbus.enabled ?? true;
  cfg.modbus.endpoints = Array.isArray(cfg.modbus.endpoints) ? cfg.modbus.endpoints : [];
  return cfg.modbus;
}

function ensureNodes(cfg) {
  cfg.nodes = Array.isArray(cfg.nodes) ? cfg.nodes : [];
  return cfg.nodes;
}

function syncJson(ctx, mb, nodes) {
  const pre = ctx.el.querySelector("#mb_json");
  if (pre) pre.textContent = JSON.stringify({ modbus: mb, nodes }, null, 2);
}

function endpointSummary(ep) {
  return `${ep.name ?? ep.id ?? "Endpoint"} — ${ep.ip ?? ""}:${ep.port ?? ""} — U${ep.unitId ?? ""}`;
}

function blockSummary(b) {
  const start = num(b.start, 0);
  const end = start + (num(b.count, 1) - 1);
  return `${b.id} — ${b.type ?? "holding"} ${start}..${end} — ${b.interval ?? 2000}ms`;
}

function attrSummary(a) {
  const src = a.source ?? {};
  return `${a.name ?? a.id ?? "Attr"} — ${src.endpointId ?? "?"}/${src.blockId ?? "?"} — Reg ${src.register ?? "?"}`;
}

function renderModbus(ctx, mb, nodes) {
  const root = ctx.el.querySelector("#mb_form");
  root.innerHTML = "";

  const top = el("div", { class: "card" });
  //top.appendChild(kv("Modbus aktiviert", checkbox(!!mb.enabled, (v) => { mb.enabled = v; syncJson(ctx, mb, nodes); })));
  top.appendChild(kv("Modbus aktiviert", checkbox(!!mb.enabled, (v) => { mb.enabled = v; syncJson(ctx, mb, nodes); }, "mb_enabled")));
  top.appendChild(el("div", { class: "sep" }));
  top.appendChild(el("button", { class: "btn", type: "button", onclick: () => {
    mb.endpoints.push({ id: `mb${mb.endpoints.length + 1}`, enabled: true, name: `modbus ${mb.endpoints.length + 1}`, ip: "", port: 502, unitId: 1, blocks: [] });
    renderAll(ctx, mb, nodes);
  }}, "+ Endpoint"));
  root.appendChild(top);

  mb.endpoints.forEach((ep, ei) => {
    const det = el("details", { class: "card" });
    det.appendChild(el("summary", { text: endpointSummary(ep) }));

    det.appendChild(kv("Aktiv", checkbox(ep.enabled ?? true, (v) => { ep.enabled = v; syncJson(ctx, mb, nodes); })));
    det.appendChild(kv("ID", inputText(ep.id ?? "", (v) => { ep.id = v; syncJson(ctx, mb, nodes); })));
    det.appendChild(kv("Name", inputText(ep.name ?? "", (v) => { ep.name = v; syncJson(ctx, mb, nodes); })));
    det.appendChild(kv("IP", inputText(ep.ip ?? "", (v) => { ep.ip = v; syncJson(ctx, mb, nodes); })));
    det.appendChild(kv("Port", inputNumber(ep.port ?? 502, (v) => { ep.port = v; syncJson(ctx, mb, nodes); }, 1)));
    det.appendChild(kv("UnitId", inputNumber(ep.unitId ?? 1, (v) => { ep.unitId = v; syncJson(ctx, mb, nodes); }, 0)));

    det.appendChild(el("div", { class: "sep" }));
    det.appendChild(el("button", { class: "btn", type: "button", onclick: () => {
      ep.blocks = Array.isArray(ep.blocks) ? ep.blocks : [];
      ep.blocks.push({ id: `b${ep.blocks.length + 1}`, enabled: true, type: "holding", start: 0, count: 10, interval: 2000, base: 0 });
      renderAll(ctx, mb, nodes);
    }}, "+ Block"));

    ep.blocks = Array.isArray(ep.blocks) ? ep.blocks : [];
    ep.blocks.forEach((b, bi) => {
      const bd = el("details", { class: "card" });
      bd.appendChild(el("summary", { text: blockSummary(b) }));
      bd.appendChild(kv("Aktiv", checkbox(b.enabled ?? true, (v) => { b.enabled = v; syncJson(ctx, mb, nodes); })));
      bd.appendChild(kv("Block-ID", inputText(b.id ?? "", (v) => { b.id = v; syncJson(ctx, mb, nodes); })));
      bd.appendChild(kv("Typ", selectEl(["holding","input","coil","discrete"].map(x=>({value:x,label:x})), b.type ?? "holding", (v)=>{ b.type=v; syncJson(ctx, mb, nodes);})));
      bd.appendChild(kv("Start", inputNumber(b.start ?? 0, (v)=>{ b.start=v; syncJson(ctx, mb, nodes); },0)));
      bd.appendChild(kv("Count", inputNumber(b.count ?? 1, (v)=>{ b.count=Math.max(1,v); syncJson(ctx, mb, nodes); },1)));
      bd.appendChild(kv("Interval", inputNumber(b.interval ?? 2000, (v)=>{ b.interval=Math.max(100,v); syncJson(ctx, mb, nodes); },100)));
      bd.appendChild(kv("Base (0/1)", inputNumber(b.base ?? 0, (v)=>{ b.base = (v===1?1:0); syncJson(ctx, mb, nodes); },0)));

      bd.appendChild(el("button", { class: "btn danger", type: "button", onclick: () => {
        ep.blocks.splice(bi, 1);
        renderAll(ctx, mb, nodes);
      }}, "Block entfernen"));
      det.appendChild(bd);
    });

    det.appendChild(el("button", { class: "btn danger", type: "button", onclick: () => {
      mb.endpoints.splice(ei, 1);
      renderAll(ctx, mb, nodes);
    }}, "Endpoint entfernen"));

    root.appendChild(det);
  });
}

function renderNodes(ctx, mb, nodes) {
  const root = ctx.el.querySelector("#nodes_form");
  root.innerHTML = "";

  const top = el("div", { class: "card" });
  top.appendChild(el("button", { class: "btn", type: "button", onclick: () => {
    nodes.push({ id: `node${nodes.length+1}`, name: `Node ${nodes.length+1}`, profileKey: "CANodeProfileOnOffSwitch", attributes: [] });
    renderAll(ctx, mb, nodes);
  }}, "+ Node"));
  root.appendChild(top);

  const epOpts = mb.endpoints.map((e) => ({ value: e.id, label: `${e.name ?? e.id} (${e.ip ?? ""})` }));

  nodes.forEach((n, ni) => {
    const nd = el("details", { class: "card" });
    nd.appendChild(el("summary", { text: `${n.name ?? n.id} (${(n.attributes ?? []).length} Attr)` }));
    nd.appendChild(kv("ID", inputText(n.id ?? "", (v)=>{ n.id=v; syncJson(ctx, mb, nodes);})));
    nd.appendChild(kv("Name", inputText(n.name ?? "", (v)=>{ n.name=v; syncJson(ctx, mb, nodes);})));
    nd.appendChild(kv("ProfileKey", selectEnum("CANodeProfile", n.profileKey ?? "CANodeProfileOnOffSwitch", (v)=>{ n.profileKey=v; syncJson(ctx, mb, nodes);} , "Profil wählen")));

    n.attributes = Array.isArray(n.attributes) ? n.attributes : [];
    nd.appendChild(el("div", { class: "sep" }));
    nd.appendChild(el("button", { class: "btn", type: "button", onclick: () => {
      n.attributes.push({
        id: `attr${n.attributes.length+1}`,
        name: `Attr ${n.attributes.length+1}`,
        attrTypeKey: "CAAttributeTypeOnOff",
        unit: "",
        min: 0, max: 100, step: 1,
        dataType: "uint16", wordOrder: "be", scale: 1, offset: 0,
        source: { kind:"modbus", endpointId: null, blockId: null, register: null }
      });
      renderAll(ctx, mb, nodes);
    }}, "+ Attribut"));

    n.attributes.forEach((a, ai) => {
      const ad = el("details", { class: "card" });
      const ep = mb.endpoints.find((x)=>x.id===a.source?.endpointId) ?? null;
      const blk = ep?.blocks?.find((b)=>b.id===a.source?.blockId) ?? null;
      ad.appendChild(el("summary", { text: attrSummary(a) }));

      ad.appendChild(kv("Attr-ID", inputText(a.id ?? "", (v)=>{ a.id=v; syncJson(ctx, mb, nodes);})));
      ad.appendChild(kv("Name", inputText(a.name ?? "", (v)=>{ a.name=v; syncJson(ctx, mb, nodes);})));
      ad.appendChild(kv("AttrTypeKey", selectEnum("CAAttributeType", a.attrTypeKey ?? "CAAttributeTypeOnOff", (v)=>{ a.attrTypeKey=v; syncJson(ctx, mb, nodes);} , "Type wählen")));
      ad.appendChild(kv("Unit", inputText(a.unit ?? "", (v)=>{ a.unit=v; syncJson(ctx, mb, nodes);})));
      ad.appendChild(kv("Min", inputNumber(a.min ?? 0, (v)=>{ a.min=v; syncJson(ctx, mb, nodes);})));
      ad.appendChild(kv("Max", inputNumber(a.max ?? 100, (v)=>{ a.max=v; syncJson(ctx, mb, nodes);})));
      ad.appendChild(kv("Step", inputNumber(a.step ?? 1, (v)=>{ a.step=v; syncJson(ctx, mb, nodes);})));

      // dropdowns
      a.source = a.source ?? { kind:"modbus" };
      a.source.kind = "modbus";

      const blkOpts = (ep?.blocks ?? []).map((b)=>({ value: b.id, label: blockSummary(b) }));
      const regOpts = (() => {
        if (!blk) return [];
        const start = num(blk.start,0);
        const count = num(blk.count,0);
        const base = num(blk.base,0);
        const out=[];
        for (let i=0;i<count;i++) out.push({ value: String(start+i+base), label: String(start+i+base) });
        return out;
      })();

      ad.appendChild(kv("Endpoint", selectEl(epOpts, a.source.endpointId ?? "", (v)=>{ a.source.endpointId=v; a.source.blockId=null; a.source.register=null; renderAll(ctx, mb, nodes);} )));
      ad.appendChild(kv("Block", selectEl(blkOpts, a.source.blockId ?? "", (v)=>{ a.source.blockId=v; a.source.register=null; renderAll(ctx, mb, nodes);} )));
      ad.appendChild(kv("Register", selectEl(regOpts, a.source.register!=null?String(a.source.register):"", (v)=>{ a.source.register = v?Number(v):null; syncJson(ctx, mb, nodes);} )));

      ad.appendChild(kv("DataType", inputText(a.dataType ?? "uint16", (v)=>{ a.dataType=v; syncJson(ctx, mb, nodes);} )));
      ad.appendChild(kv("WordOrder", inputText(a.wordOrder ?? "be", (v)=>{ a.wordOrder=v; syncJson(ctx, mb, nodes);} )));
      ad.appendChild(kv("Scale", inputNumber(a.scale ?? 1, (v)=>{ a.scale=v; syncJson(ctx, mb, nodes);} )));
      ad.appendChild(kv("Offset", inputNumber(a.offset ?? 0, (v)=>{ a.offset=v; syncJson(ctx, mb, nodes);} )));

      ad.appendChild(el("button", { class: "btn danger", type: "button", onclick: () => {
        n.attributes.splice(ai, 1);
        renderAll(ctx, mb, nodes);
      }}, "Attribut entfernen"));

      nd.appendChild(ad);
    });

    nd.appendChild(el("button", { class: "btn danger", type: "button", onclick: () => {
      nodes.splice(ni, 1);
      renderAll(ctx, mb, nodes);
    }}, "Node entfernen"));

    root.appendChild(nd);
  });
}

function renderAll(ctx, mb, nodes) {
  renderModbus(ctx, mb, nodes);
  renderNodes(ctx, mb, nodes);
  syncJson(ctx, mb, nodes);
}

export async function init(ctx) {
  await ensureEnumsLoaded();
const cfg = ctx.cfg;
  const mb = ensureModbus(cfg);

  // Load nodes either from top-level cfg.nodes or from mb._nodes if present (compat)
  const nodes = ensureNodes(cfg);
  const mbNodes = Array.isArray(mb._nodes) ? mb._nodes : null;
  const nodesState = (mbNodes && mbNodes.length) ? mbNodes : nodes;

  renderAll(ctx, mb, nodesState);

  // Store nodes into mb._nodes so manager can extract without core webui changes.
  ctx.setCollector(() => {
    mb._nodes = nodesState;
    return { __targetKey: "modbus", value: mb };
  });
  wrapWithBadge(ctx, "#mb_enabled", "ModBus");
}
