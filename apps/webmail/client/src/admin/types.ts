/**
 * Stalwart management objects (JMAP capability urn:stalwart:jmap, methods
 * `x:<Object>/get|set|query`), as served by Stalwart v0.16. Only the fields the
 * admin console reads or writes are typed; the server returns more.
 *
 * Shapes were taken from the server's own schema (GET /api/schema) and checked
 * against a live v0.16.27. Notes that matter:
 *  - "objectList" properties (aliases, credentials) are maps keyed "0","1",…
 *    that the server re-indexes when an entry is removed, so we always write
 *    the whole map instead of patching single keys.
 *  - "set" properties (memberGroupIds, recipients, publishRecords, …) are
 *    `{ value: true }` maps and can be patched per key (`memberGroupIds/<id>`).
 *  - Variant objects carry `@type`.
 */
import type { Id, UTCDate } from '../jmap/types';

export const DNS_RECORD_TYPES = [
  'dkim',
  'mx',
  'tlsRpt',
  'spf',
  'dmarc',
  'mtaSts',
  'caa',
  'tlsa',
  'srv',
  'autoConfig',
  'autoConfigLegacy',
  'autoDiscover',
] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export type DkimAlgorithm = 'Dkim1Ed25519Sha256' | 'Dkim1RsaSha256' | 'Dkim2Ed25519Sha256' | 'Dkim2RsaSha256';

export type DkimManagement =
  | { '@type': 'Manual' }
  | {
      '@type': 'Automatic';
      algorithms?: Partial<Record<DkimAlgorithm, boolean>>;
      selectorTemplate?: string;
      rotateAfter?: number;
      retireAfter?: number;
      deleteAfter?: number;
    };

export type CertificateManagement = { '@type': 'Manual' } | { '@type': 'Automatic'; acmeProviderId: Id; subjectAlternativeNames?: Record<string, boolean> };

export type DnsManagement =
  { '@type': 'Manual' } | { '@type': 'Automatic'; dnsServerId: Id; origin: string | null; publishRecords: Partial<Record<DnsRecordType, boolean>> };

export interface Domain {
  id: Id;
  name: string;
  description: string | null;
  isEnabled: boolean;
  createdAt: UTCDate;
  aliases: Record<string, boolean>;
  catchAllAddress: string | null;
  reportAddressUri: string | null;
  certificateManagement: CertificateManagement;
  dkimManagement: DkimManagement;
  dnsManagement: DnsManagement;
  /** Server-set zone file with every record the domain needs. */
  dnsZoneFile?: string;
}

/** x:DnsServer — one variant per provider (Cloudflare, Route53, Tsig, …). Secrets come back masked. */
export interface DnsServer {
  id: Id;
  '@type': string;
  description: string;
}

export interface AcmeProvider {
  id: Id;
  directory: string;
  challengeType: 'TlsAlpn01' | 'Dns01' | 'Http01' | string;
  contact: Record<string, boolean>;
  description?: string;
}

export interface EmailAlias {
  name: string;
  domainId: Id;
  enabled?: boolean;
  description?: string | null;
}

export type Permissions =
  { '@type': 'Inherit' } | { '@type': 'Merge' | 'Replace'; enabledPermissions: Record<string, boolean>; disabledPermissions: Record<string, boolean> };

export interface Credential {
  '@type': 'Password' | 'AppPassword' | 'ApiKey';
  credentialId?: string;
  secret?: string;
  expiresAt?: UTCDate | null;
}

export type UserRole = 'User' | 'Admin' | 'Custom';

export interface Account {
  id: Id;
  '@type': 'User' | 'Group';
  name: string;
  domainId: Id;
  /** Display name for users; free-text description for groups. */
  description: string | null;
  emailAddress: string;
  aliases: Record<string, EmailAlias>;
  /** Users only. */
  credentials?: Record<string, Credential>;
  /** Users only. */
  memberGroupIds?: Record<Id, boolean>;
  roles: { '@type': UserRole | 'Default'; roleIds?: Record<Id, boolean> };
  permissions: Permissions;
  /** StorageQuota → limit. `maxDiskQuota` is bytes. */
  quotas: Partial<Record<string, number>>;
  usedDiskQuota: number;
  createdAt: UTCDate;
  locale?: string;
}

export interface MailingList {
  id: Id;
  name: string;
  domainId: Id;
  description: string | null;
  emailAddress: string;
  aliases: Record<string, EmailAlias>;
  recipients: Record<string, boolean>;
}

export interface DkimSignature {
  id: Id;
  '@type': DkimAlgorithm;
  domainId: Id;
  selector: string;
  stage: 'pending' | 'active' | 'retiring' | 'retired' | string;
  createdAt: UTCDate;
  nextTransitionAt: UTCDate | null;
}

export interface Certificate {
  id: Id;
  subjectAlternativeNames: Record<string, boolean>;
  notValidBefore: UTCDate;
  notValidAfter: UTCDate;
  issuer: string;
}

export type TaskStatus =
  | { '@type': 'Pending'; due?: UTCDate; createdAt?: UTCDate }
  | { '@type': 'Retry'; due?: UTCDate; createdAt?: UTCDate; attemptNumber?: number; failureReason?: string }
  | { '@type': 'Failed'; failedAt?: UTCDate; createdAt?: UTCDate; failedAttemptNumber?: number; failureReason?: string };

/** The background tasks that carry per-domain DNS / DKIM / ACME state. */
export type DomainTaskType = 'DnsManagement' | 'DkimManagement' | 'AcmeRenewal';
export const DOMAIN_TASK_TYPES: DomainTaskType[] = ['DnsManagement', 'DkimManagement', 'AcmeRenewal'];

export interface DomainTask {
  id: Id;
  '@type': DomainTaskType;
  domainId: Id;
  due: UTCDate | null;
  status: TaskStatus;
  updateRecords?: Partial<Record<DnsRecordType, boolean>>;
}

export interface MtaRoute {
  id: Id;
  '@type': 'Mx' | 'Relay' | 'Local' | string;
  name: string;
  description: string | null;
  address?: string;
  port?: number;
  implicitTls?: boolean;
  protocol?: string;
  authUsername?: string | null;
}

/** An `if/then/else` expression as stored by Stalwart (`'name'` string literals). */
export interface Expression {
  match: Record<string, { if: string; then: string }>;
  else: string;
}

export interface MtaOutboundStrategy {
  id: 'singleton';
  route: Expression;
}
