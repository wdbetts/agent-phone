---
name: going-mobile
description: Enable outbound calls — Claude will call you when it gets stuck
user_invocable: true
---

# Going Mobile

Enable "mobile mode" so that Claude Code will call you via phone when it gets stuck and needs a decision.

## Steps

1. Determine the mode by checking if `${CLAUDE_PLUGIN_ROOT}/.env` has Twilio credentials configured:
   ```bash
   grep -qs '^TWILIO_SID=.\+' ${CLAUDE_PLUGIN_ROOT}/.env && grep -qs '^DEVELOPER_PHONE_NUMBER=.\+' ${CLAUDE_PLUGIN_ROOT}/.env && echo "live" || echo "mock"
   ```
   `.env` is the source of truth for mode — ignore what `config.json` says about mode.

2. If **live mode**, extract the developer phone number (do NOT print auth tokens or SIDs):
   ```bash
   grep -s '^DEVELOPER_PHONE_NUMBER=' ${CLAUDE_PLUGIN_ROOT}/.env | cut -d= -f2
   ```
   If the `.env` file doesn't exist at all, tell the user: "Agent Phone is not configured yet. Run `cd <plugin-dir> && npm run setup` in a terminal first (it requires interactive input)." Then stop.

3. Write `~/.agent-phone/state.json`:
   ```bash
   mkdir -p ~/.agent-phone
   echo '{"mode": "call", "phone": "<DEVELOPER_PHONE_NUMBER or mock>", "since": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ~/.agent-phone/state.json
   ```

4. Start the services using the startup script. It sources `.env` automatically, handles config.json regeneration, tunnel setup, and cloudflared installation:
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh <mode>
   ```
   where `<mode>` is either `mock` or `live` based on step 1.

5. Verify the server is healthy:
   ```bash
   curl -s http://localhost:3000/health
   ```

6. Confirm to the user:
   - Mock mode: "Mobile mode active. When I get stuck, the mock phone at http://localhost:3002 will ring."
   - Live mode: "Mobile mode active. I'll call [phone number] if I get stuck."

To disable mobile mode: use `/agent-phone:stop`
To switch to SMS mode: use `/agent-phone:text-me`
