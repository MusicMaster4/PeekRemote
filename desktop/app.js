"use strict";

const REPO_URL = "https://github.com/MusicMaster4/PeekRemote";
const TAILSCALE_URL = "https://tailscale.com/download";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  platform: "win32",
  version: "",
  backendRunning: false,
  onboardStep: 0,
  pin: "",
  qrTimer: null,
  qrExpiresAt: 0,
  updateState: "none",
  updateVersion: "",
  elevation: { usesElevatedTasks: false, isElevatedTaskLaunch: false },
};

// ---------------------------------------------------------------- bootstrap
async function boot() {
  const info = await window.peek.appInfo();
  state.platform = info.platform;
  state.version = info.version;
  state.backendRunning = info.backend.running;
  state.elevation = info.elevation || state.elevation;

  $("#footer-version").textContent = `Peek Remote v${info.version}`;
  $("#update-state").textContent = `Current version: v${info.version}`;

  // Settings reflect saved config
  $("#set-autostart").checked = info.config.autoStart;
  $("#set-autoupdate").checked = info.config.autoCheckUpdates;

  wireGlobalEvents();

  if (info.config.onboardingComplete && info.config.hasPin) {
    showPanel();
  } else {
    showOnboarding();
  }

  updateStatus();
}

function wireGlobalEvents() {
  window.peek.onBackendState((s) => {
    state.backendRunning = Boolean(s.running);
    updateStatus();
    if (s.running && !$("#panel").hidden) loadConnect();
  });

  window.peek.onUpdateStatus(handleUpdateStatus);

  $("#repo-link").addEventListener("click", (e) => {
    e.preventDefault();
    window.peek.openExternal(REPO_URL);
  });

  // Update banner
  $("#update-banner-action").addEventListener("click", onUpdateAction);
  $("#update-banner-dismiss").addEventListener("click", () => ($("#update-banner").hidden = true));
}

function setStatus(dotClass, text) {
  const dot = $("#status-dot");
  dot.className = `dot ${dotClass}`;
  $("#status-text").textContent = text;
}

async function updateStatus() {
  if (!state.backendRunning) {
    setStatus("dot-idle", "Starting…");
    return;
  }
  // Backend up — confirm Tailscale is publishing.
  const res = await window.peek.connectInfo();
  if (res.ok && res.info && res.info.tailscale_ready) {
    setStatus("dot-ok", "Ready");
  } else {
    setStatus("dot-warn", "Tailscale offline");
  }
}

// ---------------------------------------------------------------- views
function showView(id) {
  $$(".view").forEach((v) => (v.hidden = v.id !== id));
}

// ============================ ONBOARDING ============================
function showOnboarding() {
  state.onboardStep = 0;
  showView("onboarding");
  renderStep();
}

function renderStep() {
  const step = state.onboardStep;
  $$(".step").forEach((el) => (el.hidden = Number(el.dataset.step) !== step));
  $$("[data-step-dot]").forEach((d) =>
    d.classList.toggle("is-active", Number(d.dataset.stepDot) <= step)
  );
  $("#onb-back").hidden = step === 0;
  $("#onb-next").textContent = step === 3 ? "Finish" : "Next";

  if (step === 1) checkTailscale();
  if (step === 2) setTimeout(() => $("#pin-input").focus(), 50);
  if (step === 3) renderPermNote();
}

function renderPermNote() {
  const el = $("#perm-note");
  if (state.platform === "darwin") {
    el.innerHTML =
      "On macOS, the first time you control this Mac you'll be asked to grant " +
      "<strong>Screen Recording</strong> and <strong>Accessibility</strong> " +
      "permissions to Peek Remote. Approve both in System Settings → Privacy &amp; Security.";
  } else if (state.platform === "win32") {
    if (state.elevation.usesElevatedTasks) {
      el.innerHTML =
        "On Windows, the installer configures Peek Remote to start elevated " +
        "through Task Scheduler. You approve administrator access once during install, " +
        "not every time the app opens.";
    } else {
      el.innerHTML =
        "On Windows, controlling administrator windows requires running Peek Remote " +
        "as administrator.";
    }
  } else {
    el.textContent = "You're all set.";
  }
}

