/**
 * Origin checks. Requests without an Origin header (curl from the hooks,
 * other CLI tools) are always allowed. Browser pages are only allowed from
 * localhost unless listed in AGENTNAUTS_ALLOWED_ORIGINS, so a random website can't
 * read your agents' activity or inject fake events.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** A bind address that only this computer can reach. */
export function isLoopback(host: string): boolean {
  return LOCAL_HOSTS.has(host);
}

/**
 * Whether a request was addressed to this computer by a local name (its Host
 * header). A website whose domain is pointed at 127.0.0.1 ("DNS rebinding")
 * reaches the daemon without an Origin on plain GETs; its own name in Host
 * gives it away.
 */
export function isLocalHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  try {
    return LOCAL_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
  if (extra.includes('*') || extra.includes(origin)) return true;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOCAL_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}
