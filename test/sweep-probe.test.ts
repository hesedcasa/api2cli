import {expect} from 'chai'

import type {StoredOperation} from '../src/api-store.js'

import {
  judgeProbe,
  planProbe,
  type ProbeExecution,
  type ProbePlan,
  runPool,
  shouldRetry,
  summarize,
} from './sweep-helpers.js'

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/** Builds a StoredOperation as the graphql-converter would have stored it. */
function graphQLOp(
  name: string,
  operationType: 'mutation' | 'query',
  args: Record<string, {required?: boolean; type: string}>,
): StoredOperation {
  return {
    bodyParams: Object.fromEntries(
      Object.entries(args).map(([arg, def]) => [arg, {required: def.required ?? false, type: def.type}]),
    ),
    description: '',
    graphql: {fieldName: name, operationType, query: 'unused in the planner'},
    method: 'post',
    operationId: name,
    parameters: [],
    path: '',
  }
}

/** Builds a StoredOperation as extractOperations would have stored it. */
function restOp(
  operationId: string,
  method: string,
  params: Array<{in: 'header' | 'path' | 'query'; name: string; required?: boolean}>,
  {bodyParams = {}, rawBodyContentType}: {bodyParams?: Record<string, string>; rawBodyContentType?: string} = {},
): StoredOperation {
  return {
    bodyParams: Object.fromEntries(Object.entries(bodyParams).map(([name, type]) => [name, {required: true, type}])),
    description: '',
    method,
    operationId,
    parameters: params.map((p) => ({in: p.in, name: p.name, required: p.required ?? true, schema: {}})),
    path: '/v1/thing',
    rawBodyContentType,
  }
}

function invoke(plan: ProbePlan): {args: string[]; mutating: boolean; transport: 'graphql' | 'rest'} {
  if (plan.kind === 'skip') throw new Error(`expected invoke, got skip: ${plan.reason}`)
  return {args: plan.args, mutating: plan.mutating, transport: plan.transport}
}

/** Extracts `--flag` values from an argv list: flagName → array of values. */
function flagValues(args: string[], flagName: string): string[] {
  const values: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flagName) values.push(args[i + 1]!)
  }

  return values
}

// ─── planProbe: GraphQL ────────────────────────────────────────────────────────

