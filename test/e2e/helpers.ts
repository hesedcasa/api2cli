import {expect} from 'chai'
import {execFile} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CLI = path.join(REPO_ROOT, 'bin', 'run.js')

/**
 * oclif scopes its config dir override to the bin name, so `API_CONFIG_DIR`
 * redirects every store/auth read of the subprocess. See `Config.scopedEnvVar`
 * in the oclif core package.
 */
export const CONFIG_DIR_ENV = 'API_CONFIG_DIR'

/** Where the three live APIs live. Mirrors the user-facing import commands. */
export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
export const LINEAR_SCHEMA_URL =
  'https://raw.githubusercontent.com/linear/linear/refs/heads/master/packages/sdk/src/schema.graphql'
export const VERCEL_SPEC_URL = 'https://openapi.vercel.sh/'
export const CONTEXT7_SPEC_URL =
  'https://raw.githubusercontent.com/upstash/context7/refs/heads/master/docs/openapi.json'

export type Secrets = {
  context7: string
  linear: string
  vercel: string
}

/**
 * Reads the three live-API credentials from the environment.
 *
 * Nothing in this repo loads .env, so these must already be exported.
 */
export function requireEnv(): Secrets {
  const linear = process.env.LINEAR_API_KEY
  const vercel = process.env.VERCEL_API_KEY
  const context7 = process.env.CONTEXT7_API_KEY

  if (!linear || !vercel || !context7) {
    throw new Error(
      'Missing LINEAR_API_KEY, VERCEL_API_KEY or CONTEXT7_API_KEY. ' +
        'Nothing in this repo loads .env — run: set -a; . ./.env; set +a',
    )
  }

  return {context7, linear, vercel}
}

/** Every credential the suite knows about, for redacting captured CLI output. */
function secrets(): string[] {
  try {
    const {context7, linear, vercel} = requireEnv()
    return [linear, vercel, context7]
  } catch {
    return []
  }
}

export type CliResult = {
  code: number
  stderr: string
  stdout: string
}

/**
 * Builds the subprocess invocation for the configured host CLI.
 *
 * By default the built standalone CLI (`bin/run.js`) runs with `API_CONFIG_DIR`
 * (oclif scopes that env var by bin name). When `E2E_HOST_CLI=sdkck`, the same
 * arguments go to the `sdkck` binary instead — the argv is host-agnostic
 * because every command already carries the `api` topic prefix — and oclif's
 * bin-scoped `SDKCK_*` dirs are redirected: config to the same throwaway
 * config dir the standalone leg uses, data/cache into the throwaway sdkck home
 * (`E2E_SDKCK_HOME`) that the scripts installed the plugin into.
 *
 * @param args Command line arguments, e.g. ['api', 'call', 'linear', 'viewer'].
 * @param configDir Value for API_CONFIG_DIR, from createConfigDir() or the shared dir.
 * @returns The executable, its argv, and env overrides to layer over process.env.
 */
function hostInvocation(
  args: string[],
  configDir: string,
): {argv: string[]; command: string; env: Record<string, string>} {
  if (process.env.E2E_HOST_CLI === 'sdkck') {
    const home = process.env.E2E_SDKCK_HOME
    if (!home) {
      throw new Error('E2E_HOST_CLI=sdkck requires E2E_SDKCK_HOME — set by scripts/e2e.sh or the CI workflow')
    }

    return {
      argv: args,
      command: 'sdkck',
      env: {
        SDKCK_CACHE_DIR: path.join(home, 'cache'),
        SDKCK_CONFIG_DIR: configDir,
        SDKCK_DATA_DIR: path.join(home, 'data'),
      },
    }
  }

  return {argv: [CLI, ...args], command: process.execPath, env: {API_CONFIG_DIR: configDir}}
}

/**
 * Runs the host CLI as a real subprocess against an isolated config dir. The
 * host is the built standalone CLI unless `E2E_HOST_CLI=sdkck` (see
 * hostInvocation()). Non-zero exits are returned rather than thrown so tests
 * can assert on failure paths.
 *
 * @param args Command line arguments, e.g. ['api', 'call', 'linear', 'viewer'].
 * @param configDir Value for API_CONFIG_DIR / SDKCK_CONFIG_DIR, from
 *   createConfigDir() or the shared dir.
 * @returns The exit code and captured stdout/stderr.
 */
export async function runCli(args: string[], configDir: string): Promise<CliResult> {
  const {argv, command, env} = hostInvocation(args, configDir)
  try {
    const {stderr, stdout} = await execFileAsync(command, argv, {
      env: {...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env},
      maxBuffer: 64 * 1024 * 1024,
    })
    return {code: 0, stderr, stdout}
  } catch (error: unknown) {
    const failure = error as {code?: number; stderr?: string; stdout?: string}
    return {code: failure.code ?? 1, stderr: failure.stderr ?? '', stdout: failure.stdout ?? ''}
  }
}

/**
 * Replaces every occurrence of each secret in `text` with `<redacted>`.
 *
 * Empty/missing secrets are skipped rather than matching everything — an empty
 * needle would otherwise turn `replaceAll` into a full-string redaction.
 *
 * Exported (rather than a private helper) so it can be exercised directly by a
 * unit-style test without invoking a command whose output carries a real token.
 *
 * @param text Captured stdout/stderr that may contain secrets.
 * @param needles The values to scrub; falsy values leave `text` untouched.
 * @returns `text` with every occurrence of every needle replaced.
 */
