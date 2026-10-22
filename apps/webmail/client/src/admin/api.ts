/**
 * Admin data layer: Stalwart's management API (`x:<Object>/get|set|query`,
 * capability urn:stalwart:jmap) over the same JmapClient and BFF proxy the
 * mail UI uses. Authorization is entirely Stalwart's: a non-admin session gets
 * `forbidden` method errors.
 */
import { CallHandle, JmapClient, JmapMethodError } from '../jmap/client';
import { CAP, type GetResponse, type Id, type QueryResponse, type SetResponse } from '../jmap/types';
import { aliasMap, buildDomainCreate, describeSetError, matchesSearch, withSuspension, type DomainForm, type SetErrorLike } from './model';
import {
  DOMAIN_TASK_TYPES,
  type AcmeProvider,
  type Account,
  type Certificate,
  type DkimSignature,
  type DnsServer,
  type Domain,
  type DomainTask,
  type EmailAlias,
  type MailingList,
  type MtaOutboundStrategy,
  type MtaRoute,
  type UserRole,
} from './types';

/** A rejected x:<Object>/set create/update/destroy. */
export class AdminSetError extends Error {
  constructor(
    public readonly detail: SetErrorLike,
    public readonly object: string,
  ) {
    super(describeSetError(detail));
    this.name = 'AdminSetError';
  }
  get type() {
    return this.detail.type;
  }
}

/** Human-readable message for anything the admin API can throw. */
export function adminErrorMessage(e: unknown): string {
  if (e instanceof AdminSetError) return e.message;
  if (e instanceof JmapMethodError) {
    if (e.type === 'forbidden') return "You don't have permission to do that.";
    return e.description ?? e.type;
  }
  return (e as Error)?.message ?? String(e);
}

export const ACCOUNT_LIST_PROPS = [
  'name',
  'domainId',
  'description',
  'emailAddress',
  'aliases',
  'roles',
  'permissions',
  'quotas',
  'usedDiskQuota',
  'createdAt',
];
const DOMAIN_LIST_PROPS = ['name', 'description', 'isEnabled', 'createdAt', 'aliases', 'certificateManagement', 'dkimManagement', 'dnsManagement'];

export interface AccountPage {
  items: Account[];
  total: number;
}

export interface DomainStatus {
  signatures: DkimSignature[];
  certificates: Certificate[];
  tasks: DomainTask[];
}

export interface Overview {
  domains: number;
  users: number;
  groups: number;
  lists: number;
  routes: MtaRoute[];
  strategy: MtaOutboundStrategy | null;
  /** null when the queue isn't readable. */
  queued: number | null;
  /** DNS/DKIM/ACME tasks that are retrying or failed. */
  problems: DomainTask[];
}

export interface NewUser {
  name: string;
  domainId: Id;
  description: string;
  password: string;
  role: UserRole;
  quotaBytes: number | null;
  aliases?: EmailAlias[];
}

type QueryArgs = {
  filter?: Record<string, unknown>;
  sort?: { property: string; isAscending?: boolean }[];
  position?: number;
  limit?: number;
  calculateTotal?: boolean;
};

export class AdminApi {
  constructor(private client: JmapClient) {}

  get accountId(): Id {
    return this.client.accountIdFor(CAP.stalwart);
  }

  // ---------------------------------------------------------------- plumbing
  private async one<R>(method: string, args: Record<string, unknown>): Promise<R> {
    const b = this.client.batch();
    const h = b.call<R>(method, args);
    return (await b.send()).get(h);
  }

  private async query(object: string, args: QueryArgs = {}): Promise<QueryResponse> {
    return this.one<QueryResponse>(`x:${object}/query`, args);
  }

