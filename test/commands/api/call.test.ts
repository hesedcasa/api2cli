import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import ApiCall from '../../../src/commands/api/call.js'
import {makeConfig, makeFetch, makeOperation, makeSpec, runCmd, seedStore} from '../../helpers.js'

describe('api call', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  it('errors when the spec is not found', async () => {
    const config = makeConfig(tmpDir)
    const {cliError} = await runCmd(ApiCall, ['ghost', 'listPets'], config)
    expect(cliError?.message).to.include('ghost')
  })

  it('errors when the operation is not found', async () => {
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [makeOperation('listPets')]})])
    const config = makeConfig(tmpDir)
    const {cliError} = await runCmd(ApiCall, ['petstore', 'missing'], config)
    expect(cliError?.message).to.include('missing')
  })

  it('errors when no base URL is set', async () => {
    const spec = makeSpec('petstore', {baseUrl: '', operations: [makeOperation('listPets')]})
    await seedStore(tmpDir, [spec])
    const config = makeConfig(tmpDir)
    const {cliError} = await runCmd(ApiCall, ['petstore', 'listPets'], config)
    expect(cliError?.message).to.include('base URL')
  })

  it('makes a GET request with the correct URL', async () => {
    const op = makeOperation('listPets', {method: 'get', path: '/pets'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('[]')
      },
      ['petstore', 'listPets'],
      config,
    )
    expect(logs[0]).to.equal('GET https://api.example.com/pets')
  })

  it('interpolates path params', async () => {
    const op = makeOperation('getPet', {
      method: 'get',
      parameters: [{in: 'path' as const, name: 'id', required: true}],
      path: '/pets/{id}',
    })
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('{}')
      },
      ['petstore', 'getPet', '--param', 'id=42'],
      config,
    )
    expect(logs[0]).to.equal('GET https://api.example.com/pets/42')
  })

  it('appends query params to the URL', async () => {
    const op = makeOperation('listPets', {
      method: 'get',
      parameters: [{description: 'limit', in: 'query' as const, name: 'limit', required: false}],
      path: '/pets',
    })
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('[]')
      },
      ['petstore', 'listPets', '--param', 'limit=10'],
      config,
    )
    expect(logs[0]).to.include('limit=10')
  })

  it('sends POST body as JSON', async () => {
    const op = makeOperation('createPet', {
      bodyParams: {name: {required: true, type: 'string'}},
      method: 'post',
      path: '/pets',
    })
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const requests: Array<{body?: null | string; headers?: Record<string, string>; method?: string}> = []
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = async (_url: string, init?: (typeof requests)[number]) => {
          if (init) requests.push(init)
          return {ok: true, status: 201, statusText: 'Created', text: async () => '{"id":1}'}
        }
      },
      ['petstore', 'createPet', '--body', 'name=Fido'],
      config,
    )
    expect(requests[0].method).to.equal('POST')
    expect(JSON.parse(requests[0].body ?? '{}')).to.deep.equal({name: 'Fido'})
    expect(requests[0].headers?.['Content-Type']).to.equal('application/json')
    expect(logs[1]).to.include('"id": 1')
  })

  it('uses --base-url override', async () => {
    const op = makeOperation('listPets', {method: 'get', path: '/pets'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('[]')
      },
      ['petstore', 'listPets', '--base-url', 'https://override.example.com'],
      config,
    )
    expect(logs[0]).to.equal('GET https://override.example.com/pets')
  })

  it('prints raw response text when --raw is passed', async () => {
    const op = makeOperation('listPets', {method: 'get', path: '/pets'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {logs} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('[{"id":1}]')
      },
      ['petstore', 'listPets', '--raw'],
      config,
    )
    expect(logs[1]).to.equal('[{"id":1}]')
  })

  it('warns on non-2xx HTTP status', async () => {
    const op = makeOperation('getPet', {method: 'get', path: '/pets/1'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {warns} = await runCmd(
      class extends ApiCall {
        override _fetch = makeFetch('Not Found', {ok: false, status: 404, statusText: 'Not Found'})
      },
      ['petstore', 'getPet'],
      config,
    )
    expect(warns[0]).to.include('404')
  })

  it('errors when fetch throws a network error', async () => {
    const op = makeOperation('listPets', {method: 'get', path: '/pets'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const {cliError} = await runCmd(
      class extends ApiCall {
        override _fetch = async () => {
          throw new Error('ECONNREFUSED')
        }
      },
      ['petstore', 'listPets'],
      config,
    )
    expect(cliError?.message).to.include('ECONNREFUSED')
  })

  it('sends a GraphQL request body', async () => {
    const op = makeOperation('listUsers', {
      graphql: {fieldName: 'users', operationType: 'query', query: 'query listUsers { users { id } }'},
      method: 'post',
      path: '/graphql',
    })
    await seedStore(tmpDir, [makeSpec('myapi', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const requests: Array<{body?: null | string; headers?: Record<string, string>; method?: string}> = []
    await runCmd(
      class extends ApiCall {
        override _fetch = async (_url: string, init?: (typeof requests)[number]) => {
          if (init) requests.push(init)
          return {ok: true, status: 200, statusText: 'OK', text: async () => '{"data":{}}'}
        }
      },
      ['myapi', 'listUsers'],
      config,
    )
    const body = JSON.parse(requests[0].body ?? '{}')
    expect(body.query).to.include('listUsers')
  })

  it('adds header from --header flag', async () => {
    const op = makeOperation('listPets', {method: 'get', path: '/pets'})
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const config = makeConfig(tmpDir)
    const requests: Array<{body?: null | string; headers?: Record<string, string>; method?: string}> = []
    await runCmd(
      class extends ApiCall {
        override _fetch = async (_url: string, init?: (typeof requests)[number]) => {
          if (init) requests.push(init)
          return {ok: true, status: 200, statusText: 'OK', text: async () => '[]'}
        }
      },
      ['petstore', 'listPets', '--header', 'X-Trace=abc'],
      config,
    )
    expect(requests[0].headers?.['X-Trace']).to.equal('abc')
  })
})
