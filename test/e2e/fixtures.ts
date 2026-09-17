import {randomBytes} from 'node:crypto'

import {requireEnv} from './helpers.js'

/**
 * One prefix per mocha process, so concurrent runs never delete each other's
 * fixtures.
 *
 * E2E_RUN_ID overrides it so a *separate* process can address this run's
 * fixtures by title — `scripts/e2e.sh` and the CI workflow both set it, which
 * is what lets their post-run sweep reclaim fixtures a killed mocha never got
 * to clean up.
 */
export const RUN_ID = process.env.E2E_RUN_ID || randomBytes(4).toString('hex')
/** Every fixture issue is titled with this prefix. */
export const RUN_PREFIX = `[e2e ${RUN_ID}]`
/** Carried by every fixture ever created, so a crashed run can be reclaimed later. */
export const SHARED_PREFIX = '[e2e '

// ─── Raw GraphQL access (the oracle) ─────────────────────────────────────────

type LinearResponse<T> = {body: T; status: number}

/**
 * POSTs a GraphQL document to Linear directly, bypassing the CLI entirely.
 *
 * Fixtures are never created through the CLI: they are the oracle the CLI is
 * checked against, so they must not share its code path. Linear authenticates
 * with the raw API key in the Authorization header (no Bearer prefix).
 */
export async function linearGql<T = Record<string, unknown>>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<LinearResponse<T>> {
  const {linear} = requireEnv()
  const response = await fetch('https://api.linear.app/graphql', {
    body: JSON.stringify({query, variables}),
    headers: {authorization: linear, 'content-type': 'application/json'},
    method: 'POST',
  })

  const text = await response.text()
  if (response.status !== 200) {
    throw new Error(`linearGql failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  return {body: JSON.parse(text) as T, status: response.status}
}

type GqlErrors = {errors?: Array<{message: string}>}

/** Extracts `body.errors` messages from a GraphQL response, if any. */
function gqlErrorMessages(body: unknown): string[] {
  const {errors} = body as GqlErrors
  return (errors ?? []).map((error) => error.message)
}

/**
 * Resolves the first team in the workspace.
 *
 * Linear requires a teamId to create an issue, and the team is a property of
 * the account rather than something this suite should create or delete, so it
 * is discovered once and memoized.
 */
let teamIdPromise: Promise<string> | undefined

export function getTeamId(): Promise<string> {
  teamIdPromise ??= (async () => {
    const {body} = await linearGql<{data?: {teams?: {nodes?: Array<{id: string}>}}}>(
      'query { teams(first: 1) { nodes { id } } }',
    )
    const id = body.data?.teams?.nodes?.[0]?.id
    if (!id) throw new Error(`getTeamId: no teams found: ${JSON.stringify(body)}`)
    return id
  })()
  return teamIdPromise
}

// ─── Seeding and lookup ──────────────────────────────────────────────────────

type SeededIssue = {id: string; identifier: string; title: string}

/**
 * Creates a fixture issue via the REST-ish GraphQL API directly.
 *
 * The title always carries the run prefix; `overrides` replaces or extends the
 * rest of the IssueCreateInput.
 *
 * @param overrides Extra or replacement IssueCreateInput fields.
 * @returns The created issue's id, identifier and title.
 */
export async function seedIssue(overrides: Record<string, unknown> = {}): Promise<SeededIssue> {
  const teamId = await getTeamId()
  const {body} = await linearGql<{data?: {issueCreate?: {issue?: SeededIssue}}; errors?: Array<{message: string}>}>(
    `mutation ($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier title } } }`,
    {input: {teamId, title: `${RUN_PREFIX} fixture`, ...overrides}},
  )

  const issue = body.data?.issueCreate?.issue
  if (!issue) {
    throw new Error(`seedIssue failed: ${JSON.stringify(body)}`)
  }

  created.add(issue.id)
  return issue
}

type IssuePage = {
  data?: {issues?: {nodes: Array<{id: string}>; pageInfo: {endCursor?: null | string; hasNextPage: boolean}}}
  errors?: Array<{message: string}>
}

/**
 * Searches fixture issues by exact title prefix.
 *
 * Always anchored on the `[e2e ` shared prefix plus whatever the caller adds.
 * Both `cleanupRun` and `sweepStale` are destructive queries driven by ambient
 * environment values (a prefix and an age cutoff) with no other guard, so
 * anchoring every lookup here — structurally, once — bounds their blast radius
 * to issues this suite created instead of anything the token can see.
 *
 * Linear's filter queries read the store synchronously (unlike Jira's
 * asynchronous JQL index), so there is no polling step here, and soft-deleted
 * issues never appear: they are excluded unless includeArchived is set.
 *
 * @param titlePrefix The exact title prefix to match.
 * @returns The matching issue ids.
 */
export async function findIssuesByTitle(titlePrefix: string): Promise<string[]> {
  if (!titlePrefix.startsWith(SHARED_PREFIX)) {
    throw new Error(`findIssuesByTitle: refusing to search without the "${SHARED_PREFIX}" anchor: ${titlePrefix}`)
  }

  const ids: string[] = []
  let after: string | undefined

  // Every page, not just the first: a caller that stopped at 100 would delete
  // one page of fixtures and report success, leaving the rest behind.
  do {
    const {body} = await linearGql<IssuePage>(
      `query ($filter: IssueFilter, $after: String) { issues(filter: $filter, after: $after, first: 100) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
      {after, filter: {title: {startsWith: titlePrefix}}},
    )

    const messages = gqlErrorMessages(body)
    if (messages.length > 0) {
      throw new Error(`findIssuesByTitle failed: ${messages.join('; ')}`)
    }

    const page = body.data?.issues
    ids.push(...(page?.nodes ?? []).map((node) => node.id))
    after = page?.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (after)

  return ids
}

/**
 * Keys created by this process, as a fallback for `cleanupRun`.
 *
 * Linear has no indexing lag, but the created-set still matters: with
 * E2E_RUN_ID set, a sweep running in a *different* process than mocha (the
 * post-run sweep in scripts/e2e.sh) has an empty search when a fixture was
 * renamed between seeding and cleanup.
 */
const created = new Set<string>()

/**
 * Deletes a fixture issue, tolerating one that is already gone.
 *
 * Linear soft-deletes and its issueDelete mutation reports success even for
 * an issue that was already deleted (verified against the live API), so any
 * GraphQL error here is genuinely unexpected — but it must not abandon the
 * remaining deletions, which is deleteAll's job.
 *
 * @param id The issue id.
 */
export async function deleteIssue(id: string): Promise<void> {
  const {body} = await linearGql<{data?: {issueDelete?: {success?: boolean}}}>(
    'mutation ($id: String!) { issueDelete(id: $id) { success } }',
    {id},
  )

  if (!body.data?.issueDelete?.success) {
    throw new Error(`deleteIssue ${id} failed: ${JSON.stringify(body)}`)
  }

  created.delete(id)
}

/**
 * Deletes every issue in `ids`, tolerating individual failures until all
 * deletions have been attempted, then throwing if any actually failed.
 *
 * Promise.all would abandon the remaining deletions on the first rejection;
 * allSettled ensures a single stuck issue never masks failures to delete the
 * rest.
 *
 * @param ids The issue ids to delete.
 */
async function deleteAll(ids: string[]): Promise<void> {
  const results = await Promise.allSettled(ids.map((id) => deleteIssue(id)))
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failures.length > 0) {
    throw new Error(
      `deleteAll: ${failures.length}/${ids.length} deletion(s) failed: ${failures.map((f) => String(f.reason)).join('; ')}`,
    )
  }
}

