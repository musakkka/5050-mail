import type { CodeLang } from '@/components/ui/Code';
import { API_BASE } from './config';

export interface SendSample {
  apiKey: string;
  from: string;
  to: string;
  subject: string;
  html: string;
}

export type SdkId = 'node' | 'php' | 'python' | 'ruby' | 'go' | 'rust' | 'elixir' | 'java' | 'dotnet' | 'curl';

export const SDKS: { id: SdkId; label: string; lang: CodeLang }[] = [
  { id: 'node', label: 'Node.js', lang: 'javascript' },
  { id: 'php', label: 'PHP', lang: 'php' },
  { id: 'python', label: 'Python', lang: 'python' },
  { id: 'ruby', label: 'Ruby', lang: 'ruby' },
  { id: 'go', label: 'Go', lang: 'go' },
  { id: 'rust', label: 'Rust', lang: 'rust' },
  { id: 'elixir', label: 'Elixir', lang: 'elixir' },
  { id: 'java', label: 'Java', lang: 'java' },
  { id: 'dotnet', label: '.NET', lang: 'csharp' },
  { id: 'curl', label: 'cURL', lang: 'bash' },
];

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const dq = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * "Send your first email" in each SDK, pointed at 5050 Send's base URL with each
 * SDK's own override (see send/docs/integrations.md).
 */
export function sendSnippet(sdk: SdkId, s: SendSample, base = API_BASE): string {
  switch (sdk) {
    case 'node':
      return `import { Resend } from 'resend';

const resend = new Resend('${q(s.apiKey)}', { baseUrl: '${base}' });

resend.emails.send({
  from: '${q(s.from)}',
  to: '${q(s.to)}',
  subject: '${q(s.subject)}',
  html: '${q(s.html)}'
});`;
    case 'php':
      return `<?php
// Set RESEND_BASE_URL=${base} in your environment
$resend = Resend::client('${q(s.apiKey)}');

$resend->emails->send([
  'from' => '${q(s.from)}',
  'to' => '${q(s.to)}',
  'subject' => '${q(s.subject)}',
  'html' => '${q(s.html)}'
]);`;
    case 'python':
      return `import resend

resend.api_key = "${dq(s.apiKey)}"
resend.api_url = "${base}"

r = resend.Emails.send({
  "from": "${dq(s.from)}",
  "to": "${dq(s.to)}",
  "subject": "${dq(s.subject)}",
  "html": "${dq(s.html)}"
})`;
    case 'ruby':
      return `# Set RESEND_BASE_URL=${base}/ before the gem loads
require "resend"

Resend.api_key = "${dq(s.apiKey)}"

params = {
  "from": "${dq(s.from)}",
  "to": "${dq(s.to)}",
  "subject": "${dq(s.subject)}",
  "html": "${dq(s.html)}"
}

sent = Resend::Emails.send(params)
puts sent`;
    case 'go':
      return `package main

import (
  "net/url"

  "github.com/resend/resend-go/v4"
)

func main() {
  client := resend.NewClient("${dq(s.apiKey)}")
  client.BaseURL, _ = url.Parse("${base}/")

  params := &resend.SendEmailRequest{
    From:    "${dq(s.from)}",
    To:      []string{"${dq(s.to)}"},
    Subject: "${dq(s.subject)}",
    Html:    "${dq(s.html)}",
  }

  sent, err := client.Emails.Send(params)
  _ = sent
  _ = err
}`;
    case 'rust':
      return `use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{Config, Resend, Result};

#[tokio::main]
async fn main() -> Result<()> {
  let resend = Resend::with_config(
    Config::builder("${dq(s.apiKey)}")
      .base_url("${base}".parse().unwrap())
      .build(),
  );

  let from = "${dq(s.from)}";
  let to = ["${dq(s.to)}"];
  let subject = "${dq(s.subject)}";

  let email = CreateEmailBaseOptions::new(from, to, subject)
    .with_html("${dq(s.html)}");

  let _email = resend.emails.send(email).await?;

  Ok(())
}`;
    case 'elixir':
      return `client = Resend.client(api_key: "${dq(s.apiKey)}", base_url: "${base}")

Resend.Emails.send(client, %{
  from: "${dq(s.from)}",
  to: "${dq(s.to)}",
  subject: "${dq(s.subject)}",
  html: "${dq(s.html)}"
})`;
    case 'java':
      return `import com.resend.*;

public class Main {
  public static void main(String[] args) {
    Resend resend = Resend.builder()
        .apiKey("${dq(s.apiKey)}")
        .baseUrl("${base}")
        .build();

    CreateEmailOptions params = CreateEmailOptions.builder()
        .from("${dq(s.from)}")
        .to("${dq(s.to)}")
        .subject("${dq(s.subject)}")
        .html("${dq(s.html)}")
        .build();

    CreateEmailResponse data = resend.emails().send(params);
  }
}`;
    case 'dotnet':
      return `using Resend;

IResend resend = ResendClient.Create(new ResendClientOptions
{
    ApiToken = "${dq(s.apiKey)}",
    ApiUrl = "${base}",
});

var resp = await resend.EmailSendAsync( new EmailMessage()
{
    From = "${dq(s.from)}",
    To = "${dq(s.to)}",
    Subject = "${dq(s.subject)}",
    HtmlBody = "${dq(s.html)}",
} );`;
    case 'curl': {
      const body = JSON.stringify({ from: s.from, to: s.to, subject: s.subject, html: s.html });
      return `curl -X POST '${base}/emails' \\
     -H 'Authorization: Bearer ${s.apiKey}' \\
     -H 'Content-Type: application/json' \\
     -d $'${body.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    }
  }
}

/** Minimal request examples for the API drawer. */
export function endpointSnippet(method: string, path: string, body: unknown | null, sdk: 'curl' | 'node', base = API_BASE): string {
  if (sdk === 'curl') {
    const lines = [`curl -X ${method} '${base}${path}' \\`, `     -H 'Authorization: Bearer re_xxxxxxxxx'${body ? ' \\' : ''}`];
    if (body) {
      lines.push(`     -H 'Content-Type: application/json' \\`);
      lines.push(`     -d $'${JSON.stringify(body, null, 2).replace(/'/g, "\\'").split('\n').join('\n       ')}'`);
    }
    return lines.join('\n');
  }
  return `import { Resend } from 'resend';

const resend = new Resend('re_xxxxxxxxx', { baseUrl: '${base}' });

const res = await fetch('${base}${path}', {
  method: '${method}',
  headers: {
    Authorization: 'Bearer re_xxxxxxxxx',${body ? "\n    'Content-Type': 'application/json'," : ''}
  },${body ? `\n  body: JSON.stringify(${JSON.stringify(body, null, 2).split('\n').join('\n  ')}),` : ''}
});`;
}
