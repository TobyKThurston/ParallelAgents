/**
 * Strip secrets from data before it reaches the agent or the PR body.
 *
 * Conservative — when in doubt, redact. The agent doesn't need real auth
 * material; it only needs to understand the *shape* of a request.
 */

const DEFAULT_FIELD_DENYLIST = [
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'ssn',
  'creditCard',
  'cvv',
  'authorization',
  'cookie',
  'set-cookie',
]

const HEADER_DENYLIST = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key'])

// Token-shaped strings: long opaque alphanumerics (jwt, sk-..., ghp_..., etc.)
const TOKEN_SHAPE = /(eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9_.-]{16,})/g

const REDACTED = '<redacted>'

export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = HEADER_DENYLIST.has(k.toLowerCase()) ? REDACTED : sanitizeString(v)
  }
  return out
}

export function sanitizeString(s: string): string {
  return s.replace(TOKEN_SHAPE, REDACTED)
}

/** Walks an unknown payload and redacts denylisted field names + token shapes. */
export function sanitizeBody(body: unknown, extraDenylist: string[] = []): unknown {
  const denylist = new Set(
    [...DEFAULT_FIELD_DENYLIST, ...extraDenylist].map((s) => s.toLowerCase())
  )
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return sanitizeString(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = denylist.has(k.toLowerCase()) ? REDACTED : walk(val)
      }
      return out
    }
    return v
  }
  return walk(body)
}
