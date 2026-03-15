// Twilio REST API — place outbound calls, generate TwiML

import twilio from 'twilio';
import { updateSession, failSession } from './sessions.js';

let twilioClient = null;

export function initTwilio(accountSid, authToken) {
  twilioClient = twilio(accountSid, authToken);
}

export function getTwilioClient() {
  return twilioClient;
}

export async function placeOutboundCall(session, { from, to, baseUrl }) {
  if (!twilioClient) {
    throw new Error('Twilio client not initialized. Call initTwilio() first.');
  }

  updateSession(session.id, { status: 'calling' });

  try {
    const call = await twilioClient.calls.create({
      to,
      from,
      url: `${baseUrl}/twiml?sessionId=${encodeURIComponent(session.id)}`,
      method: 'POST',
      statusCallback: `${baseUrl}/call-status?sessionId=${encodeURIComponent(session.id)}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed', 'failed', 'busy', 'no-answer'],
    });

    updateSession(session.id, { callSid: call.sid });
    return call;
  } catch (err) {
    failSession(session.id, err);
    throw err;
  }
}

export function generateTwiML(sessionId, wsUrl) {
  const response = new twilio.twiml.VoiceResponse();

  const connect = response.connect();
  connect.conversationRelay({
    url: wsUrl,
    dtmfDetection: true,
  });

  return response.toString();
}
