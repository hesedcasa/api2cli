import {ux} from '@oclif/core'
import {dereference} from '@scalar/openapi-parser'
import {load as yamlLoad} from 'js-yaml'
import {Buffer} from 'node:buffer'
import {existsSync} from 'node:fs'
import {mkdir, readdir, readFile, unlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import {join} from 'node:path'

import {isPostmanCollection, type PostmanCollection, postmanToOpenApi} from './postman-converter.js'
import {buildProxyAgent} from './proxy.js'

// ─── OpenAPI types ────────────────────────────────────────────────────────────

type OpenApiParameter = {
  description?: string
  in: 'cookie' | 'header' | 'path' | 'query'
  name: string
  required?: boolean
  schema?: {enum?: string[]; type?: string}
}

type OpenApiMediaType = {
  schema?: OpenApiSchema
}

type OpenApiRequestBody = {
  content?: Record<string, OpenApiMediaType>
  required?: boolean
}

type OpenApiSchema = {
  description?: string
  properties?: Record<string, OpenApiSchemaProperty>
  required?: string[]
  type?: string
}

type OpenApiSchemaProperty = {
  allOf?: OpenApiSchemaProperty[]
  anyOf?: OpenApiSchemaProperty[]
  description?: string
  enum?: string[]
  items?: OpenApiSchemaProperty
  oneOf?: OpenApiSchemaProperty[]
  properties?: Record<string, OpenApiSchemaProperty>
  type?: string
}

type OpenApiOperation = {
  description?: string
  operationId?: string
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  summary?: string
  tags?: string[]
}

type OpenApiPaths = Record<string, Record<string, OpenApiOperation>>

type OpenApiComponents = {
  parameters?: Record<string, OpenApiParameter>
  schemas?: Record<string, OpenApiSchema>
}

type OpenApiSpec = {
  components?: OpenApiComponents
  info?: {description?: string; title?: string; version?: string}
  openapi?: string
  paths?: OpenApiPaths
  swagger?: string
}

// ─── Stored config types ──────────────────────────────────────────────────────

export type AuthScheme =
  | {apiKey: string; baseUrl?: string; header: string; type: 'apikey'}
  | {baseUrl?: string; headers: Record<string, string>; type: 'custom'}
  | {baseUrl?: string; password: string; type: 'basic'; username: string}
  | {baseUrl?: string; scheme: 'bearer'; token: string; type: 'http'}
  | {baseUrl?: string; type: 'none'}

type BodyParam = {
  description?: string
  required: boolean
  type: string
}

type GraphQLOperationMeta = {
  fieldName: string
  operationType: 'mutation' | 'query'
  /**
   * The full GraphQL document to POST, including `query Name($var: Type!) { ... }`
   * or `mutation Name($var: Type!) { ... }` with a pre-generated selection set.
   */
  query: string
}

export type StoredOperation = {
  bodyParams: Record<string, BodyParam>
  description: string
  /** Present when this operation was extracted from a GraphQL schema. */
  graphql?: GraphQLOperationMeta
  method: string
  operationId: string
  parameters: OpenApiParameter[]
  path: string
  rawBodyContentType?: string
}

export type StoredSpec = {
  baseUrl: string
  description: string
  insecure?: boolean
  /** Discriminates between OpenAPI/Postman-derived specs and GraphQL-derived specs. */
  kind?: 'graphql' | 'openapi'
  name: string
  operations: StoredOperation[]
  source: string
  title: string
}

// ts-prune-ignore-next
export type ApiStore = {
  specs: Record<string, StoredSpec>
}

// ─── File paths ───────────────────────────────────────────────────────────────

function specFilePath(configDir: string, name: string): string {
  return join(configDir, `api-${name}.json`)
}

function legacySpecFilePath(configDir: string, name: string): string {
  return join(configDir, `openapi-${name}.json`)
}

// ─── Read / write ─────────────────────────────────────────────────────────────

export async function readStore(configDir: string): Promise<ApiStore> {
  const store: ApiStore = {specs: {}}
  if (!existsSync(configDir)) return store

  let files: string[]
  try {
    files = await readdir(configDir)
  } catch (error) {
    console.error(`Failed to read config directory "${configDir}": ${(error as Error).message}`)
    return store
  }

  // Accept both `api-<name>.json` (current) and `openapi-<name>.json` (legacy).
  // When both exist for the same spec name, api-<name>.json wins.
  const specFiles = files.filter((f) => /^(api|openapi)-.+\.json$/.test(f))
  specFiles.sort((a, b) => (a.startsWith('api-') ? -1 : b.startsWith('api-') ? 1 : 0))

  const loaded = await Promise.all(
    specFiles.map(async (file) => {
      try {
        const raw = await readFile(join(configDir, file), 'utf8')
        return JSON.parse(raw) as StoredSpec
      } catch (error) {
        console.error(`Failed to load spec file "${file}": ${(error as Error).message}`)
        return null
      }
    }),
  )

  for (const spec of loaded) {
    if (spec && !store.specs[spec.name]) store.specs[spec.name] = spec
  }

  return store
}

export async function writeStore(configDir: string, store: ApiStore): Promise<void> {
  if (!existsSync(configDir)) {
    await mkdir(configDir, {recursive: true})
  }

  await Promise.all(
    Object.entries(store.specs).map(async ([name, spec]) => {
      await writeFile(specFilePath(configDir, name), JSON.stringify(spec, null, 2), 'utf8')
      // Remove any stale legacy file so readStore sees a single source of truth.
      await unlink(legacySpecFilePath(configDir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') {
          console.error(`Failed to remove legacy spec file for "${name}": ${error.message}`)
        }
      })
    }),
  )
}

