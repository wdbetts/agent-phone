// Claude API — voice conversation with context injection
// Supports both direct Anthropic API and Amazon Bedrock

import Anthropic from '@anthropic-ai/sdk';
import AnthropicBedrock from '@anthropic-ai/bedrock-sdk';

const MOCK_VOICE = process.env.MOCK_VOICE === 'true';

// Mutable config — set via configure() or falls back to env vars
let provider = process.env.CLAUDE_PROVIDER || 'anthropic'; // 'anthropic' or 'bedrock'
let region = process.env.AWS_REGION || 'us-east-1';
let model = null; // resolved lazily based on provider
let client = null;
let configured = false;

/**
 * Configure the Claude provider. Call before first use.
 * Options not provided fall back to env vars, then defaults.
 *   provider: 'anthropic' | 'bedrock'
 *   region:   AWS region (bedrock only)
 *   model:    model ID override
 */
export function configure(opts = {}) {
  if (opts.provider) provider = opts.provider;
  if (opts.region) region = opts.region;
  if (opts.model) model = opts.model;

  // Resolve model based on provider if not explicitly set
  if (!model) {
    model = provider === 'bedrock'
      ? (process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0')
      : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514');
  }

  // Startup validation
  if (!MOCK_VOICE) {
    if (provider === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      console.error('[claude] ERROR: provider is "anthropic" but ANTHROPIC_API_KEY is not set. API calls will fail.');
    }
    if (provider === 'bedrock') {
      console.log(`[claude] Provider "bedrock" selected, region=${region}, model=${model}`);
      // Attempt a lightweight validation — the SDK will use the AWS credential chain
      // (env vars, ~/.aws/credentials, IAM role). Actual errors surface on first API call.
      try {
        client = new AnthropicBedrock({ awsRegion: region });
        console.log('[claude] Bedrock client created successfully (credentials will be validated on first call).');
      } catch (err) {
        console.error(`[claude] ERROR: Failed to create Bedrock client: ${err.message}`);
        client = null;
      }
      configured = true;
      return;
    }
  }

  client = createClient();
  configured = true;
}

function resolveModel() {
  if (model) return model;
  return provider === 'bedrock'
    ? (process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-20250514-v1:0')
    : (process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514');
}

function createClient() {
  if (MOCK_VOICE) return null;

  if (provider === 'bedrock') {
    return new AnthropicBedrock({
      awsRegion: region,
    });
  }

  return new Anthropic();
}

// Ensure client is initialized (backward compat: works even without configure())
function ensureClient() {
  if (!configured) {
    configure();
  }
  return client;
}

function buildSystemPrompt(session) {
  return `You are a voice assistant calling a developer on behalf of their coding agent. The agent is stuck and needs a decision to continue.

YOUR ROLE:
- You are a one-way messenger. You deliver the question, get an answer, and the call ends.
- You CANNOT relay messages back and forth. You CANNOT tell the agent to do things.
- Once the developer gives their answer, confirm it and end the call. Do not offer to "check with the agent" or "have the agent look into it" — you can't do that.
- If the developer doesn't have enough context to answer, their answer should be "I need more context" or "skip this question" — that IS a valid answer to pass back.

WHAT THE CODING AGENT IS WORKING ON:
${session.context || 'No additional context provided.'}

THE QUESTION THE AGENT NEEDS ANSWERED:
${session.question}

${session.options ? `OPTIONS THE AGENT IDENTIFIED:\n${session.options}` : ''}

CONVERSATION RULES:
- Start by briefly explaining what the agent is working on and what it needs to know
- Give enough context that the developer can make a decision without seeing the code
- Keep responses under 2 sentences — this is a phone call
- When they give a clear answer, confirm it back and say goodbye
- If they say "go ahead", "that's all", or similar — summarize and end
- NEVER promise to relay additional messages or have the agent do something specific

PREFERENCE CHANGES (the developer can change how future notifications work):
- "text me instead" / "don't call, text me" → acknowledge, note they prefer SMS going forward
- "stop calling" / "don't call again" → acknowledge, note they want notifications disabled`;
}

export async function getVoiceResponse(session, userText) {
  // Add user message to conversation history
  session.conversationHistory.push({ role: 'user', content: userText });

  let assistantText;

  if (MOCK_VOICE) {
    // Return canned responses for testing without an API key
    if (userText.includes('[Call connected')) {
      assistantText = `Hi! The coding agent needs your help. It's asking: ${session.question}`;
    } else if (userText.toLowerCase().includes('go ahead') || userText.toLowerCase().includes('bye')) {
      assistantText = "Got it, I'll pass that along. Goodbye!";
    } else {
      assistantText = `Thanks for the input. Just to confirm, you said: "${userText}". Is that your final answer, or anything to add?`;
    }
  } else {
    // Both Anthropic and Bedrock SDKs use the same messages.create() interface
    const activeClient = ensureClient();
    const response = await activeClient.messages.create({
      model: resolveModel(),
      max_tokens: 150,
      system: buildSystemPrompt(session),
      messages: session.conversationHistory,
    });

    assistantText = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  }

  // Add assistant response to conversation history
  session.conversationHistory.push({ role: 'assistant', content: assistantText });

  return assistantText;
}

export function summarizeConversation(session) {
  if (session.transcript.length === 0) {
    return 'No conversation took place — developer did not respond.';
  }

  const lines = session.transcript
    .map((entry) => `${entry.role === 'developer' ? 'Developer' : 'Assistant'}: ${entry.text}`)
    .join('\n');

  return `Phone conversation transcript:\n${lines}`;
}
