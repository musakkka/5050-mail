import { ApiError, del, get, patch, post, qs, request } from './http';
import type {
  ApiKey,
  ApiLog,
  Automation,
  AutomationConnection,
  AutomationStep,
  Broadcast,
  Contact,
  ContactProperty,
  CreatedApiKey,
  Domain,
  DomainCloudflare,
  Email,
  EmailEvent,
  EmailListItem,
  EmailStatus,
  EventDefinition,
  Inbox,
  IntegrationSnippet,
  List,
  Me,
  Member,
  MetricsResponse,
  OAuthGrant,
  Permission,
  ReceivedEmail,
  Segment,
  SmtpInfo,
  Suppression,
  SystemInfo,
  Team,
  Template,
  Topic,
  Usage,
  Webhook,
  WebhookAttempt,
  WebhookDelivery,
  WebhookEventType,
} from './types';

/** Resend-compatible API, called as the team through the dashboard proxy. */
const rs = (teamId: string, path: string) => `/teams/${teamId}/resend${path}`;
const it = (teamId: string, path: string) => `/teams/${teamId}${path}`;

export interface Page {
  limit?: number;
  after?: string;
  before?: string;
}

/** Fall back to `fallback` when an internal endpoint is not deployed yet (404/405). */
async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return fallback();
    throw e;
  }
}

// ---------------------------------------------------------------- auth
export const auth = {
  me: () => get<Me>('/me'),
  login: (email: string, password: string) => post<{ email: string; name: string; isAdmin: boolean }>('/login', { email, password }),
  logout: () => post<{ ok: true }>('/logout'),
  system: () => get<SystemInfo>('/system'),
};

// ---------------------------------------------------------------- teams
export const teams = {
  list: () => get<{ data: Team[] }>('/teams'),
  get: (t: string) => get<Team>(`/teams/${t}`),
  create: (b: { name: string; members?: { email: string; role: 'admin' | 'member' }[] }) => post<Team>('/teams', b),
  update: (t: string, b: Partial<Pick<Team, 'name' | 'settings'>>) => patch<Team>(`/teams/${t}`, b),
  members: (t: string) => get<{ data: Member[] }>(it(t, '/members')),
  addMember: (t: string, email: string, role: 'admin' | 'member') => post<Member>(it(t, '/members'), { email, role }),
  setRole: (t: string, email: string, role: 'admin' | 'member') => patch<Member>(it(t, `/members/${encodeURIComponent(email)}`), { role }),
  removeMember: (t: string, email: string) => del<{ deleted: true }>(it(t, `/members/${encodeURIComponent(email)}`)),
  usage: (t: string) => get<Usage>(it(t, '/usage')),
  smtp: (t: string) => get<SmtpInfo>(it(t, '/smtp')),
  integrations: (t: string) => get<{ smtp: SmtpInfo; snippets: IntegrationSnippet[] }>(it(t, '/integrations')),
  grants: (t: string) => get<List<OAuthGrant>>(rs(t, '/oauth/grants')),
  revokeGrant: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/oauth/grants/${id}`)),
};

// ---------------------------------------------------------------- emails
export interface EmailFilters extends Page {
  status?: EmailStatus | '';
  api_key_id?: string;
  q?: string;
  /** ISO start (inclusive). */
  start?: string;
  end?: string;
}

export const emails = {
  /** Internal filtered list (dashboard-needs #1); falls back to the plain Resend list. */
  list: (t: string, f: EmailFilters) =>
    withFallback(
      () => get<List<EmailListItem>>(it(t, `/emails${qs({ ...f })}`)),
      () => get<List<EmailListItem>>(rs(t, `/emails${qs({ limit: f.limit, after: f.after, before: f.before })}`)),
    ),
  get: (t: string, id: string) => get<Email>(rs(t, `/emails/${id}`)),
  events: (t: string, id: string) => get<{ data: EmailEvent[] }>(it(t, `/emails/${id}/events`)),
  raw: (t: string, id: string) => get<{ raw: string }>(it(t, `/emails/${id}/raw`)),
  cancel: (t: string, id: string) => post<{ id: string }>(rs(t, `/emails/${id}/cancel`)),
  reschedule: (t: string, id: string, scheduled_at: string) => patch<{ id: string }>(rs(t, `/emails/${id}`), { scheduled_at }),
  share: (t: string, id: string) => post<{ url: string }>(rs(t, `/emails/${id}/share`), {}),
  send: (t: string, b: { from: string; to: string[]; subject: string; html?: string; text?: string }) => post<{ id: string }>(rs(t, '/emails'), b),
  receiving: (t: string, p: Page & { q?: string }) => get<List<ReceivedEmail>>(rs(t, `/emails/receiving${qs({ ...p })}`)),
  received: (t: string, id: string) => get<ReceivedEmail>(rs(t, `/emails/receiving/${id}`)),
};

export const suppressions = {
  list: (t: string, p: Page & { q?: string; reason?: string }) => get<List<Suppression>>(rs(t, `/suppressions${qs({ ...p })}`)),
  get: (t: string, id: string) => get<Suppression>(rs(t, `/suppressions/${encodeURIComponent(id)}`)),
  add: (t: string, email: string) => post<Suppression>(rs(t, '/suppressions'), { email }),
  addBatch: (t: string, emails: string[]) => post<{ data: Suppression[] }>(rs(t, '/suppressions/batch/add'), { emails }),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/suppressions/${encodeURIComponent(id)}`)),
};

