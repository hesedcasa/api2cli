import {HttpsProxyAgent} from 'https-proxy-agent'
import {getProxyForUrl} from 'proxy-from-env'

/** Options for {@link buildProxyAgent}. */
export type BuildProxyAgentOptions = {
  /**
   * Skip TLS certificate verification on the tunneled connection. Defaults to
   * `true` (verify). The insecure fetch path passes `false` for self-signed
   * targets such as the Obsidian Local REST API.
   */
  rejectUnauthorized?: boolean
}

/**
 * Returns an `HttpsProxyAgent` when `targetUrl` should be routed through a
 * proxy, or `undefined` to let the caller connect directly.
 *
 * Node's `http`/`https` modules do not consult the `HTTP(S)_PROXY` environment
 * variables themselves (unlike `fetch` with `NODE_USE_ENV_PROXY`, or axios), so
 * for `https://` targets we build an explicit agent that opens an HTTP CONNECT
 * tunnel — the form MITM-style proxies such as Agent Vault require. Those
 * proxies reject a plain absolute-URI forward for https:// upstreams; a CONNECT
 * tunnel is what they intercept.
 *
 * For `http://` targets this returns `undefined`, so the `http` module connects
 * directly. A MITM proxy only intercepts TLS, so a plain-HTTP upstream has
 * nothing to intercept and is rejected (502 Bad Gateway); connecting directly is
 * the only thing that works for those targets.
 *
 * Proxy *selection* (which of `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` applies for
 * a given protocol) is delegated to `proxy-from-env` so we resolve the URL the
 * same way the rest of the Node ecosystem does. Its `NO_PROXY` matching is
 * narrower than curl, though: a bare domain like `example.com` matches only
 * itself (not `api.example.com`), and an unbracketed IPv6 literal like `::1`
 * does not match `https://[::1]/`. Both forms are curl-compatible and were
 * honoured before this module adopted `proxy-from-env`, so
 * {@link shouldBypassProxy} is consulted first; only targets it does not bypass
 * fall through to `proxy-from-env` for selection.
 */
export function buildProxyAgent(
  targetUrl: string,
  options?: BuildProxyAgentOptions,
): HttpsProxyAgent<string> | undefined {
  if (!isHttpsTarget(targetUrl)) return undefined

  const noProxy = process.env.no_proxy || process.env.NO_PROXY || ''
  if (shouldBypassProxy(targetUrl, noProxy)) return undefined

  const proxyUrl = getProxyForUrl(targetUrl)
  if (!proxyUrl) return undefined

  return new HttpsProxyAgent(proxyUrl, {rejectUnauthorized: options?.rejectUnauthorized ?? true})
}

/**
 * Checks if a URL should bypass the proxy based on NO_PROXY/no_proxy env vars.
 * NO_PROXY contains a comma-separated list of domains, IPs, or patterns.
 * Matches follow curl behavior: each name matches as hostname OR domain suffix.
 * Supports: exact matches, domain suffix matches, wildcard prefixes, dot
 * prefixes, port-qualified entries, and IPv6 literals (with or without brackets).
 *
 * This is layered ahead of `proxy-from-env`'s own matching because that library
 * treats bare domains as exact-only and does not normalize IPv6 brackets — both
 * regressed when this module switched to `proxy-from-env`.
 */
export function shouldBypassProxy(targetUrl: string, noProxyList: string): boolean {
  if (!noProxyList.trim()) return false

  const target = new URL(targetUrl)
  // Normalize IPv6: strip brackets from hostname (e.g., [::1] -> ::1)
  // This allows NO_PROXY entries like "::1" to match URLs like "http://[::1]"
  const targetHost = stripBrackets(target.hostname)
  // URL.port is empty when the port is the scheme's default (80 for HTTP, 443 for HTTPS)
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')

  // Split NO_PROXY by commas and normalize to lowercase (URL.hostname is always lowercase)
  return noProxyList
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean)
    .some((pattern) => pattern === '*' || matchesPattern(targetHost, targetPort, pattern))
}

/** Strips the square brackets that bracket an IPv6 literal, leaving other hosts unchanged. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** True if a single (non-`*`) NO_PROXY pattern matches the target host/port. */
function matchesPattern(targetHost: string, targetPort: string, pattern: string): boolean {
  // Parse port-qualified entries (e.g., "localhost:8080" or "[::1]:8080"). The part
  // after the last colon is a port only when it is all digits and the part before
  // it is bracketed or colon-free (so a bare IPv6 literal like "::1" is not split).
  const colonIndex = pattern.lastIndexOf(':')
  const afterColon = colonIndex > 0 ? pattern.slice(colonIndex + 1) : ''
  const beforeColon = colonIndex > 0 ? pattern.slice(0, colonIndex) : ''
  const hasPort =
    colonIndex > 0 && /^\d+$/.test(afterColon) && (beforeColon.startsWith('[') || !beforeColon.includes(':'))

  // If the pattern names a port, it only matches when that port equals the target's.
  if (hasPort && targetPort !== afterColon) return false

  const patternHost = stripBrackets(hasPort ? pattern.slice(0, colonIndex) : pattern)
  return hostMatches(targetHost, patternHost)
}

/** curl-style host match: wildcard, dot-prefix, or exact/suffix for a bare domain. */
function hostMatches(targetHost: string, patternHost: string): boolean {
  // Wildcard (e.g., *.example.com) or dot-prefix (e.g., .example.com) both match
  // the domain and all of its subdomains.
  if (patternHost.startsWith('*.') || patternHost.startsWith('.')) {
    const domain = patternHost.slice(patternHost.startsWith('*.') ? 2 : 1)
    return targetHost === domain || targetHost.endsWith('.' + domain)
  }

  // Standard NO_PROXY matching: hostname exactly OR as a domain suffix.
  // Per curl behavior: "example.com" matches both "example.com" and "api.example.com".
  return targetHost === patternHost || targetHost.endsWith('.' + patternHost)
}

function isHttpsTarget(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