async function checkTailscale() {
  const card = $("#ts-state");
  card.innerHTML = `<div class="status-line"><span class="dot dot-idle"></span><span>Checking…</span></div>`;
  const s = await window.peek.tailscaleStatus();
  let dot = "dot-warn";
  let msg = "";
  if (!s.found) {
    dot = "dot-warn";
    msg = "Tailscale not found. Install it, then re-check.";
  } else if (!s.loggedIn) {
    dot = "dot-warn";
    msg = "Tailscale is installed but not signed in. Open Tailscale and log in.";
  } else if (!s.running) {
    dot = "dot-warn";
    msg = "Tailscale is signed in but not connected. Connect it, then re-check.";
  } else {
    dot = "dot-ok";
    msg = s.dnsName ? `Connected as ${s.dnsName}` : "Connected.";
  }
  card.innerHTML = `<div class="status-line"><span class="dot ${dot}"></span><span>${escapeHtml(
    msg
  )}</span></div>`;
}

function validatePin(pin) {
  if (!/^\d{6}$/.test(pin)) return "PIN must be exactly 6 digits.";
  if (["000000", "111111", "123456", "654321", "121212", "112233"].includes(pin))
    return "Choose a less predictable 6-digit PIN.";
  return "";
}

async function finishOnboarding() {
  const pin = $("#pin-input").value.trim();
  const err = validatePin(pin);
  if (err) {
    state.onboardStep = 2;
    renderStep();
    $("#pin-error").textContent = err;
    return;
  }
  const autoStart = $("#onb-autostart").checked;
  $("#onb-next").disabled = true;
  $("#onb-next").textContent = "Starting…";
  const res = await window.peek.completeOnboarding({ pin, autoStart });
  $("#onb-next").disabled = false;
  if (!res.ok) {
    $("#onb-next").textContent = "Finish";
    $("#perm-note").innerHTML = `<span class="danger">${escapeHtml(
      res.message || "Couldn't start the backend."
    )}</span>`;
    return;
  }
  // Reflect new settings in the panel and go there.
  $("#set-autostart").checked = autoStart;
  showPanel();
}

function wireOnboarding() {
  $("#onb-next").addEventListener("click", async () => {
    if (state.onboardStep === 2) {
      const err = validatePin($("#pin-input").value.trim());
      $("#pin-error").textContent = err;
      if (err) return;
    }
    if (state.onboardStep === 3) {
      await finishOnboarding();
      return;
    }
    state.onboardStep = Math.min(3, state.onboardStep + 1);
    renderStep();
  });

  $("#onb-back").addEventListener("click", () => {
    state.onboardStep = Math.max(0, state.onboardStep - 1);
    renderStep();
  });

  $("#pin-input").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
    $("#pin-error").textContent = "";
  });
  $("#pin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#onb-next").click();
  });

  $("#ts-download").addEventListener("click", () => window.peek.openExternal(TAILSCALE_URL));
  $("#ts-recheck").addEventListener("click", checkTailscale);
}

// ============================ PANEL ============================
function showPanel() {
  showView("panel");
  loadConnect();
  refreshLogs();
  syncUpdateCard();
}

