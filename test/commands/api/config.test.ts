import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readStore} from '../../../src/api-store.js'
import ApiConfig from '../../../src/commands/api/config.js'
import {makeConfig, makeSpec, runCmd, seedStore} from '../../helpers.js'

describe('api config', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  it('errors when no update flags are provided', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    const {cliError} = await runCmd(ApiConfig, ['petstore'], makeConfig(tmpDir))
    expect(cliError?.message).to.include('at least one flag')
  })

  it('errors when the spec is not found', async () => {
    const {cliError} = await runCmd(ApiConfig, ['ghost', '--base-url', 'https://x.com'], makeConfig(tmpDir))
    expect(cliError?.message).to.include('ghost')
  })

  it('updates the base URL', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    await runCmd(ApiConfig, ['petstore', '--base-url', 'https://new.example.com'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.petstore.baseUrl).to.equal('https://new.example.com')
  })

  it('updates the title', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    await runCmd(ApiConfig, ['petstore', '--title', 'My Petstore'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.petstore.title).to.equal('My Petstore')
  })

  it('updates the description', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    await runCmd(ApiConfig, ['petstore', '--description', 'A pet API'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.petstore.description).to.equal('A pet API')
  })

  it('updates the insecure flag', async () => {
    await seedStore(tmpDir, [makeSpec('petstore', {insecure: false})])
    await runCmd(ApiConfig, ['petstore', '--insecure'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.petstore.insecure).to.be.true
  })

  it('renames a spec and removes the old entry', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    await runCmd(ApiConfig, ['petstore', '--rename', 'store'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.store).to.exist
    expect(store.specs.petstore).to.be.undefined
  })

  it('errors when the rename target already exists', async () => {
    await seedStore(tmpDir, [makeSpec('petstore'), makeSpec('store')])
    const {cliError} = await runCmd(ApiConfig, ['petstore', '--rename', 'store'], makeConfig(tmpDir))
    expect(cliError?.message).to.include('store')
  })

  it('logs the updated name after rename', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    const {logs} = await runCmd(ApiConfig, ['petstore', '--rename', 'store'], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('store')
  })
})
