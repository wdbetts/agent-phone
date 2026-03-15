#!/usr/bin/env bash
# Start Agent Phone services
# Usage:
#   ./scripts/start.sh mock     # mock mode (default) — no tunnel needed
#   ./scripts/start.sh live     # live mode — starts tunnel automatically
#   ./scripts/start.sh stop     # stop all services

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PID_DIR="$HOME/.agent-phone/pids"
mkdir -p "$PID_DIR"

# ── Stop all services ──
stop_services() {
  for pidfile in "$PID_DIR"/*.pid; do
    [ -f "$pidfile" ] || continue
    pid=$(cat "$pidfile")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      echo "Stopped $(basename "$pidfile" .pid) (PID: $pid)"
    fi
    rm -f "$pidfile"
  done
}

if [ "${1:-}" = "stop" ]; then
  stop_services
  echo "All services stopped."
  exit 0
fi

# ── Determine mode ──
MODE="${1:-mock}"
cd "$PROJECT_ROOT"

# Source .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

export PORT="${PORT:-3000}"
export MOCK_TWILIO_PORT="${MOCK_TWILIO_PORT:-3001}"
export MOCK_PHONE_PORT="${MOCK_PHONE_PORT:-3002}"
export MODE

# ── Regenerate config.json from .env so it's never stale ──
CONFIG_DIR="$HOME/.agent-phone"
mkdir -p "$CONFIG_DIR"
node -e "
  const fs = require('fs');
  const config = {
    mode: '${MODE}',
    twilio: {
      accountSid: process.env.TWILIO_SID || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
    },
    claude: { provider: process.env.CLAUDE_PROVIDER || 'anthropic' },
    developer: { phoneNumber: process.env.DEVELOPER_PHONE_NUMBER || '' },
  };
  fs.writeFileSync('$CONFIG_DIR/config.json', JSON.stringify(config, null, 2));
" 2>/dev/null || true

# ── Stop existing services first ──
stop_services

# ── Start orchestrator server ──
echo "Starting orchestrator server on :$PORT..."
if [ "$MODE" = "mock" ]; then
  MOCK_VOICE=true node server/index.js > /dev/null 2>&1 &
else
  node server/index.js > /dev/null 2>&1 &
fi
echo $! > "$PID_DIR/server.pid"

# Wait for server
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -s "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
  echo "ERROR: Server failed to start"
  exit 1
fi
echo "  Server running (PID: $(cat "$PID_DIR/server.pid"))"

# ── Mock mode: start mock Twilio ──
if [ "$MODE" = "mock" ]; then
  echo "Starting mock Twilio on :$MOCK_TWILIO_PORT / :$MOCK_PHONE_PORT..."
  node mock/mock-twilio.js > /dev/null 2>&1 &
  echo $! > "$PID_DIR/mock-twilio.pid"

  for i in $(seq 1 20); do
    if curl -s "http://127.0.0.1:$MOCK_TWILIO_PORT/health" > /dev/null 2>&1; then
      break
    fi
    sleep 0.5
  done
  echo "  Mock Twilio running (PID: $(cat "$PID_DIR/mock-twilio.pid"))"
  echo "  Mock Phone UI: http://localhost:$MOCK_PHONE_PORT"
fi

# ── Live mode: start tunnel ──
if [ "$MODE" = "live" ]; then
  if [ -n "${TUNNEL_URL:-}" ]; then
    echo "Using configured TUNNEL_URL: $TUNNEL_URL"
  else
    # Try cloudflared first, then ngrok
    TUNNEL_CMD=""
    if command -v cloudflared > /dev/null 2>&1; then
      TUNNEL_CMD="cloudflared"
    elif command -v ngrok > /dev/null 2>&1; then
      TUNNEL_CMD="ngrok"
    fi

    if [ -z "$TUNNEL_CMD" ]; then
      # Auto-install cloudflared via brew (no account needed, free)
      if command -v brew > /dev/null 2>&1; then
        echo "No tunnel tool found. Installing cloudflared via Homebrew..."
        brew install cloudflared 2>&1 | tail -3
        if command -v cloudflared > /dev/null 2>&1; then
          TUNNEL_CMD="cloudflared"
          echo "  cloudflared installed."
        else
          echo "  WARNING: cloudflared installation failed."
        fi
      fi

      if [ -z "$TUNNEL_CMD" ]; then
        echo ""
        echo "WARNING: No tunnel tool found and could not auto-install."
        echo "Live mode requires a public URL for Twilio callbacks."
        echo ""
        echo "Install manually:"
        echo "  brew install cloudflared    # recommended, no account needed"
        echo ""
        echo "Or set TUNNEL_URL in .env manually."
        echo ""
        echo "Server is running locally but Twilio calls will fail without a tunnel."
      fi
    fi

    if [ "$TUNNEL_CMD" = "cloudflared" ]; then
      echo "Starting cloudflared tunnel..."
      cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$PORT" > "$PID_DIR/tunnel.log" 2>&1 &
      echo $! > "$PID_DIR/tunnel.pid"

      # Parse tunnel URL from cloudflared output
      for i in $(seq 1 30); do
        TUNNEL_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$PID_DIR/tunnel.log" 2>/dev/null | head -1 || true)
        if [ -n "$TUNNEL_URL" ]; then
          break
        fi
        sleep 1
      done

      if [ -n "$TUNNEL_URL" ]; then
        export TUNNEL_URL
        echo "  Tunnel: $TUNNEL_URL"
        # Restart server with TUNNEL_URL set
        kill "$(cat "$PID_DIR/server.pid")" 2>/dev/null || true
        sleep 1
        TUNNEL_URL="$TUNNEL_URL" node server/index.js > /dev/null 2>&1 &
        echo $! > "$PID_DIR/server.pid"
        sleep 2
        echo "  Server restarted with tunnel URL"
        # Configure Twilio phone number webhooks (SMS reply + voice) to use tunnel URL
        if [ -n "${TWILIO_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ] && [ -n "${TWILIO_PHONE_NUMBER:-}" ]; then
          echo "  Configuring Twilio webhooks..."
          # Find the phone number SID
          PHONE_SID=$(curl -s "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers.json?PhoneNumber=${TWILIO_PHONE_NUMBER}" \
            -u "${TWILIO_SID}:${TWILIO_AUTH_TOKEN}" 2>/dev/null | node -e "
            let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
              try{const j=JSON.parse(d);console.log(j.incoming_phone_numbers?.[0]?.sid||'')}catch{console.log('')}
            });" 2>/dev/null || true)
          if [ -n "$PHONE_SID" ]; then
            curl -s -X POST "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/IncomingPhoneNumbers/${PHONE_SID}.json" \
              -u "${TWILIO_SID}:${TWILIO_AUTH_TOKEN}" \
              --data-urlencode "SmsUrl=${TUNNEL_URL}/sms-reply" \
              --data-urlencode "SmsMethod=POST" > /dev/null 2>&1
            echo "  SMS webhook: ${TUNNEL_URL}/sms-reply"
          fi
        fi
      else
        echo "  WARNING: Could not determine tunnel URL. Check $PID_DIR/tunnel.log"
      fi
    elif [ "$TUNNEL_CMD" = "ngrok" ]; then
      echo "Starting ngrok tunnel..."
      ngrok http "$PORT" --log=stdout > "$PID_DIR/tunnel.log" 2>&1 &
      echo $! > "$PID_DIR/tunnel.pid"
      sleep 3

      TUNNEL_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | node -e "
        let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
          try{const j=JSON.parse(d);const t=j.tunnels.find(t=>t.proto==='https');console.log(t?t.public_url:'')}catch{console.log('')}
        });" 2>/dev/null || true)

      if [ -n "$TUNNEL_URL" ]; then
        export TUNNEL_URL
        echo "  Tunnel: $TUNNEL_URL"
        kill "$(cat "$PID_DIR/server.pid")" 2>/dev/null || true
        sleep 1
        TUNNEL_URL="$TUNNEL_URL" node server/index.js > /dev/null 2>&1 &
        echo $! > "$PID_DIR/server.pid"
        sleep 2
        echo "  Server restarted with tunnel URL"
      else
        echo "  WARNING: Could not determine ngrok URL."
      fi
    fi
  fi
fi

echo ""
echo "Agent Phone is running (mode: $MODE)"
echo "  Stop with: $SCRIPT_DIR/start.sh stop"