/**
 * Deletes every fixture created by this run.
 *
 * Unions the prefix search with the keys `seedIssue` recorded, because a
 * fixture could have been renamed after seeding and no longer match the
 * prefix the search uses.
 */
export async function cleanupRun(): Promise<void> {
  const found = await findIssuesByTitle(RUN_PREFIX)
  await deleteAll([...new Set([...found, ...created])])
}

/**
 * Deletes fixtures older than an hour, left behind by a crashed run.
 *
 * The age filter is what makes this safe to run while another suite is in
 * flight: it can only ever reclaim fixtures no live run still owns.
 *
 * @returns How many issues were deleted.
 */
export async function sweepStale(): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const ids: string[] = []
  let after: string | undefined

  // Every page, for the same reason as findIssuesByTitle: stopping at the
  // first 100 would delete one page of stale fixtures and report success,
  // leaving the rest for a sweep that keeps "passing" without reaching them.
  do {
    const {body} = await linearGql<IssuePage>(
      `query ($filter: IssueFilter, $after: String) { issues(filter: $filter, after: $after, first: 100) { nodes { id } pageInfo { endCursor hasNextPage } } }`,
      {after, filter: {createdAt: {lte: cutoff}, title: {startsWith: SHARED_PREFIX}}},
    )

    const messages = gqlErrorMessages(body)
    if (messages.length > 0) {
      throw new Error(`sweepStale failed: ${messages.join('; ')}`)
    }

    const page = body.data?.issues
    ids.push(...(page?.nodes ?? []).map((node) => node.id))
    after = page?.pageInfo.hasNextPage ? (page.pageInfo.endCursor ?? undefined) : undefined
  } while (after)

  await deleteAll(ids)
  return ids.length
}

/**
 * Reads an issue's archivedAt/trashed state straight from the API.
 *
 * An existence check that does not go through the issues filter, so it sees
 * soft-deleted issues too — that is the point: after a CLI-driven delete the
 * fixture helper is the oracle proving the issue really is trashed.
 *
 * @param id The issue id.
 * @returns `{archivedAt, trashed}`, or null once the issue is truly gone.
 */
export async function issueTrashState(
  id: string,
): Promise<null | {archivedAt: null | string; trashed: boolean | null}> {
  const {body} = await linearGql<{data?: {issue?: null | {archivedAt: null | string; trashed: boolean | null}}}>(
    'query ($id: String!) { issue(id: $id) { archivedAt trashed } }',
    {id},
  )
  return body.data?.issue ?? null
}
