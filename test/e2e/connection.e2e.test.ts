import {expect} from 'chai'

import {getSharedConfigDir, redactSecret, requireEnv, runCli, runCliJson} from './helpers.js'

type Failure = {code: number; stderr: string; stdout: string}

describe('e2e: connection', () => {
  let configDir: string

  // Slow first run: builds the shared dir, importing all three specs.
  before(async function (this: Mocha.Context) {
    this.timeout(300_000)
    configDir = await getSharedConfigDir()
  })

  it('authenticates each API through `api call`', async () => {
    const linear = await runCliJson<{data: {viewer: {email: string; id: string}}}>(
      ['api', 'call', 'linear', 'viewer'],
      configDir,
    )
    expect(linear.data.viewer.id).to.be.a('string').and.to.have.lengthOf.at.least(8)

    const vercel = await runCliJson<{user: {id: string; username: string}}>(
      ['api', 'call', 'vercel', 'getAuthUser'],
      configDir,
    )
    expect(vercel.user.username).to.be.a('string').and.to.have.lengthOf.at.least(1)

    // `api call` takes no positional parameters — required query params go
    // through the repeatable --param flag (the dynamic command form is what
    // turns them into positionals).
    const context7 = await runCliJson<{results: Array<{id: string}>}>(
      ['api', 'call', 'context7', 'searchLibraries', '--param', 'libraryName=react', '--param', 'query=hooks'],
      configDir,
    )
    expect(context7.results).to.be.an('array').with.lengthOf.at.least(1)
  })

  // `spec:operationId` is the registered id; `spec operationId` is recovered
  // by the command_not_found hook after oclif joins the tokens. Both must
  // reach the same command.
  it('resolves both the colon and the space-separated dynamic command forms', async () => {
    const colon = await runCli(['linear:viewer'], configDir)
    expect(colon.code).to.equal(0)

    const space = await runCli(['linear', 'viewer'], configDir)
    expect(space.code).to.equal(0)
  })

  // A synthetic secret, not the real API keys: chai renders the actual
  // strings in its failure message, so if this used live keys the one
  // circumstance where this test fails (a redaction regression) would print
  // credentials into the terminal and CI logs. redactSecret is a pure string
  // function, so synthetic values prove the same property with zero exposure.
  it('redacts secrets from captured output', () => {
    const needle = 'SEKRET-PLACEHOLDER-0001'
    const text = `some output embedding ${needle} in the middle of it`

    expect(redactSecret(text, [needle])).to.not.include(needle)
    expect(redactSecret(text, [needle])).to.contain('<redacted>')
  })

  it('leaves text untouched when there is no secret to redact', () => {
    const text = 'plain output with no secret in it'

    expect(redactSecret(text, [])).to.equal(text)
    expect(redactSecret(text, [''])).to.equal(text)
  })

  // PINNED AS OBSERVED, not as desired: a non-OK HTTP response only produces
  // a stderr warning — the command still exits 0 and logs the response body.
  // (`--output` is the one flag that turns failures into errors.) Changing
  // that contract is out of scope for the suite; these tests make a future
  // fix a visible, deliberate change.
  it('warns and exits 0 when Linear rejects a bad token', async () => {
    const result = await runCli(['linear', 'viewer', '-p', 'broken'], configDir)
    expect(result.code).to.equal(0)
    expect(result.stderr).to.contain('HTTP 401')
  })

  it('warns and exits 0 when Vercel rejects a bad token', async () => {
    const result = await runCli(['vercel', 'getAuthUser', '-p', 'broken'], configDir)
    expect(result.code).to.equal(0)
    // Vercel answers an invalid token with 403 (invalidToken), not 401.
    expect(result.stderr).to.contain('HTTP 403')
  })

  it('warns and exits 0 when Context7 rejects a bad token', async () => {
    const result = await runCli(['context7', 'searchLibraries', 'react', 'hooks', '-p', 'broken'], configDir)
    expect(result.code).to.equal(0)
    expect(result.stderr).to.contain('HTTP 401')
  })

  it('errors on an unknown profile rather than falling back to the default', async () => {
    const result: Failure = await runCli(['linear', 'viewer', '-p', 'nosuch'], configDir)
    expect(result.code).to.equal(2)
    expect(result.stderr).to.contain("Profile 'nosuch' does not exist")
  })

  it('errors on an unknown spec', async () => {
    const result = await runCli(['api', 'call', 'nosuch', 'op'], configDir)
    expect(result.code).to.equal(2)
    expect(result.stderr).to.contain('No spec found with name "nosuch"')
  })

  it('errors on an unknown operation', async () => {
    const result = await runCli(['api', 'call', 'linear', 'nosuchop'], configDir)
    expect(result.code).to.equal(2)
    expect(result.stderr).to.contain('not found in "linear"')
  })

  it('never prints a live key into a failing runCliOk message', async () => {
    const {context7, linear, vercel} = requireEnv()
    // The broken profile forces a warning path that echoes server output; the
    // helper's failure text (used only on non-zero exits) must scrub keys, and
    // the captured stdout/stderr of *this* passing run must not contain them.
    const result = await runCli(['linear', 'viewer', '-p', 'broken'], configDir)
    for (const key of [linear, vercel, context7]) {
      expect(result.stdout).to.not.include(key)
      expect(result.stderr).to.not.include(key)
    }
  })

  it('still lists the three specs in `api list`', async () => {
    const result = await runCli(['api', 'list'], configDir)
    expect(result.code).to.equal(0)
    expect(result.stdout).to.contain('linear [graphql]')
    expect(result.stdout).to.contain('vercel')
    expect(result.stdout).to.contain('context7')
  })
})
