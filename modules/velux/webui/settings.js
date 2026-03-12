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


export async function init(ctx) {
  const cfg = ctx.cfg;
  const v = cfg.velux ?? {};
  ctx.el.querySelector("#velux_enabled").checked = v.enabled === true;
  ctx.el.querySelector("#velux_email").value = v.email ?? cfg.velux_name ?? "";
  ctx.el.querySelector("#velux_password").value = v.password ?? cfg.velux_pw ?? "";
  ctx.el.querySelector("#velux_poll").value = Number(v.pollSec ?? 30);

  ctx.setCollector(() => {
    return {
      enabled: ctx.el.querySelector("#velux_enabled").checked,
      email: ctx.el.querySelector("#velux_email").value.trim(),
      password: ctx.el.querySelector("#velux_password").value,
      pollSec: Number(ctx.el.querySelector("#velux_poll").value || 30),
    };
  });
  wrapWithBadge(ctx, "#velux_enabled", "Velux");
}
