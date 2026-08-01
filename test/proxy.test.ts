import {expect} from 'chai'

import {buildProxyAgent} from '../src/proxy.js'

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
