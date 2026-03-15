import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { extractMessage, isBlocked, analyze } from '../scripts/detect-blocked.js';

describe('extractMessage', () => {
  it('returns string messages as-is', () => {
    const data = { last_assistant_message: 'Hello world' };
    assert.equal(extractMessage(data), 'Hello world');
  });

  it('joins text content blocks', () => {
    const data = {
      last_assistant_message: [
        { type: 'text', text: 'First part.' },
        { type: 'text', text: 'Second part.' },
      ],
    };
    assert.equal(extractMessage(data), 'First part. Second part.');
  });

  it('filters out non-text content blocks', () => {
    const data = {
      last_assistant_message: [
        { type: 'text', text: 'Visible.' },
        { type: 'tool_use', id: 'x', name: 'bash', input: {} },
        { type: 'text', text: 'Also visible.' },
      ],
    };
    assert.equal(extractMessage(data), 'Visible. Also visible.');
  });

  it('returns empty string when message is missing', () => {
    assert.equal(extractMessage({}), '');
    assert.equal(extractMessage({ last_assistant_message: undefined }), '');
  });

  it('returns empty string for null data', () => {
    assert.equal(extractMessage(null), '');
  });

  it('handles content block with missing text field', () => {
    const data = {
      last_assistant_message: [{ type: 'text' }],
    };
    assert.equal(extractMessage(data), '');
  });
});

describe('isBlocked', () => {
  it('detects messages with questions', () => {
    assert.equal(isBlocked('Should I use approach A or B?'), true);
  });

  it('detects "which approach" indicator', () => {
    assert.equal(isBlocked('I see two options. Which approach do you prefer'), true);
  });

  it('detects "need your input" indicator', () => {
    assert.equal(isBlocked('I need your input on the database schema.'), true);
  });

  it('detects "please confirm" indicator', () => {
    assert.equal(isBlocked('Please confirm before I delete these files.'), true);
  });

  it('detects "cannot proceed" indicator', () => {
    assert.equal(isBlocked('I cannot proceed without credentials.'), true);
  });

  it('detects "what would you like" indicator', () => {
    assert.equal(isBlocked('What would you like me to do next?'), true);
  });

  it('detects "let me know" indicator', () => {
    assert.equal(isBlocked('Let me know if that looks right.'), true);
  });

  it('does NOT detect plain status updates', () => {
    assert.equal(isBlocked("I've completed the refactoring."), false);
  });

  it('does NOT detect completion statements', () => {
    assert.equal(isBlocked('All tests pass. The migration is done.'), false);
  });

  it('does NOT detect empty strings', () => {
    assert.equal(isBlocked(''), false);
  });

  it('does NOT detect whitespace-only strings', () => {
    assert.equal(isBlocked('   '), false);
  });

  it('does NOT detect null/undefined', () => {
    assert.equal(isBlocked(null), false);
    assert.equal(isBlocked(undefined), false);
  });

  it('is case-insensitive', () => {
    assert.equal(isBlocked('SHOULD I proceed with the deployment'), true);
    assert.equal(isBlocked('NEED YOUR INPUT on this design.'), true);
  });
});

describe('analyze', () => {
  it('detects a blocked payload with a question', () => {
    const result = analyze({
      last_assistant_message: 'Should I use approach A or B?',
      session_id: 'ses-1',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.message, 'Should I use approach A or B?');
    assert.equal(result.sessionId, 'ses-1');
  });

  it('returns not blocked for status updates', () => {
    const result = analyze({
      last_assistant_message: "I've completed the refactoring.",
      session_id: 'ses-2',
    });
    assert.equal(result.blocked, false);
  });

  it('handles empty message payload', () => {
    const result = analyze({ last_assistant_message: '' });
    assert.equal(result.blocked, false);
    assert.equal(result.message, '');
    assert.equal(result.sessionId, '');
  });

  it('handles missing message field', () => {
    const result = analyze({});
    assert.equal(result.blocked, false);
  });

  it('generates session id when not provided', () => {
    const result = analyze({
      last_assistant_message: 'Do you want me to continue?',
    });
    assert.equal(result.blocked, true);
    assert.match(result.sessionId, /^session-\d+$/);
  });

  it('parses content-block arrays and detects blocked state', () => {
    const result = analyze({
      last_assistant_message: [
        { type: 'text', text: 'I need your input on the config.' },
      ],
      session_id: 'ses-3',
    });
    assert.equal(result.blocked, true);
    assert.equal(result.message, 'I need your input on the config.');
  });

  it('parses content-block arrays and detects non-blocked state', () => {
    const result = analyze({
      last_assistant_message: [
        { type: 'text', text: 'Done. All files updated.' },
      ],
      session_id: 'ses-4',
    });
    assert.equal(result.blocked, false);
  });
});