async function loadConnect() {
  stopQrTimer();
  const wrap = $("#qr-wrap");
  const warn = $("#connect-warning");
  const res = await window.peek.connectInfo();

  if (!res.ok || !res.info) {
    wrap.innerHTML = `<div class="qr-placeholder mono small">Backend not ready…</div>`;
    warn.hidden = false;
    warn.innerHTML = `<div class="status-line"><span class="dot dot-warn"></span><span>Waiting for the backend. <a href="#" id="retry-connect">Retry</a></span></div>`;
    $("#retry-connect")?.addEventListener("click", (e) => {
      e.preventDefault();
      loadConnect();
    });
    return;
  }

  const info = res.info;
  if (!info.tailscale_ready) {
    wrap.innerHTML = `<div class="qr-placeholder mono small">Tailscale offline</div>`;
    $("#tailnet-url").textContent = "—";
    $("#qr-timer").textContent = "--:--";
    warn.hidden = false;
    const hint = info.tailscale_found
      ? "Tailscale is installed but not connected. Open Tailscale, sign in, and make sure MagicDNS is on."
      : "Tailscale isn't installed on this PC. Install it and sign in.";
    warn.innerHTML = `<div class="status-line"><span class="dot dot-warn"></span><span>${escapeHtml(
      hint
    )}</span></div><div class="actions-row"><button class="btn btn-ghost btn-sm" id="open-ts">Get Tailscale ↗</button><button class="btn btn-ghost btn-sm" id="recheck-ts">Re-check</button></div>`;
    $("#open-ts")?.addEventListener("click", () => window.peek.openExternal(TAILSCALE_URL));
    $("#recheck-ts")?.addEventListener("click", loadConnect);
    return;
  }

  warn.hidden = true;
  wrap.innerHTML = info.qr_svg || "";
  $("#tailnet-url").textContent = info.app_url || "—";
  state.qrExpiresAt = info.expires_at * 1000;
  startQrTimer();
}

function startQrTimer() {
  stopQrTimer();
  const tick = () => {
    const left = Math.max(0, Math.round((state.qrExpiresAt - Date.now()) / 1000));
    const m = String(Math.floor(left / 60)).padStart(2, "0");
    const s = String(left % 60).padStart(2, "0");
    $("#qr-timer").textContent = `${m}:${s}`;
    if (left <= 0) {
      stopQrTimer();
      loadConnect(); // regenerate a fresh single-use token
    }
  };
  tick();
  state.qrTimer = setInterval(tick, 1000);
}
function stopQrTimer() {
  if (state.qrTimer) clearInterval(state.qrTimer);
  state.qrTimer = null;
}

async function refreshLogs() {
  const logs = await window.peek.backendLogs();
  const out = $("#log-output");
  out.textContent = logs || "(no output yet)";
  out.scrollTop = out.scrollHeight;
}

function wirePanel() {
  $("#qr-refresh").addEventListener("click", loadConnect);
  $("#copy-url").addEventListener("click", async () => {
    const url = $("#tailnet-url").textContent;
    if (url && url !== "—") {
      await window.peek.copy(url);
      flash($("#copy-url"), "Copied");
    }
  });

  $("#set-autostart").addEventListener("change", async (e) => {
    const requested = e.target.checked;
    const res = await window.peek.setAutoStart(requested);
    if (!res.ok) {
      e.target.checked = !requested;
      window.alert(res.message || "Could not change the startup setting.");
    }
  });
  $("#set-autoupdate").addEventListener("change", (e) =>
    window.peek.setAutoCheckUpdates(e.target.checked)
  );

  $("#rerun-setup").addEventListener("click", async () => {
    await window.peek.restartOnboarding();
    $("#pin-input").value = "";
    $("#onb-autostart").checked = $("#set-autostart").checked;
    showOnboarding();
  });

  window.peek.onBackendLog(() => {
    if (!$("#panel").hidden) refreshLogs();
  });

  $("#update-check").addEventListener("click", async () => {
    const button = $("#update-check");
    button.disabled = true;
    try {
      setUpdateText("Checking for updates...");
      const r = await window.peek.checkForUpdate();
      if (!r || !r.ok) {
        setUpdateText(`Update check failed: ${(r && r.message) || "No response from updater"}`);
        clearUpdateActions();
      } else if (r.dev) {
        setUpdateText("Updates are available only in the installed app.");
        clearUpdateActions();
      } else if (r.updateAvailable) {
        handleUpdateStatus({ state: "available", version: r.version });
      } else {
        handleUpdateStatus({ state: "none", version: r.version || state.version });
      }
    } catch (err) {
      setUpdateText(`Update check failed: ${errorMessage(err)}`);
      clearUpdateActions();
    } finally {
      button.disabled = false;
    }
  });
  $("#update-action").addEventListener("click", onUpdateAction);
}

