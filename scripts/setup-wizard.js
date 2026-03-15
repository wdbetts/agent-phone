#!/usr/bin/env node
// Interactive first-run setup for Agent Phone
// Collects config, provisions resources, and verifies with a test call

import { createInterface } from 'readline';
import { writeFile, readFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { execSync, exec as execCb } from 'child_process';
import { platform } from 'os';

const CONFIG_DIR = join(process.env.HOME || '/root', '.agent-phone');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');
const STATE_PATH = join(CONFIG_DIR, 'state.json');
const PROJECT_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const ENV_PATH = join(PROJECT_ROOT, '.env');

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

// ── Helpers ──────────────────────────────────────────────────────────

async function readEnv() {
  try {
    return await readFile(ENV_PATH, 'utf-8');
  } catch {
    return '';
  }
}

function getEnvValue(content, key) {
  const match = content.match(new RegExp(`^${key}=(.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

async function setEnvValue(key, value) {
  let content = await readEnv();
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  await writeFile(ENV_PATH, content);
}

function twilioAuth(sid, token) {
  return 'Basic ' + Buffer.from(sid + ':' + token).toString('base64');
}

// ── Twilio number provisioning ───────────────────────────────────────

async function provisionNumber(sid, token) {
  const auth = twilioAuth(sid, token);
  console.log('\nSearching for available US toll-free numbers (voice + SMS capable)...\n');

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/US/TollFree.json?VoiceEnabled=true&SmsEnabled=true&Limit=5`,
    { headers: { Authorization: auth } },
  );

  if (!res.ok) {
    console.error(`Error searching numbers (${res.status}): ${await res.text()}`);
    return null;
  }

  const { available_phone_numbers: numbers } = await res.json();
  if (!numbers?.length) {
    console.error('No available numbers found.');
    return null;
  }

  console.log('Available numbers:');
  numbers.forEach((n, i) => console.log(`  ${i + 1}. ${n.friendly_name} (${n.phone_number})`));
  console.log('  0. Cancel\n');

  const pick = parseInt((await ask(`Pick [1-${numbers.length}, 0 to cancel]: `)).trim(), 10);
  if (!pick || pick < 1 || pick > numbers.length) return null;

  const chosen = numbers[pick - 1];
  console.log(`\nPurchasing ${chosen.phone_number}...`);

  const purchaseRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ PhoneNumber: chosen.phone_number, FriendlyName: 'AgentPhone' }),
    },
  );

  if (!purchaseRes.ok) {
    console.error(`Error purchasing (${purchaseRes.status}): ${await purchaseRes.text()}`);
    return null;
  }

  const purchased = await purchaseRes.json();
  console.log(`  Purchased ${purchased.phone_number} (SID: ${purchased.sid})`);
  return { phoneNumber: purchased.phone_number, phoneSid: purchased.sid };
}

// ── Toll-free verification ───────────────────────────────────────────

async function submitTollFreeVerification(sid, token, phoneSid, { businessName, contactName, contactEmail, contactPhone }) {
  const auth = twilioAuth(sid, token);
  const [firstName, ...lastParts] = contactName.split(' ');
  const lastName = lastParts.join(' ') || firstName;

  console.log('\n  Submitting toll-free verification for SMS...');

  const params = new URLSearchParams({
    BusinessName: businessName,
    BusinessWebsite: '',
    BusinessContactFirstName: firstName,
    BusinessContactLastName: lastName,
    BusinessContactEmail: contactEmail,
    BusinessContactPhone: contactPhone,
    BusinessCountry: 'US',
    BusinessType: 'SOLE_PROPRIETOR',
    NotificationEmail: contactEmail,
    UseCaseCategories: 'ACCOUNT_NOTIFICATIONS',
    UseCaseSummary: 'Automated developer notifications from a coding assistant (Agent Phone). The system sends SMS to the developer\'s own phone when an AI coding agent needs input or a decision. Only sends to a single pre-configured phone number owned by the developer.',
    ProductionMessageSample: 'Agent Phone: The coding agent needs your input. Should it use PostgreSQL or SQLite for the data pipeline? Reply to this message with your answer.',
    OptInType: 'VERBAL',
    OptInImageUrls: 'https://github.com/wdbetts/agent-phone',
    MessageVolume: '10',
    TollfreePhoneNumberSid: phoneSid,
    AdditionalInformation: 'Self-use only. Developer configures their own phone number during setup and verbally opts in. No third-party recipients.',
  });

  try {
    const res = await fetch('https://messaging.twilio.com/v1/Tollfree/Verifications', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });

    if (!res.ok) {
      const body = await res.text();
      console.log(`  Verification submission failed (${res.status}): ${body}`);
      console.log(`  You can submit manually at:`);
      console.log(`  https://console.twilio.com/us1/develop/phone-numbers/manage/incoming/${phoneSid}/configure`);
      return false;
    }

    const result = await res.json();
    console.log(`  Toll-free verification submitted (${result.status}). You'll receive an email at ${contactEmail} when approved.`);
    console.log('  SMS will work once verification is approved (typically 3-5 business days).');
    return true;
  } catch (err) {
    console.log(`  Could not submit verification: ${err.message}`);
    return false;
  }
}

