#!/usr/bin/env node
// Health check script — queries /status and prints a summary

const url = `http://localhost:${process.env.PORT || 3000}/status`;

try {
  const resp = await fetch(url);
  const s = await resp.json();

  console.log(`Server:   ${s.status}`);
  console.log(`Uptime:   ${s.uptime}s`);
  console.log(`Mode:     ${s.mode}`);
  console.log(`Provider: ${s.provider}`);
  console.log(`Twilio:   ${s.hasTwilioCreds ? 'configured' : 'missing'}`);
  console.log(`Phone:    ${s.hasPhoneNumbers ? 'configured' : 'missing'}`);
  console.log(`Tunnel:   ${s.tunnelUrl || 'none'}`);
  console.log(`Sessions: ${s.activeSessions} active, ${s.completedSessions} completed`);
} catch {
  console.log('Server not running');
  process.exit(1);
}
