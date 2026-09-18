/**
 * Pure planning and judging logic for the endpoint sweep (`sweep.e2e.test.ts`).
 *
 * The sweep invokes every operation of the three imported specs live through
 * `api call`, so the guarantees it makes about NOT mutating the live accounts
 * live here, where unit tests can pin them (`test/sweep-probe.test.ts`):
 *
 * - GraphQL mutations are only invoked when at least one declared variable can
 *   be poisoned into failing validation/coercion, which aborts the whole
 *   request server-side before any resolver runs. An unknown input-object
 *   field, or an object where a scalar is declared, both do that.
 * - Mutations with no poisonable variable (argless, or all-optional scalars —
 *   any string coerces for `String!`) are skipped, never executed.
 * - REST mutations are only invoked when a required path/query/body parameter
 *   gives the server something to reject (a junk id 404s before any body is
 *   read). Header-only protection does not count — a header cannot stop an
 *   operation from executing. Unprotected REST mutations are skipped.
 * - A mutating probe that nonetheless comes back 2xx (REST), or resolves its
 *   payload without the API reporting failure (GraphQL `success: false`), is
 *   a violation the gate reports, never a silent success.
 */

import type {StoredOperation} from '../src/api-store.js'

const PROBE_VALUE = '__e2e_probe__'
/** Unknown field on an input object: rejected during GraphQL variable coercion. */
const PROBE_POISON = '{"__e2e_probe__":"probe"}'
const REST_MUTATING_METHODS = new Set(['delete', 'patch', 'post', 'put'])

export type ProbePlan =
  | {
      args: string[]
      /** GraphQL envelope key for the operation — its field name, which the id dedupe can rename. */
      fieldName?: string
      kind: 'invoke'
      mutating: boolean
      operationId: string
      transport: 'graphql' | 'rest'
    }
  | {kind: 'skip'; operationId: string; reason: string}

export type ProbeExecution = {exitCode: number; stderr: string; stdout: string}

export type ProbeVerdict = {ok: boolean; status?: number; violation?: string}

export type ProbeResult = {plan: ProbePlan; verdict: ProbeVerdict}

function isGraphQL(op: StoredOperation): boolean {
  return op.graphql !== undefined
}

function isMutating(op: StoredOperation): boolean {
  if (isGraphQL(op)) return op.graphql!.operationType === 'mutation'
  return REST_MUTATING_METHODS.has(op.method)
}

/** True when the stored body-param type unwraps to an input object or list. */
function isStructuredArg(type: string): boolean {
  return type === 'object' || type === 'array'
}

/**
 * Plans how the sweep should exercise one stored operation.
 *
 * Invoke plans carry the full argv for `api call <spec> <operationId>` minus
 * the config-dir plumbing; skip plans carry the reason so the gate can report
 * exactly what was deliberately not executed.
 */
export function planProbe(specName: string, op: StoredOperation): ProbePlan {
  const isMutation = isMutating(op)

  if (isGraphQL(op)) {
    const {operationType} = op.graphql!
    const structured = Object.entries(op.bodyParams).filter(([, def]) => isStructuredArg(def.type))
    const requiredScalars = Object.entries(op.bodyParams).filter(
      ([name, def]) => def.required && structured.every(([structName]) => structName !== name),
    )

    if (operationType === 'mutation') {
      if (Object.keys(op.bodyParams).length === 0) {
        return {kind: 'skip', operationId: op.operationId, reason: 'argless mutation — no variable can be poisoned'}
      }

      if (structured.length === 0 && requiredScalars.length === 0) {
        return {
          kind: 'skip',
          operationId: op.operationId,
          reason: 'mutation with no poisonable argument — every value would coerce, so it would execute',
        }
      }
    }

    // Poison every structured argument (required or not) and fill required
    // scalar arguments; optional scalars are left out.
    const args = ['api', 'call', specName, op.operationId]
    for (const [name] of structured) args.push('--body', `${name}=${PROBE_POISON}`)
    for (const [name] of requiredScalars) args.push('--body', `${name}=${PROBE_VALUE}`)
    return {
      args,
      fieldName: op.graphql!.fieldName,
      kind: 'invoke',
      mutating: isMutation,
      operationId: op.operationId,
      transport: 'graphql',
    }
  }

  // OpenAPI operation. A required path/query parameter or body field gives the
  // server something to reject; required headers are passed too (they may gate
  // auth) but do not count as protection.
  if (op.rawBodyContentType !== undefined) {
    return {
      kind: 'skip',
      operationId: op.operationId,
      reason: `raw ${op.rawBodyContentType} body — the CLI only sends named JSON bodies, so the request cannot be built`,
    }
  }

  const requiredParams = op.parameters.filter((p) => p.required && p.in !== 'cookie')
  const requiredBodyFields = Object.entries(op.bodyParams).filter(([, def]) => def.required)
  const protectedByParams = requiredParams.some((p) => p.in === 'path' || p.in === 'query')

  if (isMutation && !protectedByParams && requiredBodyFields.length === 0) {
    return {
      kind: 'skip',
      operationId: op.operationId,
      reason: 'mutating endpoint with no required path, query or body parameter to reject a probe',
    }
  }

  const args = ['api', 'call', specName, op.operationId]
  for (const p of requiredParams) args.push('--param', `${p.name}=${PROBE_VALUE}`)
  for (const [name, def] of requiredBodyFields) {
    args.push('--body', `${name}=${isStructuredArg(def.type) ? PROBE_POISON : PROBE_VALUE}`)
  }

  return {args, kind: 'invoke', mutating: isMutation, operationId: op.operationId, transport: 'rest'}
}

