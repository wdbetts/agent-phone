// ConversationRelay WebSocket handler

import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getSession, updateSession, completeSession, failSession, addToTranscript } from './sessions.js';
import { getVoiceResponse, summarizeConversation } from './claude.js';

const END_PHRASES = [
  'go ahead',
  "that's all",
  "that's it",
  'goodbye',
  'bye',
  'hang up',
  "i'm done",
  'end call',
  'thanks bye',
];

function isEndPhrase(text) {
  const lower = text.toLowerCase().trim();
  return END_PHRASES.some((phrase) => lower.includes(phrase));
}

// Preference change detection
const PREFER_SMS_PHRASES = [
  'text me instead',
  'send me a text',
  'text me next time',
  "don't call, text",
  'sms instead',
  'send a text next time',
  'prefer text',
  'prefer sms',
];

const PREFER_OFF_PHRASES = [
  "don't call again",
  'stop calling',
  "don't call me",
  'no more calls',
  'disable calls',
  'turn off calls',
  'stop phoning',
];

const PREFER_CALL_PHRASES = [
  'keep calling',
  'calls are fine',
  'calling is fine',
  'prefer calls',
];

/**
 * Detect if the developer expressed a preference change.
 * @param {string} text - Developer's speech text
 * @returns {'sms'|'off'|'call'|null} New mode or null if no preference detected
 */
function detectPreference(text) {
  const lower = text.toLowerCase().trim();
  if (PREFER_SMS_PHRASES.some((phrase) => lower.includes(phrase))) return 'sms';
  if (PREFER_OFF_PHRASES.some((phrase) => lower.includes(phrase))) return 'off';
  if (PREFER_CALL_PHRASES.some((phrase) => lower.includes(phrase))) return 'call';
  return null;
}

/**
 * Update the developer's preference in state.json.
 * @param {string} newMode - 'off', 'call', or 'sms'
 * @param {string} phone - Developer's phone number
 */
async function updatePreference(newMode, phone) {
  const dir = join(process.env.HOME || '/root', '.agent-phone');
  const statePath = join(dir, 'state.json');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      mode: newMode,
      phone: phone || '',
      since: new Date().toISOString()
    }));
    console.log(`[ConversationRelay] Updated preference: mode=${newMode}`);
  } catch (err) {
    console.error(`[ConversationRelay] Failed to update preference:`, err);
  }
}

export function handleConversationRelay(ws, req) {
  // Extract sessionId from the WebSocket URL query params immediately
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  let isClosing = false;

  console.log(`[ConversationRelay] WebSocket connected, sessionId: ${sessionId}`);

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      console.log(`[ConversationRelay] Non-JSON message:`, data.toString().slice(0, 100));
      return;
    }

    console.log(`[ConversationRelay] Received: ${msg.type}`, msg.type === 'prompt' ? msg.voicePrompt?.slice(0, 80) : '');

    if (msg.type === 'setup') {
      // Twilio sends this automatically with callSid, from, to, etc.
      const session = getSession(sessionId);
      if (!session) {
        console.error(`[ConversationRelay] No session found for: ${sessionId}`);
        ws.send(JSON.stringify({ type: 'text', token: "Sorry, I couldn't find the session. Goodbye.", last: true }));
        setTimeout(() => ws.close(), 2000);
        return;
      }

      updateSession(sessionId, { status: 'in-call', callSid: msg.callSid });
      console.log(`[ConversationRelay] Session ${sessionId} now in-call, callSid: ${msg.callSid}`);

      // Send initial greeting
      try {
        const greeting = await getVoiceResponse(session, '[Call connected — greet the developer and explain why you are calling]');
        addToTranscript(sessionId, 'assistant', greeting);
        ws.send(JSON.stringify({ type: 'text', token: greeting, last: true }));
        console.log(`[ConversationRelay] Sent greeting: ${greeting.slice(0, 80)}...`);
      } catch (err) {
        console.error('[ConversationRelay] Error generating greeting:', err);
        ws.send(JSON.stringify({ type: 'text', token: "Hi, the coding agent needs your help but I'm having trouble. Please check the logs.", last: true }));
      }
      return;
    }

    if (msg.type === 'prompt') {
      // Twilio sends voicePrompt with transcribed speech
      const userText = msg.voicePrompt || msg.transcript || '';
      if (!userText.trim()) return;

      const session = getSession(sessionId);
      if (!session) return;

      console.log(`[ConversationRelay] Developer said: ${userText}`);
      addToTranscript(sessionId, 'developer', userText);

      // Check for preference changes (e.g., "text me instead", "stop calling")
      const newPref = detectPreference(userText);
      if (newPref) {
        // Update state.json but continue the call normally
        await updatePreference(newPref, session.phone || '');
        console.log(`[ConversationRelay] Developer preference changed to: ${newPref}`);
        // The Claude response will naturally acknowledge (guided by system prompt)
      }

      // Check if developer wants to end the call
      if (isEndPhrase(userText)) {
        try {
          const summary = summarizeConversation(session);
          const farewell = await getVoiceResponse(session, userText);
          addToTranscript(sessionId, 'assistant', farewell);
          ws.send(JSON.stringify({ type: 'text', token: farewell, last: true }));

          // Give time for TTS to play before closing
          isClosing = true;
          setTimeout(() => {
            completeSession(sessionId, summary);
            ws.close();
          }, 5000);
        } catch (err) {
          console.error('[ConversationRelay] Error generating farewell:', err);
          completeSession(sessionId, summarizeConversation(session));
          ws.close();
        }
        return;
      }

      // Normal conversation turn
      try {
        const response = await getVoiceResponse(session, userText);
        addToTranscript(sessionId, 'assistant', response);
        ws.send(JSON.stringify({ type: 'text', token: response, last: true }));
      } catch (err) {
        console.error('[ConversationRelay] Error generating response:', err);
        ws.send(JSON.stringify({ type: 'text', token: "Sorry, I had trouble processing that. Could you repeat?", last: true }));
      }
      return;
    }

    if (msg.type === 'interrupt') {
      console.log('[ConversationRelay] Developer interrupted');
      return;
    }

    if (msg.type === 'dtmf') {
      console.log(`[ConversationRelay] DTMF: ${msg.digit}`);
      return;
    }

    if (msg.type === 'error') {
      console.error(`[ConversationRelay] Error from Twilio:`, msg.description || msg);
      return;
    }
  });

  ws.on('close', () => {
    console.log(`[ConversationRelay] WebSocket closed, sessionId: ${sessionId}`);
    if (sessionId && !isClosing) {
      const session = getSession(sessionId);
      if (session && session.status === 'in-call') {
        const summary = summarizeConversation(session);
        completeSession(sessionId, summary);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[ConversationRelay] WebSocket error:', err);
    if (sessionId) {
      failSession(sessionId, err);
    }
  });
}