// ---------------------------------------------------------------- domains
export const domains = {
  list: (t: string) => get<List<Domain>>(rs(t, '/domains')),
  get: (t: string, id: string) => get<Domain>(rs(t, `/domains/${id}`)),
  create: (
    t: string,
    b: { name: string; region?: string; custom_return_path?: string; capabilities?: { sending: string; receiving: string }; tls?: string; open_tracking?: boolean; click_tracking?: boolean },
  ) => post<Domain>(rs(t, '/domains'), b),
  update: (t: string, id: string, b: { open_tracking?: boolean; click_tracking?: boolean; tls?: string; tracking_subdomain?: string | null; capabilities?: { sending?: string; receiving?: string } }) =>
    patch<Domain>(rs(t, `/domains/${id}`), b),
  verify: (t: string, id: string) => post<{ id: string }>(rs(t, `/domains/${id}/verify`)),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/domains/${id}`)),
  cloudflare: (t: string, id: string) => get<DomainCloudflare>(it(t, `/domains/${id}/cloudflare`)),
  /** One-click DNS through Cloudflare (dashboard-needs #6). */
  cloudflareConnect: (t: string, id: string) => post<DomainCloudflare>(it(t, `/domains/${id}/cloudflare`), { action: 'connect' }),
};

// ---------------------------------------------------------------- api keys
export const apiKeys = {
  /** Internal list with permission/domain/token preview (dashboard-needs #3); falls back to the Resend list. */
  list: (t: string) => withFallback(() => get<List<ApiKey>>(it(t, '/api-keys')), () => get<List<ApiKey>>(rs(t, '/api-keys'))),
  create: (t: string, b: { name: string; permission: Permission; domain_id?: string | null }) => post<CreatedApiKey>(rs(t, '/api-keys'), b),
  rename: (t: string, id: string, name: string) => patch<{ id: string }>(rs(t, `/api-keys/${id}`), { name }),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/api-keys/${id}`)),
};

// ---------------------------------------------------------------- webhooks
export const webhooks = {
  list: (t: string) => get<List<Webhook>>(rs(t, '/webhooks')),
  get: (t: string, id: string) => get<Webhook>(rs(t, `/webhooks/${id}`)),
  create: (t: string, b: { endpoint: string; events: WebhookEventType[] }) => post<Webhook>(rs(t, '/webhooks'), b),
  update: (t: string, id: string, b: { endpoint?: string; events?: WebhookEventType[]; status?: 'enabled' | 'disabled' }) => patch<Webhook>(rs(t, `/webhooks/${id}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/webhooks/${id}`)),
  rotateSecret: (t: string, id: string) => post<{ signing_secret: string }>(rs(t, `/webhooks/${id}/signing-secret/rotate`)),
  events: (t: string, id: string, p: Page & { status?: string }) => get<List<WebhookDelivery>>(rs(t, `/webhooks/${id}/events${qs({ ...p })}`)),
  event: (t: string, id: string, eventId: string) => get<WebhookDelivery>(rs(t, `/webhooks/${id}/events/${eventId}`)),
  attempts: (t: string, id: string, eventId: string) => get<{ data: WebhookAttempt[] }>(it(t, `/webhooks/${id}/events/${eventId}/attempts`)),
  replay: (t: string, id: string, eventId: string) => post<{ id: string }>(rs(t, `/webhooks/${id}/events/${eventId}/replay`)),
  health: (t: string, id: string) =>
    get<{ status: string; failing_since: string | null; disabled_reason: string | null; last_7_days: { success: number; failed: number; pending: number } }>(
      it(t, `/webhooks/${id}/health`),
    ),
};