describe('e2e sweep helpers', () => {
  describe('sweep probe planner', () => {
    describe('GraphQL operations', () => {
      it('poisons a mutation whose input object is required via an unknown probe field', () => {
        const plan = planProbe(
          'linear',
          graphQLOp('issueCreate', 'mutation', {input: {required: true, type: 'object'}}),
        )
        const {args, mutating} = invoke(plan)
        expect(mutating).to.be.true
        expect(flagValues(args, '--body')).to.include('input={"__e2e_probe__":"probe"}')
      })

      it('poisons an optional object argument too, so the mutation can never execute', () => {
        const plan = planProbe('linear', graphQLOp('teamUpdate', 'mutation', {input: {type: 'object'}}))
        const {args, mutating} = invoke(plan)
        expect(mutating).to.be.true
        expect(flagValues(args, '--body')).to.include('input={"__e2e_probe__":"probe"}')
      })

      it('fills a required scalar argument of a mutation with a junk string', () => {
        const plan = planProbe('linear', graphQLOp('issueDelete', 'mutation', {id: {required: true, type: 'string'}}))
        const {args, mutating} = invoke(plan)
        expect(mutating).to.be.true
        expect(flagValues(args, '--body')).to.include('id=__e2e_probe__')
      })

      it('poisons the object argument and fills required scalars when a mutation has both', () => {
        const plan = planProbe(
          'linear',
          graphQLOp('issueLabelCreate', 'mutation', {
            id: {required: true, type: 'string'},
            input: {required: true, type: 'object'},
          }),
        )
        const bodies = flagValues(invoke(plan).args, '--body')
        expect(bodies).to.include('id=__e2e_probe__')
        expect(bodies).to.include('input={"__e2e_probe__":"probe"}')
      })

      it('skips an argless mutation because no variable can be poisoned', () => {
        const plan = planProbe('linear', graphQLOp('organizationStartTrial', 'mutation', {}))
        expect(plan.kind).to.equal('skip')
        if (plan.kind === 'skip') expect(plan.reason).to.contain('argless')
      })

      it('skips a mutation whose arguments are all optional scalars because every value would coerce', () => {
        const plan = planProbe(
          'linear',
          graphQLOp('logoutAllSessions', 'mutation', {includeApiSessions: {type: 'boolean'}}),
        )
        expect(plan.kind).to.equal('skip')
      })

      it('invokes a mutation whose only list-typed argument is optional, poisoning the list', () => {
        const plan = planProbe('linear', graphQLOp('teamCyclesDelete', 'mutation', {ids: {type: 'array'}}))
        const bodies = flagValues(invoke(plan).args, '--body')
        expect(bodies).to.include('ids={"__e2e_probe__":"probe"}')
      })

      it('invokes an argless query — reads are safe to execute', () => {
        const plan = planProbe('linear', graphQLOp('viewer', 'query', {}))
        expect(invoke(plan).mutating).to.be.false
      })

      it('fills a required scalar argument of a query without mutating classification', () => {
        const plan = planProbe('linear', graphQLOp('issue', 'query', {id: {required: true, type: 'string'}}))
        const {args, mutating} = invoke(plan)
        expect(mutating).to.be.false
        expect(flagValues(args, '--body')).to.include('id=__e2e_probe__')
      })
    })

    // ─── planProbe: OpenAPI ──────────────────────────────────────────────────────

    describe('OpenAPI operations', () => {
      it('passes a required query parameter of a GET as --param', () => {
        const plan = planProbe('vercel', restOp('getProject', 'get', [{in: 'query', name: 'projectId'}]))
        const {args, mutating} = invoke(plan)
        expect(mutating).to.be.false
        expect(flagValues(args, '--param')).to.include('projectId=__e2e_probe__')
      })

      it('passes a required path parameter as --param', () => {
        const plan = planProbe('vercel', restOp('deleteProject', 'delete', [{in: 'path', name: 'projectId'}]))
        const {mutating} = invoke(plan)
        expect(mutating).to.be.true
        expect(flagValues(invoke(plan).args, '--param')).to.include('projectId=__e2e_probe__')
      })

      it('passes a required header parameter as --param as well', () => {
        const plan = planProbe('vercel', restOp('uploadThing', 'get', [{in: 'header', name: 'X-Required'}]))
        expect(flagValues(invoke(plan).args, '--param')).to.include('X-Required=__e2e_probe__')
      })

      it('ignores cookie parameters, which the CLI does not support', () => {
        const op = restOp('listThings', 'get', [])
        op.parameters.push({in: 'cookie', name: 'session', required: true, schema: {}})
        const plan = planProbe('vercel', op)
        expect(flagValues(invoke(plan).args, '--param')).to.deep.equal([])
      })

      it('fills a required scalar body field as --body', () => {
        const plan = planProbe('vercel', restOp('createSecret', 'post', [], {bodyParams: {name: 'string'}}))
        const {mutating} = invoke(plan)
        expect(mutating).to.be.true
        expect(flagValues(invoke(plan).args, '--body')).to.include('name=__e2e_probe__')
      })

      it('fills a required object body field with the probe JSON object', () => {
        const plan = planProbe('vercel', restOp('createWidget', 'post', [], {bodyParams: {config: 'object'}}))
        expect(flagValues(invoke(plan).args, '--body')).to.include('config={"__e2e_probe__":"probe"}')
      })

      it('skips a mutating operation with no required path, query or body parameter', () => {
        const plan = planProbe('vercel', restOp('deleteAllArtifacts', 'delete', []))
        expect(plan.kind).to.equal('skip')
        if (plan.kind === 'skip') expect(plan.reason).to.contain('no required')
      })

      it('skips a mutating operation whose only required parameter is a header, which cannot prevent execution', () => {
        const plan = planProbe('vercel', restOp('mutateViaHeaderOnly', 'post', [{in: 'header', name: 'X-Scope'}]))
        expect(plan.kind).to.equal('skip')
      })

      it('skips an operation with a raw body content type, which named --body flags cannot fill', () => {
        const op = restOp('uploadArtifact', 'post', [], {rawBodyContentType: 'application/octet-stream'})
        const plan = planProbe('vercel', op)
        expect(plan.kind).to.equal('skip')
        if (plan.kind === 'skip') expect(plan.reason).to.contain('application/octet-stream')
      })

      it('treats a required body field as protection even with no required parameters', () => {
        const plan = planProbe('vercel', restOp('createSecret', 'post', [], {bodyParams: {name: 'string'}}))
        expect(plan.kind).to.equal('invoke')
      })

      it('invokes a read operation that has no required parameters at all', () => {
        const plan = planProbe('vercel', restOp('getProjects', 'get', []))
        expect(plan.kind).to.equal('invoke')
        expect(invoke(plan).mutating).to.be.false
      })
    })
  })

  // ─── judgeProbe ────────────────────────────────────────────────────────────────

  const invokePlan = (isMutation: boolean, transport: 'graphql' | 'rest' = 'rest', fieldName?: string): ProbePlan => ({
    args: [],
    fieldName,
    kind: 'invoke',
    mutating: isMutation,
    operationId: 'op',
    transport,
  })

  describe('sweep probe judge', () => {
    const exitTwo: ProbeExecution = {exitCode: 2, stderr: 'Missing required parameter: x (query)', stdout: ''}
    const warned404: ProbeExecution = {exitCode: 0, stderr: 'warn: HTTP 404 Not Found', stdout: 'POST https://x\n{}'}
    const cleanTwoOhh: ProbeExecution = {exitCode: 0, stderr: '', stdout: 'POST https://x\n{"ok":true}'}

    it('fails any probe that exited non-zero, since the CLI contract is exit 0 with a warning', () => {
      const verdict = judgeProbe(invokePlan(false), exitTwo)
      expect(verdict.ok).to.be.false
      expect(verdict.violation).to.contain('exit 2')
    })

    it('accepts a read that was warned about (4xx)', () => {
      expect(judgeProbe(invokePlan(false), warned404).ok).to.be.true
    })

    it('accepts a read that returned 2xx', () => {
      expect(judgeProbe(invokePlan(false), cleanTwoOhh).ok).to.be.true
    })

    it('records the HTTP status from the warning line', () => {
      expect(judgeProbe(invokePlan(false), warned404).status).to.equal(404)
    })

    it('records status 200 when no warning was printed', () => {
      expect(judgeProbe(invokePlan(false), cleanTwoOhh).status).to.equal(200)
    })

    it('fails a REST mutation that returned 2xx — that would be a live side effect', () => {
      const verdict = judgeProbe(invokePlan(true), cleanTwoOhh)
      expect(verdict.ok).to.be.false
      expect(verdict.violation).to.contain('2xx')
    })

    it('accepts a REST mutation rejected with 4xx', () => {
      expect(judgeProbe(invokePlan(true), warned404).ok).to.be.true
    })

    it('accepts a GraphQL mutation that never executed (no data key — coercion failed)', () => {
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout: 'POST https://x\n{"errors":[{"message":"bad"}]}',
      }
      expect(judgeProbe(invokePlan(true, 'graphql', 'issueDelete'), execution).ok).to.be.true
    })

    it('accepts a GraphQL mutation whose resolver rejected the junk input (data field null)', () => {
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout: 'POST https://x\n{"data":{"issueDelete":null},"errors":[{"message":"not found"}]}',
      }
      expect(judgeProbe(invokePlan(true, 'graphql', 'issueDelete'), execution).ok).to.be.true
    })

    it('accepts a GraphQL mutation whose payload reports success:false — the server rejected it', () => {
      // Observed live (integrationGitlabConnect): the resolver runs on junk
      // input but Linear's payload contract is `success:false` + null entity
      // for "did not commit" — the same shape the API returns to a caller
      // whose real credentials were rejected.
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout:
          'POST https://x\n{"data":{"integrationGitlabConnect":{"error":"Please try again.","integration":null,"lastSyncId":0,"success":false}}}',
      }
      expect(judgeProbe(invokePlan(true, 'graphql', 'integrationGitlabConnect'), execution).ok).to.be.true
    })

    it('still fails a GraphQL mutation whose payload resolved without reporting success:false', () => {
      // success:true (or no success field at all) means the mutation cannot be
      // shown to have been rejected — keep it a violation for review.
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout: 'POST https://x\n{"data":{"issueDelete":{"id":"x","trashed":true,"success":true}}}',
      }
      const verdict = judgeProbe(invokePlan(true, 'graphql', 'issueDelete'), execution)
      expect(verdict.ok).to.be.false
    })

    it('fails a GraphQL mutation that actually resolved — the payload must be allowlisted or excluded', () => {
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout: 'POST https://x\n{"data":{"issueDelete":{"id":"x","trashed":true}}}',
      }
      const verdict = judgeProbe(invokePlan(true, 'graphql', 'issueDelete'), execution)
      expect(verdict.ok).to.be.false
      expect(verdict.violation).to.contain('executed')
    })

    it('does not audit GraphQL reads for execution', () => {
      const execution: ProbeExecution = {
        exitCode: 0,
        stderr: '',
        stdout: 'POST https://x\n{"data":{"viewer":{"id":"u"}}}',
      }
      expect(judgeProbe(invokePlan(false, 'graphql'), execution).ok).to.be.true
    })

    it('fails a GraphQL mutation whose body cannot be parsed at all', () => {
      const execution: ProbeExecution = {exitCode: 0, stderr: '', stdout: 'POST https://x\nnot json at all'}
      const verdict = judgeProbe(invokePlan(true, 'graphql', 'issueDelete'), execution)
      expect(verdict.ok).to.be.false
      expect(verdict.violation).to.contain('parse')
    })

    it('does not mutate classification for skip plans', () => {
      const plan: ProbePlan = {kind: 'skip', operationId: 'op', reason: 'untouched'}
      expect(judgeProbe(plan, exitTwo).ok).to.be.true
    })
  })

  // ─── shouldRetry ───────────────────────────────────────────────────────────────

  describe('sweep probe retry rule', () => {
    it('retries a rate-limited response regardless of exit code', () => {
      expect(shouldRetry({exitCode: 0, stderr: 'warn: HTTP 429 Too Many Requests', stdout: ''})).to.be.true
    })

    it('retries a transport failure, which surfaces as exit 2', () => {
      expect(shouldRetry({exitCode: 2, stderr: 'Request failed: socket hang up', stdout: ''})).to.be.true
    })

    it('does not retry a normal 4xx', () => {
      expect(shouldRetry({exitCode: 0, stderr: 'warn: HTTP 404 Not Found', stdout: ''})).to.be.false
    })

    it('does not retry a clean success', () => {
      expect(shouldRetry({exitCode: 0, stderr: '', stdout: '{}'})).to.be.false
    })
  })

  // ─── summarize ─────────────────────────────────────────────────────────────────

  describe('sweep coverage summary', () => {
    it('counts attempted, skipped and total, and computes coverage over the whole spec', () => {
      const results = [
        {plan: invokePlan(false), verdict: {ok: true, status: 200}},
        {plan: invokePlan(true), verdict: {ok: true, status: 404}},
        {plan: {kind: 'skip' as const, operationId: 's1', reason: 'r'}, verdict: {ok: true}},
      ]
      const summary = summarize(results)
      expect(summary.total).to.equal(3)
      expect(summary.attempted).to.equal(2)
      expect(summary.skipped).to.equal(1)
      expect(summary.coverage).to.be.closeTo(2 / 3, 0.0001)
    })

    it('collects the violating operations with their reasons', () => {
      const results = [
        {plan: invokePlan(true), verdict: {ok: false, violation: 'mutating endpoint returned 2xx'}},
        {plan: invokePlan(false), verdict: {ok: true, status: 404}},
      ]
      const summary = summarize(results)
      expect(summary.violations).to.have.lengthOf(1)
      expect(summary.violations[0]!.violation).to.contain('2xx')
    })
  })

  // ─── runPool ───────────────────────────────────────────────────────────────────

  describe('sweep concurrency pool', () => {
    it('processes every item exactly once', async () => {
      const seen: number[] = []
      await runPool([1, 2, 3, 4, 5], 2, async (n: number) => {
        await Promise.resolve()
        seen.push(n)
      })
      expect(seen).to.have.members([1, 2, 3, 4, 5])
    })

    it('never runs more than `limit` workers at once', async () => {
      let active = 0
      let peak = 0
      const items = Array.from({length: 12}, (_, i) => i)
      await runPool(items, 3, async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => {
          setTimeout(resolve, 5)
        })
        active--
      })
      expect(peak).to.be.at.most(3)
    })

    it('resolves on an empty list', async () => {
      await runPool([], 4, async () => {
        throw new Error('should never run')
      })
    })
  })
})
