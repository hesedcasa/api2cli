import {expect} from 'chai'
import {mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readStore} from '../../../src/api-store.js'
import ApiImport from '../../../src/commands/api/import.js'
import {makeConfig, makeSpec, runCmd, seedStore} from '../../helpers.js'

const MINIMAL_OPENAPI = JSON.stringify({
  info: {description: 'Minimal test API', title: 'Minimal API', version: '1.0.0'},
  openapi: '3.0.0',
  paths: {
    '/items': {
      get: {operationId: 'listItems', responses: {'200': {description: 'ok'}}, summary: 'List items'},
    },
  },
})

describe('api import', () => {
  let tmpDir: string
  let specFile: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
    specFile = join(tmpDir, 'openapi.json')
    await writeFile(specFile, MINIMAL_OPENAPI)
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  it('imports a local OpenAPI file and writes the spec to the store', async () => {
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [specFile, '--name', 'testapi'], config)
    const store = await readStore(tmpDir)
    expect(store.specs.testapi).to.exist
    expect(store.specs.testapi.operations[0].operationId).to.equal('listItems')
  })

  it('derives the spec name from the title when --name is not given', async () => {
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [specFile], config)
    const store = await readStore(tmpDir)
    expect(store.specs['minimal-api']).to.exist
  })

  it('stores the source path on the spec', async () => {
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [specFile, '--name', 'testapi'], config)
    const store = await readStore(tmpDir)
    expect(store.specs.testapi.source).to.equal(specFile)
  })

  it('sets the kind to openapi for non-graphql imports', async () => {
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [specFile, '--name', 'testapi'], config)
    const store = await readStore(tmpDir)
    expect(store.specs.testapi.kind).to.equal('openapi')
  })

  it('errors when a spec with the same name already exists', async () => {
    await seedStore(tmpDir, [makeSpec('testapi')])
    const config = makeConfig(tmpDir)
    const {cliError} = await runCmd(ApiImport, [specFile, '--name', 'testapi'], config)
    expect(cliError?.message).to.include('testapi')
  })

  it('applies --base-url override', async () => {
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [specFile, '--name', 'testapi', '--base-url', 'https://override.example.com'], config)
    const store = await readStore(tmpDir)
    expect(store.specs.testapi.baseUrl).to.equal('https://override.example.com')
  })

  it('imports a GraphQL SDL file', async () => {
    const sdlFile = join(tmpDir, 'schema.graphql')
    await writeFile(sdlFile, 'type Query { hello: String }')
    const config = makeConfig(tmpDir)
    await runCmd(ApiImport, [sdlFile, '--name', 'gqlapi', '--base-url', 'https://gql.example.com/graphql'], config)
    const store = await readStore(tmpDir)
    expect(store.specs.gqlapi).to.exist
    expect(store.specs.gqlapi.kind).to.equal('graphql')
    expect(store.specs.gqlapi.operations[0].operationId).to.equal('hello')
  })
})
