import {ux} from '@oclif/core'
import {dereference} from '@scalar/openapi-parser'
import {HttpsProxyAgent} from 'https-proxy-agent'
import {load as yamlLoad} from 'js-yaml'
import {existsSync} from 'node:fs'
import {mkdir, readdir, readFile, unlink, writeFile} from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import {join} from 'node:path'

import type {PostmanCollection} from './postman-converter.js'

import {isPostmanCollection, postmanToOpenApi} from './postman-converter.js'

// ─── OpenAPI types ────────────────────────────────────────────────────────────

interface OpenApiParameter {
  description?: string
  in: 'cookie' | 'header' | 'path' | 'query'
  name: string
  required?: boolean
  schema?: {enum?: string[]; type?: string}
}

interface OpenApiMediaType {
  schema?: OpenApiSchema
}

interface OpenApiRequestBody {
  content?: Record<string, OpenApiMediaType>
  required?: boolean
}

interface OpenApiSchema {
  description?: string
  properties?: Record<string, OpenApiSchemaProperty>
  required?: string[]
  type?: string
}

interface OpenApiSchemaProperty {
  allOf?: OpenApiSchemaProperty[]
  anyOf?: OpenApiSchemaProperty[]
  description?: string
  enum?: string[]
  items?: OpenApiSchemaProperty
  oneOf?: OpenApiSchemaProperty[]
  properties?: Record<string, OpenApiSchemaProperty>
  type?: string
}

interface OpenApiOperation {
  description?: string
  operationId?: string
  parameters?: OpenApiParameter[]
  requestBody?: OpenApiRequestBody
  summary?: string
  tags?: string[]
}

interface OpenApiPaths {
  [path: string]: {
    [method: string]: OpenApiOperation
  }
}

interface OpenApiComponents {
  parameters?: Record<string, OpenApiParameter>
  schemas?: Record<string, OpenApiSchema>
}

