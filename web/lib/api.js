// FastAPI backend API client.
// In production the frontend is served by FastAPI itself (same origin),
// so BASE stays empty. To develop with `next dev`, set
// NEXT_PUBLIC_API_BASE=http://127.0.0.1:1739 in the environment.
const BASE = process.env.NEXT_PUBLIC_API_BASE || "";

function unauthorized() {
  const err = new Error("Session expired.");
  err.unauthorized = true;
  return err;
}

async function req(path, options = {}) {
  return fetch(BASE + path, { credentials: "include", ...options });
}

// Default ceiling for capture/input requests. Over the Tailscale tunnel — which
// goes idle while the phone is backgrounded and needs a moment to re-handshake
// on return — a fetch on a connection that died meanwhile can otherwise hang for
// a minute or more, freezing the UI. A timeout turns that into a fast, retryable
// failure instead.
const CAPTURE_TIMEOUT_MS = 12000;

// Build an AbortSignal that fires on either an external signal (caller-driven
// cancel) or a timeout, without relying on AbortSignal.any/timeout (not
// available on all mobile browsers).
function withDeadline(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onAbort);
  };
  return { signal: controller.signal, cleanup };
}

function timeoutError() {
  const err = new Error("Request timed out.");
  err.timeout = true;
  return err;
}

function query(params) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  });
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function detail(res, fallback) {
  const data = await res.json().catch(() => ({}));
  return data.detail || fallback;
}

function headerInt(res, name) {
  const value = Number.parseInt(res.headers.get(name) || "", 10);
  return Number.isFinite(value) ? value : 0;
}

async function screenshotFromResponse(res) {
  const blob = await res.blob();
  return {
    image: URL.createObjectURL(blob),
    timestamp: res.headers.get("X-Screenshot-Timestamp") || new Date().toISOString(),
    filename: res.headers.get("X-Screenshot-Filename") || "screenshot.jpg",
    width: headerInt(res, "X-Screenshot-Width"),
    height: headerInt(res, "X-Screenshot-Height"),
    monitorId: headerInt(res, "X-Screenshot-Monitor"),
    monitorLeft: headerInt(res, "X-Screenshot-Monitor-Left"),
    monitorTop: headerInt(res, "X-Screenshot-Monitor-Top"),
    bytes: blob.size,
    mediaType: blob.type,
  };
}

export function revokeScreenshot(shot) {
  if (shot?.image?.startsWith("blob:")) {
    URL.revokeObjectURL(shot.image);
  }
}

export async function getSession() {
  try {
    const res = await req("/api/session");
    if (!res.ok) return { authenticated: false, isOwner: false, os: "windows" };
    const data = await res.json();
    return {
      authenticated: Boolean(data.authenticated),
      isOwner: Boolean(data.is_owner),
      // OS of the controlled machine, used to pick the right shortcuts.
      os: data.os || "windows",
    };
  } catch {
    return { authenticated: false, isOwner: false, os: "windows" };
  }
}

export async function listSessions() {
  const res = await req("/api/sessions");
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't list sessions."));
  const data = await res.json();
  return data.sessions || [];
}

export async function revokeSession(pubId) {
  const res = await req(`/api/sessions/${encodeURIComponent(pubId)}/revoke`, {
    method: "POST",
  });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't remove the session."));
  return res.json();
}

export async function listMonitors() {
  const res = await req("/api/monitors");
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't list monitors."));
  const data = await res.json();
  return data.monitors || [];
}

export async function getClipboard() {
  const res = await req("/api/clipboard");
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't read the computer clipboard."));
  return res.json();
}

// On-demand read of the PC clipboard — used right after a remote Copy so the
// phone gets the fresh text without waiting for the background monitor.
export async function readClipboardNow() {
  const res = await req("/api/clipboard/read", { method: "POST" });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't read the computer clipboard."));
  return res.json();
}

export async function getPrivacyState() {
  const res = await req("/api/privacy");
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't read Privacy Mode."));
  return res.json();
}

export async function setPrivacyMode(enabled) {
  const res = await req("/api/privacy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (res.status === 401) throw unauthorized();
  if (res.status === 403) throw new Error("Only the owner phone can change Privacy Mode.");
  if (!res.ok) throw new Error(await detail(res, "Couldn't change Privacy Mode."));
  return res.json();
}

export async function login(pin) {
  const res = await req("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  if (!res.ok) throw new Error(await detail(res, "Invalid PIN."));
  return true;
}

export async function logout() {
  try {
    await req("/api/logout", { method: "POST" });
  } catch {
    /* ignore — local state will be cleared anyway */
  }
}

export function screenshotStreamUrl({ profile = "live", monitor, fps = 24, nonce = Date.now() } = {}) {
  return `${BASE}/api/screenshots/stream${query({ profile, monitor, fps, n: nonce })}`;
}

export async function captureScreenshot(profile = "photo", monitor, { signal } = {}) {
  const deadline = withDeadline(signal, CAPTURE_TIMEOUT_MS);
  try {
    const res = await req(`/api/screenshots/raw${query({ profile, monitor })}`, {
      method: "POST",
      signal: deadline.signal,
    });
    if (res.status === 401) throw unauthorized();
    if (!res.ok) throw new Error(await detail(res, "Failed to capture the screen."));
    return await screenshotFromResponse(res);
  } catch (err) {
    throw err?.name === "AbortError" ? timeoutError() : err;
  } finally {
    deadline.cleanup();
  }
}

export async function sendInput(payload) {
  const deadline = withDeadline(null, CAPTURE_TIMEOUT_MS);
  try {
    const res = await req("/api/input", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: deadline.signal,
    });
    if (res.status === 401) throw unauthorized();
    if (!res.ok) throw new Error(await detail(res, "Couldn't send the command."));
    return await res.json();
  } catch (err) {
    throw err?.name === "AbortError" ? timeoutError() : err;
  } finally {
    deadline.cleanup();
  }
}

export async function sendInputAndCapture(payload) {
  const deadline = withDeadline(null, CAPTURE_TIMEOUT_MS);
  try {
    const res = await req("/api/input/screenshot/raw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: deadline.signal,
    });
    if (res.status === 401) throw unauthorized();
    if (!res.ok) throw new Error(await detail(res, "Couldn't send the command."));
    return await screenshotFromResponse(res);
  } catch (err) {
    throw err?.name === "AbortError" ? timeoutError() : err;
  } finally {
    deadline.cleanup();
  }
}
