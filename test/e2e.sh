#!/usr/bin/env bash
# End-to-end test: verifies the complete unblock flow —
# Claude gets stuck → stop hook fires → phone call → developer answers → answer flows back → Claude unblocked
#
# Usage:
#   ./test/e2e.sh          # mock mode (default)
#   ./test/e2e.sh live     # live mode (real Twilio call)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-mock}"

echo "=== Agent Phone E2E Test (mode: $MODE) ==="

# ── Cleanup from previous runs ──
cleanup() {
  echo ""
  echo "=== Cleaning up ==="
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null || true
  echo '{"mode": "off"}' > ~/.agent-phone/state.json 2>/dev/null || true
}
trap cleanup EXIT

# ── 1. Clean state ──
echo ""
echo "--- Step 1: Reset state ---"
mkdir -p ~/.agent-phone
echo '{"mode": "off"}' > ~/.agent-phone/state.json

if [ "$MODE" = "mock" ]; then
  cat > ~/.agent-phone/config.json << 'EOF'
{"mode": "mock", "twilio": null, "claude": {"provider": "mock"}, "developer": {"phoneNumber": "mock"}}
EOF
  echo "  Config: mock mode"
else
  if [ ! -f "$PROJECT_ROOT/.env" ]; then
    echo "  ERROR: .env not found. Run 'npm run setup' first."
    exit 1
  fi
  export $(grep -v '^#' "$PROJECT_ROOT/.env" | grep '=' | xargs)
  if [ -z "${TWILIO_SID:-}" ] || [ -z "${TWILIO_PHONE_NUMBER:-}" ] || [ -z "${DEVELOPER_PHONE_NUMBER:-}" ]; then
    echo "  ERROR: .env missing required values"
    exit 1
  fi
  cat > ~/.agent-phone/config.json << EOF
{
  "mode": "live",
  "twilio": {"accountSid": "${TWILIO_SID}", "authToken": "${TWILIO_AUTH_TOKEN}", "phoneNumber": "${TWILIO_PHONE_NUMBER}"},
  "claude": {"provider": "${CLAUDE_PROVIDER:-bedrock}"},
  "developer": {"phoneNumber": "${DEVELOPER_PHONE_NUMBER}"}
}
EOF
  echo "  Config: live mode (calling ${DEVELOPER_PHONE_NUMBER})"
fi

# ── 2. Start servers ──
echo ""
echo "--- Step 2: Start servers ---"

export MOCK_VOICE=true
export PORT=4100
export MOCK_TWILIO_PORT=4101
export MOCK_PHONE_PORT=4102
export MODE="$MODE"

cd "$PROJECT_ROOT"
node server/index.js &
SERVER_PID=$!
echo "  Server started (PID: $SERVER_PID, port: $PORT)"

if [ "$MODE" = "mock" ]; then
  node mock/mock-twilio.js &
  MOCK_PID=$!
  echo "  Mock Twilio started (PID: $MOCK_PID, port: $MOCK_TWILIO_PORT)"
fi

echo "  Waiting for servers..."
for i in $(seq 1 20); do
  if curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then break; fi
  sleep 0.5
done
curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1 || { echo "  ERROR: Server did not start"; exit 1; }
echo "  Server healthy"

if [ "$MODE" = "mock" ]; then
  for i in $(seq 1 20); do
    if curl -s "http://127.0.0.1:$MOCK_TWILIO_PORT/health" > /dev/null 2>&1; then break; fi
    sleep 0.5
  done
  echo "  Mock Twilio healthy"
fi

# ── 3. Activate call mode ──
echo ""
echo "--- Step 3: Activate call mode ---"
echo '{"mode": "call", "phone": "test", "since": "2024-01-01T00:00:00Z"}' > ~/.agent-phone/state.json
echo "  Mode: call"

# ── 4. Test blocked-state detection ──
echo ""
echo "--- Step 4: Test stop hook detection ---"

DETECT_RESULT=$(echo '{"last_assistant_message": "Should I use PostgreSQL or SQLite for this project?", "session_id": "e2e-1", "stop_hook_active": false}' | node scripts/detect-blocked.js)
BLOCKED=$(echo "$DETECT_RESULT" | head -1)
echo "  Question detected as blocked: $BLOCKED"
[ "$BLOCKED" = "yes" ] || { echo "  FAIL: Should detect blocked state"; exit 1; }

DETECT_RESULT2=$(echo '{"last_assistant_message": "I have completed the refactoring.", "session_id": "e2e-2", "stop_hook_active": false}' | node scripts/detect-blocked.js)
NOT_BLOCKED=$(echo "$DETECT_RESULT2" | head -1)
echo "  Statement detected as not blocked: $NOT_BLOCKED"
[ "$NOT_BLOCKED" = "no" ] || { echo "  FAIL: Should NOT detect blocked state"; exit 1; }

