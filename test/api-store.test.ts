import {expect} from 'chai'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {
  buildAuthHeaders,
  buildGraphQLBody,
  buildUrl,
  coerceBodyValue,
  deleteSpec,
  extractBaseUrl,
  extractOperations,
  parseKV,
  readStore,
  type StoredSpec,
  writeStore,
} from '../src/api-store.js'

// Helper for coerceBodyValue tests
function bp(type: string) {
  return {[type]: {required: false, type}}
}

// Helper for store tests
function makeSpec(name: string): StoredSpec {
  return {
    baseUrl: 'https://api.example.com',
    description: '',
    kind: 'openapi',
    name,
    operations: [],
    source: 'local',
    title: name,
  }
}

describe('api-store', () => {
  // ─── parseKV ───────────────────────────────────────────────────────────────

  describe('parseKV', () => {
    it('returns empty object for empty array', () => {
      expect(parseKV([])).to.deep.equal({})
    })

    it('parses a simple key=value pair', () => {
      expect(parseKV(['foo=bar'])).to.deep.equal({foo: 'bar'})
    })

    it('parses multiple pairs', () => {
      expect(parseKV(['a=1', 'b=2'])).to.deep.equal({a: '1', b: '2'})
    })

    it('uses empty string for pair without =', () => {
      expect(parseKV(['flag'])).to.deep.equal({flag: ''})
    })

    it('treats only the first = as the separator', () => {
      expect(parseKV(['url=http://example.com/path?x=1'])).to.deep.equal({url: 'http://example.com/path?x=1'})
    })

    it('allows empty value', () => {
      expect(parseKV(['key='])).to.deep.equal({key: ''})
    })
  })

  // ─── coerceBodyValue ────────────────────────────────────────────────────────

  describe('coerceBodyValue', () => {
    it('returns string unchanged for string type', () => {
      expect(coerceBodyValue(bp('string'), 'string', 'hello')).to.equal('hello')
    })

    it('coerces boolean true', () => {
      expect(coerceBodyValue(bp('boolean'), 'boolean', 'true')).to.equal(true)
    })

    it('coerces boolean false for any non-"true" value', () => {
      expect(coerceBodyValue(bp('boolean'), 'boolean', 'false')).to.equal(false)
      expect(coerceBodyValue(bp('boolean'), 'boolean', '1')).to.equal(false)
    })

    it('coerces integer type to number', () => {
      expect(coerceBodyValue(bp('integer'), 'integer', '42')).to.equal(42)
    })

    it('coerces number type to float', () => {
      expect(coerceBodyValue(bp('number'), 'number', '3.14')).to.equal(3.14)
    })

    it('returns raw string when number conversion fails (NaN)', () => {
      expect(coerceBodyValue(bp('number'), 'number', 'notanumber')).to.equal('notanumber')
    })

    it('parses valid JSON for object type', () => {
      expect(coerceBodyValue(bp('object'), 'object', '{"a":1}')).to.deep.equal({a: 1})
    })

    it('returns raw string when object JSON is invalid', () => {
      expect(coerceBodyValue(bp('object'), 'object', 'not-json')).to.equal('not-json')
    })

    it('parses valid JSON array for array type', () => {
      expect(coerceBodyValue(bp('array'), 'array', '[1,2,3]')).to.deep.equal([1, 2, 3])
    })

    it('returns raw string for unknown param name', () => {
      expect(coerceBodyValue({}, 'missing', 'raw')).to.equal('raw')
    })
  })

  // ─── buildGraphQLBody ───────────────────────────────────────────────────────

  describe('buildGraphQLBody', () => {
    const query = 'query ListUsers { users { id } }'

    it('omits variables key when variables map is empty', () => {
      const body = JSON.parse(buildGraphQLBody(query, {}))
      expect(body).to.deep.equal({query})
    })

    it('includes variables when provided', () => {
      const body = JSON.parse(buildGraphQLBody(query, {limit: 10, name: 'Alice'}))
      expect(body).to.deep.equal({query, variables: {limit: 10, name: 'Alice'}})
    })
  })

  // ─── buildAuthHeaders ───────────────────────────────────────────────────────

  describe('buildAuthHeaders', () => {
    it('returns empty object for none type', () => {
      expect(buildAuthHeaders({type: 'none'})).to.deep.equal({})
    })

    it('builds API key header', () => {
      expect(buildAuthHeaders({apiKey: 'secret', header: 'X-API-Key', type: 'apikey'})).to.deep.equal({
        'X-API-Key': 'secret',
      })
    })

    it('uses the configured header name for API key', () => {
      expect(buildAuthHeaders({apiKey: 'abc', header: 'Authorization', type: 'apikey'})).to.deep.equal({
        Authorization: 'abc',
      })
    })

    it('builds Basic auth header', () => {
      const headers = buildAuthHeaders({password: 'pass', type: 'basic', username: 'user'})
      const encoded = Buffer.from('user:pass').toString('base64')
      expect(headers).to.deep.equal({Authorization: `Basic ${encoded}`})
    })

    it('builds Bearer auth header', () => {
      expect(buildAuthHeaders({scheme: 'bearer', token: 'tok123', type: 'http'})).to.deep.equal({
        Authorization: 'Bearer tok123',
      })
    })

    it('spreads custom headers', () => {
      const headers = buildAuthHeaders({headers: {'X-Tenant': 'acme', 'X-User': 'alice'}, type: 'custom'})
      expect(headers).to.deep.equal({'X-Tenant': 'acme', 'X-User': 'alice'})
    })
  })

  // ─── buildUrl ───────────────────────────────────────────────────────────────

  describe('buildUrl', () => {
    it('returns base + path when there are no path params', () => {
      expect(buildUrl('https://api.example.com', '/pets', {})).to.equal('https://api.example.com/pets')
    })

    it('substitutes a single path param', () => {
      expect(buildUrl('https://api.example.com', '/pets/{id}', {id: '42'})).to.equal('https://api.example.com/pets/42')
    })

    it('URL-encodes path param values', () => {
      expect(buildUrl('https://api.example.com', '/search/{q}', {q: 'hello world'})).to.equal(
        'https://api.example.com/search/hello%20world',
      )
    })

    it('substitutes multiple path params', () => {
      expect(buildUrl('https://api.example.com', '/users/{uid}/posts/{pid}', {pid: '7', uid: '3'})).to.equal(
        'https://api.example.com/users/3/posts/7',
      )
    })
  })

  // ─── extractBaseUrl ─────────────────────────────────────────────────────────

  describe('extractBaseUrl', () => {
    it('uses first server URL from OpenAPI 3 servers array', () => {
      const spec = {servers: [{url: 'https://api.example.com'}]}
      expect(extractBaseUrl(spec)).to.equal('https://api.example.com')
    })

    it('strips trailing slash from server URL', () => {
      const spec = {servers: [{url: 'https://api.example.com/'}]}
      expect(extractBaseUrl(spec)).to.equal('https://api.example.com')
    })

    it('builds URL from Swagger 2 host + schemes + basePath', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spec = {basePath: '/v2', host: 'petstore.swagger.io', schemes: ['https']} as any
      expect(extractBaseUrl(spec)).to.equal('https://petstore.swagger.io/v2')
    })

    it('defaults to https when Swagger 2 has no schemes', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spec = {host: 'petstore.swagger.io'} as any
      expect(extractBaseUrl(spec)).to.equal('https://petstore.swagger.io')
    })

    it('returns empty string when spec has no server info', () => {
      expect(extractBaseUrl({})).to.equal('')
    })
  })

  // ─── extractOperations ──────────────────────────────────────────────────────

  describe('extractOperations', () => {
    it('extracts a simple GET operation', () => {
      const spec = {
        paths: {
          '/pets': {
            get: {operationId: 'listPets', summary: 'List all pets'},
          },
        },
      }
      const ops = extractOperations(spec)
      expect(ops).to.have.length(1)
      expect(ops[0]).to.include({description: 'List all pets', method: 'get', operationId: 'listPets', path: '/pets'})
    })

    it('derives operationId from method + path when missing', () => {
      const spec = {paths: {'/users/{id}': {delete: {summary: 'Delete user'}}}}
      const ops = extractOperations(spec)
      expect(ops[0].operationId).to.equal('delete-users-id')
    })

    it('sanitizes operationId special characters', () => {
      const spec = {paths: {'/v1/things': {get: {operationId: 'get things!!', summary: 'get'}}}}
      const ops = extractOperations(spec)
      expect(ops[0].operationId).to.equal('get-things')
    })

    it('extracts body params from application/json schema', () => {
      const spec = {
        paths: {
          '/pets': {
            post: {
              operationId: 'createPet',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      properties: {
                        name: {type: 'string'},
                        tag: {description: 'optional tag', type: 'string'},
                      },
                      required: ['name'],
                      type: 'object',
                    },
                  },
                },
              },
              summary: 'Create a pet',
            },
          },
        },
      }
      const ops = extractOperations(spec)
      expect(ops[0].bodyParams).to.deep.equal({
        name: {description: undefined, required: true, type: 'string'},
        tag: {description: 'optional tag', required: false, type: 'string'},
      })
    })

    it('captures path and query parameters', () => {
      const spec = {
        paths: {
          '/pets/{id}': {
            get: {
              operationId: 'getPet',
              parameters: [
                {in: 'path' as const, name: 'id', required: true},
                {in: 'query' as const, name: 'fields', required: false},
              ],
              summary: 'Get a pet',
            },
          },
        },
      }
      const ops = extractOperations(spec)
      expect(ops[0].parameters).to.have.length(2)
      expect(ops[0].parameters[0]).to.include({in: 'path', name: 'id', required: true})
      expect(ops[0].parameters[1]).to.include({in: 'query', name: 'fields', required: false})
    })

    it('sets rawBodyContentType for non-JSON bodies', () => {
      const spec = {
        paths: {
          '/upload': {
            post: {
              operationId: 'upload',
              requestBody: {content: {'application/octet-stream': {}}},
              summary: 'Upload file',
            },
          },
        },
      }
      const ops = extractOperations(spec)
      expect(ops[0].rawBodyContentType).to.equal('application/octet-stream')
    })

    it('returns empty array when spec has no paths', () => {
      expect(extractOperations({})).to.deep.equal([])
    })

    it('handles multiple HTTP methods on the same path', () => {
      const spec = {
        paths: {
          '/pets': {
            get: {operationId: 'listPets', summary: 'List'},
            post: {operationId: 'createPet', summary: 'Create'},
          },
        },
      }
      const ops = extractOperations(spec)
      expect(ops).to.have.length(2)
      const ids = ops.map((o) => o.operationId)
      expect(ids).to.include('listPets')
      expect(ids).to.include('createPet')
    })
  })

  // ─── readStore / writeStore / deleteSpec ────────────────────────────────────

  describe('readStore / writeStore / deleteSpec', () => {
    let tmpDir: string

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
    })

    afterEach(async () => {
      await rm(tmpDir, {recursive: true})
    })

    it('readStore returns empty store when directory does not exist', async () => {
      const store = await readStore(join(tmpDir, 'nonexistent'))
      expect(store.specs).to.deep.equal({})
    })

    it('roundtrips a spec through writeStore then readStore', async () => {
      const spec = makeSpec('petstore')
      await writeStore(tmpDir, {specs: {petstore: spec}})
      const store = await readStore(tmpDir)
      expect(store.specs.petstore).to.deep.equal(spec)
    })

    it('creates the config directory if it does not exist', async () => {
      const nested = join(tmpDir, 'config', 'nested')
      const spec = makeSpec('test')
      await writeStore(nested, {specs: {test: spec}})
      const store = await readStore(nested)
      expect(store.specs.test.name).to.equal('test')
    })

    it('loads multiple specs', async () => {
      const alpha = makeSpec('alpha')
      const beta = makeSpec('beta')
      await writeStore(tmpDir, {specs: {alpha, beta}})
      const store = await readStore(tmpDir)
      expect(Object.keys(store.specs)).to.have.members(['alpha', 'beta'])
    })

    it('deleteSpec removes the written file and returns true', async () => {
      await writeStore(tmpDir, {specs: {petstore: makeSpec('petstore')}})
      const deleted = await deleteSpec(tmpDir, 'petstore')
      expect(deleted).to.be.true
      const store = await readStore(tmpDir)
      expect(store.specs).to.deep.equal({})
    })

    it('deleteSpec returns false when spec does not exist', async () => {
      const deleted = await deleteSpec(tmpDir, 'ghost')
      expect(deleted).to.be.false
    })

    it('prefers api-<name>.json over legacy openapi-<name>.json', async () => {
      const legacy = makeSpec('legacy')
      const modern = {...makeSpec('legacy'), description: 'modern'}
      await writeStore(tmpDir, {specs: {legacy}})
      await writeFile(join(tmpDir, 'openapi-legacy.json'), JSON.stringify({...legacy, description: 'old-legacy'}))
      await writeFile(join(tmpDir, 'api-legacy.json'), JSON.stringify(modern))
      const store = await readStore(tmpDir)
      expect(store.specs.legacy.description).to.equal('modern')
    })
  })
})
