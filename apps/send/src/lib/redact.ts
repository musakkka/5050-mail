/** Redaction for stored request/response logs: no secrets, no attachment payloads. */
const SECRET_KEYS = /^(token|signing_secret|secret|password|authorization|api_key|apikey|access_token|refresh_token|client_secret|credential)$/i;
const SECRET_VALUES = [/\bre_[A-Za-z0-9]{6,}_[A-Za-z0-9]{8,}\b/g, /\bwhsec_[A-Za-z0-9+/=]{8,}/g];
const MAX_STRING = 10_000;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[truncated]';
  if (typeof value === 'string') {
    let s = value;
    for (const re of SECRET_VALUES) s = s.replace(re, (m) => `${m.slice(0, m.indexOf('_') + 1)}[REDACTED]`);
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…[truncated ${s.length - MAX_STRING} chars]` : s;
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.test(k)) out[k] = v === null || v === undefined ? v : '[REDACTED]';
      else if (k === 'content' && typeof v === 'string' && v.length > 256) out[k] = `[${v.length} chars omitted]`;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return value;
}
