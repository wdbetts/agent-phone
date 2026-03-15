# Agent Phone — Build Journal

## TL;DR

Claude Code plugin that **calls or texts you when the AI agent is stuck**. Uses Twilio ConversationRelay for real-time voice, with a separate Claude session conducting the call. The developer's answer flows back and Claude resumes automatically.

**What worked:** Twilio API for number provisioning, outbound calls, webhook config — all fully automatable. ConversationRelay + cloudflared tunnel worked great once configured. Bedrock and Anthropic API both supported. Voice calls work immediately, no waiting.

**What was painful:** SMS is blocked until toll-free verification is approved (3-5 business day wait, no way to skip). Local US numbers need 10DLC registration for SMS. We switched to toll-free (voice + SMS capable), submitted verification via API, but still waiting. Also: accepting the AI/ML addendum has no API — must be done manually in the console.

**What we'd want from Twilio:** Read-only API for addendum status, developer-mode SMS to your own verified number, instant low-volume toll-free approval.

---

## Goal

Build a Claude Code plugin that calls the developer on the phone when the AI coding agent gets stuck and needs a decision. The agent should be able to run autonomously (via `/loop`) and reach the developer wherever they are — no need to be at the terminal.

**Core flow:** Claude gets stuck → stop hook fires → outbound phone call → voice conversation → answer flows back → Claude resumes.

## What We Built (in one session)

### Phase 1: Core Voice Bridge
- **Plugin structure**: `.claude-plugin/plugin.json`, hooks, skills
- **Stop hook** (`scripts/stop-hook.sh`): detects when Claude asks a question, POSTs to orchestrator
- **Orchestrator server** (`server/index.js`): Fastify + WebSocket, handles `/call-needed`, `/twiml`, `/ws`
- **ConversationRelay handler** (`server/conversation.js`): WebSocket protocol for real-time voice
- **Claude voice session** (`server/claude.js`): separate Claude API call for the phone conversation, with injected coding context
- **Mock system**: fake Twilio + browser phone UI with Web Speech API for local testing
- **Docker Compose**: profiles for dev (mock) and prod (tunnel)

### Phase 2: SMS + Controls
- **SMS mode** (`server/sms.js`): text instead of call, wait for SMS reply
- **Voice-directed preferences**: say "text me instead" or "stop calling" during a call
- **5 slash commands**: `going-mobile`, `text-me`, `call-me`, `stop`, `call-status`
- **Multi-mode state**: `off` / `call` / `sms` in `~/.agent-phone/state.json`

### Infrastructure
- **Setup wizard** (`scripts/setup-wizard.js`): interactive first-run, auto-provisions toll-free number, auto-submits toll-free verification, installs cloudflared, places test call
- **Start script** (`scripts/start.sh`): manages server + tunnel lifecycle, auto-configures Twilio webhooks
- **Health check** (`npm run health`): server status at a glance
- **51 unit tests + e2e test** covering the full unblock flow

---

## What Worked Well (Fully Automated)

### Twilio Account Setup
| Step | Automated? | How |
|------|-----------|-----|
| Search available phone numbers | Yes | Twilio REST API |
| Purchase toll-free number | Yes | Twilio REST API |
| Configure SMS webhook on number | Yes | Twilio REST API (auto-runs on each `start.sh live`) |
| Place test verification call | Yes | Twilio REST API with inline TwiML |
| Submit toll-free verification | Yes | Messaging Compliance API |

### Server Infrastructure
| Step | Automated? | How |
|------|-----------|-----|
| Start/stop server | Yes | `start.sh` with PID management |
| Start cloudflared tunnel | Yes | `start.sh` auto-detects/installs via Homebrew |
| Parse tunnel URL | Yes | Regex on cloudflared output |
| Restart server with tunnel URL | Yes | `start.sh` handles the sequence |
| Configure Twilio webhooks with tunnel URL | Yes | `start.sh` calls Twilio API on each start |