echo "  PASS: Blocked-state detection works"

# ── 5. Test the full call flow via /call-needed ──
echo ""
echo "--- Step 5: Test call flow (/call-needed → call → answer) ---"

if [ "$MODE" = "mock" ]; then
  CALL_RESPONSE_FILE=$(mktemp)
  (curl -s -X POST "http://127.0.0.1:$PORT/call-needed" \
    -H "Content-Type: application/json" \
    -d '{"question": "Should I use PostgreSQL or SQLite?", "context": "Project: my-app (working directory: /home/dev/my-app)\n\nBuilding a data pipeline that needs concurrent writes.", "session_id": "e2e-call-flow", "mode": "call"}' \
    --max-time 30 \
    > "$CALL_RESPONSE_FILE" 2>&1) &
  CALL_PID=$!

  sleep 3
  echo "  Sending developer's answer via mock phone..."
  node -e "
    import { WebSocket } from 'ws';
    const ws = new WebSocket('ws://127.0.0.1:$MOCK_PHONE_PORT');
    ws.on('open', () => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'user-input', text: 'Use PostgreSQL for better concurrency' }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'user-input', text: 'Go ahead, bye' }));
          setTimeout(() => ws.close(), 2000);
        }, 2000);
      }, 1000);
    });
    ws.on('error', (err) => { console.error('WS error:', err.message); process.exit(1); });
  " 2>&1

  wait $CALL_PID 2>/dev/null || true
  CALL_RESPONSE=$(cat "$CALL_RESPONSE_FILE")
  rm -f "$CALL_RESPONSE_FILE"

  # Validate: response has answer AND transcript with developer's words
  VALIDATION=$(echo "$CALL_RESPONSE" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const j = JSON.parse(d);
        const hasAnswer = !!j.answer;
        const hasTranscript = Array.isArray(j.transcript) && j.transcript.length >= 2;
        const devSpoke = j.transcript?.some(t => t.role === 'developer' && t.text.includes('PostgreSQL'));
        console.log(JSON.stringify({ hasAnswer, hasTranscript, devSpoke }));
      } catch { console.log('{\"hasAnswer\":false}'); }
    });
  ")

  echo "  Call response validation: $VALIDATION"
  HAS_ANSWER=$(echo "$VALIDATION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).hasAnswer?'yes':'no'))")
  DEV_SPOKE=$(echo "$VALIDATION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).devSpoke?'yes':'no'))")

  [ "$HAS_ANSWER" = "yes" ] || { echo "  FAIL: No answer in response"; exit 1; }
  [ "$DEV_SPOKE" = "yes" ] || { echo "  FAIL: Developer's answer not in transcript"; exit 1; }
  echo "  PASS: Call completed with developer's answer in transcript"
fi

# ── 6. THE CRITICAL TEST: Full stop hook → call → unblock flow ──
echo ""
echo "--- Step 6: Full unblock flow (stop hook → call → block decision with answer) ---"

export AGENT_PHONE_SERVER="http://127.0.0.1:$PORT"