// ============================ UPDATES ============================
function setUpdateText(text) {
  $("#update-state").textContent = text;
}

function errorMessage(err) {
  return String(err && err.message ? err.message : err);
}

function syncUpdateCard() {
  setUpdateText(`Current version: v${state.version}`);
}

function setUpdateAction({ hidden = false, text = "Download", disabled = false } = {}) {
  const action = $("#update-action");
  const bannerAction = $("#update-banner-action");
  action.hidden = hidden;
  action.disabled = disabled;
  action.textContent = text;
  bannerAction.disabled = disabled;
  bannerAction.textContent = text;
}

function clearUpdateActions() {
  setUpdateAction({ hidden: true, disabled: false });
  $("#update-banner").hidden = true;
}

function handleUpdateStatus(s) {
  state.updateState = s.state;
  state.updateVersion = s.version || "";

  switch (s.state) {
    case "checking":
      setUpdateText("Checking for updates...");
      clearUpdateActions();
      break;
    case "none":
      setUpdateText("You're on the latest version.");
      clearUpdateActions();
      break;
    case "available":
      setUpdateText(
        s.error ? `Download failed: ${s.error}` : `Update available: v${s.version}`
      );
      setUpdateAction({ hidden: false, text: "Download", disabled: false });
      $("#update-banner-text").textContent = `Update available: v${s.version}`;
      $("#update-banner").hidden = false;
      break;
    case "downloading":
      setUpdateText(`Downloading... ${s.percent || 0}%`);
      setUpdateAction({ hidden: false, text: `${s.percent || 0}%`, disabled: true });
      $("#update-banner-text").textContent = `Downloading update v${
        s.version || state.updateVersion
      }`;
      $("#update-banner").hidden = false;
      break;
    case "downloaded":
      setUpdateText(`Update v${s.version} ready.`);
      setUpdateAction({ hidden: false, text: "Install & Restart", disabled: false });
      $("#update-banner-text").textContent = `Update v${s.version} ready to install.`;
      $("#update-banner").hidden = false;
      break;
    case "error":
      setUpdateText(`Update error: ${s.message || "unknown"}`);
      clearUpdateActions();
      break;
  }
}

async function onUpdateAction() {
  if (state.updateState === "checking" || state.updateState === "downloading") return;

  if (state.updateState === "downloaded") {
    setUpdateAction({ hidden: false, text: "Installing...", disabled: true });
    try {
      const r = await window.peek.installUpdate();
      if (!r || !r.ok) {
        setUpdateText(`Install failed: ${(r && r.message) || "No response from updater"}`);
        setUpdateAction({ hidden: false, text: "Install & Restart", disabled: false });
      }
    } catch (err) {
      setUpdateText(`Install failed: ${errorMessage(err)}`);
      setUpdateAction({ hidden: false, text: "Install & Restart", disabled: false });
    }
    return;
  }

  setUpdateAction({ hidden: false, text: "Checking...", disabled: true });
  try {
    const r = await window.peek.downloadUpdate();
    if (!r || !r.ok) {
      if (r && r.noUpdate) {
        handleUpdateStatus({ state: "none", version: r.version || state.version });
      } else {
        setUpdateText(`Download failed: ${(r && r.message) || "No response from updater"}`);
        setUpdateAction({ hidden: false, text: "Download", disabled: false });
      }
    }
  } catch (err) {
    setUpdateText(`Download failed: ${errorMessage(err)}`);
    setUpdateAction({ hidden: false, text: "Download", disabled: false });
  }
}

// ---------------------------------------------------------------- utils
function flash(btn, text) {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = prev), 1200);
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------------------------------------------------------------- init
wireOnboarding();
wirePanel();
boot();