interface OpenApiSpec {
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

interface BodyParam {
  description?: string
  required: boolean
  type: string
}

interface GraphQLOperationMeta {
  fieldName: string
  operationType: 'mutation' | 'query'
  /**
   * The full GraphQL document to POST, including `query Name($var: Type!) { ... }`
   * or `mutation Name($var: Type!) { ... }` with a pre-generated selection set.
   */
  query: string
}

export interface StoredOperation {
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

export interface StoredSpec {
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
export interface ApiStore {
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
    [specFilePath(configDir, name), legacySpecFilePath(configDir, name)].map((fp) =>
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
    // eslint-disable-next-line n/no-unsupported-features/node-builtins
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
  let parsed = trimmed.startsWith('{') || trimmed.startsWith('[') ? JSON.parse(raw) : yamlLoad(raw)

  if (isPostmanCollection(parsed)) {
    parsed = postmanToOpenApi(parsed as PostmanCollection)
  }

  const {schema} = await dereference(parsed)
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

  const requiredSet = new Set(schema.required ?? [])
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
      const operation = (pathItem as Record<string, OpenApiOperation>)[method]
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

    default: {
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
export interface FetchResponseLike {
  arrayBuffer: () => Promise<ArrayBuffer>
  buffer?: () => Promise<Buffer>
  ok: boolean
  status: number
  statusText: string
  text: () => Promise<string>
}

export interface FetchLike {
  (
    url: string,
    init?: {body?: null | string; headers?: Record<string, string>; method?: string},
  ): Promise<FetchResponseLike>
}

/** Reads the full response body as a `Buffer`, avoiding a redundant copy when `buffer` is available. */
export async function readResponseBytes(res: FetchResponseLike): Promise<Buffer> {
  return res.buffer ? res.buffer() : Buffer.from(await res.arrayBuffer())
}

// ─── Insecure fetch (skips TLS verification) ──────────────────────────────────

/**
 * Checks if a URL should bypass the proxy based on NO_PROXY/no_proxy env vars.
 * NO_PROXY contains a comma-separated list of domains, IPs, or patterns.
 * Matches follow curl behavior: each name matches as hostname OR domain suffix.
 * Supports: exact matches, domain suffix matches, wildcard prefixes, and special values.
 */
export function shouldBypassProxy(targetUrl: string, noProxyList: string): boolean {
  if (!noProxyList.trim()) return false

  const target = new URL(targetUrl)
  let targetHost = target.hostname
  // Normalize IPv6: strip brackets from hostname (e.g., [::1] -> ::1)
  // This allows NO_PROXY entries like "::1" to match URLs like "http://[::1]"
  if (targetHost.startsWith('[') && targetHost.endsWith(']')) {
    targetHost = targetHost.slice(1, -1)
  }

  // Normalize port: use default ports for empty URL.port
  // URL.port is empty when the port is the scheme's default (80 for HTTP, 443 for HTTPS)
  const targetPort = target.port || (target.protocol === 'https:' ? '443' : '80')

  // Split NO_PROXY by commas and normalize to lowercase (URL.hostname is always lowercase)
  const patterns = noProxyList.split(',').map(p => p.trim().toLowerCase()).filter(Boolean)

  for (const pattern of patterns) {
    // Special case: "*" means bypass all
    if (pattern === '*') return true

    // Parse port-qualified entries (e.g., "localhost:8080" or "[::1]:8080")
    const colonIndex = pattern.lastIndexOf(':')
    // Check if this looks like a port-qualified entry:
    // - Part after last colon is all digits
    // - Part before last colon either is bracketed OR contains no colons (not an IPv6 address)
    const afterColon = colonIndex > 0 ? pattern.slice(colonIndex + 1) : ''
    const beforeColon = colonIndex > 0 ? pattern.slice(0, colonIndex) : ''
    const hasPort = colonIndex > 0 &&
                    /^\d+$/.test(afterColon) &&
                    (beforeColon.startsWith('[') || !beforeColon.includes(':'))
    let patternHost = hasPort ? pattern.slice(0, colonIndex) : pattern
    const patternPort = hasPort ? pattern.slice(colonIndex + 1) : undefined

    // Normalize IPv6: strip brackets from pattern (e.g., [::1] -> ::1)
    if (patternHost.startsWith('[') && patternHost.endsWith(']')) {
      patternHost = patternHost.slice(1, -1)
    }

    // If pattern has a port, it must match the target's port
    if (hasPort && targetPort !== patternPort) {
      continue
    }

    // Wildcard prefix matching (e.g., *.example.com)
    if (patternHost.startsWith('*.')) {
      const domain = patternHost.slice(2) // Remove "*."
      // Match domain and all subdomains
      if (targetHost === domain || targetHost.endsWith('.' + domain)) {
        return true
      }
    }
    // Dot-prefixed matching (e.g., .example.com matches example.com and subdomains)
    else if (patternHost.startsWith('.')) {
      const domain = patternHost.slice(1) // Remove leading dot
      // Match domain and all subdomains
      if (targetHost === domain || targetHost.endsWith('.' + domain)) {
        return true
      }
    }
    // Standard NO_PROXY matching: matches hostname exactly OR as domain suffix
    // Per curl behavior: "example.com" matches both "example.com" and "api.example.com"
    else {
      // Exact match
      if (targetHost === patternHost) {
        return true
      }

      // Domain suffix match (pattern is a suffix of hostname with a dot separator)
      // This allows "example.com" to match "api.example.com"
      if (targetHost.endsWith('.' + patternHost)) {
        return true
      }
    }
  }

  return false
}

/**
 * Returns the proxy URL from environment variables, if configured and not bypassed.
 * Selects proxy based on target protocol: HTTP_PROXY for http: URLs, HTTPS_PROXY for https: URLs.
 * Falls back to ALL_PROXY for both protocols. Respects NO_PROXY/no_proxy for bypass rules.
 */
export function getProxyUrl(targetUrl?: string): string | undefined {
  let proxyUrl: string | undefined

  // Select proxy variables based on target URL protocol
  if (targetUrl) {
    const { protocol } = new URL(targetUrl)
    if (protocol === 'http:') {
      // For HTTP: check HTTP_PROXY first, then ALL_PROXY
      proxyUrl =
        process.env.HTTP_PROXY ??
        process.env.http_proxy ??
        process.env.ALL_PROXY ??
        process.env.all_proxy
    } else if (protocol === 'https:') {
      // For HTTPS: check HTTPS_PROXY first, then ALL_PROXY
      proxyUrl =
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.ALL_PROXY ??
        process.env.all_proxy
    } else {
      // For other protocols or malformed URLs, check HTTPS_PROXY first (legacy fallback)
      proxyUrl =
        process.env.HTTPS_PROXY ??
        process.env.https_proxy ??
        process.env.HTTP_PROXY ??
        process.env.http_proxy ??
        process.env.ALL_PROXY ??
        process.env.all_proxy
    }
  } else {
    // No target URL provided: check HTTPS_PROXY first (legacy behavior for generic agent)
    proxyUrl =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy ??
      process.env.ALL_PROXY ??
      process.env.all_proxy
  }

  if (!proxyUrl) return undefined

  // Check NO_PROXY bypass
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? ''
  if (targetUrl && shouldBypassProxy(targetUrl, noProxy)) {
    return undefined
  }

  return proxyUrl
}

/**
 * Returns a fetch-compatible function that skips TLS certificate verification.
 * Use for APIs that serve self-signed certificates (e.g. Obsidian Local REST API).
 *
 * When a proxy is configured via HTTPS_PROXY/HTTP_PROXY env vars, routes requests
 * through it so Agent Vault's MITM proxy works correctly.
 */
export function buildInsecureFetch(): FetchLike {
  return (url, init = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url)
      const isHttps = u.protocol === 'https:'
      const mod = isHttps ? https : http

      const proxyUrl = getProxyUrl(url)
      const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl, {rejectUnauthorized: false}) : undefined

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
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
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
    resolvedPath = resolvedPath.replaceAll(`{${key}}`, encodeURIComponent(value))
  }

  return `${baseUrl}${resolvedPath}`
}
