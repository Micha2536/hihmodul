import http from "node:http";
import https from "node:https";
import HueSse from "./HueSse.mjs";

function asBool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function clamp(x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function parseV1Id(path, kind) {
  if (!path || typeof path !== "string") return null;
  const m = path.match(new RegExp(`\\/${kind}\\/(\\d+)`));
  return m ? m[1] : null;
}

// Hue xy -> RGB int (0..16777215) for Homee Color attribute
function xyToRgbInt(x, y, bri01 = 1) {
  const z = 1.0 - x - y;
  const Y = bri01;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  let r =  1.656492 * X - 0.354851 * Y - 0.255038 * Z;
  let g = -0.707196 * X + 1.655397 * Y + 0.036152 * Z;
  let b =  0.051713 * X - 0.121364 * Y + 1.011530 * Z;

  const gamma = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
  r = gamma(Math.max(0, r));
  g = gamma(Math.max(0, g));
  b = gamma(Math.max(0, b));

  const R = clamp(Math.round(r * 255), 0, 255);
  const G = clamp(Math.round(g * 255), 0, 255);
  const B = clamp(Math.round(b * 255), 0, 255);
  return (R << 16) | (G << 8) | B;
}

function log(rt, ...args) {
  if (rt?.log) rt.log(...args);
  else console.log(...args);
}

function httpJson({ method, host, path, body, timeoutMs = 4000 }) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body), "utf-8") : null;

    const req = http.request(
      {
        method,
        host,
        path,
        timeout: timeoutMs,
        headers: {
          "content-type": "application/json",
          ...(payload ? { "content-length": String(payload.length) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            const json = text ? JSON.parse(text) : null;
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(`HTTP ${res.statusCode}: ${text}`));
          } catch {
            reject(new Error(`Invalid JSON (${res.statusCode}): ${text}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));

    if (payload) req.write(payload);
    req.end();
  });
}

function hueV2Json(ip, appKey, pathName) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: ip,
        path: pathName,
        method: "GET",
        rejectUnauthorized: false,
        headers: { "hue-application-key": appKey },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          try {
            const json = JSON.parse(text);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
            else reject(new Error(`Hue v2 HTTP ${res.statusCode}: ${text}`));
          } catch (e) {
            reject(new Error(`Hue v2 invalid JSON: ${text}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}



async function pollSelectedExtrasOnce(rt, hueCfg) {
  const debug = process.env.DEBUG_HUE === "1";
  const ip = hueCfg.ip;
  const key = hueCfg.key;
  if (!ip || !key) return;

  const extras = hueCfg.extras ?? {};
  const selected = (type, rid) => extras?.[type]?.[rid] === true;

  const now = Date.now();
  const emit = (type, rid, action, value) => {
    if (!selected(type, rid)) return;
    const nodeKey = `hue|extra|${type}|${rid}`;
    let attrKey = null;
    if (type === "button") attrKey = `${nodeKey}|state`;
    else if (type === "motion") attrKey = `${nodeKey}|motion`;
    else if (type === "temperature") attrKey = `${nodeKey}|temperature`;
    else if (type === "light_level") attrKey = `${nodeKey}|lux`;
    else if (type === "device_power") attrKey = `${nodeKey}|battery`;
    else return;

    rt.emitTelemetry({ attrKey, value, ts: now });
  };

  const fetchType = async (type) => {
    try {
      const payload = await hueV2Json(ip, key, `/clip/v2/resource/${type}`);
      const arr = payload?.data ?? [];
      if (debug) console.log("[hue] poll extras", type, "items", arr.length);

      for (const msg of arr) {
        const rid = msg.id;
        if (!selected(type, rid)) continue;

        if (type === "device_power" && msg.power_state?.battery_level != null) {
          emit(type, rid, "battery", Number(msg.power_state.battery_level));
        } else if (type === "temperature" && msg.temperature?.temperature != null) {
          emit(type, rid, "temperature", Number(msg.temperature.temperature));
        } else if (type === "light_level" && msg.light?.light_level != null) {
          emit(type, rid, "lux", Number(msg.light.light_level));
        } else if (type === "motion" && typeof msg.motion?.motion === "boolean") {
          emit(type, rid, "motion", msg.motion.motion ? 1 : 0);
        } else if (type === "button") {
          // no stable current state; keep as 0 on poll
          emit(type, rid, "state", 0);
        }
      }
    } catch (e) {
      log(rt, "[hue] poll extras error", type, e?.message ?? e);
    }
  };

  // Poll only the types we support (no rotation)
  await fetchType("device_power");
  await fetchType("temperature");
  await fetchType("light_level");
  await fetchType("motion");
  await fetchType("button");

  // Connectivity: update node.state if selected (optional; uses owner.rid mapping)
  try {
    const payload = await hueV2Json(ip, key, `/clip/v2/resource/zigbee_connectivity`);
    const arr = payload?.data ?? [];
    for (const msg of arr) {
      const rid = msg.id;
      if (!selected("zigbee_connectivity", rid)) continue;
      const connected = msg.status === "connected";
      // owner.rid refers to the owning device; core should resolve node by this rid mapping.
      rt.setHueConnectivity?.(msg.owner?.rid, connected ? 1 : 0);
    }
  } catch (e) {
    log(rt, "[hue] poll extras error", "zigbee_connectivity", e?.message ?? e);
  }
}

function hsvToRgb(h, s, v) {
  // h,s,v: 0..1
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);

  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function hueSatToRgbInt(hue, sat, bri = 254) {
  const h = clamp(Number(hue) / 65535, 0, 1);
  const s = clamp(Number(sat) / 254, 0, 1);
  const v = clamp(Number(bri) / 254, 0, 1);
  const [r, g, b] = hsvToRgb(h, s, v);
  return (r << 16) + (g << 8) + b;
}

function pctFromHueBri(bri) {
  const b = Number.isFinite(bri) ? bri : 0;
  return clamp(Math.round((b / 254) * 100 * 100) / 100, 0, 100); // 2 decimals
}

function hueBriFromPct(pct) {
  const p = clamp(Number(pct), 0, 100);
  return clamp(Math.round((p / 100) * 254), 0, 254);
}

const COLOR_PALETTE_DATA = "7001020%3B16419669%3B12026363%3B16525995";

function groupIncluded(gid, g, rooms, zones, debug) {
  const t = String(g?.type ?? "").toLowerCase();
  const isRoom = t === "room";
  const isZone = t === "zone";
  const include = (isRoom && asBool(rooms?.[String(gid)])) || (isZone && asBool(zones?.[String(gid)]));
  if (debug) {
    console.log("[hue] group", gid, { name: g?.name, type: g?.type, include, roomSel: rooms?.[String(gid)], zoneSel: zones?.[String(gid)] });
  }
  return include;
}

function lightIncluded(lid, lightsSel, includeAllLights, debug) {
  const include = includeAllLights || asBool(lightsSel?.[String(lid)]);
  if (debug) console.log("[hue] light", lid, { include, selected: lightsSel?.[String(lid)], includeAllLights });
  return include;
}

function mkGroupNodeDef(rt, gid, g) {
  const nodeKey = `hue|group|${gid}`;

  const onValue = g?.state?.any_on ? 1 : 0;
  const hasDim = Number.isFinite(g?.action?.bri);
  const briPct = hasDim ? pctFromHueBri(g.action.bri) : 0;

  const hasCt = Number.isFinite(g?.action?.ct);
  const ctMin = 153;
  const ctMax = 555;
  const ct = hasCt ? g.action.ct : ctMin;

  const hasColor = Number.isFinite(g?.action?.hue) && Number.isFinite(g?.action?.sat);
  const color = hasColor ? hueSatToRgbInt(g.action.hue, g.action.sat, hasDim ? g.action.bri : 254) : 0;

  // Profile: only expose what exists
  const profileKey = (hasColor || hasCt) ? "CANodeProfileDimmableExtendedColorLight"
                   : hasDim ? "CANodeProfileDimmableLight"
                   : "CANodeProfileOnOffPlug";

  const attrs = [];

  // On/Off is always available for a group
  attrs.push({
    attrKey: `${nodeKey}|on`,
    name: "On",
    attrTypeKey: "CAAttributeTypeOnOff",
    unit: "",
    min: 0,
    max: 1,
    step: 1,
    writable: true,
    currentValue: onValue,
    deviceRef: { kind: "group", groupId: String(gid), action: "on" },
  });

  if (hasDim) {
    attrs.push({
      attrKey: `${nodeKey}|dim`,
      name: "Dimmer",
      attrTypeKey: "CAAttributeTypeDimmingLevel",
      unit: "%25",
      min: 0,
      max: 100,
      step: 1,
      writable: true,
      currentValue: briPct,
      deviceRef: { kind: "group", groupId: String(gid), action: "bri" },
    });
  }

  if (hasColor) {
    attrs.push({
      attrKey: `${nodeKey}|color`,
      name: "Color",
      attrTypeKey: "CAAttributeTypeColor",
      unit: "",
      min: 0,
      max: 16777215,
      step: 1,
      writable: true,
      currentValue: color,
      data: COLOR_PALETTE_DATA,
      deviceRef: { kind: "group", groupId: String(gid), action: "color" },
    });
  }

  if (hasCt) {
    attrs.push({
      attrKey: `${nodeKey}|ct`,
      name: "CT",
      attrTypeKey: "CAAttributeTypeColorTemperature",
      unit: "ct",
      min: ctMin,
      max: ctMax,
      step: 1,
      writable: true,
      currentValue: ct,
      deviceRef: { kind: "group", groupId: String(gid), action: "ct" },
    });
  }

  // Identify only if Hue API exposes alert control (group action supports it on bridges)
  // Keep it for groups, but it does not set any "data" field.
  attrs.push({
    attrKey: `${nodeKey}|identify`,
    name: "Identifikation",
    attrTypeKey: "CAAttributeTypeIdentification",
    unit: "",
    min: 0,
    max: 1,
    step: 1,
    writable: true,
    currentValue: 0,
    deviceRef: { kind: "group", groupId: String(gid), action: "identify" },
  });

  return {
    nodeKey,
    moduleId: "hue",
    name: g?.name ?? `Hue Group ${gid}`,
    profileKey,
    attributes: attrs,
  };
}


function mkLightNodeDef(rt, lid, l) {
  const nodeKey = `hue|light|${lid}`;

  const st = l?.state ?? {};
  const onValue = st.on ? 1 : 0;

  const hasDim = Number.isFinite(st.bri);
  const briPct = hasDim ? pctFromHueBri(st.bri) : 0;

  const hasCt = Number.isFinite(st.ct) || Number.isFinite(l?.capabilities?.control?.ct?.min);
  const ctMin = Number(l?.capabilities?.control?.ct?.min) || 153;
  const ctMax = Number(l?.capabilities?.control?.ct?.max) || 555;
  const ct = Number.isFinite(st.ct) ? st.ct : ctMin;

  const hasColor = (Number.isFinite(st.hue) && Number.isFinite(st.sat)) || st.colormode === "hs" || st.colormode === "xy";
  const color = (Number.isFinite(st.hue) && Number.isFinite(st.sat))
    ? hueSatToRgbInt(st.hue, st.sat, hasDim ? st.bri : 254)
    : 0;

  const hasIdentify = st.alert !== undefined;

  const profileKey = (hasColor || hasCt) ? "CANodeProfileDimmableExtendedColorLight"
                   : hasDim ? "CANodeProfileDimmableLight"
                   : "CANodeProfileOnOffPlug";

  const attrs = [];

  attrs.push({
    attrKey: `${nodeKey}|on`,
    name: "On",
    attrTypeKey: "CAAttributeTypeOnOff",
    unit: "",
    min: 0,
    max: 1,
    step: 1,
    writable: true,
    currentValue: onValue,
    deviceRef: { kind: "light", lightId: String(lid), action: "on" },
  });

  if (hasDim) {
    attrs.push({
      attrKey: `${nodeKey}|dim`,
      name: "Dimmer",
      attrTypeKey: "CAAttributeTypeDimmingLevel",
      unit: "%25",
      min: 0,
      max: 100,
      step: 1,
      writable: true,
      currentValue: briPct,
      deviceRef: { kind: "light", lightId: String(lid), action: "bri" },
    });
  }

  if (hasColor) {
    attrs.push({
      attrKey: `${nodeKey}|color`,
      name: "Color",
      attrTypeKey: "CAAttributeTypeColor",
      unit: "",
      min: 0,
      max: 16777215,
      step: 1,
      writable: true,
      currentValue: color,
      data: COLOR_PALETTE_DATA,
      deviceRef: { kind: "light", lightId: String(lid), action: "color" },
    });
  }

  if (hasCt) {
    attrs.push({
      attrKey: `${nodeKey}|ct`,
      name: "CT",
      attrTypeKey: "CAAttributeTypeColorTemperature",
      unit: "ct",
      min: ctMin,
      max: ctMax,
      step: 1,
      writable: true,
      currentValue: ct,
      deviceRef: { kind: "light", lightId: String(lid), action: "ct" },
    });
  }

  if (hasIdentify) {
    attrs.push({
      attrKey: `${nodeKey}|identify`,
      name: "Identifikation",
      attrTypeKey: "CAAttributeTypeIdentification",
      unit: "",
      min: 0,
      max: 1,
      step: 1,
      writable: true,
      currentValue: 0,
      deviceRef: { kind: "light", lightId: String(lid), action: "identify" },
    });
  }

  return {
    nodeKey,
    moduleId: "hue",
    name: l?.name ?? `Hue Light ${lid}`,
    profileKey,
    attributes: attrs,
  };
}



function mkSensorDeviceNodeDef(rt, device) {
  const product = device?.product_data?.product_name ?? "";
  const name = device?.metadata?.name ?? product ?? "Hue Sensor";
  const services = device?.services ?? [];

  const findSvc = (rtype) => services.find((s) => s?.rtype === rtype);
  const listSvc = (rtype) => services.filter((s) => s?.rtype === rtype);

  const isButton =
    /Hue Smart button|Friends of Hue Switch|Hue tap dial switch|Hue wall switch module|Hue dimmer switch/i.test(product);

  const isMotion =
    /Hue motion sensor|Hue outdoor motion sensor|Occupancy sensor/i.test(product);

  if (!isButton && !isMotion) return null;

  const nodeKey = `hue|sensor_device|${device.id}`;
  const moduleId = "hue";

  const attrs = [];

  // Node-level device ref to map zigbee_connectivity owner.rid -> nodeId
  // (Core can resolve nodeId by this ref)
  const nodeDeviceRef = { module: "hue", kind: "device", rid: String(device.id) };

  // Motion device: fixed attribute order: motion, lux, temp, battery
  if (isMotion) {
    const profileKey = "CANodeProfileMotionDetectorWithTemperatureAndBrightnessSensor";

    const m = findSvc("motion");
    if (m) attrs.push({
      attrKey: `${nodeKey}|motion`,
      name: "Motion",
      attrTypeKey: "CAAttributeTypeMotionAlarm",
      unit: "",
      min: 0,
      max: 1,
      step: 1,
      writable: false,
      currentValue: 0,
      deviceRef: { kind: "sensor", rid: String(m.rid), rtype: "motion" },
    });

    const l = findSvc("light_level");
    if (l) attrs.push({
      attrKey: `${nodeKey}|lux`,
      name: "Lux",
      attrTypeKey: "CAAttributeTypeBrightness",
      unit: "Lux",
      min: 0,
      max: 100000,
      step: 0.01,
      writable: false,
      currentValue: 0,
      deviceRef: { kind: "sensor", rid: String(l.rid), rtype: "light_level" },
    });

    const t = findSvc("temperature");
    if (t) attrs.push({
      attrKey: `${nodeKey}|temperature`,
      name: "Temperatur",
      attrTypeKey: "CAAttributeTypeTemperature",
      unit: "°C",
      min: -50,
      max: 100,
      step: 0.01,
      writable: false,
      currentValue: 0,
      deviceRef: { kind: "sensor", rid: String(t.rid), rtype: "temperature" },
    });

    const p = findSvc("device_power");
    if (p) attrs.push({
      attrKey: `${nodeKey}|battery`,
      name: "Batterie",
      attrTypeKey: "CAAttributeTypeBatteryLevel",
      unit: "%25",
      min: 0,
      max: 100,
      step: 0.01,
      writable: false,
      currentValue: 0,
      deviceRef: { kind: "sensor", rid: String(p.rid), rtype: "device_power" },
    });

    // zigbee_connectivity is node-state only (no attribute)
    const z = findSvc("zigbee_connectivity");
    const zigbeeRid = z ? String(z.rid) : null;

    return {
      nodeKey,
      moduleId,
      name,
      profileKey,
      nodeDeviceRef,
      zigbeeRid,
      attributes: attrs,
    };
  }

  // Button device: battery + button instances (instance increments)
  if (isButton) {
    const profileKey = "CANodeProfileFourButtonRemote";

    const p = findSvc("device_power");
    if (p) attrs.push({
      attrKey: `${nodeKey}|battery`,
      name: "Batterie",
      attrTypeKey: "CAAttributeTypeBatteryLevel",
      unit: "%25",
      min: 0,
      max: 100,
      step: 0.01,
      writable: false,
      currentValue: 0,
      deviceRef: { kind: "sensor", rid: String(p.rid), rtype: "device_power" },
    });

    let inst = 0;
    for (const b of listSvc("button")) {
      attrs.push({
      attrKey: `${nodeKey}|button|${String(b.rid)}`,
        name: "Taster",
        attrTypeKey: "CAAttributeTypeButtonState",
        unit: "",
        min: 1,
        max: 2,
        step: 1,
        writable: false,
        instance: inst,
        currentValue: 2,
        deviceRef: { kind: "sensor", rid: String(b.rid), rtype: "button" },
      });
      inst++;
    }

    const z = findSvc("zigbee_connectivity");
    const zigbeeRid = z ? String(z.rid) : null;

    return {
      nodeKey,
      moduleId,
      name,
      profileKey,
      nodeDeviceRef,
      zigbeeRid,
      attributes: attrs,
    };
  }

  return null;
}

function mkExtraNodeDef(rt, r) {
  const t = r.type;
  const rid = r.id;
  const name = r?.metadata?.name ?? `${t} ${rid.slice(0, 8)}`;

  // Node/attr keys for registry
  const nodeKey = `hue|extra|${t}|${rid}`;

  const attrs = [];
  if (t === "button") {
    // ButtonState: 0 idle, 1 initial_press, 2 short_release
    attrs.push({
      attrKey: `${nodeKey}|state`,
      name: "Button",
      attrTypeKey: "CAAttributeTypeButtonState",
      unit: "",
      min: 0,
      max: 2,
      step: 1,
      writable: false,
      deviceRef: { kind: "sensor", rid, rtype: "button" },
      currentValue: 0,
    });
    return {
      nodeKey,
      moduleId: "hue",
      name,
      profileKey: "CANodeProfileRemote",
      attributes: attrs,
    };
  }

  if (t === "motion") {
    attrs.push({
      attrKey: `${nodeKey}|motion`,
      name: "Motion",
      attrTypeKey: "CAAttributeTypeMotionAlarm",
      unit: "",
      min: 0,
      max: 1,
      step: 1,
      writable: false,
      deviceRef: { kind: "sensor", rid, rtype: "motion" },
      currentValue: 0,
    });
    return {
      nodeKey,
      moduleId: "hue",
      name,
      profileKey: "CANodeProfileMotionDetector",
      attributes: attrs,
    };
  }

  if (t === "temperature") {
    attrs.push({
      attrKey: `${nodeKey}|temperature`,
      name: "Temperature",
      attrTypeKey: "CAAttributeTypeTemperature",
      unit: "°C",
      min: -50,
      max: 100,
      step: 0.01,
      writable: false,
      deviceRef: { kind: "sensor", rid, rtype: "temperature" },
      currentValue: 0,
    });
    return {
      nodeKey,
      moduleId: "hue",
      name,
      profileKey: "CANodeProfileTemperatureSensor",
      attributes: attrs,
    };
  }

  if (t === "light_level") {
    attrs.push({
      attrKey: `${nodeKey}|lux`,
      name: "Light level",
      attrTypeKey: "CAAttributeTypeBrightness",
      unit: "lx",
      min: 0,
      max: 100000,
      step: 1,
      writable: false,
      deviceRef: { kind: "sensor", rid, rtype: "light_level" },
      currentValue: 0,
    });
    return {
      nodeKey,
      moduleId: "hue",
      name,
      profileKey: "CANodeProfileBrightnessSensor",
      attributes: attrs,
    };
  }

  if (t === "device_power") {
    attrs.push({
      attrKey: `${nodeKey}|battery`,
      name: "Battery",
      attrTypeKey: "CAAttributeTypeBatteryLevel",
      unit: "%",
      min: 0,
      max: 100,
      step: 1,
      writable: false,
      deviceRef: { kind: "sensor", rid, rtype: "device_power" },
      currentValue: 0,
    });
    return {
      nodeKey,
      moduleId: "hue",
      name,
      profileKey: "CANodeProfileRemote",
      attributes: attrs,
    };
  }

  // default: ignore
  return {
    nodeKey,
    moduleId: "hue",
    name,
    profileKey: "CANodeProfileRemote",
    attributes: [],
  };
}



function handleSsePayload(rt, payload) {
  const hueCfg = rt?.config?.hue ?? {};
  const __dbg = process.env.DEBUG_HUE === "1" || process.env.DEBUG_TELEMETRY === "1";
  const __logRoute = (label, ref, aid, value) => {
    if (__dbg) console.log("[hue][route]", label, { ref, aid, value });
  };
  const __logEmit = (aid, value, ref) => {
    if (__dbg) console.log("[hue][emitTelemetry]", { aid, value, ref });
  };
  const debug = process.env.DEBUG_HUE === "1";

  const messages = Array.isArray(payload) ? payload : [payload];
  for (const msg of messages) {
    const items = msg?.data;
    if (!Array.isArray(items)) continue;

    for (const r of items) {
      const t = r?.type;

      // Extras
      if (t === "button" && r?.id && r?.button?.last_event) {
        const ev = r.button.last_event;
        const v = ev === "initial_press" ? 1 : ev === "short_release" ? 2 : 0;
        const ref = { kind: "sensor", rid: r.id, rtype: "button" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, v);
        if (aid) {
          __logEmit(aid, v, ref);
          rt.emitTelemetry({ attributeId: aid, value: v, ts: Date.now(), source: "hue_sse", ref });
        }
continue;
      }

      if (t === "motion" && r?.id && typeof r?.motion?.motion === "boolean") {
        const ref = { kind: "sensor", rid: r.id, rtype: "motion" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, r.motion.motion ? 1 : 0);
        if (aid) {
          __logEmit(aid, r.motion.motion ? 1 : 0, ref);
          rt.emitTelemetry({ attributeId: aid, value: r.motion.motion ? 1 : 0, ts: Date.now(), source: "hue_sse", ref });
        }
continue;
      }

      if (t === "temperature" && r?.id && r?.temperature?.temperature != null) {
        const val = Number(r.temperature.temperature);
        const ref = { kind: "sensor", rid: r.id, rtype: "temperature" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        if (aid && Number.isFinite(val)) rt.emitTelemetry({ attributeId: aid, value: val, ts: Date.now() });
        continue;
      }

      if (t === "light_level" && r?.id && r?.light?.light_level != null) {
        const val = Number(r.light.light_level);
        const ref = { kind: "sensor", rid: r.id, rtype: "light_level" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        if (aid && Number.isFinite(val)) rt.emitTelemetry({ attributeId: aid, value: val, ts: Date.now() });
        continue;
      }

      if (t === "device_power" && r?.id && r?.power_state?.battery_level != null) {
        const val = Number(r.power_state.battery_level);
        const ref = { kind: "sensor", rid: r.id, rtype: "device_power" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        if (aid && Number.isFinite(val)) rt.emitTelemetry({ attributeId: aid, value: val, ts: Date.now() });
        continue;
      }

      // Light updates (v2 type=light with id_v1 like /lights/20)
      if (t === "light" && r?.id_v1) {
        const lid = parseV1Id(r.id_v1, "lights");
        if (lid && lightIncluded(lid, hueCfg.lights ?? {}, asBool(hueCfg.includeAllLights), debug)) {
          if (r?.on && typeof r.on.on === "boolean") {
            const ref = { kind: "light", lightId: String(lid), action: "on" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, r.on.on ? 1 : 0);
        if (aid) {
          __logEmit(aid, r.on.on ? 1 : 0, ref);
          rt.emitTelemetry({ attributeId: aid, value: r.on.on ? 1 : 0, ts: Date.now(), source: "hue_sse", ref });
        }
}
          if (r?.dimming?.brightness != null) {
            const val = clamp(Number(r.dimming.brightness), 0, 100);
            if (Number.isFinite(val)) {
              const ref = { kind: "light", lightId: String(lid), action: "bri" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, val);
        if (aid) {
          __logEmit(aid, val, ref);
          rt.emitTelemetry({ attributeId: aid, value: val, ts: Date.now(), source: "hue_sse", ref });
        }
}
          }
          if (r?.color_temperature?.mirek != null) {
            const mirek = clamp(Math.round(Number(r.color_temperature.mirek)), 153, 555);
            if (Number.isFinite(mirek)) {
              const ref = { kind: "light", lightId: String(lid), action: "ct" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, mirek);
        if (aid) {
          __logEmit(aid, mirek, ref);
          rt.emitTelemetry({ attributeId: aid, value: mirek, ts: Date.now(), source: "hue_sse", ref });
        }
}
          }
          if (r?.color?.xy?.x != null && r?.color?.xy?.y != null) {
            const x = Number(r.color.xy.x);
            const y = Number(r.color.xy.y);
            const briPct = r?.dimming?.brightness != null ? clamp(Number(r.dimming.brightness), 0, 100) : 100;
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const rgb = xyToRgbInt(x, y, briPct / 100);
              const ref = { kind: "light", lightId: String(lid), action: "color" };
        const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
        __logRoute("sse", ref, aid, rgb);
        if (aid) {
          __logEmit(aid, rgb, ref);
          rt.emitTelemetry({ attributeId: aid, value: rgb, ts: Date.now(), source: "hue_sse", ref });
        }
}
          }
        }
        continue;
      }


      // Group updates (v2 type=grouped_light with id_v1 like /groups/6)
      if (t === "grouped_light" && r?.id_v1) {
        const gid = parseV1Id(r.id_v1, "groups");
        if (gid) {
          if (r?.on && typeof r.on.on === "boolean") {
            const ref = { kind: "group", groupId: String(gid), action: "on" };
            const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
            __logRoute("sse", ref, aid, r.on.on ? 1 : 0);
            if (aid) {
              __logEmit(aid, r.on.on ? 1 : 0, ref);
              rt.emitTelemetry({ attributeId: aid, value: r.on.on ? 1 : 0, ts: Date.now(), source: "hue_sse", ref });
            }
          }
          if (r?.dimming?.brightness != null) {
            const val = clamp(Number(r.dimming.brightness), 0, 100);
            if (Number.isFinite(val)) {
              const ref = { kind: "group", groupId: String(gid), action: "bri" };
              const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
              __logRoute("sse", ref, aid, val);
              if (aid) {
                __logEmit(aid, val, ref);
                rt.emitTelemetry({ attributeId: aid, value: val, ts: Date.now(), source: "hue_sse", ref });
              }
            }
          }
          if (r?.color_temperature?.mirek != null) {
            const mirek = clamp(Math.round(Number(r.color_temperature.mirek)), 153, 555);
            if (Number.isFinite(mirek)) {
              const ref = { kind: "group", groupId: String(gid), action: "ct" };
              const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
              __logRoute("sse", ref, aid, mirek);
              if (aid) {
                __logEmit(aid, mirek, ref);
                rt.emitTelemetry({ attributeId: aid, value: mirek, ts: Date.now(), source: "hue_sse", ref });
              }
            }
          }
          if (r?.color?.xy?.x != null && r?.color?.xy?.y != null) {
            const x = Number(r.color.xy.x);
            const y = Number(r.color.xy.y);
            const briPct = r?.dimming?.brightness != null ? clamp(Number(r.dimming.brightness), 0, 100) : 100;
            if (Number.isFinite(x) && Number.isFinite(y)) {
              const rgb = xyToRgbInt(x, y, briPct / 100);
              const ref = { kind: "group", groupId: String(gid), action: "color" };
              const aid = __attrIndex?.get(stableStringify(ref)) ?? null;
              __logRoute("sse", ref, aid, rgb);
              if (aid) {
                __logEmit(aid, rgb, ref);
                rt.emitTelemetry({ attributeId: aid, value: rgb, ts: Date.now(), source: "hue_sse", ref });
              }
            }
          }
        }
        continue;
      }

      // Zigbee connectivity: set node availability (node.state)
      if (t === "zigbee_connectivity") {
        // Prefer v2 device RID mapping (works for sensor devices and lights)
        const deviceRid = r?.owner?.rid;
        if (deviceRid) {
          const nodeId = rt.resolveNodeId?.({ module: "hue", kind: "device", rid: String(deviceRid) }) ?? null;
          if (nodeId) {
            const state = r.status === "connected" ? 1 : 2;
            if (debug) console.log("[hue][sse] zigbee_connectivity(v2)", { deviceRid, status: r.status, state, nodeId });
            rt.setNodeState(nodeId, state);
            continue;
          }
        }

        const lid = parseV1Id(r.id_v1, "lights");
        if (lid && lightIncluded(lid, hueCfg.lights ?? {}, asBool(hueCfg.includeAllLights), debug)) {
          const nodeKey = `hue|light|${lid}`;
          const nodeId = rt?.registry?.data?.nodes?.[nodeKey]?.id ?? null;
          if (nodeId) {
            const state = r.status === "connected" ? 1 : 2;
            if (debug) console.log("[hue][sse] zigbee_connectivity", { lid, status: r.status, state, nodeId });
            rt.setNodeState(nodeId, state);
          } else if (debug) {
            console.log("[hue][sse] zigbee_connectivity no node for", { lid, nodeKey });
          }
        }
        continue;
      }
    }
  }
}
let __attrIndex = null;

export default {
  id: "hue",
  name: "Hue",

  enabled(cfg) {
    return asBool(cfg?.hue?.enabled);
  },

  async discover(cfg, rt) {
    const debug = process.env.DEBUG_HUE === "1";
    const hue = rt?.config?.hue ?? {};
    const ip = hue.ip;
    const key = hue.key;

    const rooms = hue.rooms ?? {};
    const zones = hue.zones ?? {};
    const lightsSel = hue.lights ?? {};
    const includeAllLights = asBool(hue.includeAllLights);

    if (!ip || !key || !asBool(hue.enabled)) {
      log(rt, "[hue] disabled or missing ip/key; no nodes");
      return { discoveredNodes: [] };
    }

    const discovered = [];

    const groups = await httpJson({ method: "GET", host: ip, path: `/api/${key}/groups` });
    const allGroups = Object.entries(groups ?? {});
    log(rt, `[hue] fetched groups: ${allGroups.length}`);

    for (const [gid, g] of allGroups) {
      if (!groupIncluded(gid, g, rooms, zones, debug)) continue;
      discovered.push(mkGroupNodeDef(rt, gid, g));
    }

    const lights = await httpJson({ method: "GET", host: ip, path: `/api/${key}/lights` });
    const allLights = Object.entries(lights ?? {});
    log(rt, `[hue] fetched lights: ${allLights.length}`);

    for (const [lid, l] of allLights) {
      if (!lightIncluded(lid, lightsSel, includeAllLights, debug)) continue;
      discovered.push(mkLightNodeDef(rt, lid, l));
    }



// Sensor devices (v2) - one Node per Hue device with ordered attributes
{
  const sensorSel = hue.sensorDevices ?? {};
  const anySelected = Object.values(sensorSel).some((v) => v === true);

  if (anySelected) {
    try {
      const devPayload = await hueV2Json(ip, key, "/clip/v2/resource/device");
      const devices = devPayload?.data ?? [];
      let built = 0;

      for (const d of devices) {
        if (!d?.id || sensorSel[d.id] !== true) continue;
        if (typeof d?.id_v1 !== "string" || !d.id_v1.startsWith("/sensors/")) continue;

        const nodeDef = mkSensorDeviceNodeDef(rt, d);
        if (!nodeDef) continue;

        discovered.push(nodeDef);
        built++;
      }

      log(rt, `[hue] sensor devices(v2): ${devices.length}, selected-built=${built}`);
    } catch (e) {
      log(rt, "[hue] sensor devices fetch failed", e?.message ?? e);
    }
  } else if (debug) {
    log(rt, "[hue] no sensorDevices selected");
  }
}

log(rt, `[hue] discover -> ${discovered.length} nodes`);
    return { discoveredNodes: discovered };
  },

  async start(cfg, rt) {
    __attrIndex = buildAttrIndexFromIds(rt);
    const debug = process.env.DEBUG_HUE === "1";
    const hue = rt?.config?.hue ?? {};
    const ip = hue.ip;
    const key = hue.key;
    const rooms = hue.rooms ?? {};
    const zones = hue.zones ?? {};
    const pollMs = Math.max(30000, Number(hue.pollMs ?? 30000));

    if (!ip || !key || !asBool(hue.enabled)) return;

    log(rt, `[hue] poll interval ms=${pollMs} (groups only)`);

    const pollOnce = async () => {
      const groups = await httpJson({ method: "GET", host: ip, path: `/api/${key}/groups` });
      const allGroups = Object.entries(groups ?? {});
      if (debug) console.log("[hue] poll groups", allGroups.length);

      for (const [gid, g] of allGroups) {
        if (!groupIncluded(gid, g, rooms, zones, false)) continue;

        const nodeKey = `hue|group|${gid}`;
        // Emit telemetry keyed by attrKey (core will resolve -> attributeId)
        rt.emitTelemetry({ attrKey: `${nodeKey}|on`, value: g?.state?.any_on ? 1 : 0, ts: Date.now() });

        const briPct = pctFromHueBri(g?.action?.bri);
        rt.emitTelemetry({ attrKey: `${nodeKey}|dim`, value: briPct, ts: Date.now() });

        if (Number.isFinite(g?.action?.ct)) {
          rt.emitTelemetry({ attrKey: `${nodeKey}|ct`, value: g.action.ct, ts: Date.now() });
        }
      }
    };


    // Hue v2 eventstream (SSE) triggers immediate refresh (no periodic light polling)
    const sseEnabled = asBool(hue.sseEnabled ?? true);
    const sseDebounceMs = Math.max(200, Number(hue.sseDebounceMs ?? 400));
    const refreshFromBridge = async () => {
      // groups (selected)
      const groups = await httpJson({ method: "GET", host: ip, path: `/api/${key}/groups` });
      for (const [gid, g] of Object.entries(groups ?? {})) {
        if (!groupIncluded(gid, g, rooms, zones, false)) continue;
        const nodeKey = `hue|group|${gid}`;
        rt.emitTelemetry({ attrKey: `${nodeKey}|on`, value: g?.state?.any_on ? 1 : 0, ts: Date.now() });
        rt.emitTelemetry({ attrKey: `${nodeKey}|dim`, value: pctFromHueBri(g?.action?.bri), ts: Date.now() });
        if (Number.isFinite(g?.action?.ct)) rt.emitTelemetry({ attrKey: `${nodeKey}|ct`, value: g.action.ct, ts: Date.now() });
      }

      // lights (selected or includeAllLights) - only updated on SSE events
      const lightsSel = hue.lights ?? {};
      const includeAllLights = asBool(hue.includeAllLights ?? false);
      const lights = await httpJson({ method: "GET", host: ip, path: `/api/${key}/lights` });
      for (const [lid, l] of Object.entries(lights ?? {})) {
        if (!lightIncluded(lid, lightsSel, includeAllLights, false)) continue;
        const nodeKey = `hue|light|${lid}`;
        const st = l?.state ?? {};
        rt.emitTelemetry({ attrKey: `${nodeKey}|on`, value: st.on ? 1 : 0, ts: Date.now() });
        rt.emitTelemetry({ attrKey: `${nodeKey}|dim`, value: pctFromHueBri(st.bri), ts: Date.now() });
        if (Number.isFinite(st.ct)) rt.emitTelemetry({ attrKey: `${nodeKey}|ct`, value: st.ct, ts: Date.now() });
        if (Number.isFinite(st.hue) && Number.isFinite(st.sat)) {
          rt.emitTelemetry({ attrKey: `${nodeKey}|color`, value: hueSatToRgbInt(st.hue, st.sat, st.bri ?? 254), ts: Date.now() });
        }
      }
    };

    await pollOnce().catch((e) => log(rt, "[hue] poll error", e?.message ?? e));

// One-time poll after startup to get current sensor values (required after restart)
await pollSelectedExtrasOnce(rt, hue).catch((e) => log(rt, "[hue] initial extras poll error", e?.message ?? e));

// Trigger file mechanism (WebUI button) to force sensor refresh on demand
const dataDir = rt?.dataDir ?? process.env.DATA_DIR ?? "/app/data";
const triggerPath = `${dataDir}/hue_poll_extras.trigger`;
let triggerTimer = null;
const checkTrigger = async () => {
  try {
    const fs = await import("node:fs");
    if (fs.existsSync(triggerPath)) {
      try { fs.unlinkSync(triggerPath); } catch {}
      await pollSelectedExtrasOnce(rt, hue).catch((e) => log(rt, "[hue] triggered extras poll error", e?.message ?? e));
    }
  } catch (e) {
    // ignore
  }
};
triggerTimer = setInterval(() => { checkTrigger(); }, 2000);
rt._hueTriggerTimer = triggerTimer;

    if (sseEnabled) {
      const agent = new https.Agent({ rejectUnauthorized: false });
      const sse = new HueSse(ip, {
        agent,
        rejectUnauthorized: false,
        headers: { "hue-application-key": key, accept: "text/event-stream" },
      });

      let refreshTimer = null;
      const scheduleRefresh = () => {
        if (refreshTimer) clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          refreshFromBridge().catch((e) => log(rt, "[hue] sse refresh error", e?.message ?? e));
        }, sseDebounceMs);
      };

      sse.on((payload) => {
        if (debug) {
          try {
            const s = JSON.stringify(payload);
            console.log("[hue] sse event", s.length > 400 ? s.slice(0, 400) + "…" : s);
          } catch {
            console.log("[hue] sse event");
          }
        }
        handleSsePayload(rt, payload);
        scheduleRefresh();
      });

      sse.start();
      this._sse = sse;
      log(rt, `[hue] SSE enabled (debounce ${sseDebounceMs}ms)`);
    }
    if (this._timer) clearInterval(this._timer);
    this._timer = setInterval(() => {
      pollOnce().catch((e) => log(rt, "[hue] poll error", e?.message ?? e));
    }, pollMs);
  },

  async stop() {

if (rt?._hueTriggerTimer) {
  clearInterval(rt._hueTriggerTimer);
  rt._hueTriggerTimer = null;
}
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    try { this._sse?.stop(); } catch {}
    this._sse = null;
  },

  async handleCommand(cmd, rt) {
    const hue = rt?.config?.hue ?? {};
    const ip = hue.ip;
    const key = hue.key;
    if (!ip || !key) throw new Error("hue missing ip/key");

    const ref = cmd?.deviceRef;
    if (!ref) throw new Error("missing deviceRef");
    const kind = ref.kind;
    const action = ref.action;

    const put = async (path, body) => httpJson({ method: "PUT", host: ip, path, body });

    if (kind === "group") {
      const gid = ref.groupId;
      const path = `/api/${key}/groups/${gid}/action`;

      if (action === "on") return put(path, { on: (typeof cmd.value === "boolean" ? cmd.value : Number(cmd.value) === 1) });
      if (action === "bri") return put(path, { bri: hueBriFromPct(cmd.value), on: true });
      if (action === "ct") return put(path, { ct: Number(cmd.value), on: true });
      if (action === "identify") return put(path, { alert: "select" });
      if (action === "color") {
        // expects cmd.value is rgb int
        // simple: no-op here unless you want hsv conversion reverse; keep as placeholder
        return put(path, { on: true });
      }
      throw new Error(`unsupported group action ${action}`);
    }

    if (kind === "light") {
      const lid = ref.lightId;
      const path = `/api/${key}/lights/${lid}/state`;

      if (action === "on") return put(path, { on: (typeof cmd.value === "boolean" ? cmd.value : Number(cmd.value) === 1) });
      if (action === "bri") return put(path, { bri: hueBriFromPct(cmd.value), on: true });
      if (action === "ct") return put(path, { ct: Number(cmd.value), on: true });
      if (action === "identify") return put(path, { alert: "select" });
      if (action === "color") {
        // placeholder; would need rgb->hue/sat or xy conversion
        return put(path, { on: true });
      }
      throw new Error(`unsupported light action ${action}`);
    }

    throw new Error(`unsupported kind ${kind}`);
  },
};
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

function buildAttrIndexFromIds(rt) {
  const m = new Map();
  const attrs = rt?.store?.ids?.modules?.hue?.attributes ?? {};
  for (const [attrId, data] of Object.entries(attrs)) {
    m.set(stableStringify(data), Number(attrId));
  }
  return m;
}

