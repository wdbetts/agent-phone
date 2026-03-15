// SMS functionality using Twilio Messages API

/**
 * Send an SMS question to the developer.
 * @param {object} twilioClient - Initialized Twilio client
 * @param {object} params
 * @param {string} params.from - Twilio phone number
 * @param {string} params.to - Developer phone number
 * @param {string} params.question - The question to ask
 * @param {string} params.context - Additional context
 * @param {string} params.sessionId - Session identifier
 * @returns {Promise<string>} The message SID
 */
export async function sendSmsQuestion(twilioClient, { from, to, question, context, sessionId }) {
  if (!twilioClient) {
    throw new Error('Twilio client not initialized');
  }

  // Build the SMS body — keep it concise for SMS
  let body = `Agent Phone: ${question}`;
  if (context) {
    // Truncate context for SMS (160 char segments, keep total reasonable)
    const truncatedContext = context.length > 300 ? context.slice(0, 297) + '...' : context;
    body += `\n\nContext: ${truncatedContext}`;
  }
  body += '\n\nReply to this message with your answer.';

  const message = await twilioClient.messages.create({
    to,
    from,
    body,
  });

  console.log(`[SMS] Sent question to ${to}, messageSid: ${message.sid}, sessionId: ${sessionId}`);
  return message.sid;
}
