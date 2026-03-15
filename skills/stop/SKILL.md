---
name: stop
description: Disable mobile mode — Claude will stop calling/texting when stuck
user_invocable: true
---

# Stop

Disable mobile mode.

## Steps

1. Write `~/.agent-phone/state.json`:
   ```bash
   echo '{"mode": "off", "phone": "", "since": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ~/.agent-phone/state.json
   ```

2. Optionally stop the services:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh stop
   ```

3. Confirm: "Mobile mode disabled. I'll ask questions in the terminal from now on."
