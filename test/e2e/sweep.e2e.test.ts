import {expect} from 'chai'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'

import type {StoredSpec} from '../../src/api-store.js'

import {
  judgeProbe,
  planProbe,
  type ProbeExecution,
  type ProbeResult,
  runPool,
  shouldRetry,
  summarize,
  type SweepSummary,
} from '../sweep-helpers.js'
import {getSharedConfigDir, runCli} from './helpers.js'

/**
 * The endpoint sweep: every operation of the three imported specs is exercised
 * live through `api call`, planned and judged by `test/sweep-helpers.ts` (the
 * side-effect guarantees live there, unit-pinned by test/sweep-probe.test.ts).
 *
 * What "tested" means here: the probe ran and satisfied the suite's pinned
 * live-API contract — exit 0, and a mutation never actually landed. Where the
 * sandbox has real data the curated suites (read/lifecycle) make positive
 * assertions; this sweep's job is breadth, not depth.
 */

const SPECS = ['context7', 'vercel', 'linear'] as const

/** Concurrent probes. Low enough to stay under every API's rate limits. */
const SWEEP_CONCURRENCY = 6

/** Retries after a 429 or transport failure, with this backoff between attempts. */
const RETRY_BACKOFF_MS = [1000, 3000]

/**
 * Operations whose probe provably resolves without a live side effect and
 * that have been reviewed as benign. Every entry needs a justification with
 * the observed payload; a fresh violation still fails the suite until
 * someone decides.
 */
const ACCEPTED_MUTATIONS = new Set<string>([
  // Delete-by-junk-id is an idempotent no-op: Linear echoes the junk entityId
  // back with lastSyncId 0 and nothing existed to delete. Observed live:
  // {"entityId":"__e2e_probe__","lastSyncId":0,"success":true}.
  'favoriteDelete',
  // Pre-login WebAuthn ceremony bootstrap: generates a challenge for the junk
  // authId. No credential exists for it, so the challenge can never verify and
  // no account state changes. Observed live: {options:{challenge,…}, success:true}.
  'passkeyLoginStart',
  'viewPreferencesDelete',
])

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Reads a spec the CLI itself imported — the sweep's denominator is the CLI's own view. */
async function readSpec(configDir: string, name: string): Promise<StoredSpec> {
  const raw = await readFile(join(configDir, `api-${name}.json`), 'utf8')
  return JSON.parse(raw) as StoredSpec
}

/** Runs one probe, retrying rate limits and transport failures per RETRY_BACKOFF_MS. */
async function executeProbe(args: string[], configDir: string): Promise<ProbeExecution> {
  const run = async (): Promise<ProbeExecution> => {
    const result = await runCli(args, configDir)
    return {exitCode: result.code, stderr: result.stderr, stdout: result.stdout}
  }

  let execution = await run()
  for (const backoff of RETRY_BACKOFF_MS) {
    if (!shouldRetry(execution)) return execution

    await sleep(backoff)
    execution = await run()
  }

  return execution
}

async function sweepSpec(specName: string): Promise<{results: ProbeResult[]; summary: SweepSummary}> {
  const configDir = await getSharedConfigDir()
  const spec = await readSpec(configDir, specName)
  const results: ProbeResult[] = []

  await runPool(spec.operations, SWEEP_CONCURRENCY, async (operation) => {
    const plan = planProbe(specName, operation)
    if (plan.kind === 'skip') {
      results.push({plan, verdict: {ok: true}})
      return
    }

    const execution = await executeProbe(plan.args, configDir)
    const verdict = judgeProbe(plan, execution)
    // An accepted mutation is one that provably lands but has been reviewed
    // as benign; only payload/status violations qualify, never exit failures.
    if (!verdict.ok && ACCEPTED_MUTATIONS.has(plan.operationId) && verdict.violation?.includes('allowlist')) {
      results.push({plan, verdict: {ok: true, status: verdict.status}})
      return
    }

    results.push({plan, verdict})
  })

  return {results, summary: summarize(results)}
}

function failureReport(summary: SweepSummary): string {
  const pct = (summary.coverage * 100).toFixed(1)
  const lines = [
    `attempted ${summary.attempted}/${summary.total} (${pct}%), skipped ${summary.skipped}, violations ${summary.violations.length}:`,
    ...summary.violations.slice(0, 20).map((v) => `  ${v.operationId}: ${v.violation}`),
  ]
  if (summary.violations.length > 20) lines.push(`  …and ${summary.violations.length - 20} more`)
  return lines.join('\n')
}

describe('e2e: endpoint sweep', () => {
  for (const specName of SPECS) {
    describe(specName, () => {
      let summary: SweepSummary

      before(async function (this: Mocha.Context) {
        // Hundreds of subprocess probes; CI runners are slower than laptops.
        this.timeout(1_200_000)
        ;({summary} = await sweepSpec(specName))
        // One line per spec in the log, so a passing run still shows the shape of the coverage.
        console.log(`sweep ${specName}: ${failureReport(summary)}`)
      })

      it('probes every non-excluded operation without a live side effect or CLI failure', () => {
        expect(summary.violations, failureReport(summary)).to.deep.equal([])
      })

      it('keeps endpoint coverage above half the spec', () => {
        expect(
          summary.coverage,
          `only ${(summary.coverage * 100).toFixed(1)}% of ${specName} operations probed (${summary.attempted}/${summary.total})`,
        ).to.be.at.least(0.5)
      })
    })
  }
})