### Claude API
| Step | Automated? | How |
|------|-----------|-----|
| Anthropic API support | Yes | `@anthropic-ai/sdk` |
| Amazon Bedrock support | Yes | `@anthropic-ai/bedrock-sdk`, standard AWS credential chain |
| Provider switching | Yes | `CLAUDE_PROVIDER=bedrock` in `.env` |
| Mock voice for testing | Yes | `MOCK_VOICE=true` returns canned responses |

---

## Issues We Hit & How We Solved Them

### 1. Fastify 415 "Unsupported Media Type"
**Problem:** Twilio POSTs to `/twiml` with `Content-Type: application/x-www-form-urlencoded`. Fastify rejected it.
**Discovery:** Found via Twilio Call Events API — the response showed `FST_ERR_CTP_INVALID_MEDIA_TYPE`.
**Fix:** Added `@fastify/formbody` plugin.
**Could Twilio help?** Twilio's error debugger didn't surface this — no alerts or notifications were generated. The call just failed silently from the developer's perspective ("We are sorry" message). We had to dig into the Call Events API to find the 415.

### 2. ConversationRelay AI/ML Addendum
**Problem:** Calls connected but immediately played "We are sorry, an application error has occurred."
**Discovery:** TwiML was valid, WebSocket worked through tunnel, but ConversationRelay requires the "Predictive and Generative AI/ML Features Addendum" to be enabled.
**Fix:** Manual toggle in Twilio Console at Voice > Settings > General.
**Blocker:** **No API to enable this.** Must be done manually in the console. This is a legal agreement, so it makes sense, but it's a friction point for automated setup. We open the console page in the browser during setup to reduce friction.
**Twilio opportunity:** An API to check if the addendum is enabled (read-only) would help — the setup wizard could detect this and give a clear error instead of the generic "We are sorry."

### 3. Claude Provider Not Set
**Problem:** Voice calls connected but Claude was silent — greeting failed with "Hi, the coding agent needs your help but I'm having trouble."
**Discovery:** The server was configured for `provider: bedrock` in config.json but `CLAUDE_PROVIDER` wasn't in `.env`. Server defaulted to `anthropic` and failed because `ANTHROPIC_API_KEY` wasn't set either.
**Fix:** Added proper config precedence (env vars override config.json), startup validation logging, and clear error messages.

### 4. Config.json vs .env Precedence
**Problem:** Setup wizard wrote config.json, but env vars in .env were ignored because config.json took priority.
**Fix:** Reversed precedence: env vars > config.json > defaults. Also made `start.sh` regenerate config.json from .env on every start, so it's never stale.

### 5. Session Not Found on WebSocket Connect
**Problem:** When testing by directly calling the Twilio API (bypassing `/call-needed`), the WebSocket handler couldn't find the session and closed immediately.
**Discovery:** The session is only created by `/call-needed`. Direct API calls bypass session creation.
**Fix:** Not a bug per se — the correct flow goes through `/call-needed`. Added better logging to make this obvious.

### 6. US SMS Requires Registration (10DLC / Toll-Free Verification)
**Problem:** SMS from local US numbers fails with error 30034 (unregistered A2P 10DLC). Switched to toll-free number — fails with 30032 (unverified toll-free).
**Fix:**
  - Switched from local to toll-free numbers (voice + SMS capable)
  - Submitted toll-free verification via API (`POST /v1/Tollfree/Verifications`)
  - Verification takes 3-5 business days
**Blocker:** **SMS doesn't work until verification is approved.** No way to skip or expedite. Voice calls work immediately — SMS is the only channel with this delay.
**Twilio opportunity:** A "developer mode" or "self-use" exception for sending SMS to your own verified number would eliminate this blocker for developer tools.

### 7. Stop Hook Interactive Wizard
**Problem:** The `/agent-phone:going-mobile` skill tried to run the interactive setup wizard, but Claude Code runs bash commands non-interactively (stdin is closed).
**Fix:** Skill now creates config directly from `.env` values instead of calling the wizard. The wizard is reserved for terminal use (`npm run setup`).