export async function deleteSpec(configDir: string, name: string): Promise<boolean> {
  const results = await Promise.all(
    [specFilePath(configDir, name), legacySpecFilePath(configDir, name)].map(async (fp) =>
      unlink(fp)
        .then(() => true)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return false
          throw new Error(`Failed to delete spec file "${fp}": ${error.message}`)
        }),
    ),
  )
  return results.some(Boolean)
}

// ─── Spec loading ─────────────────────────────────────────────────────────────

export async function loadSpec(source: string): Promise<OpenApiSpec> {
  let raw: string

  if (source.startsWith('http://') || source.startsWith('https://')) {
    const res = await fetch(source)
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${source}`)
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('json') && !contentType.includes('yaml') && !contentType.includes('text/plain')) {
      throw new Error(`URL did not return a JSON or YAML file.`)
    }

    raw = await res.text()
  } else {
    raw = await readFile(source, 'utf8')
  }

  const trimmed = raw.trimStart()
  let parsed: unknown = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(raw) : yamlLoad(raw)

  if (isPostmanCollection(parsed)) {
    parsed = postmanToOpenApi(parsed as PostmanCollection)
  }

  const {schema} = dereference(parsed as OpenApiSpec)
  return (schema ?? parsed) as OpenApiSpec
}

// ─── Command name generation ──────────────────────────────────────────────────

function deriveOperationId(method: string, path: string): string {
  const segments = path
    .split('/')
    .filter(Boolean)
    .map((s) => (s.startsWith('{') ? s.slice(1, -1) : s))
  return `${method}-${segments.join('-')}`
}

// ─── Spec extraction ──────────────────────────────────────────────────────────

function inferPropertyType(prop: OpenApiSchemaProperty): string {
  if (prop.type) return prop.type
  if (prop.properties) return 'object'
  if (prop.items) return 'array'

  const variants = prop.anyOf ?? prop.oneOf ?? prop.allOf
  if (variants) {
    if (variants.some((v) => v.type === 'object' || v.properties)) return 'object'
    if (variants.some((v) => v.type === 'array' || v.items)) return 'array'
  }

  return 'string'
}

function extractBodyParams(rb: OpenApiRequestBody | undefined): Record<string, BodyParam> {
  const bodyParams: Record<string, BodyParam> = {}
  if (!rb) return bodyParams

  const schema = rb.content?.['application/json']?.schema
  if (!schema?.properties) return bodyParams

  const requiredSet = new Set(schema.required)
  for (const [name, prop] of Object.entries(schema.properties)) {
    bodyParams[name] = {description: prop.description, required: requiredSet.has(name), type: inferPropertyType(prop)}
  }

  return bodyParams
}

/**
 * Returns the content type for a raw (non-JSON-object) request body, or
 * undefined when the body is handled as named JSON bodyParams.
 * Prefers specific MIME types over the wildcard `*\/*`.
 */
function extractRawBodyContentType(rb: OpenApiRequestBody | undefined): string | undefined {
  if (!rb?.content) return undefined

  // If application/json has named properties it's a structured JSON body → handled via bodyParams
  if (rb.content['application/json']?.schema?.properties) return undefined

  // Prefer the most specific non-wildcard, non-JSON content type
  for (const ct of Object.keys(rb.content)) {
    if (ct !== 'application/json' && ct !== '*/*') return ct
  }

  // Fall back to wildcard if nothing more specific exists
  if (rb.content['*/*']) return '*/*'

  // application/json present but no named properties (e.g. schema type: string) → raw JSON string
  if (rb.content['application/json']) return 'application/json'

  return undefined
}

const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head'] as const

export function extractOperations(spec: OpenApiSpec): StoredOperation[] {
  const ops: StoredOperation[] = []
  const paths = spec.paths ?? {}

  for (const [path, pathItem] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method]
      if (!operation) continue

      const operationId =
        operation.operationId
          ?.replaceAll(/[^\w-]/g, '-')
          .replaceAll(/-+/g, '-')
          .replaceAll(/^-|-$/g, '') ?? deriveOperationId(method, path)

      const parameters: OpenApiParameter[] = operation.parameters ?? []

      // Extract request body fields as named body params
      const bodyParams = extractBodyParams(operation.requestBody)
      const rawBodyContentType = extractRawBodyContentType(operation.requestBody)

      const description = operation.summary ?? operation.description ?? `${method.toUpperCase()} ${path}`

      ops.push({bodyParams, description, method, operationId, parameters, path, rawBodyContentType})
    }
  }

  return ops
}