// ---------------------------------------------------------------- logs
export interface LogFilters {
  status?: string;
  method?: string;
  endpoint?: string;
  api_key_id?: string;
  source?: string;
  before?: string;
  limit?: number;
  q?: string;
  start?: string;
  end?: string;
  user_agent?: string;
}
export const logs = {
  /** `total`, `start`, `end` and `user_agent` are dashboard-needs additions (ignored by older servers). */
  list: (t: string, f: LogFilters) => get<{ has_more: boolean; total?: number; data: ApiLog[] }>(it(t, `/logs${qs({ ...f })}`)),
  get: (t: string, id: string) => get<ApiLog>(it(t, `/logs/${id}`)),
};

// ---------------------------------------------------------------- metrics
export const metrics = {
  get: (t: string, p: { days?: number; start_date?: string; end_date?: string; domain_id?: string; granularity?: string; dimensions?: string[] }) =>
    get<MetricsResponse>(it(t, `/metrics${qs({ ...p, dimensions: p.dimensions })}`)),
};

// ---------------------------------------------------------------- audience
export const contacts = {
  list: (t: string, p: Page & { q?: string; segment_id?: string }) =>
    get<List<Contact>>(rs(t, p.segment_id ? `/segments/${p.segment_id}/contacts${qs({ limit: p.limit, after: p.after })}` : `/contacts${qs({ ...p })}`)),
  get: (t: string, id: string) => get<Contact>(rs(t, `/contacts/${encodeURIComponent(id)}`)),
  create: (t: string, b: { email: string; first_name?: string; last_name?: string; unsubscribed?: boolean; segments?: string[]; properties?: Record<string, string> }) =>
    post<{ id: string }>(rs(t, '/contacts'), b),
  update: (t: string, id: string, b: Partial<Contact>) => patch<{ id: string }>(rs(t, `/contacts/${encodeURIComponent(id)}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/contacts/${encodeURIComponent(id)}`)),
  /** CSV import (dashboard-needs #9): rows already parsed client-side. */
  import: (t: string, b: { contacts: { email: string; first_name?: string; last_name?: string; unsubscribed?: boolean }[]; segment_id?: string }) =>
    withFallback(
      () => post<{ id: string; imported: number; skipped: number }>(rs(t, '/contacts/imports'), b),
      async () => {
        let imported = 0;
        let skipped = 0;
        for (const c of b.contacts) {
          try {
            await post(rs(t, '/contacts'), { ...c, segments: b.segment_id ? [b.segment_id] : undefined });
            imported++;
          } catch {
            skipped++;
          }
        }
        return { id: 'local', imported, skipped };
      },
    ),
  segments: (t: string, id: string) => get<List<Segment>>(rs(t, `/contacts/${encodeURIComponent(id)}/segments`)),
};

