"use strict";

const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const http = require("http");
const net = require("net");
const path = require("path");

const { resolveBackend, IS_WIN } = require("./paths");

/**
 * Manages the FastAPI backend process: picks a free port, launches it with the
 * user's PIN + config passed as environment variables (no .env needed), waits
 * for it to become healthy, and shuts it down cleanly.
 */
class Backend extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.port = null;
    this.starting = false;
    this.logBuffer = [];
  }

  _log(line) {
    const text = String(line).trimEnd();
    if (!text) return;
    this.logBuffer.push(text);
    if (this.logBuffer.length > 400) this.logBuffer.shift();
    this.emit("log", text);
  }

  recentLogs() {
    return this.logBuffer.join("\n");
  }

  isRunning() {
    return Boolean(this.child) && this.child.exitCode === null;
  }

  async start({ pin, port, dataDir, tailscalePath }) {
    if (this.isRunning() || this.starting) return this.port;
    this.starting = true;
    try {
      this.port = await pickPort(port || 1739);
      const { command, args, cwd, mode } = resolveBackend();

      const env = {
        ...process.env,
        APP_PIN: pin,
        SERVER_HOST: "127.0.0.1",
        SERVER_PORT: String(this.port),
        QR_OPEN_BROWSER: "false",
        AUDIT_LOG_FILE: path.join(dataDir, "audit.log"),
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
      };
      if (tailscalePath) env.TAILSCALE_PATH = tailscalePath;

      this._log(`[backend] starting (${mode}) on 127.0.0.1:${this.port}`);
      this.child = spawn(command, args, {
        cwd,
        env,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.child.stdout.on("data", (d) => this._log(d.toString()));
      this.child.stderr.on("data", (d) => this._log(d.toString()));
      this.child.on("error", (err) => {
        this._log(`[backend] spawn error: ${err.message}`);
        this.emit("exit", { code: -1, error: err.message });
      });
      this.child.on("exit", (code, signal) => {
        this._log(`[backend] exited (code=${code} signal=${signal})`);
        const wasRunning = this.child !== null;
        this.child = null;
        if (wasRunning) this.emit("exit", { code, signal });
      });

      await this._waitForHealth(20000);
      this._log("[backend] healthy");
      this.emit("ready", { port: this.port });
      return this.port;
    } finally {
      this.starting = false;
    }
  }

  _waitForHealth(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const port = this.port;
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (!this.isRunning()) {
          reject(new Error("backend exited before becoming healthy"));
          return;
        }
        const req = http.get(
          { host: "127.0.0.1", port, path: "/api/health", timeout: 1500 },
          (res) => {
            res.resume();
            if (res.statusCode === 200) resolve(true);
            else retry();
          }
        );
        req.on("error", retry);
        req.on("timeout", () => req.destroy());
      };
      const retry = () => {
        if (Date.now() > deadline) {
          reject(new Error("backend health check timed out"));
          return;
        }
        setTimeout(attempt, 300);
      };
      attempt();
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null; // suppress restart logic on exit
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once("exit", finish);
      try {
        if (IS_WIN && child.pid) {
          // Ensure the whole tree dies (PyInstaller/uvicorn helpers).
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
          });
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        finish();
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
        finish();
      }, 4000);
    });
  }
}

// Prefer `preferred`; if taken, ask the OS for any free port.
function pickPort(preferred) {
  return isFree(preferred).then((free) => (free ? preferred : anyFreePort()));
}

function isFree(port) {
  return new Promise((resolve) => {
    const srv = net
      .createServer()
      .once("error", () => resolve(false))
      .once("listening", () => srv.close(() => resolve(true)))
      .listen(port, "127.0.0.1");
  });
}

function anyFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

module.exports = { Backend };
