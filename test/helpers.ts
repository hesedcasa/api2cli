import type {Config} from '@oclif/core'

import {type StoredOperation, type StoredSpec, writeStore} from '../src/api-store.js'

// ─── Config mock ──────────────────────────────────────────────────────────────

export function makeConfig(configDir: string): Config {
  return {
    bin: 'sdkck',
    configDir,
    name: '@hesed/api2cli',
    pjson: {name: '@hesed/api2cli', version: '0.0.0'},
    root: process.cwd(),
    runHook: async () => ({failures: [], successes: []}),
    version: '0.0.0',
  } as unknown as Config
}

// ─── Command runner ───────────────────────────────────────────────────────────

export interface RunResult {
  cliError: Error | undefined
  logs: string[]
  warns: string[]
}

export async function runCmd<T extends object>(
  CmdClass: new (argv: string[], config: Config) => T & {run(): Promise<void>},
  argv: string[],
  config: Config,
): Promise<RunResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cmd = new CmdClass(argv, config) as any
  const logs: string[] = []
  const warns: string[] = []
  let cliError: Error | undefined

  cmd.log = (msg?: string) => logs.push(msg ?? '')
  cmd.warn = (input: Error | string) => warns.push(typeof input === 'string' ? input : input.message)
  cmd.error = (input: Error | string) => {
    const msg = typeof input === 'string' ? input : input.message
    const err = Object.assign(new Error(msg), {oclif: {exit: 2}})
    cliError = err
    throw err
  }

  try {
    await cmd.run()
  } catch {
    // errors captured above
  }

  return {cliError, logs, warns}
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

export function makeSpec(name: string, overrides: Partial<StoredSpec> = {}): StoredSpec {
  return {
    baseUrl: 'https://api.example.com',
    description: 'Test API',
    kind: 'openapi',
    name,
    operations: [],
    source: 'local',
    title: `${name} API`,
    ...overrides,
  }
}

export function makeOperation(operationId: string, overrides: Partial<StoredOperation> = {}): StoredOperation {
  return {
    bodyParams: {},
    description: operationId,
    method: 'get',
    operationId,
    parameters: [],
    path: `/${operationId}`,
    ...overrides,
  }
}

export function makeFetch(
  responseBody: string,
  options: {ok?: boolean; status?: number; statusText?: string} = {},
): (
  url: string,
  init?: {body?: null | string; headers?: Record<string, string>; method?: string},
) => Promise<{
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}> {
  const {ok = true, status = 200, statusText = 'OK'} = options
  return async () => ({ok, status, statusText, text: async () => responseBody})
}

// ─── Store setup helpers ──────────────────────────────────────────────────────

export async function seedStore(configDir: string, specs: StoredSpec[]): Promise<void> {
  const record: Record<string, StoredSpec> = {}
  for (const s of specs) record[s.name] = s
  await writeStore(configDir, {specs: record})
}