// ─── Base URL extraction ──────────────────────────────────────────────────────

export function extractBaseUrl(spec: OpenApiSpec & {servers?: Array<{url: string}>}): string {
  // OpenAPI 3.x
  const {servers} = spec as {servers?: Array<{url: string}>}
  if (servers && servers.length > 0) {
    return servers[0].url.replace(/\/$/, '')
  }

  // Swagger 2.x
  const s2 = spec as {basePath?: string; host?: string; schemes?: string[]}
  if (s2.host) {
    const scheme = s2.schemes?.[0] ?? 'https'
    const basePath = s2.basePath ?? ''
    return `${scheme}://${s2.host}${basePath}`.replace(/\/$/, '')
  }

  return ''
}

// ─── Body value coercion ──────────────────────────────────────────────────────

/**
 * Coerces a raw string value (argv or --body flag) to the JSON-encodable type
 * indicated by the StoredOperation's bodyParam metadata. Used to turn stringly
 * typed CLI input into real numbers/booleans/objects before serialising as JSON.
 */
export function coerceBodyValue(bodyParams: Record<string, BodyParam>, name: string, raw: string): unknown {
  const paramType = bodyParams[name]?.type
  switch (paramType) {
    case 'array':
    case 'object': {
      try {
        return JSON.parse(raw)
      } catch {
        return raw
      }
    }

    case 'boolean': {
      return raw === 'true'
    }

    case 'integer':
    case 'number': {
      const n = Number(raw)
      return Number.isNaN(n) ? raw : n
    }

    default: {
      return raw
    }
  }
}

/**
 * Wraps a variables map for a GraphQL operation into the JSON body expected by
 * a GraphQL endpoint: `{query, variables}`. Omits `variables` when empty so the
 * server sees an identical request to what a typical GraphQL client sends.
 */
export function buildGraphQLBody(query: string, variables: Record<string, unknown>): string {
  const payload: {query: string; variables?: Record<string, unknown>} = {query}
  if (Object.keys(variables).length > 0) payload.variables = variables
  return JSON.stringify(payload)
}

// ─── KV parsing ───────────────────────────────────────────────────────────────

export function parseKV(pairs: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    result[idx === -1 ? pair : pair.slice(0, idx)] = idx === -1 ? '' : pair.slice(idx + 1)
  }

  return result
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

export function buildAuthHeaders(auth: AuthScheme): Record<string, string> {
  switch (auth.type) {
    case 'apikey': {
      return {[auth.header]: auth.apiKey}
    }

    case 'basic': {
      const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
      return {Authorization: `Basic ${encoded}`}
    }

    case 'custom': {
      return {...auth.headers}
    }

    case 'http': {
      return {Authorization: `Bearer ${auth.token}`}
    }

    case 'none': {
      return {}
    }
  }
}

