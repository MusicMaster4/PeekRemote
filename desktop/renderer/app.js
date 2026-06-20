"use strict";

const REPO_URL = "https://github.com/MusicMaster4/PeekRemote";
const TAILSCALE_URL = "https://tailscale.com/download";
const TAILSCALE_IOS_URL = "https://apps.apple.com/app/tailscale/id1470499037";
const TAILSCALE_ANDROID_URL =
  "https://play.google.com/store/apps/details?id=com.tailscale.ipn";
const TAILSCALE_GUIDE_URL = "https://tailscale.com/kb/1017/install";

// Onboarding steps: Welcome(0) → This PC(1) → Phone(2) → PIN(3) → Finish(4).
const PIN_STEP = 3;
const LAST_STEP = 4;

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
  // PIN field
  pinRevealAll: false,
  pinRevealIndex: -1,
  pinRevealTimer: null,
  pinPrevLen: 0,
};

// ---------------------------------------------------------------- bootstrap
async function boot() {
  const info = await window.peek.appInfo();
  state.platform = info.platform;
  state.version = info.version;
  state.backendRunning = info.backend.running;
  state.elevation = info.elevation || state.elevation;

  $("#footer-version").textContent = `v${info.version}`;
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
  renderStep("fwd");
}

function renderStep(direction = "fwd") {
  const step = state.onboardStep;
  $$(".step").forEach((el) => (el.hidden = Number(el.dataset.step) !== step));
  $$("[data-step-dot]").forEach((d) =>
    d.classList.toggle("is-active", Number(d.dataset.stepDot) <= step)
  );
  $("#onb-back").hidden = step === 0;
  $("#onb-next").textContent = step === LAST_STEP ? "Finish" : "Next";

  // Re-trigger the directional one-shot enter animation on the visible step.
  const active = $(`.step[data-step="${step}"]`);
  if (active) {
    active.classList.remove("step-anim-fwd", "step-anim-back");
    void active.offsetWidth; // reflow so the animation replays
    active.classList.add(direction === "back" ? "step-anim-back" : "step-anim-fwd");
  }

  if (step === 0) playWelcomeIntro();
  if (step === 1) checkTailscale();
  if (step === PIN_STEP) {
    renderPinCells();
    setTimeout(() => $("#pin-input").focus(), 60);
  }
}