// ── Test call ────────────────────────────────────────────────────────

async function placeTestCall(sid, token, from, to) {
  console.log(`\nPlacing test call: ${from} -> ${to} ...`);
  const auth = twilioAuth(sid, token);

  const twiml = `<Response><Say voice="Polly.Amy">Hello! This is Agent Phone. Your setup is complete. When Claude gets stuck, it will call this number. Goodbye!</Say></Response>`;

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
    {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Twiml: twiml }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error(`  Test call failed (${res.status}): ${body}`);
    return false;
  }

  const call = await res.json();
  console.log(`  Call placed (SID: ${call.sid}). Your phone should ring momentarily.`);
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log('\n--- Agent Phone Setup ---\n');
  await mkdir(CONFIG_DIR, { recursive: true });

  // Read existing .env to pre-fill values
  const envContent = await readEnv();

  console.log('How do you want to run?\n');
  console.log('  1. Local testing (mock phone in browser, no accounts needed)');
  console.log('  2. Full setup (real Twilio calls to your phone)\n');

  const choice = (await ask('Choose [1/2]: ')).trim();

  if (choice === '1') {
    await setupMock();
  } else {
    await setupLive(envContent);
  }

  rl.close();
}

// ── Mock setup ───────────────────────────────────────────────────────

async function setupMock() {
  const config = {
    mode: 'mock',
    twilio: null,
    claude: { provider: 'mock' },
    developer: { phoneNumber: 'mock' },
  };

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  await writeFile(STATE_PATH, JSON.stringify({ mobile: false }));

  console.log('\n  Configuration saved.');
  console.log('  Start servers: npm start & npm run mock');
  console.log('  Mock phone UI: http://localhost:3002');
  console.log('  Then run /agent-phone:going-mobile in Claude Code.\n');
}

// ── Live setup ───────────────────────────────────────────────────────

