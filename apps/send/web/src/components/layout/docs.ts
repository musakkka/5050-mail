import { DOCS_BASE } from '@/lib/config';

/** Server-provided docs base (GET /system → docsBase) overrides the build-time default. */
let docsBase = DOCS_BASE;
export function setDocsBase(b: string | null | undefined) {
  if (b && /^https?:\/\//.test(b)) docsBase = b;
}

/** Docs section for the current dashboard page (bottom bar "/docs/…" link). */
const MAP: [RegExp, string][] = [
  [/^\/emails\/receiving/, '/receiving/introduction'],
  [/^\/emails\/suppressions/, '/dashboard/emails/suppressions'],
  [/^\/emails/, '/dashboard/emails/introduction'],
  [/^\/templates/, '/dashboard/templates/introduction'],
  [/^\/audience/, '/dashboard/audiences/introduction'],
  [/^\/inboxes/, '/receiving/introduction'],
  [/^\/broadcasts/, '/dashboard/broadcasts/introduction'],
  [/^\/automations/, '/dashboard/automations/introduction'],
  [/^\/metrics/, '/dashboard/emails/deliverability-insights'],
  [/^\/domains/, '/dashboard/domains/introduction'],
  [/^\/logs/, '/dashboard/logs/introduction'],
  [/^\/api-keys/, '/dashboard/api-keys/introduction'],
  [/^\/webhooks/, '/webhooks/introduction'],
  [/^\/settings\/smtp/, '/send-with-smtp'],
  [/^\/settings\/integrations\/mcp/, '/mcp-server'],
  [/^\/settings/, '/dashboard/settings/introduction'],
  [/^\/onboarding/, '/introduction'],
];

export function docsPathFor(pathname: string): string {
  return MAP.find(([re]) => re.test(pathname))?.[1] ?? '/introduction';
}

export function docsUrl(path = '/introduction'): string {
  return docsBase.replace(/\/$/, '') + path;
}
