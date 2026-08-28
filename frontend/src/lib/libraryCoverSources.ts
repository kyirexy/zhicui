export type CoverSource = string | null | undefined;

/** Keep the proxy first, but retain every distinct upstream fallback. */
export function normalizeCoverSources(...sources: CoverSource[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const value = typeof source === 'string' ? source.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** Force a real browser request after a failed image without mutating the signed URL itself. */
export function withCoverRetryToken(source: string, token: number): string {
  if (!source || token <= 0) return source;
  const hashIndex = source.indexOf('#');
  const hash = hashIndex >= 0 ? source.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  return `${base}${base.includes('?') ? '&' : '?'}zhicui_retry=${token}${hash}`;
}