  private async get<T>(object: string, ids: Id[] | null, properties?: string[]): Promise<T[]> {
    if (ids && !ids.length) return [];
    const max = this.client.session?.capabilities[CAP.core]?.maxObjectsInGet ?? 500;
    if (!ids || ids.length <= max) return (await this.one<GetResponse<T>>(`x:${object}/get`, { ids, ...(properties ? { properties } : {}) })).list;
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += max) out.push(...(await this.get<T>(object, ids.slice(i, i + max), properties)));
    return out;
  }

  /** query + get in one round trip (back-reference), keeping the query's order. */
  private async queryGet<T extends { id: Id }>(object: string, args: QueryArgs, properties?: string[]): Promise<{ list: T[]; total?: number }> {
    const b = this.client.batch();
    const q = b.call<QueryResponse>(`x:${object}/query`, args);
    const g = b.call<GetResponse<T>>(`x:${object}/get`, { '#ids': q.ref('/ids'), ...(properties ? { properties } : {}) });
    const r = await b.send();
    const ids = r.get(q);
    const byId = new Map(r.get(g).list.map((x) => [x.id, x]));
    return { list: ids.ids.map((id) => byId.get(id)).filter((x): x is T => !!x), total: ids.total };
  }

  private async set(object: string, args: Record<string, unknown>): Promise<SetResponse<{ id: Id }>> {
    return this.one<SetResponse<{ id: Id }>>(`x:${object}/set`, args);
  }

  private async create(object: string, value: Record<string, unknown>): Promise<Id> {
    const r = await this.set(object, { create: { new: value } });
    const err = r.notCreated?.new;
    if (err) throw new AdminSetError(err as SetErrorLike, object);
    const id = r.created?.new?.id;
    if (!id) throw new AdminSetError({ type: 'serverFail', description: 'The server did not return an id' }, object);
    return id;
  }

  private async update(object: string, id: Id, patch: Record<string, unknown>): Promise<void> {
    const r = await this.set(object, { update: { [id]: patch } });
    const err = r.notUpdated?.[id];
    if (err) throw new AdminSetError(err as SetErrorLike, object);
  }

  private async destroy(object: string, ids: Id[]): Promise<void> {
    if (!ids.length) return;
    const r = await this.set(object, { destroy: ids });
    const failed = Object.entries(r.notDestroyed ?? {})[0];
    if (failed) throw new AdminSetError(failed[1] as SetErrorLike, object);
  }

  // ---------------------------------------------------------------- domains
  async listDomains(): Promise<Domain[]> {
    const { list } = await this.queryGet<Domain>('Domain', {}, DOMAIN_LIST_PROPS);
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getDomain(id: Id): Promise<Domain | null> {
    return (await this.get<Domain>('Domain', [id]))[0] ?? null;
  }

  /** DNS providers and ACME providers that new domains can be wired to. */
  async automationOptions(): Promise<{ dnsServers: DnsServer[]; acmeProviders: AcmeProvider[] }> {
    const b = this.client.batch();
    const d = b.call<GetResponse<DnsServer>>('x:DnsServer/get', { ids: null, properties: ['description'] });
    const a = b.call<GetResponse<AcmeProvider>>('x:AcmeProvider/get', { ids: null, properties: ['directory', 'challengeType', 'contact', 'description'] });
    const r = await b.send();
    const safe = <T>(h: CallHandle<GetResponse<T>>): T[] => {
      try {
        return r.get(h).list;
      } catch {
        return [];
      }
    };
    return { dnsServers: safe(d), acmeProviders: safe(a) };
  }

  async createDomain(form: DomainForm): Promise<Id> {
    return this.create('Domain', buildDomainCreate(form));
  }

  async updateDomain(id: Id, patch: Partial<Omit<Domain, 'id'>>): Promise<void> {
    return this.update('Domain', id, patch as Record<string, unknown>);
  }

  /**
   * Remove a domain. Its automatically-created DKIM keys are removed with it;
   * anything else still using it (accounts, lists, aliases) blocks removal.
   */
  async removeDomain(id: Id): Promise<void> {
    try {
      await this.destroy('Domain', [id]);
    } catch (e) {
      if (!(e instanceof AdminSetError) || e.type !== 'objectIsLinked') throw e;
      const linked = e.detail.linkedObjects ?? [];
      const blockers = linked.filter((l) => l.object !== 'DkimSignature');
      if (blockers.length) {
        throw new AdminSetError({ type: 'objectIsLinked', linkedObjects: blockers }, 'Domain');
      }
      await this.destroy(
        'DkimSignature',
        linked.map((l) => l.id),
      );
      await this.destroy('Domain', [id]);
    }
  }

  /** DKIM keys, certificates and pending/failed automation tasks for one domain. */
  async domainStatus(domainId: Id): Promise<DomainStatus> {
    const b = this.client.batch();
    const sq = b.call<QueryResponse>('x:DkimSignature/query', { filter: { domainId } });
    const sg = b.call<GetResponse<DkimSignature>>('x:DkimSignature/get', {
      '#ids': sq.ref('/ids'),
      // '@type' (the algorithm) is only returned when asked for explicitly.
      properties: ['@type', 'domainId', 'selector', 'stage', 'createdAt', 'nextTransitionAt'],
    });
    const cg = b.call<GetResponse<Certificate>>('x:Certificate/get', {
      ids: null,
      properties: ['subjectAlternativeNames', 'notValidBefore', 'notValidAfter', 'issuer'],
    });
    const taskHandles = DOMAIN_TASK_TYPES.map((type) => {
      const q = b.call<QueryResponse>('x:Task/query', { filter: { '@type': type } });
      return b.call<GetResponse<DomainTask>>('x:Task/get', { '#ids': q.ref('/ids') });
    });
    const r = await b.send();
    const safe = <T>(h: CallHandle<GetResponse<T>>): T[] => {
      try {
        return r.get(h).list;
      } catch {
        return [];
      }
    };
    return {
      signatures: safe(sg),
      certificates: safe(cg),
      tasks: taskHandles.flatMap((h) => safe(h)).filter((t) => t.domainId === domainId),
    };
  }

  // ---------------------------------------------------------------- accounts
  /**
   * One page of users or groups, sorted by name. Stalwart's `text` filter only
   * matches whole words, so a search term is matched client-side (substring,
   * across name, address, display name and aliases) over the light properties.
   */
  async listAccounts(opts: {
    kind: 'User' | 'Group';
    domainId?: Id;
    search?: string;
    position?: number;
    limit?: number;
    domainsById?: Map<Id, Domain>;
  }): Promise<AccountPage> {
    const filter: Record<string, unknown> = { '@type': opts.kind, ...(opts.domainId ? { domainId: opts.domainId } : {}) };
    const sort = [{ property: 'name', isAscending: true }];
    const position = opts.position ?? 0;
    const limit = opts.limit ?? 50;
    const term = opts.search?.trim();
    if (!term) {
      const { list, total } = await this.queryGet<Account>('Account', { filter, sort, position, limit, calculateTotal: true }, ACCOUNT_LIST_PROPS);
      return { items: list, total: total ?? list.length };
    }
    const { ids } = await this.query('Account', { filter, sort });
    const all = await this.get<Account>('Account', ids, ACCOUNT_LIST_PROPS);
    const byId = new Map(all.map((a) => [a.id, a]));
    const matches = ids.map((id) => byId.get(id)).filter((a): a is Account => !!a && matchesSearch(a, term, opts.domainsById));
    return { items: matches.slice(position, position + limit), total: matches.length };
  }

  async getAccount(id: Id): Promise<Account | null> {
    return (await this.get<Account>('Account', [id]))[0] ?? null;
  }

  async getAccounts(ids: Id[], properties = ACCOUNT_LIST_PROPS): Promise<Account[]> {
    return this.get<Account>('Account', ids, properties);
  }

  async createUser(u: NewUser): Promise<Id> {
    return this.create('Account', {
      '@type': 'User',
      name: u.name.trim().toLowerCase(),
      domainId: u.domainId,
      description: u.description.trim() || null,
      credentials: { '0': { '@type': 'Password', secret: u.password } },
      roles: { '@type': u.role },
      quotas: u.quotaBytes ? { maxDiskQuota: u.quotaBytes } : {},
      ...(u.aliases?.length ? { aliases: aliasMap(u.aliases) } : {}),
    });
  }

  async updateAccount(id: Id, patch: Record<string, unknown>): Promise<void> {
    return this.update('Account', id, patch);
  }

  /** Replace the account's password (keeps app passwords / API keys). */
  async setPassword(account: Pick<Account, 'id' | 'credentials'>, secret: string): Promise<void> {
    const creds = account.credentials ?? (await this.getAccounts([account.id], ['credentials']))[0]?.credentials ?? {};
    const key = Object.keys(creds).find((k) => creds[k]!['@type'] === 'Password');
    if (key !== undefined) return this.update('Account', account.id, { [`credentials/${key}/secret`]: secret });
    const next = String(Object.keys(creds).length);
    return this.update('Account', account.id, { [`credentials/${next}`]: { '@type': 'Password', secret } });
  }

  async setSuspended(account: Pick<Account, 'id' | 'permissions'>, suspended: boolean): Promise<void> {
    return this.update('Account', account.id, { permissions: withSuspension(account.permissions, suspended) });
  }

  async setRole(id: Id, role: UserRole): Promise<void> {
    return this.update('Account', id, { roles: { '@type': role } });
  }

  async setDisplayName(id: Id, name: string): Promise<void> {
    return this.update('Account', id, { description: name.trim() || null });
  }

  async setQuota(account: Pick<Account, 'id' | 'quotas'>, bytes: number | null): Promise<void> {
    const quotas = { ...(account.quotas ?? {}) };
    if (bytes) quotas.maxDiskQuota = bytes;
    else delete quotas.maxDiskQuota;
    return this.update('Account', account.id, { quotas });
  }

  /** Aliases are an objectList: always written whole. */
  async setAliases(id: Id, aliases: EmailAlias[], object: 'Account' | 'MailingList' = 'Account'): Promise<void> {
    return this.update(object, id, { aliases: aliasMap(aliases) });
  }

  async deleteAccount(id: Id): Promise<void> {
    return this.destroy('Account', [id]);
  }

  // ---------------------------------------------------------------- groups
  async createGroup(g: { name: string; domainId: Id; description: string }): Promise<Id> {
    return this.create('Account', { '@type': 'Group', name: g.name.trim().toLowerCase(), domainId: g.domainId, description: g.description.trim() || null });
  }

  async groupMembers(groupId: Id): Promise<Account[]> {
    const { list } = await this.queryGet<Account>('Account', { filter: { '@type': 'User', memberGroupIds: groupId }, sort: [{ property: 'name' }] }, [
      'name',
      'domainId',
      'description',
      'emailAddress',
      'memberGroupIds',
    ]);
    return list;
  }

  async setMembership(userId: Id, groupId: Id, member: boolean): Promise<void> {
    return this.update('Account', userId, { [`memberGroupIds/${groupId}`]: member ? true : null });
  }

  /** Stalwart refuses to destroy a group that still has members, so drop the memberships first. */
  async deleteGroup(groupId: Id): Promise<void> {
    const { ids } = await this.query('Account', { filter: { '@type': 'User', memberGroupIds: groupId } });
    if (ids.length) {
      const r = await this.set('Account', { update: Object.fromEntries(ids.map((id) => [id, { [`memberGroupIds/${groupId}`]: null }])) });
      const failed = Object.values(r.notUpdated ?? {})[0];
      if (failed) throw new AdminSetError(failed as SetErrorLike, 'Account');
    }
    return this.destroy('Account', [groupId]);
  }

  // ---------------------------------------------------------------- mailing lists
  async listMailingLists(): Promise<MailingList[]> {
    const { list } = await this.queryGet<MailingList>('MailingList', {});
    return list.sort((a, b) => a.emailAddress.localeCompare(b.emailAddress));
  }

  async getMailingList(id: Id): Promise<MailingList | null> {
    return (await this.get<MailingList>('MailingList', [id]))[0] ?? null;
  }

  async createMailingList(l: { name: string; domainId: Id; description: string; recipients: string[] }): Promise<Id> {
    return this.create('MailingList', {
      name: l.name.trim().toLowerCase(),
      domainId: l.domainId,
      description: l.description.trim() || null,
      recipients: Object.fromEntries(l.recipients.map((r) => [r.trim().toLowerCase(), true])),
    });
  }

  async setRecipients(id: Id, recipients: string[]): Promise<void> {
    return this.update('MailingList', id, { recipients: Object.fromEntries(recipients.map((r) => [r.trim().toLowerCase(), true])) });
  }

  async updateMailingList(id: Id, patch: Record<string, unknown>): Promise<void> {
    return this.update('MailingList', id, patch);
  }

  async deleteMailingList(id: Id): Promise<void> {
    return this.destroy('MailingList', [id]);
  }

  // ---------------------------------------------------------------- overview
  async overview(): Promise<Overview> {
    const b = this.client.batch();
    const count = (object: string, filter?: Record<string, unknown>) =>
      b.call<QueryResponse>(`x:${object}/query`, { ...(filter ? { filter } : {}), limit: 0, calculateTotal: true });
    // Domain ids too: tasks of since-deleted domains linger and shouldn't be reported.
    const domains = b.call<QueryResponse>('x:Domain/query', { calculateTotal: true });
    const users = count('Account', { '@type': 'User' });
    const groups = count('Account', { '@type': 'Group' });
    const lists = count('MailingList');
    const queue = count('QueuedMessage');
    const routes = b.call<GetResponse<MtaRoute>>('x:MtaRoute/get', { ids: null });
    const strategy = b.call<GetResponse<MtaOutboundStrategy>>('x:MtaOutboundStrategy/get', { ids: ['singleton'], properties: ['route'] });
    const taskHandles = DOMAIN_TASK_TYPES.map((type) => {
      const q = b.call<QueryResponse>('x:Task/query', { filter: { '@type': type } });
      return b.call<GetResponse<DomainTask>>('x:Task/get', { '#ids': q.ref('/ids') });
    });
    const r = await b.send();
    const total = (h: CallHandle<QueryResponse>): number | null => {
      try {
        return r.get(h).total ?? null;
      } catch {
        return null;
      }
    };
    const list = <T>(h: CallHandle<GetResponse<T>>): T[] => {
      try {
        return r.get(h).list;
      } catch {
        return [];
      }
    };
    // The domain query must work: surface a permission problem instead of zeros.
    const domainIds = new Set(r.get(domains).ids);
    return {
      domains: total(domains) ?? 0,
      users: total(users) ?? 0,
      groups: total(groups) ?? 0,
      lists: total(lists) ?? 0,
      queued: total(queue),
      routes: list(routes),
      strategy: list(strategy)[0] ?? null,
      problems: taskHandles.flatMap((h) => list(h)).filter((t) => t.status['@type'] !== 'Pending' && domainIds.has(t.domainId)),
    };
  }
}
