#!/usr/bin/env bash
# <xbar.title>Burnrate</xbar.title>
# <xbar.desc>Coding-agent spend & 5-hour block forecast (Claude Code, Codex).</xbar.desc>
# <xbar.dependencies>node,burnrate</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# Install: copy to your xbar/SwiftBar plugin folder and `chmod +x`. Refreshes every minute.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"
if command -v burnrate >/dev/null 2>&1; then
  burnrate bar --no-color
else
  npx --yes burnrate bar --no-color
fi
