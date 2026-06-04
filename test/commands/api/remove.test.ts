import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {readStore} from '../../../src/api-store.js'
import ApiRemove from '../../../src/commands/api/remove.js'
import {makeConfig, makeSpec, runCmd, seedStore} from '../../helpers.js'

describe('api remove', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  it('errors when the spec is not found', async () => {
    const {cliError} = await runCmd(ApiRemove, ['ghost'], makeConfig(tmpDir))
    expect(cliError?.message).to.include('ghost')
  })

  it('removes an existing spec and logs confirmation', async () => {
    await seedStore(tmpDir, [makeSpec('petstore')])
    const {logs} = await runCmd(ApiRemove, ['petstore'], makeConfig(tmpDir))
    expect(logs.join('\n')).to.include('petstore')
    const store = await readStore(tmpDir)
    expect(store.specs.petstore).to.be.undefined
  })

  it('does not affect other specs when removing one', async () => {
    await seedStore(tmpDir, [makeSpec('petstore'), makeSpec('myapi')])
    await runCmd(ApiRemove, ['petstore'], makeConfig(tmpDir))
    const store = await readStore(tmpDir)
    expect(store.specs.myapi).to.exist
    expect(store.specs.petstore).to.be.undefined
  })
})
