import type { Domain, Email } from '@/api/types';

export interface Insight {
  id: string;
  title: string;
  description: string;
  ok: boolean;
  /** Extra evidence shown under the description. */
  detail?: string;
  code?: string;
  docs?: string;
}

/** Registrable domain (last two labels, or three for common second-level suffixes). */
export function rootDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  const sl = ['co', 'com', 'org', 'net', 'ac', 'gov', 'edu'];
  if (parts.length >= 3 && sl.includes(parts.at(-2)!) && parts.at(-1)!.length === 2) return parts.slice(-3).join('.');
  return parts.slice(-2).join('.');
}

export function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

function hosts(html: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(re)) {
    try {
      const u = new URL(m[1]!);
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(u.hostname.toLowerCase());
    } catch {
      /* relative or invalid */
    }
  }
  return out;
}

function dmarcPolicy(d: Domain | null): Record<string, string> | null {
  const rec = d?.records?.find((r) => r.record === 'DMARC');
  if (!rec) return null;
  const tags: Record<string, string> = {};
  for (const part of rec.value.split(';')) {
    const [k, v] = part.split('=').map((x) => x?.trim());
    if (k && v && k.toLowerCase() !== 'v') tags[k.toLowerCase()] = v;
  }
  return tags;
}

/**
 * Deliverability checks for one email, computed in the browser from the message and
 * its sending domain (the same list and wording as the reference "Insights" tab).
 */
export function computeInsights(e: Email, domain: Domain | null): Insight[] {
  const html = e.html ?? '';
  const addr = addressOf(e.from);
  const sendHost = addr.split('@')[1] ?? '';
  const root = rootDomain(sendHost);
  const linkHosts = hosts(html, /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi);
  const imgHosts = hosts(html, /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi);
  const bytes = new TextEncoder().encode(html).length;
  const dmarc = dmarcPolicy(domain);
  const dmarcOk = !!domain?.records?.some((r) => r.record === 'DMARC' && r.status === 'verified');
  const local = addr.split('@')[0] ?? '';

  return [
    {
      id: 'subdomain',
      title: 'Use a subdomain',
      ok: !!sendHost && sendHost !== root,
      description:
        'Using a subdomain instead of the root domain helps to segment your sending by purpose. This protects different types of sending from impacting the reputation of others and shows clearly sending purpose.',
      docs: '/knowledge-base/is-it-better-to-send-emails-from-a-subdomain-or-the-root-domain',
    },
    {
      id: 'click-tracking',
      title: 'Use custom subdomain for click tracking',
      ok: !domain?.click_tracking || !!domain.tracking_subdomain,
      description:
        "You're using a shared tracking domain for click tracking. Shared tracking domains can hurt deliverability because spam filters may flag links rewritten through shared domains as suspicious. Configure a custom tracking subdomain to keep links on your own domain and improve deliverability.",
      docs: '/dashboard/domains/tracking',
    },
    {
      id: 'open-tracking',
      title: 'Use custom subdomain for open tracking',
      ok: !domain?.open_tracking || !!domain.tracking_subdomain,
      description:
        "You're using a shared tracking domain for open tracking. Spam filters are sensitive to tracking pixels served from shared domains, and may flag them as potential spam. Configure a custom tracking subdomain to serve tracking pixels from your own domain and improve deliverability.",
      docs: '/dashboard/domains/tracking',
    },
    {
      id: 'link-match',
      title: 'Ensure link URLs match sending domain',
      ok: linkHosts.every((h) => rootDomain(h) === root),
      detail: linkHosts.filter((h) => rootDomain(h) !== root).length ? `Other domains: ${[...new Set(linkHosts.filter((h) => rootDomain(h) !== root))].slice(0, 5).join(', ')}` : undefined,
      description: 'Ensure that the URLs in your email match the sending domain. Mismatched URLs can trigger spam filters.',
      docs: '/knowledge-base/what-if-my-links-dont-match-my-sending-domain',
    },
    {
      id: 'dmarc',
      title: 'Include valid DMARC record',
      ok: dmarcOk,
      code: dmarc ? JSON.stringify(dmarc, null, 2) : undefined,
      description:
        "A DMARC record is a TXT record published in the DNS that specifies how email receivers should handle messages from your domain that don't pass SPF or DKIM validation. A valid DMARC record is required for large senders by Google, Yahoo, and Microsoft.",
      docs: '/dashboard/domains/dmarc',
    },
    {
      id: 'plain-text',
      title: 'Include plain text version',
      ok: !!e.text?.trim(),
      description:
        'Including a plain text version of your email ensures that your message is accessible to all recipients, including those who have email clients that do not support HTML.',
      docs: '/api-reference/emails/send-email',
    },
    {
      id: 'size',
      title: 'Keep email body size small',
      ok: bytes < 102 * 1024,
      detail: `HTML size: ${Math.round(bytes / 1024)}KB`,
      description:
        'Gmail has a size limit of 102KB for each email message. Once that limit is reached, the remaining content is clipped and becomes hidden behind a link to view the entire message. Keep your email body size small to avoid this issue.',
      docs: '/knowledge-base/what-is-gmail-clipping',
    },
    {
      id: 'no-reply',
      title: 'Don\'t use "no-reply"',
      ok: !/no-?reply|do-?not-?reply/i.test(local),
      detail: `From: ${e.from}`,
      description: 'Indicating that this is a one-way communication decreases trust to the inbox that they can provide feedback on your emails (like reporting spam).',
      docs: '/knowledge-base/should-i-use-no-reply',
    },
    {
      id: 'images-host',
      title: 'Host images on the sending domain',
      ok: imgHosts.every((h) => rootDomain(h) === root),
      detail: imgHosts.filter((h) => rootDomain(h) !== root).length ? `Other hosts: ${[...new Set(imgHosts.filter((h) => rootDomain(h) !== root))].slice(0, 5).join(', ')}` : undefined,
      description: "Image URLs that don't align with your sending domain may look suspicious to some receivers, particularly Gmail. Use your sending domain or a subdomain to host all images.",
    },
    {
      id: 'svg',
      title: 'Avoid SVG images',
      ok: !/<svg\b|<img\b[^>]*\bsrc\s*=\s*["'][^"']+\.svg(\?[^"']*)?["']/i.test(html),
      description: 'SVG images are not supported by Gmail. Consider using PNG or JPG images instead.',
    },
    {
      id: 'youtube',
      title: 'Use full YouTube URLs',
      ok: !/youtu\.be\//i.test(html),
      description:
        "Gmail's spam filters are flagging emails containing shortened YouTube links (youtu.be) as potential phishing attempts. Use full YouTube URLs instead (youtube.com/watch?v=...).",
      docs: '/knowledge-base/why-are-my-emails-with-youtube-links-going-to-spam',
    },
  ];
}
