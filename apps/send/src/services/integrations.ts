/** SMTP relay facts and copy-paste snippets for the dashboard's Integrations / SMTP pages. */
import type { AppContext } from '../context.js';

export function smtpInfo(ctx: AppContext) {
  const c = ctx.config;
  return {
    host: c.smtpHostname,
    username: 'resend',
    password: 'YOUR_API_KEY',
    ports: [
      ...c.smtpPortsTls.map((p) => ({ port: p, security: 'tls' as const, description: 'Implicit TLS (SMTPS)' })),
      ...c.smtpPortsStartTls.map((p) => ({ port: p, security: 'starttls' as const, description: 'STARTTLS' })),
    ],
    max_message_bytes: c.smtpMaxMessageBytes,
    notes: [
      'Use an API key as the password. Sending-access and full-access keys both work; domain-restricted keys can only send from their domain.',
      'Set the Resend-Idempotency-Key header to make retries safe (24 hours).',
      'Custom headers such as X-Entity-Ref-ID and List-Unsubscribe are passed through.',
      'X-Resend-Tags: name=value, name2=value2 adds tags (a 5050 Send extension).',
      'Emails sent over SMTP cannot be scheduled. The API rate limit also applies to SMTP.',
    ],
  };
}

export interface IntegrationSnippet {
  id: string;
  name: string;
  category: 'smtp' | 'sdk' | 'framework' | 'platform';
  docs_url: string;
  language?: string;
  snippet: string;
  notes?: string;
}

/** Links to Resend's own guides: our API and SMTP settings are drop-in replacements. */
const R = (p: string) => `https://resend.com/docs/${p}`;

