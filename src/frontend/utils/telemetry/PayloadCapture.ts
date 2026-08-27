// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

/**
 * Request/response payload capture for spans.
 *
 * Monoscope shows `http.request.body` / `http.response.body` on a span, which
 * is the difference between "checkout returned 500" and "checkout returned 500
 * for *this* cart". The demo emits plenty of business attributes but no
 * payloads at all, so this is what makes a trace answer the second question.
 *
 * **Redaction is not optional here.** The collector's
 * `transform/redact_sensitive_data` processor redacts by attribute *key*
 * (`demo.payment.card_cvv`, `demo.payment.card_number`, hashing `user.email`).
 * A serialized body is one opaque string those rules cannot see, so turning on
 * capture over /api/checkout without redacting first would ship real card
 * numbers, CVVs and postal addresses to the backend in clear text. Everything
 * below runs before the value ever reaches a span.
 */

/** Matched case-insensitively against key names, as substrings. */
const SENSITIVE_KEY_PATTERNS = [
  'password',
  'passwd',
  'secret',
  'token',
  'authorization',
  'apikey',
  'api_key',
  'cookie',
  'session',
  'creditcard',
  'credit_card',
  'cardnumber',
  'card_number',
  'cvv',
  'cvc',
  'securitycode',
  'ssn',
];

/** Keys we keep but coarsen, because the shape is interesting and the value is not. */
const PARTIAL_KEY_PATTERNS = ['email', 'streetaddress', 'street_address', 'zipcode', 'zip_code'];

const REDACTED = '[redacted]';
const MAX_SERIALIZED_BYTES = 8 * 1024;
const MAX_DEPTH = 6;

function isSensitive(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some(p => k.includes(p));
}

function isPartial(key: string): boolean {
  const k = key.toLowerCase();
  return PARTIAL_KEY_PATTERNS.some(p => k.includes(p));
}

// Keeps the domain and the first character, which is enough to tell two users
// apart in a trace without recording who they are.
function coarsen(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) return value;
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}***@${value.slice(at + 1)}`;
  return `${value.slice(0, 1)}***`;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  // A body nested deeper than this is not something anyone reads off a span,
  // and recursing without a bound is how a cyclic structure hangs a request.
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitive(k)) out[k] = REDACTED;
    else if (isPartial(k)) out[k] = coarsen(v);
    else out[k] = redact(v, depth + 1);
  }
  return out;
}

/**
 * Redact, serialize, and cap. Returns undefined when there is nothing worth
 * attaching — an absent body, or one that cannot be serialized at all.
 *
 * Oversized payloads are truncated rather than dropped: knowing a 2 MB body
 * arrived, and what its first 8 KB looked like, beats knowing nothing.
 */
export function serializeBody(body: unknown): string | undefined {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' && body.length === 0) return undefined;

  let parsed: unknown = body;
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body);
    } catch {
      // Not JSON — keep the raw text, still capped below.
      return body.length > MAX_SERIALIZED_BYTES ? `${body.slice(0, MAX_SERIALIZED_BYTES)}…[truncated]` : body;
    }
  }

  try {
    const json = JSON.stringify(redact(parsed));
    if (json === undefined) return undefined;
    return json.length > MAX_SERIALIZED_BYTES ? `${json.slice(0, MAX_SERIALIZED_BYTES)}…[truncated]` : json;
  } catch {
    // Cyclic or otherwise unserializable. Never let telemetry break a request.
    return undefined;
  }
}
