import {expect} from 'chai'

import {
  cleanupRun,
  deleteIssue,
  findIssuesByTitle,
  issueTrashState,
  RUN_PREFIX,
  seedIssue,
  sweepStale,
} from './fixtures.js'

describe('e2e: fixtures', () => {
  it('seeds an issue that is findable by its run prefix, then cleans up', async () => {
    const seeded = await seedIssue()
    expect(seeded.title.startsWith(RUN_PREFIX), `unexpected title: ${seeded.title}`).to.be.true
    // Linear identifiers look like HES-7 — no regex literals in test/** (see CLAUDE.md).
    expect(seeded.identifier).to.include('-')

    const found = await findIssuesByTitle(RUN_PREFIX)
    expect(found).to.include(seeded.id)

    await cleanupRun()

    const afterCleanup = await findIssuesByTitle(RUN_PREFIX)
    expect(afterCleanup).to.not.include(seeded.id)
  })

  it('tolerates deleting an issue twice', async () => {
    const seeded = await seedIssue()
    await deleteIssue(seeded.id)
    // Linear soft-deletes, and its issueDelete mutation reports success even
    // for an issue that is already trashed — this pins that contract, since
    // cleanupRun can race a test that deletes its own fixture first.
    await deleteIssue(seeded.id)
  })

  it('marks a deleted fixture as trashed for the oracle', async () => {
    const seeded = await seedIssue()
    // Linear renders unset booleans as null, not false (probed live), so
    // "not trashed" is `.to.not.be.true` — `false` would never hold.
    expect((await issueTrashState(seeded.id))?.trashed).to.not.be.true

    await deleteIssue(seeded.id)

    const state = await issueTrashState(seeded.id)
    expect(state?.trashed, 'deleted issue should read back as trashed').to.be.true
    expect(state?.archivedAt).to.be.a('string')
  })

  it('sweepStale leaves fresh fixtures alone', async () => {
    const seeded = await seedIssue()

    // The one-hour cutoff cannot reach a fixture created moments ago, so the
    // count this run contributed is zero. A single allSettled-style deletion
    // is still possible from a concurrent process, but its fixtures would
    // carry a different run prefix and not this issue's.
    const stateBefore = await issueTrashState(seeded.id)
    expect(stateBefore?.trashed).to.not.be.true

    await sweepStale()

    const stateAfter = await issueTrashState(seeded.id)
    expect(stateAfter?.trashed, 'sweepStale must not touch fresh fixtures').to.not.be.true
  })

  after(async () => {
    await cleanupRun()
  })
})
