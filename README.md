# Agent Phone

A Claude Code plugin that calls you on the phone when the agent gets stuck and needs a decision. Instead of blocking on a question in the terminal, Claude places an outbound voice call, talks through the problem with you, and resumes work with your answer. Works locally with a browser-based mock phone (no accounts needed) or with real Twilio calls to your cell.

## Quick Start -- Local Mock Mode

No Twilio account or API keys required.

```bash
git clone https://github.com/wdbetts/agent-phone.git
cd agent-phone
npm install
npm run setup        # choose option 1 (local testing)
```

Start the servers:

```bash
# Option A: run directly
./scripts/start.sh mock     # starts server + mock Twilio + phone UI
./scripts/start.sh stop     # stop all services

# Option B: Docker
docker compose --profile dev up
```

Open **http://localhost:3002** for the mock phone UI. Toggle voice mode to use your browser's microphone and speaker via Web Speech API.

Launch Claude Code with the plugin loaded:

```bash
claude --plugin-dir /path/to/agent-phone
```

Then activate mobile mode:

```
/agent-phone:going-mobile
```

When Claude gets stuck, the mock phone rings in your browser.

## Full Setup -- Real Twilio Calls

### Prerequisites

- A **Twilio account**. Trial accounts work (calls are limited to verified numbers, which is fine for calling yourself). See:
  - [Create a Twilio account](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account)
  - [Verify your phone number](https://www.twilio.com/docs/usage/tutorials/how-to-use-your-free-trial-account#verify-your-personal-phone-number) in the Twilio console
- **AI/ML Addendum** enabled in the Twilio console. ConversationRelay requires the Predictive and Generative AI/ML Features Addendum. Enable it at [Voice Settings > General](https://console.twilio.com/us1/develop/voice/settings/general?frameUrl=%2Fconsole%2Fvoice%2Fsettings%3Fx-target-region%3Dus1). Without this, calls will fail with a "We are sorry" message.
- A **Claude API** provider -- either:
  - An [Anthropic API key](https://docs.anthropic.com/en/docs/initial-setup), or
  - [Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) with Claude model access enabled and AWS credentials configured

### Setup

The setup wizard handles everything: credential validation, phone number provisioning, Claude provider config, and a verification test call.

```bash
npm run setup        # choose option 2 (full setup)
```

The wizard will:

1. **Twilio credentials** -- enter your Account SID and Auth Token (or reuse values from `.env`)
2. **AI/ML addendum** -- opens the Twilio console so you can enable the required addendum
3. **Phone number** -- auto-provision a new US number or enter an existing one
4. **Your number** -- the phone number Claude should call when it needs you
5. **Claude provider** -- choose Anthropic API (enter API key) or Bedrock (enter AWS region, uses standard credential chain)
6. **cloudflared** -- checks if `cloudflared` is installed and offers to install it via Homebrew (needed for Twilio callbacks in live mode)
7. **Test call** -- places a real call to your phone to verify the setup works end-to-end

Config is saved to `~/.agent-phone/config.json` and `.env`.

### Start the server

The startup script handles everything -- server, tunnel, and health checks:

```bash
./scripts/start.sh live     # starts server + cloudflared tunnel
./scripts/start.sh stop     # stop all services
```

For live mode, `cloudflared` is required for Twilio callbacks. The script will auto-install it via Homebrew if not found. Alternatively, use Docker:

```bash
docker compose --profile prod up
```

### Activate

Launch Claude Code with the plugin:

```bash
claude --plugin-dir /path/to/agent-phone
```

Then go mobile:

| Command | Description |
|---|---|
| `/agent-phone:going-mobile` | Enable call mode |
| `/agent-phone:text-me` | Switch to SMS mode |
| `/agent-phone:call-me` | Switch back to call mode |
| `/agent-phone:stop` | Disable all notifications |
| `/agent-phone:call-status` | Check status |

You can load the plugin on every session by adding the flag to your shell alias, or use `/plugin` inside Claude Code to install it from a marketplace for persistent use.

## How It Works

```
Claude gets stuck ──> Stop hook fires ──> POST /call-needed ──> Twilio outbound call/SMS
                                                                      |
Claude resumes   <── Hook returns    <── Answer extracted  <── Voice conversation
with phone context   block + reason      from transcript       or SMS reply
                                                                (ConversationRelay
                                                                + Claude API)
```

1. A **Stop hook** fires when Claude finishes a turn. The hook checks if mobile mode is active (`mode: "call"` or `mode: "sms"`) and if the message contains a question.
2. If blocked, the hook POSTs the question to the local orchestrator server (`localhost:3000/call-needed`) and **blocks** waiting for a response.
3. The server places an **outbound call** via Twilio (or sends an SMS if in SMS mode), or uses the mock server in dev mode.
4. **Call mode**: When you pick up, Twilio connects a **ConversationRelay** WebSocket. A separate Claude API session (via Anthropic or Bedrock) conducts the voice conversation with injected coding context. **SMS mode**: Claude sends the question as a text message and waits for your reply.
5. After the call or SMS reply, the answer flows back through the hook response as `{"decision": "block", "reason": "Developer responded via phone: ..."}` and Claude resumes work.

### Voice-Directed Preferences

During a phone call, you can tell Claude "text me next time" to switch to SMS mode, or "stop calling" to disable notifications entirely. Claude will update the mode accordingly for future interactions.

The `stop_hook_active` field prevents infinite loops -- if the hook already triggered this continuation, it exits without calling again.

## Configuration Reference

All options can be set in `.env` (see `.env.example`):

| Variable | Description |
|---|---|
| `MODE` | `mock` or `live` |
| `TWILIO_SID` | Twilio Account SID |
| `TWILIO_AUTH_TOKEN` | Twilio Auth Token |
| `TWILIO_PHONE_NUMBER` | Twilio number to call from (auto-provisioned by setup) |
| `DEVELOPER_PHONE_NUMBER` | Your phone number to receive calls |
| `CLAUDE_PROVIDER` | `anthropic` or `bedrock` |
| `ANTHROPIC_API_KEY` | API key (when using Anthropic) |
| `AWS_REGION` | AWS region (when using Bedrock, default `us-east-1`) |
| `BEDROCK_MODEL` | Bedrock model ID (default `us.anthropic.claude-sonnet-4-20250514-v1:0`) |
| `ANTHROPIC_MODEL` | Anthropic model ID (default `claude-sonnet-4-20250514`) |
| `PORT` | Server port (default `3000`) |
| `TUNNEL_URL` | Public URL for Twilio callbacks |

## Development

Run tests:

```bash
MOCK_VOICE=true npm test      # unit + integration tests
./test/e2e.sh                  # full end-to-end mock flow
./test/e2e.sh live             # e2e with real Twilio call
npm run health                 # check server status
```

### Project Structure

```
.claude-plugin/  Plugin manifest
server/          Fastify orchestrator (HTTP + WebSocket)
mock/            Mock Twilio server and browser phone UI (with voice support)
hooks/           Stop hook registration
scripts/         Setup wizard, hook runner, blocked-state detection
skills/          Slash command definitions (going-mobile, call-me, text-me, stop, call-status)
```

## Troubleshooting

- **"We are sorry" error on call** -- Enable the AI/ML addendum in the Twilio console: [Voice Settings > General](https://console.twilio.com/us1/develop/voice/settings/general?frameUrl=%2Fconsole%2Fvoice%2Fsettings%3Fx-target-region%3Dus1). ConversationRelay will not work without it.
- **Call connects but Claude is silent** -- Check `CLAUDE_PROVIDER` in `.env` and make sure the matching credentials are set (`ANTHROPIC_API_KEY` for anthropic, or valid AWS credentials for bedrock).
- **Server won't start** -- Check if port 3000 is already in use: `lsof -i :3000`. Kill the existing process or set a different `PORT` in `.env`.
- **Stop hook doesn't fire** -- Make sure mobile mode is active (`cat ~/.agent-phone/state.json` should show `"mode": "call"` or `"mode": "sms"`). Also check that the plugin is loaded (`claude --plugin-dir /path/to/agent-phone`).
- **Tunnel issues in live mode** -- Run `npm run health` to verify the server is running and the tunnel URL is set. If cloudflared isn't installed, `./scripts/start.sh live` will auto-install it via Homebrew.

## License

MIT
