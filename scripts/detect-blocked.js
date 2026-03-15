// Blocked-state detection logic extracted from stop-hook.sh
// Used by stop-hook.sh via: node scripts/detect-blocked.js < input.json
// Also importable for testing.

const INDICATORS = [
  '?',
  'what would you like',
  'how should i',
  'which approach',
  'should i',
  'do you want',
  'please confirm',
  'waiting for',
  'need your input',
  'need guidance',
  'blocked',
  'cannot proceed',
  'let me know',
  'your preference',
  'what do you think',
  'choose between',
];

/**
 * Extract the message text from a stop-hook payload.
 * Handles both string messages and content-block arrays.
 * @param {object} data - The parsed stop-hook JSON payload
 * @returns {string} The extracted message text
 */
export function extractMessage(data) {
  let msg = data?.last_assistant_message ?? '';
  if (Array.isArray(msg)) {
    msg = msg
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join(' ');
  }
  return typeof msg === 'string' ? msg : '';
}

/**
 * Determine whether a message indicates the agent is blocked.
 * @param {string} message - The assistant message text
 * @returns {boolean}
 */
export function isBlocked(message) {
  if (!message || !message.trim()) return false;
  const lower = message.toLowerCase();
  return INDICATORS.some((ind) => lower.includes(ind));
}

/**
 * Full analysis: extract message, detect blocked, return session id.
 * Mirrors the Python analysis block in stop-hook.sh.
 * @param {object} data - The parsed stop-hook JSON payload
 * @returns {{ blocked: boolean, message: string, sessionId: string }}
 */
export function analyze(data) {
  const message = extractMessage(data);
  if (!message.trim()) {
    return { blocked: false, message: '', sessionId: '' };
  }
  const blocked = isBlocked(message);
  const sessionId =
    data?.session_id || `session-${Math.floor(Date.now() / 1000)}`;
  return { blocked, message, sessionId };
}

// CLI entry point: read JSON from stdin, output analysis
if (
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].endsWith('detect-blocked.js')
) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input);
      const result = analyze(data);
      // Output format matches the old Python script: three lines
      // Line 1: "yes" or "no"
      // Line 2: base64-encoded message
      // Line 3: session id
      console.log(result.blocked ? 'yes' : 'no');
      console.log(Buffer.from(result.message).toString('base64'));
      console.log(result.sessionId);
    } catch {
      console.log('no');
      console.log('');
      console.log('');
    }
  });
}
