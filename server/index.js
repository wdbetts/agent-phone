// Fastify server — HTTP + WebSocket endpoints

import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import formbody from '@fastify/formbody';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { createSession, getSession, updateSession, completeSession, failSession, getAllSessions, generateSessionId, getSessionByPhone, addToTranscript } from './sessions.js';
import { initTwilio, placeOutboundCall, generateTwiML, getTwilioClient } from './twilio.js';
import { handleConversationRelay } from './conversation.js';
import { configure as configureClaude } from './claude.js';
import { sendSmsQuestion } from './sms.js';

const CONFIG_PATH = join(process.env.HOME || '/root', '.agent-phone', 'config.json');
const STATE_PATH = join(process.env.HOME || '/root', '.agent-phone', 'state.json');

/**
 * Read the current mode from state.json.
 * Handles both old format ({mobile: true/false}) and new format ({mode: "call"}).
 * @returns {Promise<{mode: string, phone: string}>}
 */
async function readMode() {
  try {
    const data = await readFile(STATE_PATH, 'utf-8');
    const state = JSON.parse(data);
    // Backward compatibility: old format used {mobile: true/false}
    const mode = state.mode || (state.mobile ? 'call' : 'off');
    const phone = state.phone || '';
    return { mode, phone };
  } catch {
    return { mode: 'off', phone: '' };
  }
}

async function loadConfig() {
  // 1. Load config.json as base defaults
  let fileConfig = {};
  try {
    const data = await readFile(CONFIG_PATH, 'utf-8');
    fileConfig = JSON.parse(data);
  } catch {
    // No config file — that's fine, defaults + env vars will be used
  }

  // 2. Build merged config: config.json values first, env vars override
  const config = {
    mode: process.env.MODE || fileConfig.mode || 'mock',
    provider: process.env.CLAUDE_PROVIDER || fileConfig.provider || 'anthropic',
    tunnelUrl: process.env.TUNNEL_URL || fileConfig.tunnelUrl || '',
    twilio: {
      accountSid: process.env.TWILIO_SID || fileConfig.twilio?.accountSid || '',
      authToken: process.env.TWILIO_AUTH_TOKEN || fileConfig.twilio?.authToken || '',
      phoneNumber: process.env.TWILIO_PHONE_NUMBER || fileConfig.twilio?.phoneNumber || '',
    },
    developer: {
      phoneNumber: process.env.DEVELOPER_PHONE_NUMBER || fileConfig.developer?.phoneNumber || '',
    },
  };

  return config;
}

