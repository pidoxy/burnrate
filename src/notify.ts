import { execFile } from "node:child_process";

/** Best-effort desktop notification (macOS, Linux, Windows). Never throws. */
export function notify(title: string, body: string) {
  const cb = () => {};
  try {
    if (process.platform === "darwin") {
      const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      execFile("osascript", ["-e", `display notification "${esc(body)}" with title "${esc(title)}"`], cb);
    } else if (process.platform === "win32") {
      const ps = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(8000, $env:BR_T, $env:BR_B, 'Info'); Start-Sleep 9`;
      execFile("powershell", ["-NoProfile", "-Command", ps], { env: { ...process.env, BR_T: title, BR_B: body } }, cb);
    } else {
      execFile("notify-send", ["-a", "Burnrate", title, body], cb);
    }
  } catch {
    /* ignore */
  }
  process.stdout.write(`\x07[${new Date().toLocaleTimeString()}] ${title}: ${body}\n`);
}

export function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    execFile(cmd, args, () => {});
  } catch {
    /* headless */
  }
}
