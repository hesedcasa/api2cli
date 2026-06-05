import type {Config} from '@oclif/core'

import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {registerApiCommands} from '../src/api-dynamic-commands.js'
import {createApiAuthManager} from '../src/auth-store.js'
import hook from '../src/hooks/init/register-api-commands.js'
import {makeFetch, makeOperation, makeSpec, seedStore} from './helpers.js'

// ─── Internal config shape for tests ─────────────────────────────────────────

interface TestConfig {
  _commands: Map<string, {description?: string; id: string; load: () => Promise<unknown>}>
  _topics: Map<string, {description?: string; hidden: boolean; name: string}>
  bin: string
  configDir: string
  name: string
  pjson: Record<string, unknown>
  root: string
  runHook: () => Promise<{failures: unknown[]; successes: unknown[]}>
  version: string
}

function makeInternalConfig(configDir: string): TestConfig {
  return {
    _commands: new Map(),
    _topics: new Map(),
    bin: 'sdkck',
    configDir,
    name: '@hesed/api2cli',
    pjson: {name: '@hesed/api2cli', version: '0.0.0'},
    root: process.cwd(),
    runHook: async () => ({failures: [], successes: []}),
    version: '0.0.0',
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildDynamicCmd(tmpDir: string, op: ReturnType<typeof makeOperation>, argv: string[]): Promise<any> {
  const spec = makeSpec('petstore', {operations: [op]})
  await seedStore(tmpDir, [spec])
  const config = makeInternalConfig(tmpDir)
  await registerApiCommands(config as unknown as Config)
  const entry = config._commands.get(`petstore:${op.operationId}`)!
  const CmdClass = (await entry.load()) as new (
    argv: string[],
    config: unknown,
  ) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [k: string]: any
    run(): Promise<void>
  }
  const cmd = new CmdClass(argv, config as unknown as Config)
  const logs: string[] = []
  const warns: string[] = []
  let cliError: Error | undefined
  cmd.log = (msg?: string) => logs.push(msg ?? '')
  cmd.warn = (input: Error | string) => warns.push(typeof input === 'string' ? input : input.message)
  cmd.error = (input: Error | string) => {
    const msg = typeof input === 'string' ? input : input.message
    cliError = new Error(msg)
    throw cliError
  }

  return {cliError: () => cliError, cmd, logs, warns}
}

describe('api-dynamic-commands', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  // ─── registerApiCommands ────────────────────────────────────────────────────

  describe('registerApiCommands', () => {
    it('does not register any commands when store is empty', async () => {
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      expect(config._commands.size).to.equal(0)
    })

    it('registers one command per operation', async () => {
      const spec = makeSpec('petstore', {
        operations: [makeOperation('listPets'), makeOperation('getPet')],
      })
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      expect(config._commands.has('petstore:listPets')).to.be.true
      expect(config._commands.has('petstore:getPet')).to.be.true
    })

    it('registers a topic for each spec', async () => {
      // Empty description so the title is used as fallback
      const spec = makeSpec('petstore', {description: '', operations: [makeOperation('listPets')]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      expect(config._topics.has('petstore')).to.be.true
      expect(config._topics.get('petstore')?.description).to.equal('petstore API')
    })

    it('does not overwrite a topic that already exists', async () => {
      const spec = makeSpec('petstore', {operations: [makeOperation('listPets')]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      config._topics.set('petstore', {description: 'existing', hidden: false, name: 'petstore'})
      await registerApiCommands(config as unknown as Config)
      expect(config._topics.get('petstore')?.description).to.equal('existing')
    })

    it('does not re-register commands that already exist', async () => {
      const spec = makeSpec('petstore', {operations: [makeOperation('listPets')]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      await registerApiCommands(config as unknown as Config)
      expect(config._commands.size).to.equal(1)
    })

    it('stores the correct command id and description', async () => {
      const op = makeOperation('listPets', {description: 'List all pets', method: 'get', path: '/pets'})
      const spec = makeSpec('petstore', {operations: [op]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      const entry = config._commands.get('petstore:listPets')!
      expect(entry.id).to.equal('petstore:listPets')
      expect(entry.description).to.equal('List all pets')
    })

    it('load() returns a class with the correct static id', async () => {
      const spec = makeSpec('petstore', {operations: [makeOperation('listPets')]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      await registerApiCommands(config as unknown as Config)
      const entry = config._commands.get('petstore:listPets')!
      const CmdClass = await entry.load()
      expect((CmdClass as {id?: string}).id).to.equal('petstore:listPets')
    })
  })

  // ─── Dynamic command execution ──────────────────────────────────────────────

  describe('dynamic command execution', () => {
    it('makes a GET request with the correct URL', async () => {
      const op = makeOperation('listPets', {method: 'get', path: '/pets'})
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, [])
      cmd._fetch = makeFetch('[]')
      await cmd.run()
      expect(logs[0]).to.equal('GET https://api.example.com/pets')
    })

    it('interpolates path params into the URL', async () => {
      const op = makeOperation('getPet', {
        method: 'get',
        parameters: [{in: 'path' as const, name: 'id', required: true}],
        path: '/pets/{id}',
      })
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, ['42'])
      cmd._fetch = makeFetch('{}')
      await cmd.run()
      expect(logs[0]).to.equal('GET https://api.example.com/pets/42')
    })

    it('appends optional query params to the URL', async () => {
      const op = makeOperation('listPets', {
        method: 'get',
        parameters: [{description: 'limit', in: 'query' as const, name: 'limit', required: false}],
        path: '/pets',
      })
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, ['--limit', '10'])
      cmd._fetch = makeFetch('[]')
      await cmd.run()
      expect(logs[0]).to.include('limit=10')
    })

    it('uses the selected auth profile for base URL and headers', async () => {
      const op = makeOperation('listPets', {method: 'get', path: '/pets'})
      const requests: Array<{body?: null | string; headers?: Record<string, string>; method?: string}> = []
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, ['-p', 'prod'])
      const pm = createApiAuthManager(cmd.config, 'petstore')
      await pm.saveProfiles({
        prod: {baseUrl: 'https://prod.example.com', scheme: 'bearer', token: 'prod-token', type: 'http'},
      })
      cmd._fetch = async (_url: string, init: (typeof requests)[number]) => {
        requests.push(init)
        return {ok: true, status: 200, statusText: 'OK', text: async () => '[]'}
      }

      await cmd.run()
      expect(logs[0]).to.equal('GET https://prod.example.com/pets')
      expect(requests[0].headers?.Authorization).to.equal('Bearer prod-token')
    })

    it('sends required body params in the POST body', async () => {
      const op = makeOperation('createPet', {
        bodyParams: {name: {required: true, type: 'string'}},
        method: 'post',
        path: '/pets',
      })
      const requests: Array<{body?: null | string; headers?: Record<string, string>; method?: string}> = []
      const {cmd} = await buildDynamicCmd(tmpDir, op, ['Fido'])
      cmd._fetch = async (_url: string, init: (typeof requests)[number]) => {
        requests.push(init)
        return {ok: true, status: 201, statusText: 'Created', text: async () => '{}'}
      }

      await cmd.run()
      expect(requests[0].method).to.equal('POST')
      expect(JSON.parse(requests[0].body ?? '{}')).to.deep.equal({name: 'Fido'})
      expect(requests[0].headers?.['Content-Type']).to.equal('application/json')
    })

    it('formats JSON response with indentation', async () => {
      const op = makeOperation('listPets', {method: 'get', path: '/pets'})
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, [])
      cmd._fetch = makeFetch('[{"id":1}]')
      await cmd.run()
      const responseLog = logs.find((l: string) => l.includes('['))
      expect(responseLog).to.equal(JSON.stringify([{id: 1}], null, 2))
    })

    it('logs plain text for a non-JSON response', async () => {
      const op = makeOperation('ping', {method: 'get', path: '/ping'})
      const {cmd, logs} = await buildDynamicCmd(tmpDir, op, [])
      cmd._fetch = makeFetch('pong')
      await cmd.run()
      expect(logs).to.include('pong')
    })

    it('warns on non-2xx response', async () => {
      const op = makeOperation('getSecret', {method: 'get', path: '/secret'})
      const {cmd, warns} = await buildDynamicCmd(tmpDir, op, [])
      cmd._fetch = makeFetch('Forbidden', {ok: false, status: 403, statusText: 'Forbidden'})
      await cmd.run()
      expect(warns[0]).to.include('403')
    })
  })

  // ─── init hook ──────────────────────────────────────────────────────────────

  describe('init hook', () => {
    it('registers commands via registerApiCommands', async () => {
      const spec = makeSpec('petstore', {operations: [makeOperation('listPets')]})
      await seedStore(tmpDir, [spec])
      const config = makeInternalConfig(tmpDir)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await hook.call({} as never, {argv: [], config: config as unknown as Config, context: {} as any, id: 'init'})
      expect(config._commands.has('petstore:listPets')).to.be.true
    })

    it('swallows errors from registerApiCommands', async () => {
      const config = {
        _commands: new Map(),
        _topics: new Map(),
        bin: 'sdkck',
        configDir: '/dev/null/nonexistent',
        name: 'test',
      } as unknown as Config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await hook.call({} as never, {argv: [], config, context: {} as any, id: 'init'})
      // No error thrown — the hook swallows exceptions from registerApiCommands
    })
  })
})
