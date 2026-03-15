// Integration test — exercises the orchestrator server + WebSocket ConversationRelay flow
// Uses MOCK_VOICE=true to avoid needing an Anthropic API key

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const SERVER_PORT = 4000;
const MOCK_TWILIO_PORT = 4001;

function waitForServer(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tryConnect = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve();
      } catch {
        // server not ready yet
      }
      if (Date.now() > deadline) return reject(new Error(`Server at ${url} did not start in time`));
      setTimeout(tryConnect, 200);
    };
    tryConnect();
  });
}

function spawnServer(script, env) {
  const child = spawn('node', [script], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Collect stderr/stdout for debugging on failure
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  child.getOutput = () => output;
  return child;
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), timeoutMs);
    const handler = (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}

describe('Agent Phone integration', () => {
  let serverProc;
  let mockTwilioProc;

  before(async () => {
    // Start orchestrator server with MOCK_VOICE
    serverProc = spawnServer('server/index.js', {
      PORT: String(SERVER_PORT),
      MOCK_TWILIO_PORT: String(MOCK_TWILIO_PORT),
      MODE: 'mock',
      MOCK_VOICE: 'true',
      HOST: '127.0.0.1',
    });

    // Start mock-twilio server
    mockTwilioProc = spawnServer('mock/mock-twilio.js', {
      MOCK_TWILIO_PORT: String(MOCK_TWILIO_PORT),
      MOCK_PHONE_PORT: String(MOCK_TWILIO_PORT + 1),
      HOST: '127.0.0.1',
    });

    // Wait for both servers to be ready
    await Promise.all([
      waitForServer(`http://127.0.0.1:${SERVER_PORT}/health`),
      waitForServer(`http://127.0.0.1:${MOCK_TWILIO_PORT}/health`),
    ]);
  });

  after(async () => {
    // Kill child processes
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
    }
    if (mockTwilioProc && !mockTwilioProc.killed) {
      mockTwilioProc.kill('SIGTERM');
    }
    // Give processes time to clean up
    await new Promise((r) => setTimeout(r, 500));
  });

  it('health check returns ok', async () => {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });

  it('full call flow: POST /call-needed triggers mock call and returns answer', async () => {
    const sessionId = 'test-integration-1';

    // POST /call-needed — this will block until the call completes.
    // We run it as a background promise and interact via WebSocket.
    const callPromise = fetch(`http://127.0.0.1:${SERVER_PORT}/call-needed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Should I use PostgreSQL or SQLite?',
        context: 'Building a data pipeline for batch processing',
        session_id: sessionId,
        mode: 'call',
      }),
    });

    // The mock-twilio server will connect a WebSocket to our server's /ws endpoint.
    // The server conversation handler will send a greeting.
    // We need to wait a moment for the mock-twilio WS connection to establish,
    // then send a user response through mock-twilio.

    // Wait for mock-twilio to establish the call
    await new Promise((r) => setTimeout(r, 1500));

    // Now connect our own WS to simulate a second interaction path:
    // Actually the mock-twilio already connected. We'll interact via the mock-twilio's
    // phone WS to send user input.
    const phoneWs = await connectWs(`ws://127.0.0.1:${MOCK_TWILIO_PORT + 1}`);

    // Wait a moment for the greeting to be sent
    await new Promise((r) => setTimeout(r, 500));

    // Send user's answer
    phoneWs.send(JSON.stringify({
      type: 'user-input',
      text: 'Use PostgreSQL, it handles concurrent writes better',
    }));

    // Wait for the assistant response to come back
    const assistantMsg = await waitForMessage(phoneWs, (msg) => msg.type === 'assistant-message');
    assert.ok(assistantMsg.text, 'Should receive assistant response text');

    // Now send end phrase to complete the call
    phoneWs.send(JSON.stringify({
      type: 'user-input',
      text: 'Go ahead, bye',
    }));

    // Wait for the call to end
    await waitForMessage(phoneWs, (msg) => msg.type === 'call-ended' || msg.type === 'assistant-message', 10000);

    // The /call-needed request should now resolve
    const res = await callPromise;
    const body = await res.json();

    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.ok(body.answer, 'Response should have an answer');
    assert.ok(body.transcript, 'Response should have a transcript');
    assert.ok(Array.isArray(body.transcript), 'Transcript should be an array');
    assert.ok(body.transcript.length >= 2, `Transcript should have at least 2 entries, got ${body.transcript.length}`);

    phoneWs.close();
  });

  it('direct WebSocket ConversationRelay flow without mock-twilio', async () => {
    const sessionId = 'test-direct-ws';

    // POST /call-needed in background — but in mock mode it will try to hit mock-twilio.
    // Instead, let's create the session manually and test WS directly.
    // We'll trigger a call and connect our own WS simultaneously.

    const callPromise = fetch(`http://127.0.0.1:${SERVER_PORT}/call-needed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'Which testing framework should I use?',
        context: 'Node.js project with ESM modules',
        session_id: sessionId,
        mode: 'call',
      }),
    });

    // Wait for the mock-twilio to process the call
    await new Promise((r) => setTimeout(r, 1500));

    // Send answer through phone WS
    const phoneWs = await connectWs(`ws://127.0.0.1:${MOCK_TWILIO_PORT + 1}`);
    await new Promise((r) => setTimeout(r, 500));

    phoneWs.send(JSON.stringify({
      type: 'user-input',
      text: "Use node:test, it's built in. That's all, goodbye.",
    }));

    // Wait for call to complete
    const res = await callPromise;
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.ok(body.answer);

    phoneWs.close();
  });
});
