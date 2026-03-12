import fetch from "node-fetch";
import https from "https";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

class Velux {
  constructor(veluxUser, veluxPw, opts = {}) {
    this.veluxUser = veluxUser;
    this.veluxPw = veluxPw;

    this.accessToken = "";
    this.refreshTokenValue = "";
    this.accessTokenExpiresAt = 0; // ms epoch
    this.homeId = "";
    this.veluxId = {};
    this.name = "";
    this.bridgeId = "";
    this.moduleBridgeById = {};

    this._started = false;
    this._pollTimer = null;
    this._refreshTimer = null;

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? path.join(__dirname, "..", "..", "data");
    this.tokenPath = opts.tokenPath ?? path.join(dataDir, "velux-token.json");

    this.agent = new https.Agent({ rejectUnauthorized: false });
  }

  _tokenValidSoon(minValidMs = 60_000) {
    return !!this.accessToken && Number.isFinite(this.accessTokenExpiresAt) &&
      (this.accessTokenExpiresAt - Date.now()) > minValidMs;
  }

  async _loadTokensFromFile() {
    try {
      const txt = await fs.readFile(this.tokenPath, "utf-8");
      const j = JSON.parse(txt);
      if (typeof j?.accessToken === "string") this.accessToken = j.accessToken;
      if (typeof j?.refreshToken === "string") this.refreshTokenValue = j.refreshToken;
      if (Number.isFinite(Number(j?.accessTokenExpiresAt))) this.accessTokenExpiresAt = Number(j.accessTokenExpiresAt);
      if (typeof j?.bridgeId === "string") this.bridgeId = j.bridgeId;
      if (typeof j?.homeId === "string") this.homeId = j.homeId;
      if (j?.moduleBridgeById && typeof j.moduleBridgeById === "object") this.moduleBridgeById = j.moduleBridgeById;
    } catch {
      // ignore
    }
  }

