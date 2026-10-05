const nodemailer = require('nodemailer');

// Transport is picked from the environment:
//   SMTP_URL=smtps://user:pass@smtp.example.com:465   -> real email (any SMTP provider)
//   MAIL_TRANSPORT=memory                            -> kept in `outbox` (tests)
//   neither                                          -> printed to the server log (local dev)
const FROM = process.env.MAIL_FROM || 'Connecto <no-reply@localhost>';
const outbox = [];
const transport = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;
const mode = transport ? 'smtp' : process.env.MAIL_TRANSPORT === 'memory' ? 'memory' : 'console';

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function layout({ heading, intro, buttonText, url, outro }) {
  const html = `<!doctype html><html><body style="margin:0;background:#fbf7f2;font-family:Helvetica,Arial,sans-serif;color:#1d1a24">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #e8e0d6;border-radius:20px" cellpadding="0" cellspacing="0">
      <tr><td style="padding:32px">
        <p style="margin:0 0 20px;font-size:22px;font-weight:800">Connecto</p>
        <h1 style="margin:0 0 12px;font-size:20px">${escape(heading)}</h1>
        <p style="margin:0 0 24px;line-height:1.5;color:#4a4553">${escape(intro)}</p>
        <a href="${escape(url)}" style="display:inline-block;background:#ff6b4a;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:999px">${escape(buttonText)}</a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6d6778">${escape(outro)}</p>
        <p style="margin:16px 0 0;font-size:12px;color:#9a94a5;word-break:break-all">${escape(url)}</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = `${heading}\n\n${intro}\n\n${buttonText}: ${url}\n\n${outro}\n`;
  return { html, text };
}

// "altug@gmail.com" -> "al***@gmail.com": enough to tell sends apart in logs without storing addresses.
const mask = (addr) => String(addr).split(',').map((a) => a.trim().replace(/^(.{0,2}).*@/, '$1***@')).join(', ');

async function send({ to, subject, html, text }) {
  if (mode === 'smtp') {
    const info = await transport.sendMail({ from: FROM, to, subject, html, text });
    console.log(`[mail] sent "${subject}" to ${mask(to)} (${info.response})`);
    return info;
  }
  if (mode === 'memory') return outbox.push({ to, subject, html, text });
  console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}`);
}

function sendVerificationEmail(user, url) {
  return send({
    to: user.email,
    subject: 'Confirm your email for Connecto',
    ...layout({
      heading: `Welcome, ${user.first_name}!`,
      intro: 'Confirm your email address to start matching with people doing the same thing as you.',
      buttonText: 'Confirm email',
      url,
      outro: "This link expires in 24 hours. If you didn't create a Connecto account, you can ignore this email.",
    }),
  });
}

function sendPasswordResetEmail(user, url) {
  return send({
    to: user.email,
    subject: 'Reset your Connecto password',
    ...layout({
      heading: 'Reset your password',
      intro: `Hi ${user.first_name}, we received a request to reset your password. Choose a new one with the button below.`,
      buttonText: 'Choose a new password',
      url,
      outro: "This link expires in 1 hour and can only be used once. If you didn't ask for this, ignore this email; your password won't change.",
    }),
  });
}

function sendAdminReportEmail(to, { reportedName, reportedEmail, reason, details, reporters, autoSuspended }) {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const status = autoSuspended
    ? `The account was suspended automatically (${reporters} different people reported it within 24 hours). Review it to confirm or lift the suspension.`
    : `${reporters} ${reporters === 1 ? 'person has' : 'people have'} reported this account.`;
  return send({
    to: to.join(', '),
    subject: `${autoSuspended ? '[Auto-suspended] ' : ''}New report: ${reportedName}`,
    ...layout({
      heading: `New report: ${reason}`,
      intro: `${reportedName} (${reportedEmail}) was reported.${details ? ` Details: “${details}”` : ''} ${status}`,
      buttonText: 'Review reports',
      url: `${appUrl}/admin.html`,
      outro: 'You get this email because your address is listed in ADMIN_EMAILS.',
    }),
  });
}

// Background search: someone wants to connect / accepted / is looking for the same thing.
// A time in the recipient's own time zone, e.g. "Tue, Oct 7, 7:00 PM".
function localTime(user, ms) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: user.timezone || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: user.timezone ? undefined : 'short' }).format(new Date(ms));
  } catch {
    return new Date(ms).toUTCString();
  }
}

function sendConnectNotice(user, { kind, name, activity, at }) {
  const appUrl = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
  const when = at ? localTime(user, at) : '';
  const copy = {
    message: [`${name} sent you a message`, `${name} sent you a message on Connecto. Open Connects to read it and reply.`],
    proposed: [`${name} suggested times to meet`, `${name} proposed some times to talk. Open Connecto and pick the one that works for you.`],
    scheduled: [`Meeting with ${name} set for ${when}`, `${name} picked ${when}. We'll remind you shortly before. Open Connecto at that time and tap Join.`],
    reminder: [`Your meeting with ${name} starts soon`, `You're meeting ${name} at ${when}. Open Connecto and tap Join under Connects.`],
    request: [`${name} wants to connect`, `${name} would like to do “${activity}” with you. Open Connecto to accept or decline.`],
    accepted: [`${name} accepted your request`, `${name} wants to connect too. Open Connecto and call them when you’re both online.`],
    match: ['Someone is looking for the same thing', `${name} is also looking for “${activity}”. Open Connecto to send them a request.`],
  }[kind];
  return send({
    to: user.email,
    subject: copy[0],
    ...layout({
      heading: copy[0],
      intro: `Hi ${user.first_name}! ${copy[1]}`,
      buttonText: 'Open Connecto',
      url: kind === 'match' ? `${appUrl}/#background` : `${appUrl}/#connects`,
      outro: 'You get these because you started a background search. We send at most one every few hours. Turn them off under “Search in the background” in Connecto.',
    }),
  });
}

module.exports = { sendVerificationEmail, sendPasswordResetEmail, sendAdminReportEmail, sendConnectNotice, outbox, mode };
