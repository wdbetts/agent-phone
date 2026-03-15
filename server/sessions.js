// Session and call state manager

import crypto from 'crypto';

const sessions = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function generateSessionId() {
  return crypto.randomUUID();
}

// Clean up completed/failed sessions older than TTL
function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (
      ['completed', 'failed'].includes(session.status) &&
      session.completedAt &&
      now - new Date(session.completedAt).getTime() > SESSION_TTL_MS
    ) {
      sessions.delete(id);
    }
  }
}

// Run cleanup every 60 seconds
const cleanupInterval = setInterval(cleanupSessions, 60_000);
cleanupInterval.unref(); // Don't keep the process alive for cleanup

export function createSession(sessionId, { question, context, options }) {
  const session = {
    id: sessionId,
    question,
    context: context || '',
    options: options || '',
    status: 'pending', // pending | calling | in-call | completed | failed
    callSid: null,
    conversationHistory: [],
    transcript: [],
    answer: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    // Promise resolve/reject for blocking the hook request
    _resolve: null,
    _reject: null,
  };

  session.waitForCompletion = new Promise((resolve, reject) => {
    session._resolve = resolve;
    session._reject = reject;
  });

  sessions.set(sessionId, session);
  return session;
}

export function getSession(sessionId) {
  return sessions.get(sessionId);
}

export function getActiveSession() {
  for (const session of sessions.values()) {
    if (['pending', 'calling', 'in-call'].includes(session.status)) {
      return session;
    }
  }
  return null;
}

export function updateSession(sessionId, updates) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  Object.assign(session, updates);
  return session;
}

export function completeSession(sessionId, answer) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  session.status = 'completed';
  session.answer = answer;
  session.completedAt = new Date().toISOString();

  if (session._resolve) {
    session._resolve({ answer, transcript: session.transcript });
  }

  return session;
}

export function failSession(sessionId, error) {
  const session = sessions.get(sessionId);
  if (!session) return null;

  session.status = 'failed';
  session.completedAt = new Date().toISOString();

  if (session._reject) {
    session._reject(error);
  }

  return session;
}

export function addToTranscript(sessionId, role, text) {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.transcript.push({ role, text, timestamp: new Date().toISOString() });
}

/**
 * Find an active session associated with a specific phone number.
 * Used by SMS reply webhook to match incoming replies to pending sessions.
 * @param {string} phone - The developer's phone number (E.164 format)
 * @returns {object|null} The matching session or null
 */
export function getSessionByPhone(phone) {
  for (const session of sessions.values()) {
    if (['pending', 'calling', 'in-call', 'sms-waiting'].includes(session.status) && session.phone === phone) {
      return session;
    }
  }
  return null;
}

export function getAllSessions() {
  return Array.from(sessions.values()).map(({ _resolve, _reject, waitForCompletion, ...rest }) => rest);
}
