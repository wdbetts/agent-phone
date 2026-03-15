---
name: call-me
description: Switch to call mode — Claude will call you instead of texting when stuck
user_invocable: true
---

# Call Me

Switch to call mode. When Claude gets stuck, it will call you on the phone instead of texting.

## Steps

1. Check if `${CLAUDE_PLUGIN_ROOT}/.env` has Twilio credentials:
   ```bash
   grep -qs '^TWILIO_SID=.\+' ${CLAUDE_PLUGIN_ROOT}/.env && grep -qs '^DEVELOPER_PHONE_NUMBER=.\+' ${CLAUDE_PLUGIN_ROOT}/.env && echo "configured" || echo "missing"
   ```
   If missing, tell the user to run `npm run setup` first.

2. Extract the developer phone number:
   ```bash
   grep -s '^DEVELOPER_PHONE_NUMBER=' ${CLAUDE_PLUGIN_ROOT}/.env | cut -d= -f2
   ```

3. Ensure services are running:
   ```bash
   curl -s http://localhost:3000/health > /dev/null 2>&1 || bash ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh live
   ```

4. Write `~/.agent-phone/state.json`:
   ```bash
   echo '{"mode": "call", "phone": "<DEVELOPER_PHONE_NUMBER>", "since": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ~/.agent-phone/state.json
   ```

5. Confirm: "Call mode active. I'll call [phone number] when I get stuck."
