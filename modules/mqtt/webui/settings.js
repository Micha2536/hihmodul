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

function wrapWithBadge(ctx, enabledSelector, title) {
  ensureBadgeStyles();
  const root = ctx.el;
  if (!root || root.dataset.vhihBadgeWrapped === "1") return;
  root.dataset.vhihBadgeWrapped = "1";

  const enabledEl = root.querySelector(enabledSelector);
  const enabled = !!enabledEl?.checked;

  const wrap = document.createElement("div");
  wrap.className = "vhihBadgeWrap";

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

  function setState(isOn) {
    badge.classList.toggle("ok", !!isOn);
    badge.classList.toggle("bad", !isOn);
    state.textContent = isOn ? "aktiv" : "inaktiv";
  }

  badge.addEventListener("click", () => {
    wrap.classList.toggle("expanded");
  });

  if (enabledEl) {
    enabledEl.addEventListener("change", () => setState(!!enabledEl.checked));
  }
}

/* ---------- enums (same approach as modbus) ---------- */

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
  const e = window.ENUMS?.[enumName];
  if (!e || typeof e !== "object") return [];
  return Object.keys(e).sort((a, b) => a.localeCompare(b));
}

function humanizeEnumKey(enumName, key) {
  // "CANodeProfileDimmableLight" -> "Dimmable Light"
  const stripped = key
    .replace(/^CA(AttributeType|NodeProfile)/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2");
  return stripped.trim() || key;
}

function enumGroup(enumName, label) {
  const has = (s) => label.includes(s);
  if (enumName === "CANodeProfile") {
    if (has("None") || has("Homee")) return "Allgemein";
    if (has("Sensor") || has("Temperature") || has("Humidity") || has("Brightness") || has("Pressure")) return "Sensoren";
    if (has("Shutter") || has("Open") || has("Close") || has("Window") || has("Blind")) return "Rolladen/Fenster";
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

/* ---------- tiny ui helpers ---------- */

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "text") n.textContent = v;
    else if (k === "onclick") n.addEventListener("click", v);
    else n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function kv(label, control) {
  return el("div", { class: "kv" }, el("div", { class: "k" }, label), el("div", { class: "v" }, control));
}

function inputText(value, onChange, optsOrPlaceholder = {}) {
  const opts = typeof optsOrPlaceholder === "string" ? { placeholder: optsOrPlaceholder } : (optsOrPlaceholder || {});
  const i = el("input", { class: "input", type: "text", value: value ?? "", placeholder: opts.placeholder ?? "" });
  i.addEventListener("input", () => onChange(i.value));
  return i;
}

function inputNumber(value, onChange, opts = {}) {
  const i = el("input", { class: "input", type: "number", value: String(value ?? ""), min: opts.min ?? "", max: opts.max ?? "" });
  i.addEventListener("input", () => onChange(Number(i.value)));
  return i;
}

function inputCheck(value, onChange) {
  const i = el("input", { type: "checkbox" });
  i.checked = !!value;
  i.addEventListener("change", () => onChange(!!i.checked));
  return i;
}

function selectEl(options, value, onChange) {
  const s = el("select", { class: "input" });
  for (const o of options) s.appendChild(el("option", { value: o.value, text: o.label }));
  s.value = value ?? "";
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

/* ---------- config shape ---------- */

const SECRET_MASK = "*****";

function ensureConfigShape(cfg) {
  cfg = cfg || {};
  cfg.nodes ??= [];
  cfg.mqtt ??= {};
  cfg.mqtt.nodes ??= [];
  return cfg;
}

function ensureMqttShape(cfg) {
  cfg = cfg || {};
  cfg.enabled ??= false;
  cfg.brokers ??= [];
  cfg.nodes ??= [];
  return cfg;
}

function ensureNodeShape(n) {
  n.id ??= "";
  n.name ??= "";
  n.profileKey ??= "CANodeProfileNone";
  n.attributes ??= [];
  return n;
}

function ensureAttrShape(a) {
  a.id ??= "";
  a.name ??= "";
  a.attrTypeKey ??= "CAAttributeTypeOnOff";
  a.unit ??= "";
  a.min ??= 0;
  a.max ??= 100;
  a.step ??= 1;
  a.writable ??= false;
  a.source ??= { kind: "mqtt" };
  a.source.kind = "mqtt";
  a.source.brokerId ??= "";
  a.source.topic ??= "";
  a.source.jsonPath ??= "";
  a.source.valueType ??= "string";
  a.source.qos ??= 0;
  a.source.retain ??= false;
  a.source.writeTopic ??= "";
  return a;
}

/* ---------- mqtt-only node separation ---------- */

function isMqttAttr(a) {
  return !!(a && a.source && a.source.kind === "mqtt");
}

function isMqttNode(n) {
  const attrs = Array.isArray(n?.attributes) ? n.attributes : [];
  if (attrs.length === 0) return String(n?.id || "").startsWith("mqtt");
  return attrs.some(isMqttAttr);
}

function migrateMqttNodes(cfg) {
  cfg = ensureConfigShape(cfg);
  const mqttCfg = ensureMqttShape(cfg.mqtt);

  // Move MQTT nodes out of global cfg.nodes into cfg.mqtt.nodes, so other module UIs don't pick them up.
  const keepGlobal = [];
  for (const n of cfg.nodes) {
    if (isMqttNode(n)) mqttCfg.nodes.push(n);
    else keepGlobal.push(n);
  }
  cfg.nodes = keepGlobal;

  // Move non-MQTT nodes accidentally stored under mqtt back into global cfg.nodes (never drop user data).
  const keepMqtt = [];
  for (const n of mqttCfg.nodes) {
    if (isMqttNode(n)) keepMqtt.push(n);
    else cfg.nodes.push(n);
  }
  mqttCfg.nodes = keepMqtt;
  cfg.mqtt = mqttCfg;
  return cfg;
}


/* ---------- render ---------- */

function syncJson(ctx, mqttCfg) {
  mqttCfg.nodes ??= [];
  const out = { mqtt: mqttCfg };
  const pre = ctx.el.querySelector("#mqtt_json");
  if (pre) pre.textContent = JSON.stringify(out, null, 2);

  ctx.setCollector(() => ({ __targetKey: "mqtt", value: mqttCfg }));
}

function renderAll(ctx, cfg) {
  cfg = ensureConfigShape(cfg);
  const mqttCfg = ensureMqttShape(cfg.mqtt);

  renderMqtt(ctx, mqttCfg);
  renderNodes(ctx, mqttCfg.nodes, mqttCfg);
  syncJson(ctx, mqttCfg);
}

function renderMqtt(ctx, mqttCfg) {
  const root = ctx.el.querySelector("#mqtt_form");
  root.innerHTML = "";

  const enabledId = "mqtt_enabled";
  const enabledEl = inputCheck(!!mqttCfg.enabled, (v) => { mqttCfg.enabled = v; syncJson(ctx, mqttCfg); });
  enabledEl.id = enabledId;

  const head = el("div", { class: "row" },
    el("label", {}, enabledEl, el("span", { style: "margin-left:8px" }, "MQTT aktivieren"))
  );

  const addBtn = el("button", { class: "primary", onclick: () => {
    mqttCfg.brokers.push({ id: `mqttBroker${mqttCfg.brokers.length + 1}`, enabled: true, name: "Broker", protocol:"mqtt", host:"localhost", port:1883, username:"", password:"" });
    renderAll(ctx, ctx.cfg);
  }}, "+ Broker");

  root.append(head, el("div", { class: "sep" }), el("div", { class:"row" }, addBtn));

  mqttCfg.brokers.forEach((b, idx) => {
    const box = el("div", { class: "box" });

    box.append(
      el("div", { class:"row" },
        el("strong", {}, `Broker ${idx+1}`),
        el("span", { class:"muted" }, b.id || "")
      ),
      kv("Enabled", inputCheck(b.enabled ?? true, (v)=>{ b.enabled=v; syncJson(ctx, mqttCfg);})),
      kv("ID", inputText(b.id ?? "", (v)=>{ b.id=v; syncJson(ctx, mqttCfg);} , {placeholder:"mqttBroker1"})),
      kv("Name", inputText(b.name ?? "", (v)=>{ b.name=v; syncJson(ctx, mqttCfg);} , {placeholder:"My Broker"})),
      kv("Protocol", selectEl([
        {value:"mqtt",label:"mqtt"},
        {value:"mqtts",label:"mqtts"},
        {value:"ws",label:"ws"},
        {value:"wss",label:"wss"},
      ], b.protocol ?? "mqtt", (v)=>{ b.protocol=v; syncJson(ctx, mqttCfg);})),
      kv("Host", inputText(b.host ?? "", (v)=>{ b.host=v; syncJson(ctx, mqttCfg);} , {placeholder:"localhost"})),
      kv("Port", inputNumber(b.port ?? 1883, (v)=>{ b.port=v; syncJson(ctx, mqttCfg);}, {min:1,max:65535})),
      kv("Username", inputText(b.username ?? "", (v)=>{ b.username=v; syncJson(ctx, mqttCfg);})),
      kv("Password", inputText((b.password && b.password !== SECRET_MASK) ? b.password : "", (v)=>{ b.password=v; syncJson(ctx, mqttCfg);} , {placeholder:"(optional)"})),
      el("div", { class:"row" },
        el("button", { class:"bad", onclick:()=>{ mqttCfg.brokers.splice(idx,1); renderAll(ctx, ctx.cfg);} }, "Remove")
      )
    );

    root.append(el("div",{class:"sep"}), box);
  });

  wrapWithBadge(ctx, `#${enabledId}`, "MQTT");
}

function renderNodes(ctx, nodes, mqttCfg) {
  const root = ctx.el.querySelector("#nodes_form");
  root.innerHTML = "";

  const brokerOpts = [{ value:"", label:"(select)" }, ...(mqttCfg.brokers ?? []).map((b)=>({value:b.id,label:`${b.name||b.id} (${b.id})`}))];

  const addNodeBtn = el("button", { class:"primary", onclick:()=>{
    nodes.push({ id:`mqttNode${nodes.length+1}`, name:`MQTT Node ${nodes.length+1}`, profileKey:"CANodeProfileNone", attributes:[] });
    renderAll(ctx, ctx.cfg);
  }}, "+ Node");

  root.append(el("div",{class:"row"}, el("strong",{}, "Nodes (MQTT Attributes)"), addNodeBtn));

  nodes.forEach((n, ni) => {
    ensureNodeShape(n);

    const box = el("div", { class:"box" });
    box.append(
      el("div",{class:"row"},
        el("strong",{}, `Node ${ni+1}`),
        el("span",{class:"muted"}, n.id||"")
      ),
      kv("Node ID", inputText(n.id, (v)=>{ n.id=v; syncJson(ctx, mqttCfg);} , {placeholder:"mqttNode1"})),
      kv("Name", inputText(n.name, (v)=>{ n.name=v; syncJson(ctx, mqttCfg);} , {placeholder:"My Node"})),
      kv("Profile", selectEnum("CANodeProfile", n.profileKey, (v)=>{ n.profileKey=v; syncJson(ctx, mqttCfg); }, "(select)")),
    );

    const addAttrBtn = el("button", { class:"primary", onclick:()=>{
      n.attributes.push({
        id:`mqttAttr${(n.attributes?.length||0)+1}`,
        name:`Topic`,
        attrTypeKey:"CAAttributeTypeOnOff",
        unit:"",
        min:0,max:100,step:1,
        writable:false,
        source:{ kind:"mqtt", brokerId:"", topic:"", jsonPath:"", valueType:"string", qos:0, retain:false, writeTopic:"" }
      });
      renderAll(ctx, ctx.cfg);
    }}, "+ Attribute");

    box.append(el("div",{class:"row"}, addAttrBtn));

    (n.attributes ?? []).forEach((a, ai) => {
      ensureAttrShape(a);

      const ad = el("div", { class:"box", style:"margin-top:10px;padding:10px" });

      ad.append(
        el("div",{class:"row"},
          el("strong",{}, `Attr ${ai+1}`),
          el("span",{class:"muted"}, a.id||"")
        ),
        kv("Attr ID", inputText(a.id, (v)=>{ a.id=v; syncJson(ctx, mqttCfg);} , {placeholder:"mqttAttr1"})),
        kv("Name", inputText(a.name, (v)=>{ a.name=v; syncJson(ctx, mqttCfg);} , {placeholder:"temp"})),
        kv("Type", selectEnum("CAAttributeType", a.attrTypeKey, (v)=>{ a.attrTypeKey=v; syncJson(ctx, mqttCfg); }, "(select)")),
        kv("Unit", inputText(a.unit, (v)=>{ a.unit=v; syncJson(ctx, mqttCfg);} , {placeholder:"°C"})),
        kv("Writable", inputCheck(!!a.writable, (v)=>{ a.writable=v; syncJson(ctx, mqttCfg);})),
        el("div",{class:"sep"}),
        el("div",{class:"muted"}, "MQTT Source"),
        kv("Broker", selectEl(brokerOpts, a.source.brokerId ?? "", (v)=>{ a.source.brokerId=v; syncJson(ctx, mqttCfg);})),
        kv("Topic (sub)", inputText(a.source.topic ?? "", (v)=>{ a.source.topic=v; syncJson(ctx, mqttCfg);} , {placeholder:"home/sensor/temp"})),
        kv("JSONPath", inputText(a.source.jsonPath ?? "", (v)=>{ a.source.jsonPath=v; syncJson(ctx, mqttCfg);} , {placeholder:"payload.value"})),
        kv("ValueType", selectEl([
          {value:"string",label:"string"},
          {value:"int",label:"int"},
          {value:"float",label:"float"},
          {value:"bool",label:"bool"},
          {value:"json",label:"json"},
        ], a.source.valueType ?? "string", (v)=>{ a.source.valueType=v; syncJson(ctx, mqttCfg);})),
        kv("QoS", selectEl([{value:"0",label:"0"},{value:"1",label:"1"},{value:"2",label:"2"}], String(a.source.qos ?? 0), (v)=>{ a.source.qos=Number(v); syncJson(ctx, mqttCfg);})),
        kv("Retain", inputCheck(!!a.source.retain, (v)=>{ a.source.retain=v; syncJson(ctx, mqttCfg);})),
        kv("Write Topic", inputText(a.source.writeTopic ?? "", (v)=>{ a.source.writeTopic=v; syncJson(ctx, mqttCfg);} , {placeholder:"(optional) home/sensor/temp/set"})),
        el("div",{class:"row"},
          el("button",{class:"bad", onclick:()=>{ n.attributes.splice(ai,1); renderAll(ctx, ctx.cfg);} }, "Remove Attr")
        )
      );

      box.append(ad);
    });

    box.append(el("div",{class:"row"},
      el("button",{class:"bad", onclick:()=>{ nodes.splice(ni,1); renderAll(ctx, ctx.cfg);} }, "Remove Node")
    ));

    root.append(el("div",{class:"sep"}), box);
  });
}

export async function init(ctx) {
  await ensureEnumsLoaded();
  ctx.cfg = migrateMqttNodes(ctx.cfg || {});
  renderAll(ctx, ctx.cfg);
}