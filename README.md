# Connecto

Asks "What are you doing right now?", matches you in real time with people doing
something similar, and drops you both into a video room when a request is accepted.

## Run

```bash
npm install
npm start          # http://localhost:3000
npm test           # matcher + end-to-end socket flow
```

To try it alone, open two browser windows (one normal, one incognito), create two
accounts, and enter similar activities.

## Production

Live at **https://connecto.clientchase.com** on the Hostinger VPS (`ssh connecto-vps`).

- **Deploy:** `./deploy.sh` runs the tests, syncs code to `/docker/connecto`, rebuilds and restarts
  the container, and waits for its health check.
- **HTTPS:** the existing Traefik (`/docker/traefik`) routes the domain via the labels in
  `compose.yaml` and renews the Let's Encrypt certificate automatically.
- **Data:** SQLite on the Docker volume `connecto_connecto_data` (`/data` in the container).
  Daily backup at 03:15 server time (`/etc/cron.d/connecto-backup`) into `/data/backups`,
  keeping 14. Restore: stop the container, copy a backup over `/data/connecto.db`, start it.
- **Logs:** `ssh connecto-vps docker logs -f connecto-connecto-1`
- **TURN relay:** coturn (`turn` service in `compose.yaml`, config in `deploy/turnserver.conf`)
  on UDP/TCP 3478 plus relay ports 49160–49999/udp, and `turns:` on 443 via Traefik for
  `turn.clientchase.com`. The app hands each user 12-hour credentials when a room opens
  (`turn.js`), signed with `TURN_SECRET`.
- **Email:** verification and password-reset links. Set `SMTP_URL` (and `MAIL_FROM`) in
  `/docker/connecto/.env`; without it, emails are printed to the container log.
- **Secrets:** `/docker/connecto/.env` on the server only (`TURN_SECRET`, `SMTP_URL`, `MAIL_FROM`).
- **Firewall:** ufw allows 22, 80, 443, 3478 tcp/udp and 49160–49999/udp. Ports published by
  Docker bypass ufw.

## How it works

| Piece | File | Notes |
|---|---|---|
| Accounts | `auth.js`, `db.js` | Sign up / sign in / log out. SQLite (built into Node) at `data/connecto.db`. Passwords hashed with scrypt; 30-day HttpOnly session cookies, stored hashed. Sign-ups require 18+. |
| Server | `server.js` | Express + Socket.IO. Holds online users, requests and rooms in memory. |
| Matching | `matcher.js` | Scores prompts 0–100% by activity category (e.g. "gym" ≈ "workout"), shared keywords, and typo-tolerant trigrams. The top 12 are pushed live whenever anyone joins, leaves or changes activity. |
| Client | `public/` | Plain HTML/CSS/JS, no build step. |
| Meeting room | `public/app.js` | WebRTC peer-to-peer video/audio (the server only relays signaling), plus text chat. |

Flow: sign up (first/last name, email, password, date of birth, optional gender and photo,
18+ and guidelines checkbox) or sign in → activity prompt → live match grid → click a card to
send a request → the other person accepts → both enter a room. Leaving puts you back in the
match list. Other users only see your first name and last initial, never your email, surname or
birth date.

Accounts API (JSON): `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`,
`GET /api/auth/me`, `PATCH /api/auth/me` (profile photo), `POST /api/auth/verify-email`,
`POST /api/auth/resend-verification`, `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`.

New accounts must confirm their email (24-hour link) before they can match. Password-reset links
last 1 hour, are single use, and sign the account out everywhere. Locally, emails are printed in
the terminal running `npm start`.

## Before going to production

- **HTTPS is required** for camera/mic anywhere except `localhost`.
- **Accounts**: move
  from SQLite to Postgres when you run more than one server; use the Socket.IO Redis adapter for
  realtime state. Set `NODE_ENV=production` (Secure cookies) and `TRUST_PROXY=1` behind a proxy.
- **Smarter matching**: swap `score()` in `matcher.js` for sentence embeddings if you want
  semantic matching beyond the built-in category list.
- **Safety**: add reporting/blocking before opening video chat to strangers.
