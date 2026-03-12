// HueSse.mjs
import https from "node:https";

/**
 * Minimal SSE client for Philips Hue Bridge v2 eventstream.
 * Endpoint: https://<bridge>/eventstream/clip/v2
 * Requires header: hue-application-key: <username>
 *
 * Emits parsed JSON payloads from "data:" lines.
 */
class HueSse {
  constructor(hueIp, options) {
    this.hueIp = hueIp;
    this.options = options;
    this.listeners = [];
    this.keepRunning = true;
    this._req = null;
    this._res = null;
    this._buffer = "";
  }

  on(callback) {
    if (typeof callback === "function") this.listeners.push(callback);
  }

  start() {
    this.keepRunning = true;
    this._connect();
  }

  stop() {
    this.keepRunning = false;
    try {
      this._res?.destroy();
    } catch {}
    try {
      this._req?.destroy();
    } catch {}
    this._res = null;
    this._req = null;
  }

  _connect() {
    if (!this.keepRunning) return;

    const req = https.request(
      {
        hostname: this.hueIp,
        path: "/eventstream/clip/v2",
        method: "GET",
        ...this.options,
      },
      (res) => {
        this._res = res;
        res.setEncoding("utf8");

        res.on("data", (chunk) => this._onChunk(chunk));
        res.on("end", () => this._reconnect("end"));
        res.on("close", () => this._reconnect("close"));
      }
    );

    this._req = req;

    req.on("error", (err) => this._reconnect(`error:${err?.message ?? err}`));
    req.end();
  }

  _reconnect(reason) {
    if (!this.keepRunning) return;
    // reset buffer to avoid partial frames
    this._buffer = "";
    // simple backoff
    setTimeout(() => this._connect(), 1000);
  }

  _emit(payload) {
    for (const cb of this.listeners) {
      try {
        cb(payload);
      } catch (e) {
        // ignore listener errors
      }
    }
  }

  _onChunk(chunk) {
    this._buffer += chunk;

    // SSE events are separated by blank lines
    let idx;
    while ((idx = this._buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 2);

      const lines = rawEvent.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.slice(5).trim();
        if (!dataStr) continue;

        try {
          const json = JSON.parse(dataStr);
          this._emit(json);
        } catch {
          // Hue sometimes sends keep-alive comments; ignore invalid json
        }
      }
    }
  }
}

export default HueSse;
