/**
 * Mail client settings handed to new users. The host comes from the server at
 * runtime (/api/me → mailHost, from MAIL_HOSTNAME); VITE_MAIL_HOST is the
 * build-time fallback. Everything else reads from here.
 */
export const MAIL_HOST: string = (import.meta.env?.VITE_MAIL_HOST as string | undefined) || 'mail.example.com';

export const MAIL_CLIENT_SETTINGS = {
  imap: { host: MAIL_HOST, port: 993, security: 'SSL/TLS' },
  smtp: { host: MAIL_HOST, port: 465, security: 'SSL/TLS' },
};

/** Apply the server's mail hostname (called once /api/me answers). */
export function setMailHost(host: string | null | undefined) {
  if (!host || !/^[a-z0-9.-]+$/i.test(host)) return;
  MAIL_CLIENT_SETTINGS.imap.host = host;
  MAIL_CLIENT_SETTINGS.smtp.host = host;
}

/** Plain-text sign-in details to paste into a message to the new user. */
export function loginDetailsText(opts: { webmailUrl: string; email: string; password: string; settings?: typeof MAIL_CLIENT_SETTINGS }): string {
  const s = opts.settings ?? MAIL_CLIENT_SETTINGS;
  return [
    `Webmail: ${opts.webmailUrl}`,
    `Email: ${opts.email}`,
    `Password: ${opts.password}`,
    '',
    'Mail apps (Apple Mail, Outlook, Thunderbird, phones):',
    `IMAP: ${s.imap.host}:${s.imap.port} (${s.imap.security})`,
    `SMTP: ${s.smtp.host}:${s.smtp.port} (${s.smtp.security})`,
    `Username: ${opts.email}`,
  ].join('\n');
}
