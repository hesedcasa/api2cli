import {expect} from 'chai'
import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import AuthAdd from '../../../src/commands/api/auth/add.js'
import AuthDelete from '../../../src/commands/api/auth/delete.js'
import AuthList from '../../../src/commands/api/auth/list.js'
import AuthProfile from '../../../src/commands/api/auth/profile.js'
import AuthUpdate from '../../../src/commands/api/auth/update.js'
import {makeConfig, makeSpec, runCmd, seedStore} from '../../helpers.js'

describe('api auth', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'api2cli-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, {recursive: true})
  })

  // ─── auth add ──────────────────────────────────────────────────────────────

  describe('auth add', () => {
    it('errors when the API is not found', async () => {
      const {cliError} = await runCmd(AuthAdd, ['ghost', '--type', 'none'], makeConfig(tmpDir))
      expect(cliError?.message).to.include('ghost')
    })

    it('adds a bearer profile and logs confirmation', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {logs} = await runCmd(AuthAdd, ['petstore', '--type', 'bearer', '--token', 'tok123'], makeConfig(tmpDir))
      expect(logs.join('\n')).to.include('default')
      expect(logs.join('\n')).to.include('bearer')
    })

    it('adds an apikey profile', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {logs} = await runCmd(AuthAdd, ['petstore', '--type', 'apikey', '--api-key', 'my-key'], makeConfig(tmpDir))
      expect(logs.join('\n')).to.include('apikey')
    })

    it('errors when the profile already exists', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      const {cliError} = await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      expect(cliError?.message).to.include('already exists')
    })

    it('supports a custom profile name via -p', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {logs} = await runCmd(
        AuthAdd,
        ['petstore', '--type', 'bearer', '--token', 'tok', '-p', 'prod'],
        makeConfig(tmpDir),
      )
      expect(logs.join('\n')).to.include('prod')
    })
  })

  // ─── auth list ─────────────────────────────────────────────────────────────

  describe('auth list', () => {
    it('errors when the API is not found', async () => {
      const {cliError} = await runCmd(AuthList, ['ghost'], makeConfig(tmpDir))
      expect(cliError?.message).to.include('ghost')
    })

    it('shows empty-state message when no profiles exist', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {logs} = await runCmd(AuthList, ['petstore'], makeConfig(tmpDir))
      expect(logs.join('\n')).to.include('No auth profiles')
    })

    it('lists profiles with redacted secrets', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'bearer', '--token', 'tok-secret-value'], config)
      const {logs} = await runCmd(AuthList, ['petstore'], config)
      const output = logs.join('\n')
      expect(output).to.include('bearer')
      expect(output).to.not.include('tok-secret-value')
    })

    it('marks the default profile', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      const {logs} = await runCmd(AuthList, ['petstore'], config)
      expect(logs.join('\n')).to.include('default')
    })
  })

  // ─── auth delete ───────────────────────────────────────────────────────────

  describe('auth delete', () => {
    it('errors when the API is not found', async () => {
      const {cliError} = await runCmd(AuthDelete, ['ghost'], makeConfig(tmpDir))
      expect(cliError?.message).to.include('ghost')
    })

    it('errors when the profile does not exist', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {cliError} = await runCmd(AuthDelete, ['petstore'], makeConfig(tmpDir))
      expect(cliError?.message).to.not.be.undefined
    })

    it('deletes an existing profile and logs confirmation', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      const {logs} = await runCmd(AuthDelete, ['petstore'], config)
      expect(logs.join('\n')).to.include('default')
    })

    it('deletes a named profile via -p', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none', '-p', 'staging'], config)
      const {logs} = await runCmd(AuthDelete, ['petstore', '-p', 'staging'], config)
      expect(logs.join('\n')).to.include('staging')
    })
  })

  // ─── auth update ───────────────────────────────────────────────────────────

  describe('auth update', () => {
    it('errors when the API is not found', async () => {
      const {cliError} = await runCmd(AuthUpdate, ['ghost', '--type', 'none'], makeConfig(tmpDir))
      expect(cliError?.message).to.include('ghost')
    })

    it('errors when the profile does not exist', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {cliError} = await runCmd(
        AuthUpdate,
        ['petstore', '--type', 'bearer', '--token', 'new'],
        makeConfig(tmpDir),
      )
      expect(cliError?.message).to.include('default')
    })

    it('updates an existing profile and logs confirmation', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      const {logs} = await runCmd(AuthUpdate, ['petstore', '--type', 'bearer', '--token', 'newtok'], config)
      expect(logs.join('\n')).to.include('bearer')
    })
  })

  // ─── auth profile ──────────────────────────────────────────────────────────

  describe('auth profile', () => {
    it('errors when the API is not found', async () => {
      const {cliError} = await runCmd(AuthProfile, ['ghost'], makeConfig(tmpDir))
      expect(cliError?.message).to.include('ghost')
    })

    it('shows message when no default profile is set', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const {logs} = await runCmd(AuthProfile, ['petstore'], makeConfig(tmpDir))
      expect(logs.join('\n')).to.include('No default profile')
    })

    it('prints the default profile name', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none'], config)
      const {logs} = await runCmd(AuthProfile, ['petstore'], config)
      expect(logs.join('\n')).to.include('default')
    })

    it('sets the default profile via --default flag', async () => {
      await seedStore(tmpDir, [makeSpec('petstore')])
      const config = makeConfig(tmpDir)
      await runCmd(AuthAdd, ['petstore', '--type', 'none', '-p', 'prod'], config)
      const {logs} = await runCmd(AuthProfile, ['petstore', '--default', 'prod'], config)
      expect(logs.join('\n')).to.include('prod')
    })
  })
})
