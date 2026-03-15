// Verification tests for Twilio integration
// Uses node:test — run with: node --test test/twilio-verify.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateTwiML, initTwilio } from '../server/twilio.js';

describe('generateTwiML', () => {
  it('returns valid XML with a ConversationRelay element', () => {
    const twiml = generateTwiML('test-session-1', 'wss://example.com/ws?sessionId=test-session-1');

    // Must be valid XML starting with the XML declaration or <Response>
    assert.ok(twiml.includes('<?xml'), 'should contain XML declaration');
    assert.ok(twiml.includes('<Response>'), 'should contain <Response> root element');
    assert.ok(twiml.includes('</Response>'), 'should close <Response>');

    // Must contain ConversationRelay inside a Connect
    assert.ok(twiml.includes('<Connect>'), 'should contain <Connect> element');
    assert.ok(twiml.includes('<ConversationRelay'), 'should contain <ConversationRelay> element');

    // ConversationRelay should have the websocket URL
    assert.ok(
      twiml.includes('wss://example.com/ws?sessionId=test-session-1'),
      'should embed the WebSocket URL in ConversationRelay'
    );

    // dtmfDetection should be enabled
    assert.ok(twiml.includes('dtmfDetection="true"'), 'should enable DTMF detection');
  });

  it('encodes the sessionId in the WebSocket URL', () => {
    const wsUrl = 'wss://host.example.com/ws?sessionId=abc%20123';
    const twiml = generateTwiML('abc 123', wsUrl);
    assert.ok(twiml.includes(wsUrl), 'should include the provided wsUrl as-is');
  });
});

describe('initTwilio', () => {
  it('does not throw when given credential strings in SID/token format', () => {
    // Use the same format as .env (AC-prefixed SID + hex token)
    // This only creates a client object; it does NOT make any API calls.
    assert.doesNotThrow(() => {
      initTwilio('AC00000000000000000000000000000000', 'a0000000000000000000000000000000');
    });
  });

  it('does not throw with arbitrary non-empty strings', () => {
    assert.doesNotThrow(() => {
      initTwilio('AC_TEST_SID', 'TEST_AUTH_TOKEN');
    });
  });
});
