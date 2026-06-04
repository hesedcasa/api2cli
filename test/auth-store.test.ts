import {expect} from 'chai'

import {buildAuthScheme} from '../src/auth-store.js'

describe('buildAuthScheme', () => {
  describe('none', () => {
    it('returns type none', () => {
      expect(buildAuthScheme({type: 'none'})).to.deep.equal({baseUrl: undefined, type: 'none'})
    })

    it('includes baseUrl when provided', () => {
      expect(buildAuthScheme({'base-url': 'https://api.example.com', type: 'none'})).to.deep.include({
        baseUrl: 'https://api.example.com',
      })
    })
  })

  describe('apikey', () => {
    it('builds an apikey scheme with default header', () => {
      const scheme = buildAuthScheme({'api-key': 'secret123', type: 'apikey'})
      expect(scheme).to.deep.equal({apiKey: 'secret123', baseUrl: undefined, header: 'X-API-Key', type: 'apikey'})
    })

    it('uses custom header when provided', () => {
      const scheme = buildAuthScheme({'api-key': 'secret', 'api-key-header': 'Authorization', type: 'apikey'})
      expect(scheme).to.deep.include({header: 'Authorization'})
    })

    it('throws when --api-key is missing', () => {
      expect(() => buildAuthScheme({type: 'apikey'})).to.throw('--api-key is required')
    })
  })

  describe('basic', () => {
    it('builds a basic auth scheme', () => {
      const scheme = buildAuthScheme({password: 'pass', type: 'basic', username: 'user'})
      expect(scheme).to.deep.equal({baseUrl: undefined, password: 'pass', type: 'basic', username: 'user'})
    })

    it('throws when username is missing', () => {
      expect(() => buildAuthScheme({password: 'pass', type: 'basic'})).to.throw('--username is required')
    })

    it('throws when password is missing', () => {
      expect(() => buildAuthScheme({type: 'basic', username: 'user'})).to.throw('--password is required')
    })
  })

  describe('bearer', () => {
    it('builds a bearer scheme', () => {
      const scheme = buildAuthScheme({token: 'tok123', type: 'bearer'})
      expect(scheme).to.deep.equal({baseUrl: undefined, scheme: 'bearer', token: 'tok123', type: 'http'})
    })

    it('throws when token is missing', () => {
      expect(() => buildAuthScheme({type: 'bearer'})).to.throw('--token is required')
    })
  })

  describe('custom', () => {
    it('builds a custom scheme from key=value headers', () => {
      const scheme = buildAuthScheme({header: ['X-Tenant=acme', 'X-User=alice'], type: 'custom'})
      expect(scheme).to.deep.equal({
        baseUrl: undefined,
        headers: {'X-Tenant': 'acme', 'X-User': 'alice'},
        type: 'custom',
      })
    })

    it('throws when no headers are provided', () => {
      expect(() => buildAuthScheme({header: [], type: 'custom'})).to.throw('--header is required')
    })

    it('throws when header flag is missing', () => {
      expect(() => buildAuthScheme({type: 'custom'})).to.throw('--header is required')
    })
  })

  describe('unknown type', () => {
    it('throws for an unsupported auth type', () => {
      expect(() => buildAuthScheme({type: 'oauth2'})).to.throw('Unknown auth type: "oauth2"')
    })
  })
})
