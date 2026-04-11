function ensureStyles() {
  if (document.getElementById("vhihHomeeDebugStyles")) return;
  const s = document.createElement("style");
  s.id = "vhihHomeeDebugStyles";
  s.textContent = `
    .vhihCard{border:1px solid #3333;border-radius:10px;padding:12px;background:#0b0b0b0a}
    .vhihCardTitle{font-weight:700;margin-bottom:8px}
    .vhihCardBody{padding:2px 0}
    .muted{opacity:.75}
    .btnPrimary{padding:8px 12px;border-radius:8px;border:1px solid #3336;background:#1f6feb;color:white;cursor:pointer}
    .btnPrimary:hover{filter:brightness(1.05)}
  `;
  document.head.appendChild(s);
}

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

/**
 * Wrap the module UI with a collapsible badge header (Demo-style).
 * - Click badge toggles expanded/collapsed.
 * - No enabled checkbox needed for tools; badge stays "ok".
 */
function wrapWithBadge(ctx, title) {
  ensureBadgeStyles();

  const root = ctx.el;
  if (!root || root.dataset.vhihBadgeWrapped === "1") return;
  root.dataset.vhihBadgeWrapped = "1";

  const wrap = document.createElement("div");
  wrap.className = "vhihBadgeWrap";

  const badge = document.createElement("div");
  badge.className = "vhihBadge ok";

  const dot = document.createElement("span");
  dot.className = "vhihBadgeDot";

  const name = document.createElement("strong");
  name.textContent = title || "Modul";

  const state = document.createElement("span");
  state.className = "muted";
  state.setAttribute("data-badge-text", "1");
  state.textContent = "Tool";

  badge.append(dot, name, state);

  const body = document.createElement("div");
  body.className = "vhihBadgeBody";

  while (root.firstChild) body.appendChild(root.firstChild);

  wrap.append(badge, body);
  root.appendChild(wrap);

  badge.addEventListener("click", () => wrap.classList.toggle("expanded"));
}

export async function init(ctx) {
  ensureStyles();

  const baseUrl = `${location.origin}/modules/homee_debug/site/index.html`;
  const btn = ctx.el.querySelector("#openHomeeToolBtn");
  const hint = ctx.el.querySelector("#homeeToolHint");

  if (hint) hint.textContent = `Lokaler Pfad: ${baseUrl}`;

  if (btn) {
    btn.addEventListener("click", () => {
      window.open(baseUrl, "_blank", "noopener,noreferrer");
    });
  }

  // Demo-style collapsible badge wrapper
  wrapWithBadge(ctx, "homee Debug");
}
