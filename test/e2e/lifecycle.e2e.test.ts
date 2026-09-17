import {expect} from 'chai'

import {cleanupRun, deleteIssue, findIssuesByTitle, getTeamId, issueTrashState, RUN_ID, RUN_PREFIX} from './fixtures.js'
import {getSharedConfigDir, runCli, runCliJson} from './helpers.js'

type IssuePayload = {
  data: {
    issue: {archivedAt: null | string; identifier: string; title: string; trashed: boolean | null}
    issueCreate?: {issue: {id: string; identifier: string; title: string}}
    issueDelete?: {entity: {id: string; identifier: string; title: string; trashed: boolean | null}}
    issueUpdate?: {issue: {id: string; title: string}}
  }
}

describe('e2e: issue lifecycle', () => {
  let configDir: string
  const created: string[] = []

  before(async function (this: Mocha.Context) {
    this.timeout(300_000)
    configDir = await getSharedConfigDir()
  })

  // allSettled-style backstop: every issue created here carries the run
  // prefix, so cleanupRun reclaims them even if a test dies mid-lifecycle —
  // the CLI-created fixtures are folded into the same guarantee the raw-fetch
  // oracle provides.
  after(async () => {
    await cleanupRun()
  })

  /**
   * Creates an issue through the CLI's own dynamic mutation command.
   *
   * Unlike fixtures.seedIssue this is the code path under test, so failures
   * here are failures — but the run-prefix title keeps it reclaimable.
   */
  async function createIssueViaCli(name: string): Promise<{id: string; identifier: string; title: string}> {
    const input = JSON.stringify({
      description: 'created by the api2cli e2e suite',
      teamId: await getTeamId(),
      title: `${RUN_PREFIX} lifecycle ${name}`,
    })
    const payload = await runCliJson<IssuePayload>(['linear', 'issueCreate', input], configDir)
    const {issue} = payload.data.issueCreate!
    created.push(issue.id)
    return issue
  }

  it('creates an issue and reads it back', async () => {
    const createdIssue = await createIssueViaCli('create')
    expect(createdIssue.title).to.contain(RUN_ID)
    expect(createdIssue.identifier).to.include('-')

    const fetched = await runCliJson<IssuePayload>(['linear', 'issue', createdIssue.id], configDir)
    expect(fetched.data.issue.identifier).to.equal(createdIssue.identifier)
    expect(fetched.data.issue.title).to.contain('lifecycle create')
  })

  it('updates the title', async () => {
    const issue = await createIssueViaCli('update')
    const updated = `${RUN_PREFIX} lifecycle updated`

    const payload = await runCliJson<IssuePayload>(
      ['linear', 'issueUpdate', issue.id, JSON.stringify({title: updated})],
      configDir,
    )
    expect(payload.data.issueUpdate!.issue.title).to.equal(updated)

    const fetched = await runCliJson<IssuePayload>(['linear', 'issue', issue.id], configDir)
    expect(fetched.data.issue.title).to.equal(updated)
  })

  it('rejects a mutation with malformed input JSON without corrupting state', async () => {
    const issue = await createIssueViaCli('guard')
    // A non-object where IssueUpdateInput is expected — argv coercion leaves
    // the string as-is and Linear rejects it. The issue itself must be
    // untouched.
    const result = await runCli(['linear', 'issueUpdate', issue.id, 'not-json'], configDir)
    expect(result.code).to.equal(0) // PINNED: GraphQL errors are HTTP 200 + errors body
    expect(result.stdout).to.contain('errors')

    const fetched = await runCliJson<IssuePayload>(['linear', 'issue', issue.id], configDir)
    expect(fetched.data.issue.title).to.contain('lifecycle guard')
  })

  it('deletes the issue, which Linear soft-deletes rather than removes', async () => {
    const issue = await createIssueViaCli('delete')

    const payload = await runCliJson<IssuePayload>(['linear', 'issueDelete', issue.id], configDir)
    // DeleteEntity is an interface, so the generated selection expands to the
    // concrete Issue fields (probed live: the full scalar set, minus
    // __typename, which the converter never requests). The deleted issue's own
    // fields come back — enough to prove the mutation landed on the right
    // issue, and the first place `trashed: true` shows up.
    expect(payload.data.issueDelete!.entity.id).to.equal(issue.id)
    expect(payload.data.issueDelete!.entity.trashed).to.be.true

    // Unlike Jira's hard 404, Linear keeps soft-deleted issues readable during
    // its ~30-day grace period. PINNED AS OBSERVED: the deleted issue reads
    // back with archivedAt set and trashed true, and the default issues filter
    // stops returning it (asserted in fixtures.e2e).
    const fetched = await runCliJson<IssuePayload>(['linear', 'issue', issue.id], configDir)
    expect(fetched.data.issue.archivedAt).to.be.a('string')
    expect(fetched.data.issue.trashed).to.be.true

    const state = await issueTrashState(issue.id)
    expect(state?.trashed).to.be.true
  })

  it('reclaims its own fixture through cleanupRun', async () => {
    const issue = await createIssueViaCli('cleanup')
    // Linear renders unset booleans as null, not false — "not trashed" is
    // `.to.not.be.true` (see fixtures.e2e).
    expect((await issueTrashState(issue.id))?.trashed).to.not.be.true

    await deleteIssue(issue.id)

    const found = await findIssuesByTitle(RUN_PREFIX)
    expect(found).to.not.include(issue.id)
  })
})
