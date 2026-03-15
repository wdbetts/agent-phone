#!/usr/bin/env bash
# Stop hook entry point — detect blocked state, call server
# Receives JSON on stdin with stop_hook_active, last_assistant_message, session_id, transcript_path

set -euo pipefail

STATE_FILE="${HOME}/.agent-phone/state.json"
SERVER_URL="${AGENT_PHONE_SERVER:-http://localhost:3000}"

# Read stdin into a temp file so we can pipe it multiple times
INPUT_FILE=$(mktemp)
trap 'rm -f "$INPUT_FILE"' EXIT
cat > "$INPUT_FILE"

# Check stop_hook_active — if true, a previous hook already triggered this continuation.
# Without this guard, we'd loop forever: question → hook blocks → question → hook blocks...
STOP_HOOK_ACTIVE=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$INPUT_FILE','utf8'));
  console.log(d.stop_hook_active ? 'true' : 'false');
" 2>/dev/null || echo "false")

if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

# Check mode from state.json (supports both old {mobile:bool} and new {mode:string} formats)
if [ ! -f "$STATE_FILE" ]; then
  exit 0
fi

MODE=$(node -e "
  const d = JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8'));
  const mode = d.mode || (d.mobile ? 'call' : 'off');
  console.log(mode);
" 2>/dev/null || echo "off")

if [ "$MODE" = "off" ]; then
  exit 0
fi

# Extract the last assistant message and detect blocked state via Node.js module
# Outputs three lines: "yes"/"no", base64 message, session id
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYSIS=$(node "$SCRIPT_DIR/detect-blocked.js" < "$INPUT_FILE" 2>/dev/null || echo -e "no\n\n")

IS_BLOCKED=$(echo "$ANALYSIS" | head -1)
MSG_B64=$(echo "$ANALYSIS" | sed -n '2p')
SESSION_ID=$(echo "$ANALYSIS" | sed -n '3p')

if [ "$IS_BLOCKED" != "yes" ]; then
  exit 0
fi

# Build the JSON payload with rich context from the hook input
PAYLOAD=$(node -e "
  const fs = require('fs');
  const msg = Buffer.from('${MSG_B64}', 'base64').toString();
  // Read the hook input for additional context (cwd, transcript_path)
  let hookData = {};
  try { hookData = JSON.parse(fs.readFileSync('$INPUT_FILE', 'utf8')); } catch {}
  const cwd = hookData.cwd || process.cwd();
  const projectName = cwd.split('/').pop();
  console.log(JSON.stringify({
    question: msg.slice(0, 500),
    context: 'Project: ' + projectName + ' (working directory: ' + cwd + ')\\n\\nFull message from the coding agent:\\n' + msg,
    session_id: '${SESSION_ID}',
    mode: '${MODE}'
  }));
")

# SMS mode needs longer timeout (10 min) vs call mode (5 min)
if [ "$MODE" = "sms" ]; then
  MAX_TIME=630
else
  MAX_TIME=330
fi

RESPONSE=$(curl -s -X POST "${SERVER_URL}/call-needed" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time "$MAX_TIME") || true

if [ -z "$RESPONSE" ]; then
  exit 0
fi

# Extract answer and build response safely in Node.js
echo "$RESPONSE" | node -e "
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => input += c);
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const answer = data.answer || 'No answer received';
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'Developer responded via phone: ' + answer
      }));
    } catch {
      console.log(JSON.stringify({
        decision: 'block',
        reason: 'Developer responded via phone: No answer received'
      }));
    }
  });
"
