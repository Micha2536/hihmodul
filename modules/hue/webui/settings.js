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

export function stableStringify(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(stableStringify).join(",") + "]";
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.appendChild(c);
  return e;
}

function deviceHasServiceTypes(dev, types) {
  const svcs = Array.isArray(dev?.services) ? dev.services : [];
  const set = new Set(svcs.map((s) => String(s?.rtype ?? s?.type ?? "").toLowerCase()).filter(Boolean));
  for (const t of types) if (set.has(String(t).toLowerCase())) return true;
  return false;
}

function isSensorDevice(dev) {
  // Hue device discovery returns both lights and sensors.
  // Sensors are the ones with id_v1 under /sensors/.. (e.g. /sensors/00).
  const idv1 = String(dev?.id_v1 ?? "");
  if (idv1.startsWith("/sensors/")) return true;
  if (idv1.startsWith("/lights/")) return false;

  // Fallback for devices without id_v1: exclude lights/bridge-like.
  const svcs = Array.isArray(dev?.services) ? dev.services : [];
  const types = svcs.map((s) => String(s?.rtype ?? s?.type ?? "").toLowerCase()).filter(Boolean);
  if (!types.length) return false;
  if (types.includes("light")) return false;
  if (types.includes("bridge")) return false;

  const sensorish = new Set([
    "motion",
    "temperature",
    "light_level",
    "button",
    "relative_rotary",
    "contact",
    "device_power",
    "zigbee_connectivity",
    "battery",
    "tamper",
    "switch",
    "behavior_instance",
    "zgp_connectivity",
  ]);
  return types.some((t) => sensorish.has(t));
}

export async function init(ctx) {
  const cfg = ctx.cfg;
  const h = cfg.hue ?? {};
  const enabled = h.enabled === true || (!!h.ip && !!h.key) || (!!cfg.ip && !!cfg.key);

  ctx.el.querySelector("#hue_enabled").checked = enabled;
  ctx.el.querySelector("#hue_ip").value = h.ip ?? cfg.ip ?? "";
  ctx.el.querySelector("#hue_key").value = h.key ?? cfg.key ?? "";

const btnLink = ctx.el.querySelector("#btn_link");
const keyState = ctx.el.querySelector("#hue_key_state");
const msg1 = ctx.el.querySelector("#hue_msg"); // existiert schon in deinem HTML

const refreshKeyState = () => {
  const hasKey = (ctx.el.querySelector("#hue_key").value || "").trim().length > 0;
  keyState.textContent = hasKey ? "Token vorhanden – bitte speichern" : "";
};
refreshKeyState();

btnLink?.addEventListener("click", async () => {
  const ip = (ctx.el.querySelector("#hue_ip").value || "").trim();
  if (!ip) {
    msg1.textContent = "Bitte Bridge IP eintragen.";
    return;
  }

  btnLink.disabled = true;
  msg1.textContent = "Link-Button an der Bridge drücken… Token wird geholt…";

  try {
    // Option A: wenn ctx.api POST kann
    let data = null;
    try {
      data = await ctx.api("/api/hue/link", {
        method: "POST",
        body: JSON.stringify({ ip }),
      });
    } catch {
      // Option B: fallback per fetch (funktioniert immer)
      const r = await fetch("/api/hue/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ip }),
      });
      data = await r.json();
      if (!r.ok) throw new Error(data?.error || "Token holen fehlgeschlagen");
    }

    if (data?.ok && data?.username) {
      ctx.el.querySelector("#hue_key").value = data.username;
      msg1.textContent = "Token erhalten – bitte speichern!";
    } else {
      msg1.textContent = data?.error ?? "Kein Token erhalten (Link-Button gedrückt?)";
    }
  } catch (e) {
    msg1.textContent = e?.message ?? String(e);
  } finally {
    btnLink.disabled = false;
    refreshKeyState();
  }
});

  const groupsSel = new Set(Object.keys(h.groups ?? {}).filter((k) => h.groups[k] === true));
  const lightsSel = new Set(Object.keys(h.lights ?? {}).filter((k) => h.lights[k] === true));
  const sensorsSel = new Set(Object.keys(h.sensors ?? {}).filter((k) => (h.sensors ?? {})[k] === true));
  const legacyExtrasSel = h.extras ?? {}; // legacy { rtype: { rid: true } }

  const msg = ctx.el.querySelector("#hue_msg");
  const groupsBox = ctx.el.querySelector("#groups_box");
  const lightsBox = ctx.el.querySelector("#lights_box");
  const extrasBox = ctx.el.querySelector("#extras_box");

  function renderLights(list) {
    lightsBox.innerHTML = "";
    const wrap = el("div");
    for (const d of list) {
      const id = String(d.id_v1 ?? d.id ?? "");
      const name = d.name ?? id;
      const cb = el("input", { type: "checkbox" });
      cb.checked = lightsSel.has(id);
      cb.addEventListener("change", () => {
        if (cb.checked) lightsSel.add(id);
        else lightsSel.delete(id);
      });
      const line = el("div", {}, [
        cb,
        el("span", { style: "margin-left:8px", text: name + " (" + id + ")" }),
      ]);
      wrap.appendChild(line);
    }
    lightsBox.appendChild(wrap);
  }

  function ensureType(type) {
    extrasSel[type] = extrasSel[type] ?? {};
    return extrasSel[type];
  }

  function renderExtras(payload) {
    extrasBox.innerHTML = "";
    let devices = (payload?.devices ?? []).filter((d) => isSensorDevice(d));
    if (!devices.length && Array.isArray(payload?.extras)) {
      const byOwner = new Map();
      for (const e of payload.extras) {
        const owner = e.ownerRid ?? "unknown";
        const arr = byOwner.get(owner) ?? [];
        arr.push({ rid: e.rid, rtype: e.type });
        byOwner.set(owner, arr);
      }
      devices = [...byOwner.entries()].map(([ownerRid, services]) => ({ id: ownerRid, name: ownerRid, services }))
      .filter((d) => !(Array.isArray(d.services) && d.services.some((s) => String(s?.rtype ?? s?.type ?? "").toLowerCase() === "light")));
    }

    // Backward compat: if no sensors selected yet but legacy extras exist, preselect device when any service rid is selected.
    const legacySelectedServiceRids = new Set(
      Object.values(legacyExtrasSel ?? {}).flatMap((m) =>
        Object.keys(m ?? {}).filter((rid) => (m ?? {})[rid] === true)
      )
    );

    const container = el("div");
    if (!devices.length) {
      container.appendChild(el("div", { class: "muted", text: "—" }));
      extrasBox.appendChild(container);
      return;
    }

    for (const dev of devices) {
      const rid = String(dev.id ?? dev.rid ?? dev.ownerRid ?? "");
      const title = dev.name ?? rid;

      const cb = el("input", { type: "checkbox" });
      const legacyHit = (dev.services ?? []).some((s) => legacySelectedServiceRids.has(String(s.rid)));
      cb.checked = sensorsSel.has(rid) || (!sensorsSel.size && legacyHit);

      cb.addEventListener("change", () => {
        if (cb.checked) sensorsSel.add(rid);
        else sensorsSel.delete(rid);
      });

      container.appendChild(
        el("div", {}, [
          cb,
          el("span", { style: "margin-left:8px", text: `${title} (${rid})` }),
        ])
      );
    }

    extrasBox.appendChild(container);
  }