// ─── Fetch abstraction (shared by call.ts and api-dynamic-commands.ts) ────────

/**
 * Minimal interface for the fetch-like response used across the CLI. Using a
 * structural type here makes it easy to mock in tests without depending on the
 * global `fetch` type, which ESLint flags as experimental for Node < 21.
 *
 * `buffer` is an optional fast path for implementations (like the insecure
 * fetch below) that already hold the body as a `Buffer` — it lets callers skip
 * the extra copy that `Buffer.from(await arrayBuffer())` would otherwise make.
 */
export type FetchResponseLike = {
  arrayBuffer: () => Promise<ArrayBuffer>
  buffer?: () => Promise<Buffer>
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}

export type FetchLike = (
  url: string,
  init?: {body?: null | string; headers?: Record<string, string>; method?: string},
) => Promise<FetchResponseLike>

/** Reads the full response body as a `Buffer`, avoiding a redundant copy when `buffer` is available. */
export async function readResponseBytes(res: FetchResponseLike): Promise<Buffer> {
  return res.buffer ? res.buffer() : Buffer.from(await res.arrayBuffer())
}

// ─── Insecure fetch (skips TLS verification) ──────────────────────────────────

/**
 * Returns a fetch-compatible function that skips TLS certificate verification.
 * Use for APIs that serve self-signed certificates (e.g. Obsidian Local REST API).
 *
 * For https:// targets, routes through a configured proxy via a CONNECT tunnel
 * (see {@link buildProxyAgent}) so a MITM proxy such as Agent Vault works.
 * Plain http:// targets connect directly — a MITM proxy only intercepts TLS, so
 * routing them through it would fail; direct is the only thing that works.
 */
export function buildInsecureFetch(): FetchLike {
  return async (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url)
      const isHttps = u.protocol === 'https:'
      const mod = isHttps ? https : http

      // HTTPS: route through a configured proxy (CONNECT tunnel — see
      // {@link buildProxyAgent}) for MITM credential injection. HTTP: connect
      // directly with a fresh agent — a MITM proxy only intercepts TLS and
      // rejects plain-HTTP upstreams (502), and under Node's NODE_USE_ENV_PROXY
      // the http.globalAgent would otherwise route the request through it. An
      // explicit direct agent overrides that env-configured global agent.
      const agent = isHttps ? buildProxyAgent(url, {rejectUnauthorized: false}) : new http.Agent()

      const req = mod.request(
        {
          agent,
          headers: init.headers,
          hostname: u.hostname,
          method: init.method ?? 'GET',
          path: u.pathname + u.search,
          port: u.port ? Number(u.port) : isHttps ? 443 : 80,
          rejectUnauthorized: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })
          res.on('end', () => {
            const body = Buffer.concat(chunks)
            resolve({
              arrayBuffer: async () => new Uint8Array(body).buffer,
              // Already an exact-length copy of the body — return it directly instead of
              // re-copying via arrayBuffer().
              buffer: async () => body,
              ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
              status: res.statusCode ?? 0,
              statusText: res.statusMessage ?? '',
              text: async () => body.toString('utf8'),
            })
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      if (init.body) req.write(init.body)
      req.end()
    })
}

// ─── Progress spinner ─────────────────────────────────────────────────────────

/**
 * Starts a stderr spinner, but only in an interactive terminal. In non-TTY
 * contexts (pipes, CI, tests) oclif's spinner degrades to plain "action... done"
 * lines on stderr, which are just noise, so we skip it entirely there.
 */
export function startSpinner(action: string): void {
  if (process.stderr.isTTY) ux.action.start(action)
}

/** Stops the spinner started by {@link startSpinner}. No-op when none is running. */
export function stopSpinner(msg?: string): void {
  if (process.stderr.isTTY) ux.action.stop(msg)
}

// ─── URL building ─────────────────────────────────────────────────────────────

export function buildUrl(baseUrl: string, path: string, pathParams: Record<string, string>): string {
  let resolvedPath = path
  for (const [key, value] of Object.entries(pathParams)) {
    resolvedPath = resolvedPath.replaceAll(`{${key}}`, () => encodeURIComponent(value))
  }

  return `${baseUrl}${resolvedPath}`
}
