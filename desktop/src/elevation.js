"use strict";

const { app } = require("electron");
const { execFile, spawn } = require("child_process");
const path = require("path");

const TASK_PATH = "\\Peek Remote\\";
const TASK_SHOW = "Peek Remote Elevated";
const TASK_HIDDEN = "Peek Remote Elevated Hidden";
const TASK_STARTUP = "Peek Remote Startup";

function isWindowsPackaged() {
  return process.platform === "win32" && app.isPackaged;
}

function isElevatedTaskLaunch() {
  return process.argv.includes("--elevated-task");
}

function wantsHiddenLaunch() {
  return process.argv.includes("--hidden");
}

function shouldRelaunchElevated() {
  return (
    isWindowsPackaged() &&
    !isElevatedTaskLaunch() &&
    process.env.PEEK_REMOTE_DISABLE_ELEVATION !== "1"
  );
}

function relaunchElevatedSelf() {
  const taskName = TASK_PATH + (wantsHiddenLaunch() ? TASK_HIDDEN : TASK_SHOW);
  return runTask(taskName);
}

function runTask(taskName) {
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    const child = spawn("schtasks.exe", ["/Run", "/TN", taskName], {
      windowsHide: true,
      stdio: "ignore",
    });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, 5000);

    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
  });
}

function configureAutoStart(enabled, exePath = process.execPath) {
  if (!isWindowsPackaged()) {
    return Promise.resolve({ ok: false, message: "Not a packaged Windows app." });
  }

  const script = buildAutoStartScript(Boolean(enabled), exePath);
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const powershell = powershellPath();

  return new Promise((resolve) => {
    execFile(
      powershell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            message: cleanPowerShellError(stderr || stdout || err.message),
          });
          return;
        }
        resolve({ ok: true });
      }
    );
  });
}

function buildAutoStartScript(enabled, exePath) {
  const enabledLiteral = enabled ? "$true" : "$false";
  return `
$ErrorActionPreference = 'Stop'
$taskPath = ${psString(TASK_PATH)}
$taskName = ${psString(TASK_STARTUP)}
if (${enabledLiteral}) {
  $exePath = ${psString(exePath)}
  $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $action = New-ScheduledTaskAction -Execute $exePath -Argument '--elevated-task --hidden'
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts Peek Remote elevated at login.' -Force | Out-Null
} else {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}
`;
}

function psString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// PowerShell writes its error/progress streams as CLIXML when stderr is
// redirected, which is unreadable in a UI. Pull out the human text if we can,
// otherwise fall back to a plain sentence. Never return raw CLIXML.
function cleanPowerShellError(raw) {
  const s = String(raw || "").trim();
  if (!s) return "Windows could not configure start-on-boot.";
  if (s.includes("CLIXML") || s.includes("<Objs")) {
    const errors = [...s.matchAll(/<S S="Error">([^<]*)<\/S>/g)]
      .map((m) => decodeClixml(m[1]))
      .join(" ")
      .trim();
    return errors || "Windows could not configure start-on-boot.";
  }
  return s;
}

function decodeClixml(text) {
  return String(text)
    .replace(/_x000D_/g, "")
    .replace(/_x000A_/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function powershellPath() {
  const root = process.env.SystemRoot || "C:\\Windows";
  return path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

module.exports = {
  configureAutoStart,
  isElevatedTaskLaunch,
  relaunchElevatedSelf,
  shouldRelaunchElevated,
};