function renderGroups(payload) {
  groupsBox.innerHTML = "";
  const rooms = payload?.rooms ?? [];
  const zones = payload?.zones ?? [];
  const container = el("div");

  function addSection(title, list) {
    const sec = el("div", { style: "margin:8px 0" });
    sec.appendChild(el("div", { text: title, style: "font-weight:600;margin-bottom:6px" }));
    if (!list.length) {
      sec.appendChild(el("div", { class: "muted", text: "—" }));
      container.appendChild(sec);
      return;
    }
    for (const g of list) {
      const id = String(g.id);
      const name = g.name ?? id;
      const cb = el("input", { type: "checkbox" });
      cb.checked = groupsSel.has(id);
      cb.addEventListener("change", () => {
        if (cb.checked) groupsSel.add(id);
        else groupsSel.delete(id);
      });
      sec.appendChild(el("div", {}, [
        cb,
        el("span", { style: "margin-left:8px", text: name + " (" + id + ")" }),
      ]));
    }
    container.appendChild(sec);
  }

  addSection("Räume", rooms);
  addSection("Zonen", zones);

  groupsBox.appendChild(container);
}

async function loadGroups() {
  msg.textContent = "lade gruppen…";
  const r = await ctx.api("/api/hue/groups");
  renderGroups(r);
  msg.textContent = "";
}

  async function loadLights() {
    msg.textContent = "lade lampen…";
    const r = await ctx.api("/api/hue/lights");
    renderLights(r?.lights ?? r?.data ?? []);
    msg.textContent = "";
  }

  async function loadSensors() {
    msg.textContent = "lade sensor devices…";
    const r = await ctx.api("/api/hue/sensor_devices");
    renderExtras(r);
    msg.textContent = "";
  }

  ctx.el.querySelector("#btn_groups").addEventListener("click", () => {
    loadGroups().catch((e) => (msg.textContent = e.message));
  });
  ctx.el.querySelector("#btn_lights").addEventListener("click", () => {
    loadLights().catch((e) => (msg.textContent = e.message));
  });
  ctx.el.querySelector("#btn_sensors").addEventListener("click", () => {
    loadSensors().catch((e) => (msg.textContent = e.message));
  });
  ctx.el.querySelector("#btn_save_sel").addEventListener("click", () => {
    msg.textContent = "Auswahl wird beim Speichern übernommen.";
    setTimeout(() => (msg.textContent = ""), 1200);
  });

  ctx.setCollector(() => {
    const ip = ctx.el.querySelector("#hue_ip").value.trim();
    const key = ctx.el.querySelector("#hue_key").value.trim();
    return {
      enabled: ctx.el.querySelector("#hue_enabled").checked,
      ip,
      key,
      groups: Object.fromEntries([...groupsSel].map((id) => [id, true])),
      lights: Object.fromEntries([...lightsSel].map((id) => [id, true])),
      sensors: Object.fromEntries([...sensorsSel].map((rid) => [rid, true])),
    };
  });
  wrapWithBadge(ctx, "#hue_enabled", "Hue");
}
