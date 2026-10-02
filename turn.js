const crypto = require('crypto');

// ICE servers handed to each client when a room opens.
//
// TURN uses coturn's "REST API" scheme: credentials are minted here with a secret shared with
// coturn (TURN_SECRET) and expire on their own, so the relay can't be used by anyone who isn't
// currently in a Connecto room.
const TTL_SECONDS = 12 * 60 * 60;
const PUBLIC_STUN = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };

function iceServersFor(accountId) {
  const secret = process.env.TURN_SECRET;
  const host = process.env.TURN_HOST; // IP or hostname for plain TURN on 3478
  if (!secret || !host) return [PUBLIC_STUN];

  const username = `${Math.floor(Date.now() / 1000) + TTL_SECONDS}:${accountId}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  const urls = [
    `stun:${host}:3478`,
    `turn:${host}:3478?transport=udp`,
    `turn:${host}:3478?transport=tcp`,
  ];
  // TURN over TLS on 443 looks like ordinary HTTPS, so it gets through the strictest firewalls.
  if (process.env.TURN_TLS_HOST) urls.push(`turns:${process.env.TURN_TLS_HOST}:443?transport=tcp`);
  return [PUBLIC_STUN, { urls, username, credential }];
}

module.exports = { iceServersFor };
