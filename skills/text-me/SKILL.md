---
name: text-me
description: Switch to SMS mode — Claude will text you instead of calling when stuck
user_invocable: true
---

# Text Me

Switch to SMS mode. When Claude gets stuck, it will send you a text message instead of calling.

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
   echo '{"mode": "sms", "phone": "<DEVELOPER_PHONE_NUMBER>", "since": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ~/.agent-phone/state.json
   ```

5. Confirm: "SMS mode active. I'll text [phone number] when I get stuck instead of calling."
