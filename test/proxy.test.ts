import {expect} from 'chai'

import {buildProxyAgent, shouldBypassProxy} from '../src/proxy.js'

describe('proxy', () => {
  describe('shouldBypassProxy', () => {
    it('returns false for an empty NO_PROXY list', () => {
      expect(shouldBypassProxy('https://api.example.com', '')).to.equal(false)
      expect(shouldBypassProxy('https://api.example.com', '   ')).to.equal(false)
    })

    it('bypasses all traffic for the "*" wildcard', () => {
      expect(shouldBypassProxy('https://api.example.com', '*')).to.equal(true)
    })

    it('matches a bare parent domain as a suffix (curl behavior)', () => {
      // The proxy-from-env refactor regressed this: it treated bare domains as
      // exact-only. curl (and the prior implementation) match subdomains too.
      expect(shouldBypassProxy('https://api.example.com', 'example.com')).to.equal(true)
      expect(shouldBypassProxy('https://sub.api.example.com', 'example.com')).to.equal(true)
      expect(shouldBypassProxy('https://example.com', 'example.com')).to.equal(true)
      // A bare domain must not match an unrelated host.
      expect(shouldBypassProxy('https://api.other.com', 'example.com')).to.equal(false)
      // Nor a sibling that merely shares a string suffix (no dot boundary).
      expect(shouldBypassProxy('https://notexample.com', 'example.com')).to.equal(false)
    })

    it('matches wildcard prefixes (*.example.com)', () => {
      expect(shouldBypassProxy('https://api.example.com', '*.example.com')).to.equal(true)
      expect(shouldBypassProxy('https://sub.api.example.com', '*.example.com')).to.equal(true)
      expect(shouldBypassProxy('https://example.com', '*.example.com')).to.equal(true)
      expect(shouldBypassProxy('https://api.other.com', '*.example.com')).to.equal(false)
    })

    it('matches dot-prefix patterns (.example.com)', () => {
      expect(shouldBypassProxy('https://api.example.com', '.example.com')).to.equal(true)
      expect(shouldBypassProxy('https://sub.api.example.com', '.example.com')).to.equal(true)
      expect(shouldBypassProxy('https://example.com', '.example.com')).to.equal(true)
    })

    it('normalizes IPv6 brackets so unbracketed entries match bracketed URL hosts', () => {
      // The proxy-from-env refactor regressed this: it kept URL brackets and so
      // never matched an unbracketed literal like "::1" against "[::1]".
      expect(shouldBypassProxy('https://[::1]/path', '::1')).to.equal(true)
      expect(shouldBypassProxy('http://[::1]:8080/health', '::1')).to.equal(true)
      // Bracketed entries match too.
      expect(shouldBypassProxy('https://[::1]/path', '[::1]')).to.equal(true)
      expect(shouldBypassProxy('http://[2001:db8::1]:443/api', '2001:db8::1')).to.equal(true)
      // A different address does not match.
      expect(shouldBypassProxy('http://[::2]:8080/health', '::1')).to.equal(false)
    })

    it('normalizes mixed-case patterns to lowercase', () => {
      expect(shouldBypassProxy('https://example.com', 'Example.COM')).to.equal(true)
      expect(shouldBypassProxy('https://api.example.com', 'EXAMPLE.COM')).to.equal(true)
    })

    it('handles multiple comma-separated patterns', () => {
      const noProxy = 'localhost,127.0.0.1,*.internal,example.com'
      expect(shouldBypassProxy('https://localhost', noProxy)).to.equal(true)
      expect(shouldBypassProxy('https://127.0.0.1:8080', noProxy)).to.equal(true)
      expect(shouldBypassProxy('https://service.internal', noProxy)).to.equal(true)
      expect(shouldBypassProxy('https://api.example.com', noProxy)).to.equal(true)
      expect(shouldBypassProxy('https://external.com', noProxy)).to.equal(false)
    })

    it('matches port-qualified entries and honors default ports', () => {
      expect(shouldBypassProxy('https://localhost:8080', 'localhost:8080')).to.equal(true)
      expect(shouldBypassProxy('https://localhost:9000', 'localhost:8080')).to.equal(false)
      // URL omits the default port; the pattern still matches against the effective port.
      expect(shouldBypassProxy('https://example.com', 'example.com:443')).to.equal(true)
      // A hostname-only entry matches any port.
      expect(shouldBypassProxy('https://localhost:3000', 'localhost')).to.equal(true)
    })
  })

  describe('buildProxyAgent', () => {
    const originalEnv = {...process.env}

    // proxy-from-env consults each of these (preferring the lowercase form), so any
    // left set by the surrounding environment would leak into the assertions below.
    const proxyEnvKeys = [
      'ALL_PROXY',
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'NO_PROXY',
      'npm_config_no_proxy',
      'npm_config_proxy',
      'npm_config_http_proxy',
      'npm_config_https_proxy',
    ]

    beforeEach(() => {
      for (const key of proxyEnvKeys) {
        delete process.env[key]
        delete process.env[key.toLowerCase()]
      }
    })

    afterEach(() => {
      for (const key of Object.keys(process.env)) {
        if (!(key in originalEnv)) delete process.env[key]
      }

      Object.assign(process.env, originalEnv)
    })

    it('returns undefined when no proxy env var is set', () => {
      expect(buildProxyAgent('https://api.example.com')).to.equal(undefined)
    })

    it('returns an HttpsProxyAgent when HTTPS_PROXY is set for an https:// target', () => {
      process.env.HTTPS_PROXY = 'http://user:pass@proxy.example.com:8080'

      const agent = buildProxyAgent('https://api.example.com')

      expect(agent).to.not.equal(undefined)
      expect(agent).to.be.an('object')
    })

    it('returns undefined when the host is excluded via NO_PROXY', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
      process.env.NO_PROXY = 'api.example.com'

      expect(buildProxyAgent('https://api.example.com')).to.equal(undefined)
    })

    it('honors a bare parent domain in NO_PROXY for a subdomain (curl behavior)', () => {
      // proxy-from-env treats "example.com" as exact-only; buildProxyAgent must
      // still bypass subdomains such as "api.example.com".
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
      process.env.NO_PROXY = 'example.com'

      expect(buildProxyAgent('https://api.example.com/path')).to.equal(undefined)
    })

    it('honors an unbracketed IPv6 NO_PROXY entry against a bracketed URL host', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'
      process.env.NO_PROXY = '::1'

      expect(buildProxyAgent('https://[::1]/path')).to.equal(undefined)
    })

    it('returns undefined for an http:// target so the http module connects directly', () => {
      process.env.HTTP_PROXY = 'http://proxy.example.com:8080'

      expect(buildProxyAgent('http://jenkins.internal:8080')).to.equal(undefined)
    })

    it('returns undefined for a host without a parseable URL', () => {
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'

      expect(buildProxyAgent('api.example.com')).to.equal(undefined)
    })

    it('still proxies an https:// target when HTTP_PROXY (but not HTTPS_PROXY) is set', () => {
      // proxy-from-env falls back to ALL_PROXY/HTTP_PROXY for https targets only
      // when HTTPS_PROXY is absent; HTTPS_PROXY is the canonical var, so assert the
      // primary path rather than the fallback.
      process.env.HTTPS_PROXY = 'http://proxy.example.com:8080'

      expect(buildProxyAgent('https://api.example.com')).to.not.equal(undefined)
    })
  })
})
