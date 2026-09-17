import {expect} from 'chai'

import {
  CONTEXT7_SPEC_URL,
  createConfigDir,
  LINEAR_GRAPHQL_URL,
  LINEAR_SCHEMA_URL,
  removeConfigDir,
  requireEnv,
  runCli,
  runCliJson,
  runCliOk,
  VERCEL_SPEC_URL,
} from './helpers.js'

describe('e2e: import', () => {
  let configDir: string

  before(async () => {
    configDir = await createConfigDir('api2cli-e2e-import-')
  })

  after(async () => {
    await removeConfigDir(configDir)
  })

  // The three commands under test, verbatim from the brief. Each import hits
  // the network for the spec (the Linear SDL alone is several MB) and converts
  // it, so the hooks get a generous timeout.
  describe('imports the three specs with their brief commands', () => {
    before(async function (this: Mocha.Context) {
      this.timeout(600_000)

      await runCliOk(
        ['api', 'import', LINEAR_SCHEMA_URL, '--name', 'linear', '--base-url', LINEAR_GRAPHQL_URL],
        configDir,
      )
      await runCliOk(['api', 'import', VERCEL_SPEC_URL, '--name', 'vercel'], configDir)
      await runCliOk(['api', 'import', CONTEXT7_SPEC_URL, '--name', 'context7'], configDir)
    })

    it('imports the Linear GraphQL schema as a graphql-kind spec', async () => {
      const {stdout} = await runCli(['api', 'list', 'linear'], configDir)
      expect(stdout).to.contain('GraphQL API (linear)')
      expect(stdout).to.contain(`Base URL: ${LINEAR_GRAPHQL_URL}`)
      // The brief's command passes no auth flags — auth is added separately below.
      expect(stdout).to.contain('Auth    : none')
      expect(stdout).to.contain('Operations (')
    })

    it('imports the Vercel OpenAPI spec', async () => {
      const {stdout} = await runCli(['api', 'list', 'vercel'], configDir)
      expect(stdout).to.contain('Vercel API (vercel)')
      expect(stdout).to.contain('Base URL: https://api.vercel.com')
      // Spot-check operations the rest of the suite drives.
      expect(stdout).to.contain('getProjects')
      expect(stdout).to.contain('getAuthUser')
    })

    it('imports the Context7 OpenAPI spec', async () => {
      const {stdout} = await runCli(['api', 'list', 'context7'], configDir)
      expect(stdout).to.contain('Context7 Public API (context7)')
      expect(stdout).to.contain('Base URL: https://context7.com/api')
      expect(stdout).to.contain('searchLibraries')
      expect(stdout).to.contain('getContext')
    })

    it('refuses a duplicate spec name', async () => {
      const result = await runCli(['api', 'import', VERCEL_SPEC_URL, '--name', 'vercel'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('already exists')
    })

    it('shows all three specs in `api list`', async () => {
      const {stdout} = await runCli(['api', 'list'], configDir)
      expect(stdout).to.contain('linear [graphql]')
      expect(stdout).to.contain('vercel:')
      expect(stdout).to.contain('context7:')
    })
  })

  describe('auth', () => {
    before(async function (this: Mocha.Context) {
      // Auth is added here rather than via hand-written profile files so the
      // `api auth add` path is exercised too. The imports above must have run.
      this.timeout(300_000)
      const {context7, linear, vercel} = requireEnv()

      await runCliOk(
        ['api', 'auth', 'add', 'linear', '--type', 'apikey', '--api-key', linear, '--api-key-header', 'Authorization'],
        configDir,
      )
      await runCliOk(['api', 'auth', 'add', 'vercel', '--type', 'bearer', '--token', vercel], configDir)
      await runCliOk(['api', 'auth', 'add', 'context7', '--type', 'bearer', '--token', context7], configDir)
    })

    it('refuses to add the same profile twice', async () => {
      const result = await runCli(
        [
          'api',
          'auth',
          'add',
          'linear',
          '--type',
          'apikey',
          '--api-key',
          'whatever',
          '--api-key-header',
          'Authorization',
        ],
        configDir,
      )
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('already exists')
    })

    it('calls each freshly imported API end to end', async () => {
      const linear = await runCliJson<{data: {viewer: {id: string}}}>(['api', 'call', 'linear', 'viewer'], configDir)
      expect(linear.data.viewer.id).to.be.a('string')

      const vercel = await runCliJson<{user: {id: string}}>(['api', 'call', 'vercel', 'getAuthUser'], configDir)
      expect(vercel.user.id).to.be.a('string')

      // `api call` takes no positional parameters — required query params go
      // through the repeatable --param flag.
      const context7 = await runCliJson<{results: unknown[]}>(
        ['api', 'call', 'context7', 'searchLibraries', '--param', 'libraryName=react', '--param', 'query=hooks'],
        configDir,
      )
      expect(context7.results).to.have.lengthOf.at.least(1)
    })
  })

  describe('removal', () => {
    before(async function (this: Mocha.Context) {
      this.timeout(300_000)
      // Every other test in this file may have run before us, so removal
      // operates on whatever is left — removing all three makes the
      // assertions below order-independent.
      for (const name of ['linear', 'vercel', 'context7']) {
        // Sequential on purpose: each `api remove` rewrites the store file, so
        // concurrent CLI processes would race the read-modify-write.
        await runCli(['api', 'remove', name], configDir)
      }
    })

    it('removes a spec and its auth file together', async () => {
      const {stdout} = await runCli(['api', 'list'], configDir)
      expect(stdout).to.not.contain('linear')
      expect(stdout).to.not.contain('vercel')
      expect(stdout).to.not.contain('context7')
    })

    it('reports "No API specs imported yet" once everything is gone', async () => {
      const {stdout} = await runCli(['api', 'list'], configDir)
      expect(stdout).to.contain('No API specs imported yet')
    })

    it('errors when removing an unknown spec', async () => {
      const result = await runCli(['api', 'remove', 'linear'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('No spec found with name "linear"')
    })

    it('fails calls against a removed spec', async () => {
      const result = await runCli(['api', 'call', 'vercel', 'getAuthUser'], configDir)
      expect(result.code).to.equal(2)
      expect(result.stderr).to.contain('No spec found with name "vercel"')
    })
  })
})
