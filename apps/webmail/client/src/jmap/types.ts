/** JMAP (RFC 8620 core, RFC 8621 mail/submission/vacation) types used by 5050 Mail. */

export type Id = string;
export type UTCDate = string;

export const CAP = {
  core: 'urn:ietf:params:jmap:core',
  mail: 'urn:ietf:params:jmap:mail',
  submission: 'urn:ietf:params:jmap:submission',
  vacation: 'urn:ietf:params:jmap:vacationresponse',
  blob: 'urn:ietf:params:jmap:blob',
  quota: 'urn:ietf:params:jmap:quota',
  principals: 'urn:ietf:params:jmap:principals',
  stalwart: 'urn:stalwart:jmap',
} as const;

export interface CoreCapability {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
  collationAlgorithms: string[];
}

export interface Account {
  name: string;
  isPersonal: boolean;
  isReadOnly: boolean;
  accountCapabilities: Record<string, unknown>;
}

export interface Session {
  capabilities: Record<string, unknown> & { [CAP.core]: CoreCapability };
  accounts: Record<Id, Account>;
  primaryAccounts: Record<string, Id>;
  username: string;
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
}

export interface MailboxRights {
  mayReadItems: boolean;
  mayAddItems: boolean;
  mayRemoveItems: boolean;
  maySetSeen: boolean;
  maySetKeywords: boolean;
  mayCreateChild: boolean;
  mayRename: boolean;
  mayDelete: boolean;
  maySubmit: boolean;
}

export interface Mailbox {
  id: Id;
  name: string;
  parentId: Id | null;
  role: string | null;
  sortOrder: number;
  totalEmails: number;
  unreadEmails: number;
  totalThreads: number;
  unreadThreads: number;
  myRights: MailboxRights;
  isSubscribed: boolean;
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

export interface EmailHeader {
  name: string;
  value: string;
}

export interface EmailBodyPart {
  partId: string | null;
  blobId: Id | null;
  size: number;
  headers?: EmailHeader[];
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  language?: string[] | null;
  location?: string | null;
  subParts?: EmailBodyPart[] | null;
}

export interface EmailBodyValue {
  value: string;
  isEncodingProblem: boolean;
  isTruncated: boolean;
}

export interface Email {
  id: Id;
  blobId: Id;
  threadId: Id;
  mailboxIds: Record<Id, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: UTCDate;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  sender: EmailAddress[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  replyTo: EmailAddress[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  bodyStructure?: EmailBodyPart;
  bodyValues?: Record<string, EmailBodyValue>;
  textBody?: EmailBodyPart[];
  htmlBody?: EmailBodyPart[];
  attachments?: EmailBodyPart[];
  headers?: EmailHeader[];
  /** header:List-Unsubscribe:asURLs etc. */
  [header: `header:${string}`]: unknown;
}

/** Shape accepted by Email/set create. */
export interface EmailCreate {
  mailboxIds: Record<Id, boolean>;
  keywords?: Record<string, boolean>;
  from?: EmailAddress[];
  to?: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject?: string;
  sentAt?: string;
  receivedAt?: UTCDate;
  messageId?: string[];
  inReplyTo?: string[] | null;
  references?: string[] | null;
  bodyValues?: Record<string, { value: string; isTruncated?: boolean; isEncodingProblem?: boolean }>;
  textBody?: Partial<EmailBodyPart>[];
  htmlBody?: Partial<EmailBodyPart>[];
  attachments?: Partial<EmailBodyPart>[];
  bodyStructure?: Partial<EmailBodyPart>;
  [header: `header:${string}`]: unknown;
}

export interface Thread {
  id: Id;
  emailIds: Id[];
}

export interface Identity {
  id: Id;
  name: string;
  email: string;
  replyTo: EmailAddress[] | null;
  bcc: EmailAddress[] | null;
  textSignature: string;
  htmlSignature: string;
  mayDelete: boolean;
}

export interface EnvelopeAddress {
  email: string;
  parameters?: Record<string, string | null> | null;
}

export interface EmailSubmission {
  id: Id;
  identityId: Id;
  emailId: Id;
  threadId: Id;
  envelope: { mailFrom: EnvelopeAddress; rcptTo: EnvelopeAddress[] } | null;
  sendAt: UTCDate;
  undoStatus: 'pending' | 'final' | 'canceled';
  deliveryStatus: Record<string, { smtpReply: string; delivered: string; displayed: string }> | null;
}

export interface SearchSnippet {
  emailId: Id;
  subject: string | null;
  preview: string | null;
}

export interface VacationResponse {
  id: 'singleton';
  isEnabled: boolean;
  fromDate: UTCDate | null;
  toDate: UTCDate | null;
  subject: string | null;
  textBody: string | null;
  htmlBody: string | null;
}

/** RFC 8621 §4.4.1 FilterCondition. */
export interface EmailFilterCondition {
  inMailbox?: Id;
  inMailboxOtherThan?: Id[];
  before?: UTCDate;
  after?: UTCDate;
  minSize?: number;
  maxSize?: number;
  allInThreadHaveKeyword?: string;
  someInThreadHaveKeyword?: string;
  noneInThreadHaveKeyword?: string;
  hasKeyword?: string;
  notKeyword?: string;
  hasAttachment?: boolean;
  text?: string;
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  header?: [string] | [string, string];
  /** Stalwart extension: match these email ids. */
  id?: Id[];
  /** Client-side placeholder for Gmail's filename: (resolved by resolveFilenameFilters before querying). */
  acme_filename?: string;
}

export interface FilterOperator<T> {
  operator: 'AND' | 'OR' | 'NOT';
  conditions: (T | FilterOperator<T>)[];
}

export type EmailFilter = EmailFilterCondition | FilterOperator<EmailFilterCondition>;

export interface Comparator {
  property: string;
  isAscending?: boolean;
  keyword?: string;
  collation?: string;
}

export interface QueryResponse {
  accountId: Id;
  queryState: string;
  canCalculateChanges: boolean;
  position: number;
  ids: Id[];
  total?: number;
  limit?: number;
}

export interface GetResponse<T> {
  accountId: Id;
  state: string;
  list: T[];
  notFound: Id[];
}

export interface SetError {
  type: string;
  description?: string;
  properties?: string[];
}

export interface SetResponse<T = Record<string, unknown>> {
  accountId: Id;
  oldState: string | null;
  newState: string;
  created?: Record<Id, T & { id: Id }> | null;
  updated?: Record<Id, Partial<T> | null> | null;
  destroyed?: Id[] | null;
  notCreated?: Record<Id, SetError> | null;
  notUpdated?: Record<Id, SetError> | null;
  notDestroyed?: Record<Id, SetError> | null;
}

export interface ChangesResponse {
  accountId: Id;
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: Id[];
  updated: Id[];
  destroyed: Id[];
  updatedProperties?: string[] | null;
}

export interface StateChange {
  '@type': 'StateChange';
  changed: Record<Id, Record<string, string>>;
}

/** A JMAP patch object: JSON pointer paths → values (null removes). */
export type PatchObject = Record<string, unknown>;

export interface ResultReference {
  resultOf: string;
  name: string;
  path: string;
}
