import {expect} from 'chai'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {cleanupRun, RUN_ID, RUN_PREFIX, seedIssue} from './fixtures.js'
import {getSharedConfigDir, removeConfigDir, runCliJson, runCliOk, stripRequestLine} from './helpers.js'

type Issue = {id: string; identifier: string; title: string}
type IssueConnection = {nodes: Issue[]; pageInfo: {endCursor?: null | string; hasNextPage: boolean}}

describe('e2e: read paths', () => {
  let configDir: string
  let seededKey: string
  let secondKey: string

  // Two fixtures, not one: with a single issue a `--first 1` assertion passes
  // whether or not --first works.
  before(async function (this: Mocha.Context) {
    this.timeout(300_000)
    configDir = await getSharedConfigDir()
    const first = await seedIssue({title: `${RUN_PREFIX} read one`})
    const second = await seedIssue({title: `${RUN_PREFIX} read two`})
    seededKey = first.id
    secondKey = second.id
  })

  // allSettled + finally: a failed cleanup must not leave the token-bearing
  // shared dir dangling without its fixtures reclaimed.
  after(async () => {
    await cleanupRun()
  })

  it('finds the seeded issues by title filter', async () => {
    const payload = await runCliJson<{data: {issues: IssueConnection}}>(
      ['linear', 'issues', '--filter', JSON.stringify({title: {startsWith: RUN_PREFIX}})],
      configDir,
    )
    const ids = payload.data.issues.nodes.map((issue) => issue.id)
    expect(ids).to.include(seededKey)
    expect(ids).to.include(secondKey)
  })

  // Scoped to this file's own prefix so the count is deterministic, and paired
  // with an unbounded search so the capped result is only reachable if --first
  // works.
  it('honours --first', async () => {
    const unbounded = await runCliJson<{data: {issues: IssueConnection}}>(
      ['linear', 'issues', '--filter', JSON.stringify({title: {startsWith: RUN_PREFIX}})],
      configDir,
    )
    expect(unbounded.data.issues.nodes, 'both fixtures should be visible').to.have.lengthOf(2)

    const capped = await runCliJson<{data: {issues: IssueConnection}}>(
      ['linear', 'issues', '--filter', JSON.stringify({title: {startsWith: RUN_PREFIX}}), '--first', '1'],
      configDir,
    )
    expect(capped.data.issues.nodes).to.have.lengthOf(1)
  })

  // Two pages of one issue each must together cover both seeded keys with no
  // overlap — the regression class this closes is a broken/ignored pagination
  // variable (here: --after carrying the cursor).
  it('pages through results with --first and --after', async () => {
    const firstPage = await runCliJson<{data: {issues: IssueConnection}}>(
      ['linear', 'issues', '--filter', JSON.stringify({title: {startsWith: RUN_PREFIX}}), '--first', '1'],
      configDir,
    )
    expect(firstPage.data.issues.nodes).to.have.lengthOf(1)
    expect(firstPage.data.issues.pageInfo.hasNextPage, 'expected a second page').to.be.true
    expect(firstPage.data.issues.pageInfo.endCursor).to.be.a('string')

    const secondPage = await runCliJson<{data: {issues: IssueConnection}}>(
      [
        'linear',
        'issues',
        '--filter',
        JSON.stringify({title: {startsWith: RUN_PREFIX}}),
        '--first',
        '1',
        '--after',
        firstPage.data.issues.pageInfo.endCursor!,
      ],
      configDir,
    )
    expect(secondPage.data.issues.nodes).to.have.lengthOf(1)

    const seenIds = [firstPage.data.issues.nodes[0].id, secondPage.data.issues.nodes[0].id]
    expect(seenIds).to.have.members([seededKey, secondKey])
  })

  it('reads a single issue and includes the run id in the title', async () => {
    const payload = await runCliJson<{data: {issue: Issue}}>(['linear', 'issue', seededKey], configDir)
    expect(payload.data.issue.title).to.contain(RUN_ID)
  })

  it('returns an empty Vercel project list as a success', async () => {
    // The sandbox account owns no projects, so this empty result is a stable
    // target (the role KAN plays in the unit suite) — and the response shape
    // still proves the call, auth and query-param routing all worked.
    const payload = await runCliJson<{pagination: {count: number}; projects: unknown[]}>(
      ['api', 'call', 'vercel', 'getProjects'],
      configDir,
    )
    expect(payload.projects).to.deep.equal([])
    expect(payload.pagination.count).to.equal(0)
  })

  it('searches Context7 libraries', async () => {
    // libraryName and query are both required query params, so both arrive as
    // positional args in spec order.
    const payload = await runCliJson<{results: Array<{id: string; title: string}>}>(
      ['context7', 'searchLibraries', 'react', 'state management', '--fast', 'true'],
      configDir,
    )
    expect(payload.results.length).to.be.at.least(1)
    expect(payload.results[0].id).to.be.a('string')
  })

  it('streams a non-JSON response through unmodified', async () => {
    // getContext defaults to type=txt, a markdown document — the only part of
    // the suite that exercises the parse-failure passthrough in call.ts.
    const {stdout} = await runCliOk(['context7', 'getContext', '/vercel/next.js', 'app router setup'], configDir)
    const body = stripRequestLine(stdout)
    expect(body).to.have.lengthOf.at.least(100)
    expect(() => JSON.parse(body)).to.throw()
  })

  it('writes the raw response body to a file with --output', async () => {
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'api2cli-e2e-out-'))
    try {
      // getLibraryMetrics would be the natural target, but the sandbox key is
      // not a library owner — Context7 answers it 403 ("Library owners only").
      const target = path.join(workDir, 'search.json')
      const result = await runCliOk(
        [
          'api',
          'call',
          'context7',
          'searchLibraries',
          '--param',
          'libraryName=react',
          '--param',
          'query=hooks',
          '-o',
          target,
        ],
        configDir,
      )
      expect(result.code).to.equal(0)
      // --output writes the bytes without also pretty-printing them.
      expect(result.stdout).to.contain('Saved')

      const onDisk = JSON.parse(await fs.readFile(target, 'utf8')) as {results: unknown[]}
      expect(onDisk.results).to.be.an('array').with.lengthOf.at.least(1)
    } finally {
      await removeConfigDir(workDir)
    }
  })

  it('emits TOON rather than JSON under --toon', async () => {
    const {stdout} = await runCliOk(['linear', 'viewer', '--toon'], configDir)
    const body = stripRequestLine(stdout)
    expect(() => JSON.parse(body)).to.throw()
    expect(body).to.contain('viewer')
    expect(body).to.contain('data:')
  })
})
