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

export async function captureScreenshot(profile = "photo") {
  const res = await req(`/api/screenshots/raw?profile=${encodeURIComponent(profile)}`, {
    method: "POST",
  });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Failed to capture the screen."));
  return screenshotFromResponse(res);
}

export async function sendInput(payload) {
  const res = await req("/api/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't send the command."));
  return res.json();
}

export async function sendInputAndCapture(payload) {
  const res = await req("/api/input/screenshot/raw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 401) throw unauthorized();
  if (!res.ok) throw new Error(await detail(res, "Couldn't send the command."));
  return screenshotFromResponse(res);
}