// Cinematic welcome entrance: split the title into letters for a staggered
// rise, then let the iris / lead / chips cascade in. One-shot only.
function playWelcomeIntro() {
  const title = $("#welcome-title");
  if (title && !title.dataset.split) {
    const text = title.textContent;
    title.textContent = "";
    [...text].forEach((ch, i) => {
      const span = document.createElement("span");
      span.className = "wl";
      span.textContent = ch;
      span.style.setProperty("--i", i);
      title.appendChild(span);
    });
    title.dataset.split = "1";
  }
  $$(".welcome-chips li").forEach((li, i) => li.style.setProperty("--i", i));

  const welcome = $(".welcome");
  if (!welcome) return;
  welcome.classList.remove("intro");
  void welcome.offsetWidth;
  welcome.classList.add("intro");
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

// ---- PIN field (custom masked cells) -------------------------------------
function renderPinCells() {
  const val = $("#pin-input").value;
  $$("#pin-cells .pin-cell").forEach((cell, i) => {
    const filled = i < val.length;
    const reveal = filled && (state.pinRevealAll || i === state.pinRevealIndex);
    cell.textContent = filled ? (reveal ? val[i] : "●") : "";
    cell.classList.toggle("is-filled", filled);
    cell.classList.toggle("is-reveal", reveal);
    cell.classList.toggle("is-next", i === val.length);
  });
}

function resetPinField() {
  $("#pin-input").value = "";
  state.pinPrevLen = 0;
  state.pinRevealIndex = -1;
  clearTimeout(state.pinRevealTimer);
  renderPinCells();
}

// ---- Start-on-boot segmented choice --------------------------------------
function getAutoStartChoice() {
  const sel = $("#autostart-choice .seg.is-selected");
  return sel ? sel.dataset.autostart === "1" : true;
}
function setAutoStartChoice(enabled) {
  $$("#autostart-choice .seg").forEach((b) => {
    const on = (b.dataset.autostart === "1") === Boolean(enabled);
    b.classList.toggle("is-selected", on);
    b.setAttribute("aria-checked", String(on));
  });
}

async function finishOnboarding() {
  const pin = $("#pin-input").value.trim();
  const err = validatePin(pin);
  if (err) {
    state.onboardStep = PIN_STEP;
    renderStep("back");
    $("#pin-error").textContent = err;
    return;
  }
  const autoStart = getAutoStartChoice();
  $("#onb-next").disabled = true;
  $("#onb-next").textContent = "Starting…";
  $("#finish-error").textContent = "";
  const res = await window.peek.completeOnboarding({ pin, autoStart });
  $("#onb-next").disabled = false;
  if (!res.ok) {
    $("#onb-next").textContent = "Finish";
    $("#finish-error").textContent = res.message || "Couldn't start the backend.";
    return;
  }
  // Reflect the saved preference in the panel, then animate across to it.
  $("#set-autostart").checked = autoStart;
  transitionToPanel();
}

function transitionToPanel() {
  const onb = $("#onboarding");
  onb.classList.add("view-leaving");
  setTimeout(() => {
    onb.classList.remove("view-leaving");
    showPanel(true);
  }, 340);
}

function wireOnboarding() {
  $("#onb-next").addEventListener("click", async () => {
    if (state.onboardStep === PIN_STEP) {
      const err = validatePin($("#pin-input").value.trim());
      $("#pin-error").textContent = err;
      if (err) return;
    }
    if (state.onboardStep === LAST_STEP) {
      await finishOnboarding();
      return;
    }
    state.onboardStep = Math.min(LAST_STEP, state.onboardStep + 1);
    renderStep();
  });

  $("#onb-back").addEventListener("click", () => {
    state.onboardStep = Math.max(0, state.onboardStep - 1);
    renderStep("back");
  });

  // PIN: keep digits in the hidden input; reveal each freshly typed digit for
  // 2s before it masks to a dot. The eye toggle reveals/hides the whole PIN.
  $("#pin-input").addEventListener("input", (e) => {
    const clean = e.target.value.replace(/\D/g, "").slice(0, 6);
    e.target.value = clean;
    $("#pin-error").textContent = "";
    if (clean.length > state.pinPrevLen) {
      state.pinRevealIndex = clean.length - 1;
      clearTimeout(state.pinRevealTimer);
      state.pinRevealTimer = setTimeout(() => {
        state.pinRevealIndex = -1;
        renderPinCells();
      }, 2000);
    } else {
      state.pinRevealIndex = -1;
    }
    state.pinPrevLen = clean.length;
    renderPinCells();
  });
  $("#pin-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#onb-next").click();
  });

  $("#pin-eye").addEventListener("click", () => {
    state.pinRevealAll = !state.pinRevealAll;
    const eye = $("#pin-eye");
    eye.classList.toggle("is-revealed", state.pinRevealAll);
    eye.setAttribute("aria-pressed", String(state.pinRevealAll));
    eye.setAttribute("aria-label", state.pinRevealAll ? "Hide PIN" : "Show PIN");
    renderPinCells();
    $("#pin-input").focus();
  });

  $$("#autostart-choice .seg").forEach((b) =>
    b.addEventListener("click", () => setAutoStartChoice(b.dataset.autostart === "1"))
  );

  $("#ts-download").addEventListener("click", () => window.peek.openExternal(TAILSCALE_URL));
  $("#ts-recheck").addEventListener("click", checkTailscale);

  // Phone-setup step resources
  $("#ts-ios").addEventListener("click", () => window.peek.openExternal(TAILSCALE_IOS_URL));
  $("#ts-android").addEventListener("click", () =>
    window.peek.openExternal(TAILSCALE_ANDROID_URL)
  );
  $("#ts-guide").addEventListener("click", () => window.peek.openExternal(TAILSCALE_GUIDE_URL));
}

// ============================ PANEL ============================
function showPanel(animate = false) {
  showView("panel");
  if (animate) {
    const panel = $("#panel");
    panel.classList.remove("panel-enter");
    void panel.offsetWidth; // reflow so the stagger replays
    panel.classList.add("panel-enter");
  }
  loadConnect();
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
  fitUrlBox();
  state.qrExpiresAt = info.expires_at * 1000;
  startQrTimer();
}

// Keep the whole pairing URL on a single line: shrink the font just enough to
// fit the box width (down to a readable floor) instead of wrapping.
function fitUrlBox() {
  const box = $("#tailnet-url");
  if (!box) return;
  box.style.fontSize = "";
  const text = box.textContent.trim();
  if (!text || text === "—") return;
  let size = parseFloat(getComputedStyle(box).fontSize) || 11;
  box.style.fontSize = `${size}px`;
  let guard = 0;
  while (box.scrollWidth > box.clientWidth && size > 7.5 && guard < 60) {
    size -= 0.5;
    box.style.fontSize = `${size}px`;
    guard += 1;
  }
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

function wirePanel() {
  window.addEventListener("resize", fitUrlBox);

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
    resetPinField();
    state.pinRevealAll = false;
    $("#pin-eye").classList.remove("is-revealed");
    setAutoStartChoice($("#set-autostart").checked);
    showOnboarding();
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
  if (s.version) {
    state.updateVersion = s.version;
  } else if (s.state === "none" || s.state === "error") {
    state.updateVersion = "";
  }

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
