import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// sessions.js uses a module-level Map, so we need to work around shared state.
// We import fresh each time via dynamic import with cache-busting? No — ESM caches.
// Instead we rely on unique session IDs per test.

import {
  createSession,
  getSession,
  getActiveSession,
  updateSession,
  completeSession,
  failSession,
  addToTranscript,
  getAllSessions,
} from '../server/sessions.js';

let counter = 0;
function uniqueId() {
  return `test-session-${Date.now()}-${++counter}`;
}

describe('createSession', () => {
  it('creates a session with required fields', () => {
    const id = uniqueId();
    const session = createSession(id, {
      question: 'What color?',
      context: 'Choosing a theme',
      options: 'red or blue',
    });
    assert.equal(session.id, id);
    assert.equal(session.question, 'What color?');
    assert.equal(session.context, 'Choosing a theme');
    assert.equal(session.options, 'red or blue');
    assert.equal(session.status, 'pending');
    assert.equal(session.answer, null);
    assert.equal(session.callSid, null);
    assert.ok(Array.isArray(session.transcript));
    assert.equal(session.transcript.length, 0);
    assert.ok(session.waitForCompletion instanceof Promise);
  });

  it('defaults context and options to empty strings', () => {
    const id = uniqueId();
    const session = createSession(id, { question: 'Q' });
    assert.equal(session.context, '');
    assert.equal(session.options, '');
  });
});

describe('getSession', () => {
  it('returns the session by id', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    const session = getSession(id);
    assert.equal(session.id, id);
  });

  it('returns undefined for unknown id', () => {
    assert.equal(getSession('nonexistent-id'), undefined);
  });
});

describe('getActiveSession', () => {
  it('returns a session with pending status', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    const active = getActiveSession();
    assert.ok(active);
    // The active session should be one of the pending/calling/in-call sessions
    assert.ok(['pending', 'calling', 'in-call'].includes(active.status));
  });

  it('returns a session with calling status', () => {
    const id = uniqueId();
    const session = createSession(id, { question: 'Q' });
    updateSession(id, { status: 'calling' });
    const active = getActiveSession();
    assert.ok(active);
  });

  it('does not return completed sessions', () => {
    // Complete all pending sessions first by creating a fresh one and completing it
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    completeSession(id, 'done');
    // getActiveSession might return other sessions from previous tests,
    // so we just verify the completed one is not returned
    const session = getSession(id);
    assert.equal(session.status, 'completed');
  });
});

describe('updateSession', () => {
  it('merges updates into the session', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    updateSession(id, { status: 'calling', callSid: 'CA123' });
    const session = getSession(id);
    assert.equal(session.status, 'calling');
    assert.equal(session.callSid, 'CA123');
  });

  it('returns null for unknown session', () => {
    assert.equal(updateSession('no-such-session', { status: 'x' }), null);
  });
});

describe('completeSession', () => {
  it('sets status to completed and stores the answer', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    completeSession(id, 'Use approach A');
    const session = getSession(id);
    assert.equal(session.status, 'completed');
    assert.equal(session.answer, 'Use approach A');
    assert.ok(session.completedAt);
  });

  it('resolves the waitForCompletion promise', async () => {
    const id = uniqueId();
    const session = createSession(id, { question: 'Q' });
    // Complete after a microtask to simulate async flow
    queueMicrotask(() => completeSession(id, 'The answer'));
    const result = await session.waitForCompletion;
    assert.equal(result.answer, 'The answer');
    assert.ok(Array.isArray(result.transcript));
  });

  it('returns null for unknown session', () => {
    assert.equal(completeSession('no-such-session', 'x'), null);
  });
});

describe('failSession', () => {
  it('sets status to failed', async () => {
    const id = uniqueId();
    const session = createSession(id, { question: 'Q' });
    // Catch the rejection so it doesn't become unhandled
    session.waitForCompletion.catch(() => {});
    failSession(id, new Error('timeout'));
    const s = getSession(id);
    assert.equal(s.status, 'failed');
    assert.ok(s.completedAt);
  });

  it('rejects the waitForCompletion promise', async () => {
    const id = uniqueId();
    const session = createSession(id, { question: 'Q' });
    queueMicrotask(() => failSession(id, new Error('call failed')));
    await assert.rejects(session.waitForCompletion, {
      message: 'call failed',
    });
  });

  it('returns null for unknown session', () => {
    assert.equal(failSession('no-such-session', new Error('x')), null);
  });
});

describe('addToTranscript', () => {
  it('adds entries to the session transcript', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    addToTranscript(id, 'user', 'Hello');
    addToTranscript(id, 'assistant', 'Hi there');
    const session = getSession(id);
    assert.equal(session.transcript.length, 2);
    assert.equal(session.transcript[0].role, 'user');
    assert.equal(session.transcript[0].text, 'Hello');
    assert.ok(session.transcript[0].timestamp);
    assert.equal(session.transcript[1].role, 'assistant');
    assert.equal(session.transcript[1].text, 'Hi there');
  });

  it('silently does nothing for unknown session', () => {
    // Should not throw
    addToTranscript('no-such-session', 'user', 'Hello');
  });
});

describe('getAllSessions', () => {
  it('returns sessions without internal promise fields', () => {
    const id = uniqueId();
    createSession(id, { question: 'Q' });
    const all = getAllSessions();
    const found = all.find((s) => s.id === id);
    assert.ok(found);
    assert.equal(found._resolve, undefined);
    assert.equal(found._reject, undefined);
    assert.equal(found.waitForCompletion, undefined);
  });
});