  async _saveTokensToFile() {
    try {
      await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
      const payload = {
        accessToken: this.accessToken,
        refreshToken: this.refreshTokenValue,
        accessTokenExpiresAt: this.accessTokenExpiresAt,
        bridgeId: this.bridgeId,
        homeId: this.homeId,
        moduleBridgeById: this.moduleBridgeById,
        updatedAt: Date.now(),
      };
      await fs.writeFile(this.tokenPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
    } catch {
      // ignore
    }
  }

  _setTokensFromOauthResponse(responseBody) {
    this.accessToken = responseBody?.access_token ?? this.accessToken;
    this.refreshTokenValue = responseBody?.refresh_token ?? this.refreshTokenValue;

    const expiresInSec = Number(responseBody?.expires_in);
    // Safety buffer: refresh 60s before expiry
    if (Number.isFinite(expiresInSec) && expiresInSec > 0) {
      this.accessTokenExpiresAt = Date.now() + (expiresInSec * 1000) - 60_000;
    } else if (!Number.isFinite(this.accessTokenExpiresAt) || this.accessTokenExpiresAt <= 0) {
      // Fallback: treat as short-lived
      this.accessTokenExpiresAt = Date.now() + (10 * 60 * 1000);
    }
  }

  _extractBridgeIdFromHome(home) {
    if (!home) return "";
    const pick = (v) => {
      if (!v) return "";
      if (typeof v === "string") return v;
      if (typeof v === "object") {
        return (
          (typeof v.id === "string" && v.id) ||
          (typeof v.bridge_id === "string" && v.bridge_id) ||
          (typeof v.gateway_id === "string" && v.gateway_id) ||
          (typeof v.mac === "string" && v.mac) ||
          (typeof v.mac_address === "string" && v.mac_address) ||
          (typeof v.device_id === "string" && v.device_id) ||
          ""
        );
      }
      return "";
    };

    const direct =
      pick(home.bridge_id) ||
      pick(home.bridge) ||
      pick(home.gateway_id) ||
      pick(home.gateway) ||
      pick(home.gatewayId) ||
      pick(home.bridgeId) ||
      pick(home.hub) ||
      "";

    if (direct) return direct;

    const mods = Array.isArray(home.modules) ? home.modules : [];
    for (const m of mods) {
      const v =
        pick(m.bridge_id) ||
        pick(m.bridge) ||
        pick(m.gateway_id) ||
        pick(m.gateway) ||
        pick(m.bridgeId) ||
        pick(m.gatewayId) ||
        "";
      if (v) return v;
    }
    return "";
  }

  async start({ pollMs = 5 * 60 * 1000 } = {}) {
    if (this._started) return;
    this._started = true;

    await this._loadTokensFromFile();
    await this.ensureAuth();
    await this.veluxHomeData();
    await this.veluxHomeStatus();

    // Refresh timer: check every minute and refresh if close to expiry
    this._refreshTimer = setInterval(async () => {
      try {
        if (!this._tokenValidSoon(2 * 60_000)) {
          await this.ensureAuth();
        }
      } catch {
        // ignore; next tick will retry
      }
    }, 60_000);

    // Poll status
    this._pollTimer = setInterval(async () => {
      try { await this.veluxHomeStatus(); } catch {}
    }, pollMs);
  }

  async stop() {
    if (this._refreshTimer) clearInterval(this._refreshTimer);
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._refreshTimer = null;
    this._pollTimer = null;
    this._started = false;
  }

  async ensureAuth() {
    // 1) If access token is still valid, keep it.
    if (this._tokenValidSoon()) return;

    // 2) If refresh token exists, try refresh.
    if (this.refreshTokenValue) {
      try {
        await this.refreshToken();
        return;
      } catch {
        // fall through to password grant
      }
    }

    // 3) Password grant (fallback)
    await this.velux();
  }

  async refreshToken() {
    const url = "https://app.velux-active.com/oauth2/token";
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Velux/1.6.1 (iPhone, ioc13, Scale/3.0)",
      Accept: "*/*",
      Host: "app.velux-active.com",
    };

    const body =
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(this.refreshTokenValue)}` +
      `&client_id=5931426da127d981e76bdd3f&client_secret=6ae2d89d15e767ae5c56b456b452d319`;

    const response = await fetch(url, { method: "POST", headers, body, agent: this.agent });
    const responseBody = await response.json();

    // Capture bridge/gateway id for setState()
    try {
      const home = responseBody?.body?.home;
      this.bridgeId = this._extractBridgeIdFromHome(home) || this.bridgeId;
      if (typeof home?.id === "string") this.homeId = home.id;
    } catch {}

    this._setTokensFromOauthResponse(responseBody);
    await this._saveTokensToFile();
  }

  async velux() {
    const url = "https://app.velux-active.com/oauth2/token";
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Velux/1.6.1 (iPhone, ioc13, Scale/3.0)",
      Accept: "*/*",
      Host: "app.velux-active.com",
    };

    const body =
      `grant_type=password&client_id=5931426da127d981e76bdd3f&client_secret=6ae2d89d15e767ae5c56b456b452d319` +
      `&username=${encodeURIComponent(this.veluxUser)}&password=${encodeURIComponent(this.veluxPw)}&user_prefix=velux`;

    const response = await fetch(url, { method: "POST", headers, body, agent: this.agent });
    const responseBody = await response.json();

    // Capture bridge/gateway id for setState()
    try {
      const home = responseBody?.body?.home;
      this.bridgeId = this._extractBridgeIdFromHome(home) || this.bridgeId;
      if (typeof home?.id === "string") this.homeId = home.id;
    } catch {}

    this._setTokensFromOauthResponse(responseBody);
    await this._saveTokensToFile();

    await this.veluxHomeData();
  }

  async veluxHomeData() {
    const url = "https://app.velux-active.com/api/homesdata";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
    };

    const response = await fetch(url, { method: "GET", headers, agent: this.agent });
    const responseBody = await response.json();

    // Best-effort capture homeId/bridgeId
    try {
      const homes = Array.isArray(responseBody?.body?.homes) ? responseBody.body.homes : [];
      const home0 = homes[0];
      const mods = Array.isArray(home0?.modules) ? home0.modules : [];
      for (const m of mods) {
        if (m?.id && m?.bridge) this.moduleBridgeById[String(m.id)] = String(m.bridge);
      }
      if (home0?.id) this.homeId = String(home0.id);
      this.bridgeId = this._extractBridgeIdFromHome(home0) || this.bridgeId;
      await this._saveTokensToFile();
    } catch {}

    return responseBody;
  }

  
  async veluxHomeStatus() {
    const url = 'https://app.velux-active.com/api/homestatus';
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Velux/1.6.1 ( Iphone, ioc13 , Scale/3.0)',
      'Accept': '*/*',
      'Host': 'app.velux-active.com'
    };

    const body = `access_token=${this.accessToken}&home_id=${this.homeId}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body,
      agent: this.agent
    });
    const responseBody = await response.json();
    console.log(responseBody);

    try {
      const home = responseBody?.body?.home;
      if (home?.id) this.homeId = String(home.id);
      this.bridgeId = this._extractBridgeIdFromHome(home) || this.bridgeId;

      const mods = Array.isArray(home?.modules) ? home.modules : [];
      for (const m of mods) {
        if (m?.id && m?.bridge) this.moduleBridgeById[String(m.id)] = String(m.bridge);
      }
      await this._saveTokensToFile();
    } catch {}

    return responseBody;
  }

  async setState(moduleId, targetPosition) {
    await this._loadTokensFromFile();
    await this.ensureAuth();

    if (!this.homeId) {
      try { await this.veluxHomeData(); } catch {}
    }
    if (!this.homeId) {
      try { await this.veluxHomeStatus(); } catch {}
    }
    if (!this.homeId) throw new Error("Missing home_id");

    const id = String(moduleId);
    const bridge = this.moduleBridgeById?.[id] || this.bridgeId || (this.veluxId?.bridge_id ?? "");
    if (!bridge) throw new Error("Missing bridge_id");

    const url = "https://app.velux-active.com/syncapi/v1/setstate";
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.accessToken}`,
      home_id: this.homeId,
      Accept: "*/*",
      Host: "app.velux-active.com",
      "User-Agent": "Velux/1.6.1",
    };

    const body = {
      home: {
        id: this.homeId,
        modules: [
          {
            bridge,
            id,
            target_position: Number(targetPosition),
            nonce: 0,
            sign_key_id: "6ae2d89d15e767ae5c56b456b452d319",
          },
        ],
      },
      app_version: "1.6.1",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      agent: this.agent,
    });

    return response.json();
  }


  vhihState(id, value) {
    // unused
  }
}

export default Velux;