export const segments = {
  list: (t: string) => get<List<Segment>>(rs(t, '/segments')),
  get: (t: string, id: string) => get<Segment>(rs(t, `/segments/${id}`)),
  create: (t: string, name: string) => post<Segment>(rs(t, '/segments'), { name }),
  update: (t: string, id: string, name: string) => patch<Segment>(rs(t, `/segments/${id}`), { name }),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/segments/${id}`)),
};

export const topics = {
  list: (t: string) => get<List<Topic>>(rs(t, '/topics')),
  create: (t: string, b: { name: string; description?: string; default_subscription: 'opt_in' | 'opt_out'; visibility?: 'public' | 'private' }) => post<Topic>(rs(t, '/topics'), b),
  update: (t: string, id: string, b: Partial<Topic>) => patch<Topic>(rs(t, `/topics/${id}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/topics/${id}`)),
};

export const properties = {
  list: (t: string) => get<List<ContactProperty>>(rs(t, '/contact-properties')),
  create: (t: string, b: { key: string; type: 'string' | 'number'; fallback_value?: string | number | null }) => post<ContactProperty>(rs(t, '/contact-properties'), b),
  update: (t: string, id: string, b: { fallback_value?: string | number | null }) => patch<ContactProperty>(rs(t, `/contact-properties/${id}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/contact-properties/${id}`)),
};

// ---------------------------------------------------------------- broadcasts / templates
export const broadcasts = {
  list: (t: string) => get<List<Broadcast>>(rs(t, '/broadcasts')),
  get: (t: string, id: string) => get<Broadcast>(rs(t, `/broadcasts/${id}`)),
  create: (t: string, b: Partial<Broadcast> & { segment_id?: string | null }) => post<{ id: string }>(rs(t, '/broadcasts'), b),
  update: (t: string, id: string, b: Partial<Broadcast>) => patch<{ id: string }>(rs(t, `/broadcasts/${id}`), b),
  send: (t: string, id: string, scheduled_at?: string) => post<{ id: string }>(rs(t, `/broadcasts/${id}/send`), scheduled_at ? { scheduled_at } : {}),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/broadcasts/${id}`)),
};

export const templates = {
  list: (t: string) => get<List<Template>>(rs(t, '/templates?limit=100')),
  get: (t: string, id: string) => get<Template>(rs(t, `/templates/${id}`)),
  create: (t: string, b: Partial<Template>) => post<{ id: string }>(rs(t, '/templates'), b),
  update: (t: string, id: string, b: Partial<Template>) => patch<{ id: string }>(rs(t, `/templates/${id}`), b),
  publish: (t: string, id: string) => post<{ id: string }>(rs(t, `/templates/${id}/publish`)),
  duplicate: (t: string, id: string) => post<{ id: string }>(rs(t, `/templates/${id}/duplicate`)),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/templates/${id}`)),
};

// ---------------------------------------------------------------- automations / events / inboxes
export const automations = {
  list: (t: string, p: Page & { status?: string } = {}) => get<List<Automation>>(rs(t, `/automations${qs({ limit: 100, ...p })}`)),
  get: (t: string, id: string) => get<Automation>(rs(t, `/automations/${id}`)),
  create: (t: string, b: { name: string; status?: 'enabled' | 'disabled'; steps: AutomationStep[]; connections: AutomationConnection[] }) => post<{ id: string }>(rs(t, '/automations'), b),
  update: (t: string, id: string, b: { name?: string; status?: 'enabled' | 'disabled'; steps?: AutomationStep[]; connections?: AutomationConnection[] }) => patch<{ id: string }>(rs(t, `/automations/${id}`), b),
  duplicate: (t: string, id: string) => post<{ id: string }>(rs(t, `/automations/${id}/duplicate`)),
  stop: (t: string, id: string) => post<{ id: string; status: string }>(rs(t, `/automations/${id}/stop`)),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/automations/${id}`)),
};

export const events = {
  list: (t: string) => get<List<EventDefinition>>(rs(t, '/events?limit=100')),
  create: (t: string, b: { name: string; schema?: EventDefinition['schema'] }) => post<{ id: string }>(rs(t, '/events'), b),
  update: (t: string, id: string, b: { schema: EventDefinition['schema'] }) => patch<{ id: string }>(rs(t, `/events/${id}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/events/${id}`)),
};

export const inboxes = {
  list: (t: string) => get<List<Inbox>>(rs(t, '/inboxes?limit=100')),
  get: (t: string, id: string) => get<Inbox>(rs(t, `/inboxes/${encodeURIComponent(id)}`)),
  create: (t: string, b: { email_address: string; name?: string; from_name?: string; forwarding?: boolean }) => post<{ id: string }>(rs(t, '/inboxes'), b),
  update: (t: string, id: string, b: { name?: string; from_name?: string }) => patch<{ id: string }>(rs(t, `/inboxes/${encodeURIComponent(id)}`), b),
  remove: (t: string, id: string) => del<{ deleted: true }>(rs(t, `/inboxes/${encodeURIComponent(id)}`)),
};

export const raw = { request };