export function redactSecret(text: string, needles: string[]): string {
  let result = text
  for (const needle of needles) {
    if (needle) result = result.replaceAll(needle, '<redacted>')
  }

  return result
}

/**
 * Runs the CLI and fails the test if it exited non-zero.
 *
 * The failure message redacts the three API keys from stdout/stderr before
 * they are interpolated, so a failing call never prints a live credential
 * into mocha's failure output or CI logs. The returned `CliResult` itself is
 * left unredacted — tests need the real values to assert on.
 *
 * @param args Command line arguments.
 * @param configDir Value for API_CONFIG_DIR.
 * @returns The successful result.
 */
export async function runCliOk(args: string[], configDir: string): Promise<CliResult> {
  const result = await runCli(args, configDir)
  const needles = secrets()
  const stdout = redactSecret(result.stdout, needles)
  const stderr = redactSecret(result.stderr, needles)
  expect(result.code, `\`api ${args.join(' ')}\` failed:\n${stdout}\n${stderr}`).to.equal(0)
  return result
}

/**
 * Strips the `METHOD <url>` request line that every call/dynamic command logs
 * to stdout before the response body.
 *
 * Import/list output has no request line and typically starts with `{`-less
 * text, so detection is by first character: a trimmed `{` or `[` means the
 * whole stdout is the response already.
 */
export function stripRequestLine(stdout: string): string {
  const trimmed = stdout.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed

  const newline = stdout.indexOf('\n')
  return newline === -1 ? '' : stdout.slice(newline + 1)
}

/**
 * Runs the CLI, expects success, and parses the response body on stdout as
 * JSON (request line stripped — see stripRequestLine).
 *
 * @param args Command line arguments.
 * @param configDir Value for API_CONFIG_DIR.
 * @returns The parsed JSON payload.
 */
export async function runCliJson<T = unknown>(args: string[], configDir: string): Promise<T> {
  const {stdout} = await runCliOk(args, configDir)
  return JSON.parse(stripRequestLine(stdout)) as T
}

// ─── Config dirs ──────────────────────────────────────────────────────────────

export async function createConfigDir(prefix = 'api2cli-e2e-'): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

export async function removeConfigDir(dir: string): Promise<void> {
  await fs.rm(dir, {force: true, recursive: true})
}

/**
 * The one config dir shared by every test file in a mocha process, with the
 * three specs imported and authenticated.
 *
 * Importing the Linear schema takes tens of seconds, and every file needs the
 * same three specs, so the dir is built once and memoized. Each file's
 * `before` awaits this; the root-level `after` registered below removes the
 * token-bearing directory after the whole run, however it ends.
 */
let sharedConfigDir: Promise<string> | undefined

export function getSharedConfigDir(): Promise<string> {
  sharedConfigDir ??= buildSharedConfigDir()
  return sharedConfigDir
}

async function buildSharedConfigDir(): Promise<string> {
  const dir = await createConfigDir('api2cli-e2e-shared-')
  const {context7, linear, vercel} = requireEnv()

  // The exact commands from the suite's brief, plus a reduced selection depth
  // for Linear: depth 2 still covers every field the assertions read
  // (viewer scalars, issue scalars, issues edges/node) and roughly halves the
  // schema conversion time. The unmodified commands are covered by
  // import.e2e.test.ts, which builds its own throwaway dir.
  await runCliOk(
    [
      'api',
      'import',
      LINEAR_SCHEMA_URL,
      '--name',
      'linear',
      '--base-url',
      LINEAR_GRAPHQL_URL,
      '--selection-depth',
      '2',
    ],
    dir,
  )
  await runCliOk(['api', 'import', VERCEL_SPEC_URL, '--name', 'vercel'], dir)
  await runCliOk(['api', 'import', CONTEXT7_SPEC_URL, '--name', 'context7'], dir)

  // Linear expects its raw API key in the Authorization header; the other two
  // are standard bearer tokens.
  await runCliOk(
    ['api', 'auth', 'add', 'linear', '--type', 'apikey', '--api-key', linear, '--api-key-header', 'Authorization'],
    dir,
  )
  await runCliOk(['api', 'auth', 'add', 'vercel', '--type', 'bearer', '--token', vercel], dir)
  await runCliOk(['api', 'auth', 'add', 'context7', '--type', 'bearer', '--token', context7], dir)

  // A deliberately invalid profile per API, for the auth-failure tests.
  await runCliOk(
    [
      'api',
      'auth',
      'add',
      'linear',
      '--type',
      'apikey',
      '--api-key',
      'definitely-not-the-token',
      '--api-key-header',
      'Authorization',
      '-p',
      'broken',
    ],
    dir,
  )
  await runCliOk(
    ['api', 'auth', 'add', 'vercel', '--type', 'bearer', '--token', 'definitely-not-the-token', '-p', 'broken'],
    dir,
  )
  await runCliOk(
    ['api', 'auth', 'add', 'context7', '--type', 'bearer', '--token', 'definitely-not-the-token', '-p', 'broken'],
    dir,
  )

  return dir
}

// Root-level hook: helpers.ts is imported by every e2e file, but ESM module
// caching means this registers exactly once, and mocha runs root `after` hooks
// after every suite has finished — including when an earlier suite failed.
//
// Guarded on the global existing: scripts/sweep.ts imports this module too,
// outside any mocha process, where `after` is undefined.
if (typeof after === 'function') {
  after(async () => {
    if (!sharedConfigDir) return
    const dir = await sharedConfigDir.catch(() => null)
    if (dir) await removeConfigDir(dir)
  })
}
