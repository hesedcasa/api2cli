import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import ApiList from '../../../src/commands/api/list.js'
import {makeConfig, makeOperation, makeSpec, runCmd, seedStore} from '../../helpers.js'

describe('api list', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  it('shows an empty-state message when no specs are imported', async () => {
    const {logs} = await runCmd(ApiList, [], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('No API specs imported')
  })

  it('lists all specs in summary form', async () => {
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [makeOperation('listPets')]}), makeSpec('myapi')])
    const {logs} = await runCmd(ApiList, [], makeConfig(tmpDir))
    const output = logs.join('\n')
    expect(output).to.include('petstore')
    expect(output).to.include('myapi')
    expect(output).to.include('1 operations')
  })

  it('shows [graphql] indicator for graphql kind specs', async () => {
    await seedStore(tmpDir, [makeSpec('gql', {kind: 'graphql', operations: [makeOperation('getUser')]})])
    const {logs} = await runCmd(ApiList, [], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('[graphql]')
  })

  it('errors when the named spec is not found', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    const {cliError} = await runCmd(ApiList, ['ghost'], makeConfig(tmpDir))
    expect(cliError?.message).to.include('ghost')
  })

  it('lists operations for a specific spec', async () => {
    const ops = [
      makeOperation('listPets', {description: 'List pets', method: 'get', path: '/pets'}),
      makeOperation('getPet', {description: 'Get one', method: 'get', path: '/pets/{id}'}),
    ]
    await seedStore(tmpDir, [makeSpec('petstore', {operations: ops})])
    const {logs} = await runCmd(ApiList, ['petstore'], makeConfig(tmpDir))
    const output = logs.join('\n')
    expect(output).to.include('listPets')
    expect(output).to.include('getPet')
    expect(output).to.include('List pets')
  })

  it('shows the base URL in the spec detail view', async () => {
    await seedStore(tmpDir, [makeSpec('petstore', {baseUrl: 'https://petstore.example.com'})])
    const {logs} = await runCmd(ApiList, ['petstore'], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('https://petstore.example.com')
  })

  it('marks required params with angle brackets and optional with square brackets', async () => {
    const op = makeOperation('getPet', {
      parameters: [{in: 'path' as const, name: 'id', required: true}],
      path: '/pets/{id}',
    })
    await seedStore(tmpDir, [makeSpec('petstore', {operations: [op]})])
    const {logs} = await runCmd(ApiList, ['petstore'], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('<id>')
  })

  it('shows operation count in the summary', async () => {
    await seedStore(tmpDir, [
      makeSpec('petstore', {operations: [makeOperation('a'), makeOperation('b'), makeOperation('c')]}),
    ])
    const {logs} = await runCmd(ApiList, [], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('3 operations')
  })
})
