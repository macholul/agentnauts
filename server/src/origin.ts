/**
 * Origin checks. Requests without an Origin header (curl from the hooks,
 * other CLI tools) are always allowed. Browser pages are only allowed from
 * localhost unless listed in ALLOWED_ORIGINS, so a random website can't
 * read your agents' activity or inject fake events.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (extra.includes('*') || extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