async function start() {
  const config = await loadConfig();
  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0';

  // Startup validation log
  const hasTwilioCreds = !!(config.twilio.accountSid && config.twilio.authToken);
  const hasPhoneNumbers = !!(config.twilio.phoneNumber && config.developer.phoneNumber);
  console.log('--- Agent Phone startup ---');
  console.log(`  mode:            ${config.mode}`);
  console.log(`  provider:        ${config.provider}`);
  console.log(`  twilio creds:    ${hasTwilioCreds ? 'yes' : 'no'}`);
  console.log(`  phone numbers:   ${hasPhoneNumbers ? 'yes' : 'no'}`);
  if (config.tunnelUrl) {
    console.log(`  tunnel URL:      ${config.tunnelUrl}`);
  }
  console.log('---------------------------');

  // Configure Claude provider from merged config
  configureClaude({ provider: config.provider });

  const fastify = Fastify({ logger: true });
  await fastify.register(formbody);
  await fastify.register(websocket);

  // Initialize Twilio if credentials are available
  if (hasTwilioCreds) {
    initTwilio(config.twilio.accountSid, config.twilio.authToken);
  }

  // Health check
  fastify.get('/health', async () => {
    return { status: 'ok', mode: config.mode, sessions: getAllSessions().length };
  });

  // Detailed status endpoint
  const startTime = Date.now();
  fastify.get('/status', async () => {
    const allSessions = getAllSessions();
    const activeSessions = allSessions.filter(s => ['pending', 'calling', 'in-call', 'sms-waiting'].includes(s.status)).length;
    const completedSessions = allSessions.filter(s => s.status === 'completed').length;

    return {
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      mode: config.mode,
      provider: config.provider,
      tunnelUrl: config.tunnelUrl || null,
      hasTwilioCreds,
      hasPhoneNumbers,
      activeSessions,
      completedSessions,
    };
  });

  // Hook triggers this — places outbound call or SMS, waits for completion, returns answer
  fastify.post('/call-needed', async (request, reply) => {
    const { question, context, options, session_id, mode: requestMode } = request.body;
    const sessionId = session_id || generateSessionId();

    const session = createSession(sessionId, { question, context, options });

    const serverMode = config.mode; // 'mock' or 'live'
    const baseUrl = config.tunnelUrl || `http://localhost:${port}`;

    // Determine communication mode: from request body, state.json, or default to 'call'
    let commMode = requestMode;
    if (!commMode) {
      const stateInfo = await readMode();
      commMode = stateInfo.mode;
    }

    if (commMode === 'off') {
      failSession(sessionId, new Error('Agent Phone is disabled (mode: off)'));
      return reply.code(400).send({ error: 'Agent Phone is disabled (mode: off)' });
    }

    const from = config.twilio.phoneNumber;
    const to = config.developer.phoneNumber;

    if (commMode === 'sms') {
      // SMS flow
      if (!from || !to) {
        failSession(sessionId, new Error('Missing phone numbers'));
        return reply.code(500).send({ error: 'Missing Twilio or developer phone number in config' });
      }

      try {
        const twilioClient = getTwilioClient();
        const messageSid = await sendSmsQuestion(twilioClient, { from, to, question, context, sessionId });
        updateSession(sessionId, { status: 'sms-waiting', messageSid, phone: to });
      } catch (err) {
        failSession(sessionId, err);
        return reply.code(500).send({ error: 'Failed to send SMS', details: err.message });
      }

      // Wait for SMS reply (longer timeout: 10 minutes)
      try {
        const result = await Promise.race([
          session.waitForCompletion,
          new Promise((_, reject) => setTimeout(() => reject(new Error('SMS timeout — no reply after 10 minutes')), 10 * 60 * 1000)),
        ]);
        return { answer: result.answer, transcript: result.transcript };
      } catch (err) {
        failSession(sessionId, err);
        return reply.code(504).send({ error: 'SMS reply not received', details: err.message });
      }
    }

    // Call flow (commMode === 'call' or default)
    if (serverMode === 'mock') {
      // In mock mode, the mock-twilio server handles the call
      const mockUrl = `http://localhost:${process.env.MOCK_TWILIO_PORT || 3001}`;
      try {
        const resp = await fetch(`${mockUrl}/place-call`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            twimlUrl: `${baseUrl}/twiml?sessionId=${encodeURIComponent(sessionId)}`,
            wsUrl: `ws://localhost:${port}/ws?sessionId=${encodeURIComponent(sessionId)}`,
          }),
        });
        if (!resp.ok) {
          throw new Error(`Mock Twilio returned ${resp.status}`);
        }
      } catch (err) {
        failSession(sessionId, err);
        return reply.code(500).send({ error: 'Failed to place mock call', details: err.message });
      }
    } else {
      // Live Twilio call
      if (!from || !to) {
        failSession(sessionId, new Error('Missing phone numbers'));
        return reply.code(500).send({ error: 'Missing Twilio or developer phone number in config' });
      }

      try {
        await placeOutboundCall(session, { from, to, baseUrl });
      } catch (err) {
        return reply.code(500).send({ error: 'Failed to place call', details: err.message });
      }
    }

    // Wait for the call to complete (blocking — this is the key behavior)
    try {
      const result = await Promise.race([
        session.waitForCompletion,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Call timeout — no response after 5 minutes')), 5 * 60 * 1000)),
      ]);
      return { answer: result.answer, transcript: result.transcript };
    } catch (err) {
      failSession(sessionId, err);
      return reply.code(504).send({ error: 'Call did not complete', details: err.message });
    }
  });

  // Twilio webhook for incoming SMS replies
  fastify.post('/sms-reply', async (request, reply) => {
    const { From, Body } = request.body || {};

    console.log(`[SMS Reply] From: ${From}, Body: ${(Body || '').slice(0, 80)}`);

    if (!From || !Body) {
      return reply.type('text/xml').send('<Response></Response>');
    }

    // Match the reply to a pending SMS session by phone number
    const session = getSessionByPhone(From);

    if (!session) {
      console.log(`[SMS Reply] No active session found for phone: ${From}`);
      return reply.type('text/xml').send('<Response><Message>No pending question found. Your reply was not matched to an active session.</Message></Response>');
    }

    console.log(`[SMS Reply] Matched session: ${session.id}, completing with answer`);

    // Add to transcript and complete the session
    addToTranscript(session.id, 'developer', Body);
    completeSession(session.id, Body);

    // Acknowledge via SMS
    return reply.type('text/xml').send('<Response><Message>Got it, passing your answer to the coding agent.</Message></Response>');
  });

  // Twilio requests TwiML when call connects
  fastify.post('/twiml', async (request, reply) => {
    const sessionId = request.query.sessionId;
    const wsUrl = `wss://${request.headers.host}/ws?sessionId=${encodeURIComponent(sessionId)}`;
    const twiml = generateTwiML(sessionId, wsUrl);
    reply.type('text/xml').send(twiml);
  });

  // Twilio call status callbacks
  fastify.post('/call-status', async (request) => {
    const sessionId = request.query.sessionId;
    const { CallStatus } = request.body || {};

    if (['failed', 'busy', 'no-answer'].includes(CallStatus)) {
      failSession(sessionId, new Error(`Call ${CallStatus}`));
    }

    return { ok: true };
  });

  // ConversationRelay WebSocket endpoint
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      handleConversationRelay(socket, req);
    });
  });

  await fastify.listen({ port, host });
  console.log(`Agent Phone server running on http://${host}:${port}`);

  return fastify;
}

export { start };

// Auto-start when run directly (not imported)
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMainModule) {
  start().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
