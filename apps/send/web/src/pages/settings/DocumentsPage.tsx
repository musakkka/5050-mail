import { Button, LinkButton } from '@/components/ui/Button';
import { SUPPORT_EMAIL } from '@/lib/config';
import { downloadText } from '@/lib/csv';
import { useSession } from '@/state/session';
import { SettingsCard, SettingsLayout } from './SettingsLayout';

const SUBPROCESSORS = () => `# 5050 Send sub-processors

| Provider | Purpose | Data |
|---|---|---|
| Your outbound relay, if configured (e.g. Cloudflare Email Service, Amazon SES, Postmark) | Email delivery | Message content and metadata, recipient addresses |
| Your 5050 Send server (self-hosted) | Application servers, database, inbound mail (Stalwart) | Account data, message metadata, logs |

Questions: ${SUPPORT_EMAIL || 'your server administrator'}
`;

const AUP = () => `# 5050 Send acceptable use

You may only send email to people who asked to receive it.

- No purchased, rented or scraped lists.
- Every marketing email needs a working unsubscribe link; transactional email must be expected by the recipient.
- Keep bounce rates under 4% and complaint rates under 0.08%. Teams above these levels may be paused.
- No phishing, malware, deceptive content or impersonation.
- Authenticate your domains (DKIM, SPF and DMARC) before sending.

Report abuse: ${SUPPORT_EMAIL || 'your server administrator'}
`;

/** Documents your team may need. Only documents that exist are offered; the rest are on request. */
export function DocumentsPage() {
  const { team, me } = useSession();
  const request = (doc: string) =>
    `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${doc} request for ${team.name}`)}&body=${encodeURIComponent(`Team: ${team.name} (${team.id})\nRequested by: ${me.email}\n`)}`;
  return (
    <SettingsLayout title="Documents">
      <SettingsCard title="Acceptable use policy" footer={<Button onClick={() => downloadText('5050-send-acceptable-use.md', AUP(), 'text/markdown;charset=utf-8')}>Download</Button>}>
        <p className="text-sm text-default font-normal">
          The rules every team agrees to when sending with 5050 Send: consent, unsubscribe links, bounce and complaint limits.
          <br />
          <br />
          You can download the policy below.
        </p>
      </SettingsCard>
      <SettingsCard title="Sub-processors" footer={<Button onClick={() => downloadText('5050-send-subprocessors.md', SUBPROCESSORS(), 'text/markdown;charset=utf-8')}>Download</Button>}>
        <p className="text-sm text-default font-normal">
          The third parties that process email data on behalf of 5050 Send, and what they do with it.
          <br />
          <br />
          You can download the current list below.
        </p>
      </SettingsCard>
      <SettingsCard title="DPA" footer={<LinkButton href={request('DPA')}>Request</LinkButton>}>
        <p className="text-sm text-default font-normal">
          A Data Processing Agreement (DPA) is a contract that regulates data processing conducted for business purposes.
          <br />
          <br />
          5050 Send does not publish a pre-signed DPA yet. Request one and an administrator will send it to you.
        </p>
      </SettingsCard>
      <SettingsCard title="Security reports" footer={<LinkButton href={request('Security report')}>Request</LinkButton>}>
        <p className="text-sm text-default font-normal">
          5050 Send has no third-party audit report (such as SOC 2) or penetration-test letter to share at this time.
          <br />
          <br />
          For security questionnaires, contact support and we will answer them directly.
        </p>
      </SettingsCard>
    </SettingsLayout>
  );
}