async function setupLive(envContent) {
  // ── 1. Twilio credentials ──
  console.log('\n--- Twilio ---\n');

  let sid = getEnvValue(envContent, 'TWILIO_SID');
  let token = getEnvValue(envContent, 'TWILIO_AUTH_TOKEN');

  if (sid && token) {
    console.log(`  Found existing Twilio credentials (${sid.slice(0, 6)}...)`);
    const keep = (await ask('  Use these? [Y/n]: ')).trim().toLowerCase();
    if (keep === 'n') {
      sid = '';
      token = '';
    }
  }

  if (!sid) sid = (await ask('  Twilio Account SID: ')).trim();
  if (!token) token = (await ask('  Twilio Auth Token: ')).trim();

  // Validate credentials
  console.log('\n  Verifying Twilio credentials...');
  const verifyRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}.json`,
    { headers: { Authorization: twilioAuth(sid, token) } },
  );
  if (!verifyRes.ok) {
    console.error(`  Invalid credentials (${verifyRes.status}). Check your SID and token.`);
    rl.close();
    process.exit(1);
  }
  console.log('  Credentials valid.');

  // ── AI/ML Addendum ──
  console.log('\n  ConversationRelay requires the AI/ML addendum enabled in your Twilio console.');
  console.log('  Opening the settings page in your browser...');
  const addendumUrl = 'https://console.twilio.com/us1/develop/voice/settings/general?frameUrl=%2Fconsole%2Fvoice%2Fsettings%3Fx-target-region%3Dus1';
  try {
    if (platform() === 'darwin') {
      execSync(`open "${addendumUrl}"`, { stdio: 'ignore' });
    } else {
      execSync(`xdg-open "${addendumUrl}"`, { stdio: 'ignore' });
    }
  } catch {
    console.log(`  Could not open browser. Visit manually:\n  ${addendumUrl}`);
  }
  const addendumOk = (await ask('\n  Have you enabled the Predictive and Generative AI/ML Features Addendum? [Y/n]: ')).trim().toLowerCase();
  if (addendumOk === 'n') {
    console.log('  Please enable the addendum before proceeding. Calls will fail without it.');
    rl.close();
    process.exit(1);
  }

  await setEnvValue('TWILIO_SID', sid);
  await setEnvValue('TWILIO_AUTH_TOKEN', token);

  // ── 2. Twilio phone number ──
  let twilioPhone = getEnvValue(await readEnv(), 'TWILIO_PHONE_NUMBER');

  if (twilioPhone) {
    console.log(`\n  Found existing Twilio number: ${twilioPhone}`);
    const keep = (await ask('  Use this? [Y/n]: ')).trim().toLowerCase();
    if (keep === 'n') twilioPhone = '';
  }

  let provisionedPhoneSid = null;
  if (!twilioPhone) {
    const provision = (await ask('\n  Auto-provision a new US toll-free number? [Y/n]: ')).trim().toLowerCase();
    if (provision !== 'n') {
      const result = await provisionNumber(sid, token);
      if (result) {
        twilioPhone = result.phoneNumber;
        provisionedPhoneSid = result.phoneSid;
      }
    }
    if (!twilioPhone) {
      twilioPhone = (await ask('  Enter your Twilio phone number: ')).trim();
    }
  }

  await setEnvValue('TWILIO_PHONE_NUMBER', twilioPhone);

  // ── 3. Developer phone number ──
  let devPhone = getEnvValue(await readEnv(), 'DEVELOPER_PHONE_NUMBER');

  if (devPhone) {
    console.log(`\n  Found existing developer number: ${devPhone}`);
    const keep = (await ask('  Use this? [Y/n]: ')).trim().toLowerCase();
    if (keep === 'n') devPhone = '';
  }

  if (!devPhone) {
    devPhone = (await ask('\n  Your phone number (to receive calls, e.g. +15551234567): ')).trim();
  }

  await setEnvValue('DEVELOPER_PHONE_NUMBER', devPhone);

  // ── 4. Claude provider ──
  console.log('\n--- Claude API ---\n');
  console.log('  How should Agent Phone call the Claude API for voice conversations?\n');
  console.log('  1. Anthropic API (needs ANTHROPIC_API_KEY)');
  console.log('  2. Amazon Bedrock (uses AWS credential chain)\n');

  const providerChoice = (await ask('  Choose [1/2]: ')).trim();
  let provider = 'anthropic';

  if (providerChoice === '2') {
    provider = 'bedrock';
    let region = (await ask('  AWS region [us-east-1]: ')).trim() || 'us-east-1';
    await setEnvValue('CLAUDE_PROVIDER', 'bedrock');
    await setEnvValue('AWS_REGION', region);
    console.log('  Using Bedrock with standard AWS credential chain.');
  } else {
    await setEnvValue('CLAUDE_PROVIDER', 'anthropic');
    let apiKey = getEnvValue(await readEnv(), 'ANTHROPIC_API_KEY');
    if (!apiKey) {
      apiKey = (await ask('  Anthropic API Key: ')).trim();
      await setEnvValue('ANTHROPIC_API_KEY', apiKey);
    } else {
      console.log(`  Found existing API key (${apiKey.slice(0, 10)}...)`);
    }
  }

  // ── 5. Set mode to live ──
  await setEnvValue('MODE', 'live');

  // ── 5b. Check for cloudflared ──
  let hasCloudflared = false;
  try {
    execSync('command -v cloudflared', { stdio: 'ignore' });
    hasCloudflared = true;
  } catch {}

  if (!hasCloudflared) {
    console.log('\n  cloudflared is required for live mode (Twilio needs a public URL for callbacks).');
    const installIt = (await ask('  Install now? [Y/n]: ')).trim().toLowerCase();
    if (installIt !== 'n') {
      if (platform() === 'darwin') {
        console.log('  Installing cloudflared via Homebrew...');
        try {
          execSync('brew install cloudflared', { stdio: 'inherit' });
          console.log('  cloudflared installed.');
        } catch {
          console.log('  WARNING: cloudflared installation failed. You can install it later.');
        }
      } else {
        console.log('  On Linux, install cloudflared manually:');
        console.log('    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared');
        console.log('    chmod +x /usr/local/bin/cloudflared');
      }
    } else {
      console.log('  Skipped. You can install cloudflared later before starting live mode.');
    }
  }

  // ── 6. Write config.json ──
  const config = {
    mode: 'live',
    twilio: {
      accountSid: sid,
      authToken: token,
      phoneNumber: twilioPhone,
    },
    claude: {
      provider,
    },
    developer: {
      phoneNumber: devPhone,
    },
  };

  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  await writeFile(STATE_PATH, JSON.stringify({ mobile: false }));

  console.log('\n  Configuration saved.');

  // ── 6b. Submit toll-free verification for SMS ──
  if (provisionedPhoneSid) {
    const contactName = (await ask('\n  Your name (for toll-free verification): ')).trim() || 'Developer';
    await submitTollFreeVerification(sid, token, provisionedPhoneSid, {
      businessName: contactName,
      contactName,
      contactEmail: (await ask('  Email for verification notifications: ')).trim(),
      contactPhone: devPhone,
    });
  }

  console.log('');

  // ── 7. Test call ──
  const testCall = (await ask('  Place a test call to verify everything works? [Y/n]: ')).trim().toLowerCase();

  if (testCall !== 'n') {
    const success = await placeTestCall(sid, token, twilioPhone, devPhone);
    if (success) {
      console.log('\n  Setup complete! Run /agent-phone:going-mobile in Claude Code.');
    } else {
      console.log('\n  Setup saved but test call failed. Check your Twilio config.');
      console.log('  Common issues:');
      console.log('    - Developer number not verified (trial accounts)');
      console.log('    - Twilio number not voice-capable');
    }
  } else {
    console.log('\n  Setup complete! Run /agent-phone:going-mobile in Claude Code.');
  }

  console.log(`  Claude will call ${devPhone} when it gets stuck.\n`);
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
