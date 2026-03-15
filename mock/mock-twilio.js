// Mock Twilio REST API + ConversationRelay WebSocket client

import Fastify from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import { readFile } from 'fs/promises';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = parseInt(process.env.MOCK_TWILIO_PORT || '3001', 10);
const phonePort = parseInt(process.env.MOCK_PHONE_PORT || '3002', 10);

const fastify = Fastify({ logger: true });

// Active calls — maps sessionId to WebSocket connections
const activeCalls = new Map();

// Phone UI connections (browser WebSocket clients)
const phoneClients = new Set();

// === Mock Phone UI server (serves static files + WebSocket for browser) ===

const phoneServer = createServer(async (req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    const html = await readFile(join(__dirname, 'mock-phone', 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } else if (req.url === '/app.js') {
    const js = await readFile(join(__dirname, 'mock-phone', 'app.js'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(js);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const phoneWss = new WebSocketServer({ server: phoneServer });

phoneWss.on('connection', (ws) => {
  phoneClients.add(ws);
  ws.on('close', () => phoneClients.delete(ws));

  // Forward messages from browser phone UI to the ConversationRelay WebSocket
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'user-input') {
      // Find the active call and forward as a ConversationRelay prompt
      for (const [sessionId, call] of activeCalls) {
        if (call.serverWs && call.serverWs.readyState === WebSocket.OPEN) {
          call.serverWs.send(JSON.stringify({
            type: 'prompt',
            voicePrompt: msg.text,
          }));
        }
      }
    }

    if (msg.type === 'hang-up') {
      for (const [sessionId, call] of activeCalls) {
        if (call.serverWs && call.serverWs.readyState === WebSocket.OPEN) {
          call.serverWs.close();
        }
        activeCalls.delete(sessionId);
      }
    }
  });
});

// Broadcast to all phone UI clients
function broadcastToPhone(msg) {
  const data = JSON.stringify(msg);
  for (const client of phoneClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

// === Mock Twilio REST API ===

// Place a call (called by the orchestrator server in mock mode)
fastify.post('/place-call', async (request) => {
  const { sessionId, twimlUrl, wsUrl } = request.body;

  // Notify browser phone UI that a call is incoming
  broadcastToPhone({ type: 'incoming-call', sessionId });

  // Connect to the server's ConversationRelay WebSocket
  const serverWs = new WebSocket(wsUrl);

  activeCalls.set(sessionId, { serverWs, sessionId });

  serverWs.on('open', () => {
    // Send setup message like real ConversationRelay would
    serverWs.send(JSON.stringify({ type: 'setup', sessionId }));
  });

  serverWs.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Forward server responses to the phone UI
    if (msg.type === 'text') {
      broadcastToPhone({ type: 'assistant-message', text: msg.token, sessionId });
    }
  });

  serverWs.on('close', () => {
    broadcastToPhone({ type: 'call-ended', sessionId });
    activeCalls.delete(sessionId);
  });

  serverWs.on('error', (err) => {
    console.error('WebSocket error to server:', err.message);
    broadcastToPhone({ type: 'call-error', error: err.message, sessionId });
    activeCalls.delete(sessionId);
  });

  return { status: 'call-placed', sessionId };
});

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', activeCalls: activeCalls.size, phoneClients: phoneClients.size };
});

// Start both servers
await fastify.listen({ port, host: '0.0.0.0' });
phoneServer.listen(phonePort, '0.0.0.0', () => {
  console.log(`Mock Twilio API running on http://0.0.0.0:${port}`);
  console.log(`Mock Phone UI running on http://0.0.0.0:${phonePort}`);
});