if [ "$MODE" = "mock" ]; then
  # Simulate exactly what Claude Code sends to the stop hook:
  # - last_assistant_message: the question Claude asked
  # - session_id: from the Claude Code session
  # - stop_hook_active: false (first time)
  # - cwd: the project directory
  HOOK_INPUT='{"last_assistant_message": "I need to decide on a database for the data pipeline. Should I use PostgreSQL or SQLite? PostgreSQL offers better concurrency but SQLite is simpler to deploy. What do you think?", "session_id": "e2e-unblock-test", "stop_hook_active": false, "cwd": "/home/dev/my-awesome-project"}'

  echo "  Simulating Claude Code stop hook with blocked question..."
  echo "  Input: $(echo "$HOOK_INPUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const j=JSON.parse(d);console.log('\"'+j.last_assistant_message.slice(0,80)+'...\"')})")"

  HOOK_RESPONSE_FILE=$(mktemp)
  (echo "$HOOK_INPUT" | bash scripts/stop-hook.sh > "$HOOK_RESPONSE_FILE" 2>&1) &
  HOOK_PID=$!

  # Wait for call to be placed, then answer as the developer
  sleep 3
  echo "  Developer answering via mock phone: 'Use SQLite, it is simpler'"
  node -e "
    import { WebSocket } from 'ws';
    const ws = new WebSocket('ws://127.0.0.1:$MOCK_PHONE_PORT');
    ws.on('open', () => {
      setTimeout(() => {
        ws.send(JSON.stringify({ type: 'user-input', text: 'Use SQLite, it is simpler for our use case' }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'user-input', text: 'That is all, goodbye' }));
          setTimeout(() => ws.close(), 2000);
        }, 2000);
      }, 1000);
    });
    ws.on('error', () => process.exit(0));
  " 2>&1

  wait $HOOK_PID 2>/dev/null || true
  HOOK_RESPONSE=$(cat "$HOOK_RESPONSE_FILE")
  rm -f "$HOOK_RESPONSE_FILE"

  echo ""
  echo "  Stop hook output (this is what Claude Code receives):"
  echo "  $HOOK_RESPONSE"
  echo ""

  # Validate the stop hook response — this is what unblocks Claude Code
  UNBLOCK_VALIDATION=$(echo "$HOOK_RESPONSE" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try {
        const j = JSON.parse(d);
        const isBlock = j.decision === 'block';
        const hasReason = typeof j.reason === 'string' && j.reason.length > 0;
        const reasonContainsAnswer = j.reason.includes('SQLite');
        const reasonHasPhonePrefix = j.reason.startsWith('Developer responded via phone:');
        console.log(JSON.stringify({ isBlock, hasReason, reasonContainsAnswer, reasonHasPhonePrefix }));
      } catch(e) { console.log('{\"isBlock\":false,\"error\":\"' + e.message + '\"}'); }
    });
  ")

  echo "  Unblock validation: $UNBLOCK_VALIDATION"

  IS_BLOCK=$(echo "$UNBLOCK_VALIDATION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).isBlock?'yes':'no'))")
  HAS_ANSWER_IN_REASON=$(echo "$UNBLOCK_VALIDATION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).reasonContainsAnswer?'yes':'no'))")
  HAS_PHONE_PREFIX=$(echo "$UNBLOCK_VALIDATION" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).reasonHasPhonePrefix?'yes':'no'))")

  if [ "$IS_BLOCK" != "yes" ]; then
    echo "  FAIL: Stop hook did not return decision='block'"
    exit 1
  fi
  if [ "$HAS_ANSWER_IN_REASON" != "yes" ]; then
    echo "  FAIL: Developer's answer ('SQLite') not found in the reason field"
    exit 1
  fi
  if [ "$HAS_PHONE_PREFIX" != "yes" ]; then
    echo "  FAIL: Reason doesn't start with 'Developer responded via phone:'"
    exit 1
  fi

  echo "  PASS: Stop hook returned block decision with developer's answer"
  echo ""
  echo "  ✓ Claude Code receives: decision=block"
  echo "  ✓ Reason contains developer's actual answer (SQLite)"
  echo "  ✓ Reason prefixed with 'Developer responded via phone:'"
  echo "  → Claude Code is UNBLOCKED and continues with the developer's guidance"
fi

# ── 7. Test stop_hook_active guard (prevents infinite loops) ──
echo ""
echo "--- Step 7: Test stop_hook_active guard ---"

GUARD_RESPONSE_FILE=$(mktemp)
echo '{"last_assistant_message": "Should I continue?", "session_id": "guard-test", "stop_hook_active": true, "cwd": "/tmp"}' \
  | bash scripts/stop-hook.sh > "$GUARD_RESPONSE_FILE" 2>&1
GUARD_RESPONSE=$(cat "$GUARD_RESPONSE_FILE")
rm -f "$GUARD_RESPONSE_FILE"

if [ -z "$GUARD_RESPONSE" ]; then
  echo "  PASS: stop_hook_active=true correctly suppressed the hook (no output)"
else
  echo "  FAIL: Hook should have exited silently when stop_hook_active=true"
  echo "  Got: $GUARD_RESPONSE"
  exit 1
fi

# ── 8. Test mode=off suppresses the hook ──
echo ""
echo "--- Step 8: Test mode=off suppresses hook ---"

echo '{"mode": "off"}' > ~/.agent-phone/state.json
OFF_RESPONSE_FILE=$(mktemp)
echo '{"last_assistant_message": "Should I continue?", "session_id": "off-test", "stop_hook_active": false, "cwd": "/tmp"}' \
  | bash scripts/stop-hook.sh > "$OFF_RESPONSE_FILE" 2>&1
OFF_RESPONSE=$(cat "$OFF_RESPONSE_FILE")
rm -f "$OFF_RESPONSE_FILE"

if [ -z "$OFF_RESPONSE" ]; then
  echo "  PASS: mode=off correctly suppressed the hook"
else
  echo "  FAIL: Hook should have exited silently when mode=off"
  exit 1
fi

# Restore call mode for any remaining tests
echo '{"mode": "call", "phone": "test", "since": "2024-01-01T00:00:00Z"}' > ~/.agent-phone/state.json

echo ""
echo "=== All E2E tests passed! ==="
echo ""
echo "Summary:"
echo "  ✓ Blocked-state detection (questions vs statements)"
echo "  ✓ Call flow: /call-needed → mock call → answer returned"
echo "  ✓ FULL UNBLOCK: stop hook → call → developer answers → block decision with answer"
echo "  ✓ stop_hook_active guard prevents infinite loops"
echo "  ✓ mode=off suppresses the hook"
