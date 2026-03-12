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
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (v !== undefined) n.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function asBool(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function num(v, dflt = null) { const n = Number(v); return Number.isFinite(n) ? n : dflt; }

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!res.ok) throw new Error(data?.error ?? data?.message ?? txt ?? res.statusText);
  return data;
}

function ensure(cfg) {
  cfg.shelly = cfg.shelly ?? {};
  const sh = cfg.shelly;
  sh.enabled = sh.enabled ?? false;
  sh.realtimeWs = sh.realtimeWs ?? true;
  sh.pollMs = sh.pollMs ?? 5000;
  sh.devices = Array.isArray(sh.devices) ? sh.devices : [];
  return sh;
}

const state = { found: [] };

function sync(ctx) {
  ctx.setCollector(() => ({ __targetKey: "shelly", value: ctx.cfg.shelly }));
  const ta = document.getElementById("sh_json");
  if (ta) ta.value = JSON.stringify(ctx.cfg.shelly, null, 2);
}

function render(ctx) {
  const sh = ensure(ctx.cfg);
  const root = document.getElementById("sh_form");
  root.innerHTML = "";

  /*
  root.appendChild(el("div", { class: "kv" },
    el("label", { text: "Shelly aktiv" }),
    (() => {
      const i = el("input", { type: "checkbox" });
      i.checked = !!sh.enabled;
      i.addEventListener("change", () => { sh.enabled = i.checked; sync(ctx); });
      return i;
    })()
  ));
  */
 root.appendChild(el("div", { class: "kv" },
  el("label", { text: "Shelly aktiv" }),
  (() => {
    const i = el("input", { type: "checkbox", id: "sh_enabled" }); // 👈 ID hinzufügen
    i.checked = !!sh.enabled;
    i.addEventListener("change", () => { sh.enabled = i.checked; sync(ctx); });
    return i;
  })()
));

  root.appendChild(el("div", { class: "kv" },
    el("label", { text: "Realtime WS (best-effort)" }),
    (() => {
      const i = el("input", { type: "checkbox" });
      i.checked = !!sh.realtimeWs;
      i.addEventListener("change", () => { sh.realtimeWs = i.checked; sync(ctx); });
      return i;
    })()
  ));

  root.appendChild(el("div", { class: "kv" },
    el("label", { text: "Polling (ms)" }),
    (() => {
      const i = el("input", { type: "number", value: String(sh.pollMs ?? 5000) });
      i.addEventListener("input", () => { sh.pollMs = Math.max(1000, num(i.value, 5000)); sync(ctx); });
      return i;
    })()
  ));

  root.appendChild(el("div", { class: "sep" }));

  // Discovery
  const scanBtn = el("button", { class: "btn", type: "button", text: "Scan", onclick: async () => {
    scanBtn.disabled = true;
    try {
      const r = await api("/api/shelly/scan", { method: "POST", body: JSON.stringify({ timeoutMs: 2500 }) });
      state.found = r.devices ?? [];
      render(ctx);
    } catch (e) {
      alert("Scan Fehler: " + (e?.message ?? e));
    } finally {
      scanBtn.disabled = false;
    }
  }});
  root.appendChild(el("div", { class: "row" }, scanBtn, el("span", { class: "muted", text: "mDNS via avahi-browse, sonst manuell hinzufügen." })));

  const foundBox = el("div", {});
  for (const f of state.found) {
    foundBox.appendChild(el("div", { class: "row" },
      el("span", { text: `${f.name ?? "Shelly"} — ${f.ip}` }),
      el("button", { class: "btn", type: "button", text: "Übernehmen", onclick: () => {
        if (sh.devices.some(d => d.ip === f.ip)) return;
        sh.devices.push({ enabled: true, name: f.name ?? "Shelly", ip: f.ip, channels: 1, switchId: 0, includePower: true, includeEnergy: false });
        sync(ctx);
        render(ctx);
      }})
    ));
  }
  root.appendChild(foundBox);

  root.appendChild(el("div", { class: "sep" }));

  // Selected devices
  root.appendChild(el("div", { class: "row" },
    el("h3", { text: "Geräte" }),
    el("button", { class: "btn", type: "button", text: "+ Manuell", onclick: () => {
      sh.devices.push({ enabled: true, name: "", ip: "", channels: 1, switchId: 0, includePower: true, includeEnergy: false, _open: true });
      sync(ctx);
      render(ctx);
    }})
  ));

  sh.devices.forEach((d, idx) => {
    const det = el("details", { class: "card" });
    if (d._open) det.open = true;
    det.appendChild(el("summary", { text: `${d.name || d.ip || "Shelly"} — ${d.ip || ""}` }));

    const body = el("div", {});
    body.appendChild(el("div", { class: "kv" }, el("label", { text: "Enabled" }), (() => {
      const i = el("input", { type: "checkbox" }); i.checked = !!d.enabled;
      i.addEventListener("change", () => { d.enabled = i.checked; sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "kv" }, el("label", { text: "Name" }), (() => {
      const i = el("input", { type: "text", value: d.name ?? "" });
      i.addEventListener("input", () => { d.name = i.value; sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "kv" }, el("label", { text: "IP" }), (() => {
      const i = el("input", { type: "text", value: d.ip ?? "" });
      i.addEventListener("input", () => { d.ip = i.value.trim(); sync(ctx); });
      return i;
    })()));

    
    body.appendChild(el("div", { class: "kv" }, el("label", { text: "Channels" }), (() => {
      const i = el("input", { type: "number", value: String(d.channels ?? 1) });
      i.addEventListener("input", () => { d.channels = Math.max(1, num(i.value, 1) ?? 1); sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "kv" }, el("label", { text: "SwitchId (fallback)" }), (() => {
      const i = el("input", { type: "number", value: String(d.switchId ?? 0) });
      i.addEventListener("input", () => { d.switchId = num(i.value, 0) ?? 0; sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "kv" }, el("label", { text: "Power" }), (() => {
      const i = el("input", { type: "checkbox" }); i.checked = !!d.includePower;
      i.addEventListener("change", () => { d.includePower = i.checked; sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "kv" }, el("label", { text: "Energy" }), (() => {
      const i = el("input", { type: "checkbox" }); i.checked = !!d.includeEnergy;
      i.addEventListener("change", () => { d.includeEnergy = i.checked; sync(ctx); });
      return i;
    })()));

    body.appendChild(el("div", { class: "row" },
      el("button", { class: "btn danger", type: "button", text: "Entfernen", onclick: () => {
        sh.devices.splice(idx, 1);
        sync(ctx);
        render(ctx);
      }})
    ));

    det.appendChild(body);
    root.appendChild(det);
  });

  sync(ctx);
}

export async function init(ctx) {
  ensure(ctx.cfg);
  render(ctx);
wrapWithBadge(ctx, "#sh_enabled", "Shelly");
}
