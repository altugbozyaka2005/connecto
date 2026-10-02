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

async function send({ to, subject, html, text }) {
  if (mode === 'smtp') return transport.sendMail({ from: FROM, to, subject, html, text });
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

module.exports = { sendVerificationEmail, sendPasswordResetEmail, outbox, mode };