export function integrationSnippets(ctx: AppContext): IntegrationSnippet[] {
  const c = ctx.config;
  const host = c.smtpHostname;
  const tls = c.smtpPortsTls[0] ?? 465;
  const starttls = c.smtpPortsStartTls.includes(587) ? 587 : (c.smtpPortsStartTls[0] ?? 587);
  const api = c.publicApiBase;
  const smtp = (id: string, name: string, docs: string, snippet: string, language?: string, notes?: string): IntegrationSnippet => ({
    id, name, category: 'smtp', docs_url: docs, ...(language ? { language } : {}), snippet, ...(notes ? { notes } : {}),
  });
  const plat = (id: string, name: string, docs: string, notes?: string): IntegrationSnippet => ({
    id, name, category: 'platform', docs_url: docs,
    snippet: `SMTP host: ${host}\nPort: ${tls} (SSL/TLS) or ${starttls} (STARTTLS)\nUsername: resend\nPassword: YOUR_API_KEY`,
    ...(notes ? { notes } : {}),
  });

  return [
    // ---- SDKs (base URL override; see docs/integrations.md)
    { id: 'node', name: 'Node.js', category: 'sdk', language: 'typescript', docs_url: R('send-with-nodejs'),
      snippet: `// npm install resend\nimport { Resend } from 'resend';\n\n// or set RESEND_BASE_URL=${api}\nconst resend = new Resend('YOUR_API_KEY', { baseUrl: '${api}' });\n\nawait resend.emails.send({\n  from: 'Acme <onboarding@yourdomain.com>',\n  to: ['delivered@resend.dev'],\n  subject: 'Hello world',\n  html: '<p>It works!</p>',\n});` },
    { id: 'python', name: 'Python', category: 'sdk', language: 'python', docs_url: R('send-with-python'),
      snippet: `# pip install resend\nimport resend\n\nresend.api_key = "YOUR_API_KEY"\nresend.api_url = "${api}"  # or RESEND_API_URL=${api}\n\nresend.Emails.send({\n    "from": "Acme <onboarding@yourdomain.com>",\n    "to": ["delivered@resend.dev"],\n    "subject": "Hello world",\n    "html": "<p>It works!</p>",\n})` },
    { id: 'php', name: 'PHP', category: 'sdk', language: 'php', docs_url: R('send-with-php'),
      snippet: `// composer require resend/resend-php\n// RESEND_BASE_URL=${api}  (read by Resend::client())\n$resend = Resend::client('YOUR_API_KEY');\n\n$resend->emails->send([\n  'from' => 'Acme <onboarding@yourdomain.com>',\n  'to' => ['delivered@resend.dev'],\n  'subject' => 'Hello world',\n  'html' => '<p>It works!</p>',\n]);` },
    { id: 'laravel', name: 'Laravel', category: 'framework', language: 'php', docs_url: R('send-with-laravel'),
      snippet: `# .env (resend/resend-laravel uses resend-php underneath)\nRESEND_API_KEY=YOUR_API_KEY\nRESEND_BASE_URL=${api}\nMAIL_MAILER=resend` },
    { id: 'ruby', name: 'Ruby', category: 'sdk', language: 'ruby', docs_url: R('send-with-ruby'),
      snippet: `# gem install resend\n# RESEND_BASE_URL must be set before the gem loads and end with a slash:\n#   RESEND_BASE_URL=${api}/\nrequire "resend"\nResend.api_key = "YOUR_API_KEY"\n\nResend::Emails.send({\n  from: "Acme <onboarding@yourdomain.com>",\n  to: ["delivered@resend.dev"],\n  subject: "Hello world",\n  html: "<p>It works!</p>"\n})` },
    { id: 'go', name: 'Go', category: 'sdk', language: 'go', docs_url: R('send-with-go'),
      snippet: `// go get github.com/resend/resend-go/v4\n// RESEND_BASE_URL=${api}/  (trailing slash), or:\nclient := resend.NewClient("YOUR_API_KEY")\nclient.BaseURL, _ = url.Parse("${api}/")\n\nclient.Emails.Send(&resend.SendEmailRequest{\n  From: "Acme <onboarding@yourdomain.com>",\n  To: []string{"delivered@resend.dev"},\n  Subject: "Hello world",\n  Html: "<p>It works!</p>",\n})` },
    { id: 'rust', name: 'Rust', category: 'sdk', language: 'rust', docs_url: R('send-with-rust'),
      snippet: `// cargo add resend-rs\n// RESEND_BASE_URL=${api}  or:\nlet resend = Resend::with_config(\n    Config::builder("YOUR_API_KEY").base_url("${api}".parse()?).build(),\n);` },
    { id: 'java', name: 'Java', category: 'sdk', language: 'java', docs_url: R('send-with-java'),
      snippet: `// com.resend:resend-java\nResend resend = Resend.builder()\n    .apiKey("YOUR_API_KEY")\n    .baseUrl("${api}")\n    .build();` },
    { id: 'dotnet', name: '.NET', category: 'sdk', language: 'csharp', docs_url: R('send-with-dotnet'),
      snippet: `// dotnet add package Resend\nbuilder.Services.Configure<ResendClientOptions>(o => {\n    o.ApiToken = "YOUR_API_KEY";\n    o.ApiUrl = "${api}";\n});`,
      notes: 'The .NET SDK uses absolute request paths ("/emails"), so the base URL must be a host root (no path prefix).' },
    { id: 'elixir', name: 'Elixir', category: 'sdk', language: 'elixir', docs_url: 'https://github.com/elixir-saas/resend-elixir',
      snippet: `# config/runtime.exs\nconfig :resend, Resend.Client,\n  api_key: "YOUR_API_KEY",\n  base_url: "${api}"` },
    { id: 'curl', name: 'cURL', category: 'sdk', language: 'bash', docs_url: R('api-reference/emails/send-email'),
      snippet: `curl -X POST '${api}/emails' \\\n  -H 'Authorization: Bearer YOUR_API_KEY' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"from":"Acme <onboarding@yourdomain.com>","to":["delivered@resend.dev"],"subject":"Hello world","html":"<p>It works!</p>"}'` },

    // ---- SMTP
    smtp('nodemailer', 'Nodemailer', R('send-with-nodemailer-smtp'),
      `import nodemailer from 'nodemailer';\n\nconst transporter = nodemailer.createTransport({\n  host: '${host}',\n  port: ${tls},\n  secure: true,\n  auth: { user: 'resend', pass: 'YOUR_API_KEY' },\n});\n\nawait transporter.sendMail({\n  from: 'Acme <onboarding@yourdomain.com>',\n  to: 'delivered@resend.dev',\n  subject: 'Hello world',\n  html: '<p>It works!</p>',\n});`, 'javascript'),
    smtp('django', 'Django', R('send-with-django-smtp'),
      `# settings.py\nEMAIL_BACKEND = "django.core.mail.backends.smtp.EmailBackend"\nEMAIL_HOST = "${host}"\nEMAIL_PORT = ${tls}\nEMAIL_USE_SSL = True\nEMAIL_HOST_USER = "resend"\nEMAIL_HOST_PASSWORD = "YOUR_API_KEY"\nDEFAULT_FROM_EMAIL = "Acme <onboarding@yourdomain.com>"`, 'python'),
    smtp('laravel-smtp', 'Laravel (SMTP)', R('send-with-laravel-smtp'),
      `# .env\nMAIL_MAILER=smtp\nMAIL_HOST=${host}\nMAIL_PORT=${tls}\nMAIL_USERNAME=resend\nMAIL_PASSWORD=YOUR_API_KEY\nMAIL_ENCRYPTION=tls\nMAIL_FROM_ADDRESS=onboarding@yourdomain.com\nMAIL_FROM_NAME=Acme`, 'bash', 'For port ' + tls + ' Laravel 10+ uses implicit TLS via the smtps scheme; use MAIL_PORT=' + starttls + ' for STARTTLS.'),
    smtp('rails', 'Rails / ActionMailer', R('send-with-rails-smtp'),
      `# config/environments/production.rb\nconfig.action_mailer.delivery_method = :smtp\nconfig.action_mailer.smtp_settings = {\n  address: "${host}",\n  port: ${tls},\n  user_name: "resend",\n  password: ENV["RESEND_API_KEY"],\n  tls: true,\n  authentication: :plain,\n}`, 'ruby'),
    smtp('spring', 'Spring Boot', 'https://docs.spring.io/spring-boot/reference/io/email.html',
      `# application.properties\nspring.mail.host=${host}\nspring.mail.port=${starttls}\nspring.mail.username=resend\nspring.mail.password=YOUR_API_KEY\nspring.mail.properties.mail.smtp.auth=true\nspring.mail.properties.mail.smtp.starttls.enable=true\nspring.mail.properties.mail.smtp.starttls.required=true`, 'properties'),
    smtp('phpmailer', 'PHPMailer', R('send-with-phpmailer-smtp'),
      `$mail = new PHPMailer\\PHPMailer\\PHPMailer(true);\n$mail->isSMTP();\n$mail->Host = '${host}';\n$mail->SMTPAuth = true;\n$mail->Username = 'resend';\n$mail->Password = 'YOUR_API_KEY';\n$mail->SMTPSecure = PHPMailer\\PHPMailer\\PHPMailer::ENCRYPTION_SMTPS;\n$mail->Port = ${tls};`, 'php'),
    smtp('nextauth', 'NextAuth.js (Email provider)', R('send-with-nextauth-smtp'),
      `EmailProvider({\n  server: {\n    host: '${host}',\n    port: ${tls},\n    auth: { user: 'resend', pass: process.env.RESEND_API_KEY },\n  },\n  from: 'Acme <onboarding@yourdomain.com>',\n})`, 'typescript'),
    smtp('supabase', 'Supabase Auth (custom SMTP)', R('send-with-supabase-smtp'),
      `Project Settings → Authentication → SMTP Settings → Enable custom SMTP\nSender email: onboarding@yourdomain.com\nSender name: Acme\nHost: ${host}\nPort: ${tls}\nUsername: resend\nPassword: YOUR_API_KEY`),
    smtp('wordpress', 'WordPress (WP Mail SMTP)', R('send-with-wordpress-smtp'),
      `WP Mail SMTP → Settings → Mailer: Other SMTP\nSMTP Host: ${host}\nEncryption: SSL\nSMTP Port: ${tls}\nAuthentication: On\nSMTP Username: resend\nSMTP Password: YOUR_API_KEY`),
    smtp('strapi', 'Strapi', 'https://strapi.io/integrations/resend',
      `// config/plugins.js (@strapi/provider-email-nodemailer)\nmodule.exports = ({ env }) => ({\n  email: {\n    config: {\n      provider: 'nodemailer',\n      providerOptions: {\n        host: '${host}',\n        port: ${tls},\n        secure: true,\n        auth: { user: 'resend', pass: env('RESEND_API_KEY') },\n      },\n      settings: { defaultFrom: 'onboarding@yourdomain.com' },\n    },\n  },\n});`, 'javascript'),
    smtp('payload', 'Payload CMS', 'https://payloadcms.com/docs/email/overview',
      `// payload.config.ts (@payloadcms/email-nodemailer)\nemail: nodemailerAdapter({\n  defaultFromAddress: 'onboarding@yourdomain.com',\n  defaultFromName: 'Acme',\n  transportOptions: { host: '${host}', port: ${tls}, secure: true, auth: { user: 'resend', pass: process.env.RESEND_API_KEY } },\n})`, 'typescript'),
    smtp('generic', 'Any SMTP client', R('send-with-smtp'),
      `Host: ${host}\nPorts: ${c.smtpPortsTls.join(', ')} (implicit SSL/TLS), ${c.smtpPortsStartTls.join(', ')} (STARTTLS)\nUsername: resend\nPassword: YOUR_API_KEY`),

    // ---- Platforms with a custom-SMTP setting (Resend lists these as integrations)
    plat('clerk', 'Clerk', 'https://clerk.com/docs/customization/email-sms-templates', 'Clerk Dashboard → Customization → Emails → custom SMTP (Production instances).'),
    plat('auth0', 'Auth0', 'https://auth0.com/docs/customize/email/smtp-email-providers/resend', 'Auth0 → Branding → Email Provider → Use my own email provider → SMTP Provider.'),
    plat('firebase', 'Firebase Authentication', 'https://firebase.google.com/docs/auth', 'Firebase Console → Authentication → Templates → SMTP settings (Identity Platform). Security mode: SSL on port ' + tls + '.'),
    plat('kinde', 'Kinde', 'https://docs.kinde.com/integrate/third-party-tools/kinde-resend-custom-smtp/'),
    plat('appwrite', 'Appwrite', 'https://appwrite.io/docs/products/messaging/resend'),
    plat('customer-io', 'Customer.io', R('send-with-customer-io-smtp')),
    plat('metabase', 'Metabase', R('send-with-metabase-smtp')),
    plat('retool', 'Retool', R('send-with-retool-smtp')),
    plat('liferay', 'Liferay', R('send-with-liferay-smtp')),
    plat('coolify', 'Coolify', 'https://coolify.io/docs/knowledge-base/notifications'),
    plat('gravity-forms', 'Gravity SMTP', 'https://docs.gravitysmtp.com/category/integrations/resend/'),
    plat('post-smtp', 'Post SMTP (WordPress)', 'https://postmansmtp.com/docs/mailers/how-to-setup-resend-with-post-smtp/'),
    plat('pulsetic', 'Pulsetic', 'https://help.pulsetic.com/article/492-setting-up-custom-email-for-status-page'),
    // API-key based integrations: they talk to the Resend API; they work with 5050 Send only if they let you set the API base URL.
    ...[
      ['n8n', 'n8n', 'https://n8n.io/integrations/resend'], ['zapier', 'Zapier', 'https://zapier.com/apps/resend/integrations'],
      ['make', 'Make.com', 'https://www.make.com/en/integrations/resend'], ['pipedream', 'Pipedream', 'https://pipedream.com/apps/resend'],
      ['activepieces', 'Activepieces', 'https://www.activepieces.com/pieces/resend'], ['courier', 'Courier', 'https://www.courier.com/docs/guides/providers/email/resend/'],
      ['novu', 'Novu', 'https://docs.novu.co/platform/integrations/email/resend'], ['knock', 'Knock', 'https://docs.knock.app/integrations/email/resend'],
      ['convex', 'Convex', 'https://www.convex.dev/components/resend'], ['inngest', 'Inngest', 'https://www.inngest.com/docs/guides/resend-webhook-events'],
      ['trigger', 'Trigger.dev', 'https://trigger.dev/docs/guides/examples/resend-email-sequence'], ['medusa', 'Medusa', 'https://docs.medusajs.com/resources/integrations/guides/resend'],
      ['posthog', 'PostHog', 'https://posthog.com/docs/cdp/sources/resend'], ['vercel', 'Vercel / v0', 'https://vercel.com/marketplace/resend'],
      ['lovable', 'Lovable', 'https://docs.lovable.dev/integrations/resend'], ['raycast', 'Raycast', 'https://www.raycast.com/resend/resend'],
    ].map(([id, name, docs]): IntegrationSnippet => ({
      id: id!, name: name!, category: 'platform', docs_url: docs!,
      snippet: `API base URL: ${api}\nAPI key: YOUR_API_KEY`,
      notes: 'Uses the Resend API. Works with 5050 Send only where the integration lets you change the API base URL (or use the SMTP settings instead).',
    })),
  ];
}
