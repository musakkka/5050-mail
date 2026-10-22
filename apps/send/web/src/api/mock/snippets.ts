import type { IntegrationSnippet } from '../types';

const host = 'smtp.example.com';
const smtpBlock = `SMTP host: ${host}\nPort: 465 (SSL/TLS) or 587 (STARTTLS)\nUsername: resend\nPassword: YOUR_API_KEY`;

/** Same shape as GET /api/internal/teams/:id/integrations → snippets (subset for the mock). */
export const MOCK_SNIPPETS: IntegrationSnippet[] = [
  { id: 'node', name: 'Node.js', category: 'sdk', language: 'typescript', docs_url: 'https://www.npmjs.com/package/resend', snippet: `// npm install resend\nimport { Resend } from 'resend';\n\nconst resend = new Resend('YOUR_API_KEY', { baseUrl: 'https://api.example.com' });` },
  { id: 'python', name: 'Python', category: 'sdk', language: 'python', docs_url: 'https://pypi.org/project/resend/', snippet: `# pip install resend\nimport resend\n\nresend.api_key = "YOUR_API_KEY"\nresend.api_url = "https://api.example.com"` },
  { id: 'curl', name: 'cURL', category: 'sdk', language: 'bash', docs_url: 'https://api.example.com/docs', snippet: `curl -X POST 'https://api.example.com/emails' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"from":"Acme <onboarding@yourdomain.com>","to":["delivered@example.com"],"subject":"Hello world","html":"<p>It works!</p>"}'` },
  { id: 'nodemailer', name: 'Nodemailer', category: 'smtp', docs_url: 'https://nodemailer.com/smtp/', language: 'javascript', snippet: `const transporter = nodemailer.createTransport({\n  host: '${host}',\n  port: 465,\n  secure: true,\n  auth: { user: 'resend', pass: 'YOUR_API_KEY' },\n});` },
  { id: 'django', name: 'Django', category: 'smtp', docs_url: 'https://docs.djangoproject.com/en/stable/topics/email/', language: 'python', snippet: `EMAIL_HOST = "${host}"\nEMAIL_PORT = 587\nEMAIL_USE_TLS = True\nEMAIL_HOST_USER = "resend"\nEMAIL_HOST_PASSWORD = "YOUR_API_KEY"` },
  { id: 'laravel', name: 'Laravel', category: 'framework', docs_url: 'https://laravel.com/docs/mail', language: 'bash', snippet: `RESEND_API_KEY=YOUR_API_KEY\nRESEND_BASE_URL=https://api.example.com\nMAIL_MAILER=resend` },
  { id: 'rails', name: 'Rails', category: 'smtp', docs_url: 'https://guides.rubyonrails.org/action_mailer_basics.html', language: 'ruby', snippet: `config.action_mailer.smtp_settings = {\n  address: "${host}", port: 465, user_name: "resend",\n  password: ENV["SEND_API_KEY"], tls: true\n}` },
  { id: 'supabase', name: 'Supabase Auth', category: 'platform', docs_url: 'https://supabase.com/docs/guides/auth/auth-smtp', snippet: smtpBlock },
  { id: 'clerk', name: 'Clerk', category: 'platform', docs_url: 'https://clerk.com/docs', snippet: smtpBlock },
  { id: 'auth0', name: 'Auth0', category: 'platform', docs_url: 'https://auth0.com/docs/customize/email/smtp-email-providers', snippet: smtpBlock },
  { id: 'wordpress', name: 'WordPress', category: 'platform', docs_url: 'https://wordpress.org/plugins/wp-mail-smtp/', snippet: smtpBlock },
];
