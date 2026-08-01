import {HttpsProxyAgent} from 'https-proxy-agent'
import {getProxyForUrl} from 'proxy-from-env'

/** Options for {@link buildProxyAgent}. */
export interface BuildProxyAgentOptions {
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
 * `proxy-from-env` resolves the proxy URL the same way the rest of the Node
 * ecosystem does — honouring `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` (and their
 * lowercase + `npm_config_*` variants) — so NO_PROXY bypass rules work without
 * re-implementing them.
 */
export function buildProxyAgent(
  targetUrl: string,
  options?: BuildProxyAgentOptions,
): HttpsProxyAgent<string> | undefined {
  if (!isHttpsTarget(targetUrl)) return undefined

  const proxyUrl = getProxyForUrl(targetUrl)
  if (!proxyUrl) return undefined

  return new HttpsProxyAgent(proxyUrl, {rejectUnauthorized: options?.rejectUnauthorized ?? true})
}

function isHttpsTarget(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}