### 8. Voice Claude Making False Promises
**Problem:** During phone calls, the voice Claude would say things like "I'll tell the agent to dig deeper" — but it can't relay messages back mid-call. It's a one-shot conversation.
**Fix:** Rewrote the voice system prompt to be explicit: "You are a one-way messenger. You CANNOT relay messages back and forth."

---

## Blockers Requiring Human Intervention

These are steps that **cannot be automated via API** and require the developer to interact with the Twilio Console or wait for manual review:

| Blocker | Why | Workaround |
|---------|-----|------------|
| **AI/ML Addendum** | Legal agreement, must be accepted manually | Setup wizard opens the console page in the browser |
| **Toll-free SMS verification** | Regulatory review, 3-5 business days | Submit via API, but approval is manual. Voice calls work immediately meanwhile |
| **Twilio account creation** | Requires email/payment info | Link to docs in README |
| **Twilio account upgrade from trial** | Requires billing info in console | Link to docs in README |
| **Phone number verification (trial)** | Must receive verification call/SMS | Link to docs in README |

---

## What We'd Love From Twilio

1. **API to check AI/ML addendum status** — even read-only would help detect the issue before the first call fails
2. **Developer/self-use SMS exemption** — sending to your own verified number shouldn't require 10DLC or toll-free verification
3. **Better error surfacing** — the "We are sorry" message on ConversationRelay failure should indicate *why* (missing addendum, invalid TwiML, etc.) instead of a generic error. The call events API had the detail, but alerts/notifications were empty
4. **Instant toll-free verification for low-volume** — for accounts sending <50 SMS/month to a single number, instant approval would unlock developer tools

---

## Architecture That Works

```
Claude Code Session
  │
  ├── Stop hook fires (question detected)
  │     │
  │     ├── POST /call-needed {question, context, mode}
  │     │     │
  │     │     ├── mode=call → Twilio outbound call
  │     │     │     │
  │     │     │     ├── Twilio fetches /twiml (via tunnel)
  │     │     │     ├── ConversationRelay connects /ws (via tunnel)
  │     │     │     ├── Voice conversation (Claude API via Bedrock)
  │     │     │     └── Transcript returned
  │     │     │
  │     │     ├── mode=sms → Twilio SMS
  │     │     │     ├── SMS sent to developer
  │     │     │     ├── Developer replies
  │     │     │     ├── Twilio webhook /sms-reply
  │     │     │     └── Reply text returned
  │     │     │
  │     │     └── Returns {answer, transcript}
  │     │
  │     └── Returns {decision: "block", reason: "Developer responded via phone: ..."}
  │
  └── Claude resumes with developer's guidance
```

---

## Test Results

- **51 unit tests** (blocked-state detection, session management, TwiML generation)
- **3 integration tests** (server + mock-twilio + WebSocket flow)
- **8-step e2e test** proving the full unblock flow:
  1. Blocked-state detection (questions vs statements)
  2. Call flow: `/call-needed` → mock call → answer returned
  3. **Full unblock**: stop hook → call → developer answers → `{decision: "block"}` with answer
  4. `stop_hook_active` guard prevents infinite loops
  5. `mode=off` suppresses the hook
- **Live Twilio call verified** — real phone rang, ConversationRelay connected, voice conversation with Bedrock Claude, transcript returned

---

## Tech Stack

- **Server:** Node.js, Fastify, @fastify/websocket, @fastify/formbody
- **Twilio:** REST API, ConversationRelay, Messages API
- **Claude:** @anthropic-ai/sdk (Anthropic), @anthropic-ai/bedrock-sdk (Bedrock)
- **Tunnel:** cloudflared (auto-installed via Homebrew)
- **Testing:** Node.js built-in test runner (`node:test`)
- **Mock:** Custom mock-twilio server + browser phone UI with Web Speech API
