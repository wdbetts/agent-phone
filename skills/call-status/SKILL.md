---
name: call-status
description: Check Agent Phone server status, config, and recent calls
user_invocable: true
---

# Call Status

Report the current status of the Agent Phone system.

## Steps

1. Check if `~/.agent-phone/state.json` exists and read it:
   ```bash
   cat ~/.agent-phone/state.json 2>/dev/null || echo "not found"
   ```
   The `mode` field indicates the current state: `off`, `call`, or `sms`.

2. Check if `~/.agent-phone/config.json` exists and read the configuration (mode, phone numbers).

3. Hit `http://localhost:3000/health` to check if the orchestrator server is running. Report the response or connection error.

4. If in mock mode, also check `http://localhost:3001/health` for the mock Twilio server.

5. Report a summary:
   - Mode: off / call / sms (since when)
   - Server: running/not running
   - Config mode: mock/live
   - Phone number: configured number or "mock"
   - Recent sessions: count from health endpoint