/**
 * Extracts the first `HTTP <3 digits>` occurrence from CLI stderr — the warn
 * line `call.ts` prints for non-OK responses. No regex literals in test/**
 * (see CLAUDE.md), so this is a hand-rolled scan.
 */
function parseWarnedStatus(stderr: string): number | undefined {
  let at = stderr.indexOf('HTTP ')
  while (at !== -1) {
    const digits = stderr.slice(at + 5, at + 8)
    if (digits.length === 3 && [...digits].every((c) => c >= '0' && c <= '9')) {
      return Number(digits)
    }

    at = stderr.indexOf('HTTP ', at + 1)
  }

  return undefined
}

/** Pulls the JSON response body out of CLI stdout (the request line precedes it). */
function parseResponseJson(stdout: string): unknown {
  const start = stdout.indexOf('{')
  if (start === -1) return undefined
  try {
    return JSON.parse(stdout.slice(start))
  } catch {
    return undefined
  }
}

/**
 * Judges one executed probe against the suite's pinned live-API contract:
 * exit 0 always, and mutations must never actually land. Reads may return
 * anything — the sandbox simply lacks data for most of them.
 */
export function judgeProbe(plan: ProbePlan, execution: ProbeExecution): ProbeVerdict {
  if (plan.kind === 'skip') return {ok: true}

  if (execution.exitCode !== 0) {
    const excerpt = execution.stderr.trim().slice(0, 200)
    return {ok: false, violation: `exit ${execution.exitCode}: ${excerpt}`}
  }

  const warnedStatus = parseWarnedStatus(execution.stderr)
  const status = warnedStatus ?? 200

  if (plan.mutating) {
    if (plan.transport === 'graphql') {
      const body = parseResponseJson(execution.stdout)
      if (body === undefined || body === null || typeof body !== 'object') {
        return {ok: false, status, violation: `could not parse GraphQL response of "${plan.operationId}"`}
      }

      // A request aborted by variable coercion has no `data` key at all; a
      // resolver that rejects the junk input yields `data.<field>: null`; and
      // a payload with `success: false` is the API's own "did not commit"
      // verdict (observed live on integrationGitlabConnect). Only a payload
      // that resolved without reporting failure means the mutation landed.
      const envelope = body as {data?: Record<string, unknown>}
      const envelopeKey = plan.fieldName ?? plan.operationId
      const payload = envelope.data?.[envelopeKey]
      if (payload !== undefined && payload !== null) {
        const wasRejected =
          typeof payload === 'object' && 'success' in payload && (payload as {success?: unknown}).success === false
        if (!wasRejected) {
          return {
            ok: false,
            status,
            violation: `GraphQL mutation executed — payload came back; allowlist or exclude "${plan.operationId}"`,
          }
        }
      }

      return {ok: true, status: 200}
    }

    if (status < 300) {
      return {
        ok: false,
        status,
        violation: `mutating endpoint returned 2xx — allowlist or exclude "${plan.operationId}"`,
      }
    }

    return {ok: true, status}
  }

  return {ok: true, status}
}

/**
 * True when re-running the probe could plausibly change the outcome: a rate
 * limit (the CLI exits 0 with a 429 warning) or a transport failure (which
 * surfaces as exit 2 with "Request failed").
 */
export function shouldRetry(execution: ProbeExecution): boolean {
  if (execution.stderr.includes('HTTP 429')) return true
  return execution.exitCode !== 0 && execution.stderr.includes('Request failed')
}

/**
 * Runs `worker` over every item with at most `limit` concurrent executions,
 * preserving no ordering guarantees. Worker errors propagate after the in-flight
 * batch settles.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (next < items.length) {
      const item = items[next++]!
      // The sequential-await loop IS the pool: `limit` of these runners drain
      // the shared index concurrently.
      // eslint-disable-next-line no-await-in-loop
      await worker(item)
    }
  })

  await Promise.all(runners)
}

export type SweepSummary = {
  attempted: number
  coverage: number
  skipped: number
  total: number
  violations: Array<{operationId: string; violation: string}>
}

/**
 * Aggregates probe results: coverage is attempted / total over the whole spec
 * (structural skips count against coverage — that is what keeps the gate
 * honest when a spec grows faster than the sweep can safely probe it).
 */
export function summarize(results: readonly ProbeResult[]): SweepSummary {
  const total = results.length
  const skipped = results.filter((r) => r.plan.kind === 'skip').length
  const attempted = total - skipped
  const violations = results
    .filter((r) => !r.verdict.ok)
    .map((r) => ({operationId: r.plan.operationId, violation: r.verdict.violation ?? 'unknown violation'}))

  return {attempted, coverage: total === 0 ? 0 : attempted / total, skipped, total, violations}
}
