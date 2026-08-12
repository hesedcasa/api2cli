import {Args, Command, Flags} from '@oclif/core'
import {encode} from '@toon-format/toon'
import {writeFile} from 'node:fs/promises'

import {
  buildAuthHeaders,
  buildGraphQLBody,
  buildInsecureFetch,
  buildUrl,
  coerceBodyValue,
  type FetchLike,
  parseKV,
  readResponseBytes,
  readStore,
  startSpinner,
  stopSpinner,
  type StoredOperation,
} from '../../api-store.js'
import {loadApiAuthConfig} from '../../auth-store.js'

export default class ApiCall extends Command {
  static args = {
    name: Args.string({
      description: "API name (as shown in 'api list')",
      required: true,
    }),
    operationId: Args.string({
      description: 'Operation ID to call (as shown in `api list <name>`)',
      required: true,
    }),
  }

  static description = 'Call an imported API operation'
  static examples = [
    '<%= config.bin %> api call petstore listPets',
    '<%= config.bin %> api call petstore getPetById --param petId=42',
    '<%= config.bin %> api call petstore createPet --body name=Fido --body tag=dog',
    '<%= config.bin %> api call petstore listPets --query limit=10 --header X-Trace=abc',
  ]

  static flags = {
    'base-url': Flags.string({
      description: 'Override the base URL for this request',
      required: false,
    }),
    body: Flags.string({
      description: 'Request body field as key=value (repeatable)',
      multiple: true,
      required: false,
    }),
    header: Flags.string({
      description: 'Extra request header as Key=Value (repeatable)',
      multiple: true,
      required: false,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Write the raw response body to a file (required for binary responses such as zip archives)',
      exclusive: ['toon', 'raw'],
      required: false,
    }),
    param: Flags.string({
      description: 'Path or query parameter as key=value (repeatable)',
      multiple: true,
      required: false,
    }),
    profile: Flags.string({
      char: 'p',
      description: 'Authentication profile name',
      required: false,
    }),
    raw: Flags.boolean({
      description: 'Print the raw response body without JSON formatting',
      required: false,
    }),
    toon: Flags.boolean({
      description: 'Encode JSON output with TOON for token-efficient LLM consumption',
      required: false,
    }),
  }

  // Exposed for testing — inject a mock to avoid encoding in unit tests
  _applyToon: (value: unknown) => string = encode
  // Exposed for testing — inject a mock implementation to avoid real HTTP calls
  _fetch: FetchLike = fetch

  // eslint-disable-next-line complexity
  async run(): Promise<void> {
    const {args, flags} = await this.parse(ApiCall)

    const store = await readStore(this.config.configDir)
    const spec = store.specs[args.name]
    if (!spec) {
      this.error(`No spec found with name "${args.name}". Run 'api list' to see available specs.`)
    }

    const auth = await loadApiAuthConfig(this.config, args.name, flags.profile).catch((error: Error) => {
      this.error(error.message)
    })

    const operation: StoredOperation | undefined = spec.operations.find((o) => o.operationId === args.operationId)
    if (!operation) {
      this.error(
        `Operation "${args.operationId}" not found in "${args.name}". Run 'api list ${args.name}' to see operations.`,
      )
    }

    const baseUrl = flags['base-url'] ?? auth?.baseUrl ?? spec.baseUrl
    if (!baseUrl) {
      this.error('No base URL set. Supply one with --base-url or re-import with `api import --base-url <url>`.')
    }

    // ── Parse key=value pairs ──────────────────────────────────────────────────
    const parsedParams = parseKV(flags.param ?? [])
    const parsedBody = parseKV(flags.body ?? [])
    const parsedHeaders = parseKV(flags.header ?? [])

    // ── Split params into path / query / header ────────────────────────────────
    const {headerParams, pathParams, queryParams} = this._splitParams(operation.parameters, parsedParams)

    // Validate required body params
    this._validateBodyParams(operation.bodyParams, parsedBody)

    // ── Build URL ──────────────────────────────────────────────────────────────
    const url = new URL(buildUrl(baseUrl, operation.path, pathParams))
    for (const [k, v] of Object.entries(queryParams)) {
      url.searchParams.set(k, v)
    }

    // ── Build body ─────────────────────────────────────────────────────────────
    const coercedBody: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(parsedBody)) {
      coercedBody[k] = coerceBodyValue(operation.bodyParams, k, v)
    }

    const isGraphQL = operation.graphql !== undefined
    const hasBody = isGraphQL || Object.keys(coercedBody).length > 0
    const requestBody = isGraphQL
      ? buildGraphQLBody(operation.graphql!.query, coercedBody)
      : hasBody
        ? JSON.stringify(coercedBody)
        : undefined

    // ── Build headers ──────────────────────────────────────────────────────────
    // parsedHeaders (from --header) take priority — they can override the inferred Content-Type.
    const headers: Record<string, string> = {
      ...(auth && buildAuthHeaders(auth)),
      ...headerParams,
    }
    if (hasBody && !parsedHeaders['Content-Type']) {
      headers['Content-Type'] = 'application/json'
    }

    Object.assign(headers, parsedHeaders)

    // ── Execute ────────────────────────────────────────────────────────────────
    const method = operation.method.toUpperCase()
    const reqInit = {body: requestBody, headers, method}

    this.log(`${method} ${url.href}`)

    // A spinner (on stderr, so piped stdout stays clean) reassures the user
    // while the request is in flight — downloads to a file can be large
    // binaries such as zips, and even plain responses can be slow.
    startSpinner(flags.output ? `Downloading to ${flags.output}` : `${method} request`)

    const fetchFn = spec.insecure ? buildInsecureFetch() : this._fetch
    const res = await fetchFn(url.href, reqInit).catch((error: Error) => {
      stopSpinner('failed')
      this.error(`Request failed: ${error.message}`)
    })

    if (!res.ok) {
      stopSpinner('failed')
      this.warn(`HTTP ${res.status} ${res.statusText}`)
    }

    if (flags.output && res.ok) {
      const body = await readResponseBytes(res)
      await writeFile(flags.output, body)
      stopSpinner(`saved ${body.length} bytes`)
      this.log(`Saved ${body.length} bytes to ${flags.output}`)
      return
    }

    stopSpinner()
    const responseText = await res.text()

    if (flags.raw) {
      this.log(responseText)
    } else {
      try {
        const parsed = JSON.parse(responseText)
        if (flags.toon) {
          this.log(this._applyToon(parsed))
        } else {
          this.log(JSON.stringify(parsed, null, 2))
        }
      } catch {
        this.log(responseText)
      }
    }

    if (flags.output) {
      this.error(`Not writing ${flags.output}: request failed with HTTP ${res.status}`)
    }
  }

  private _splitParams(
    parameters: StoredOperation['parameters'],
    parsedParams: Record<string, string>,
  ): {headerParams: Record<string, string>; pathParams: Record<string, string>; queryParams: Record<string, string>} {
    const pathParams: Record<string, string> = {}
    const queryParams: Record<string, string> = {}
    const headerParams: Record<string, string> = {}
    for (const p of parameters) {
      const value = parsedParams[p.name]
      if (value === undefined) {
        if (p.required) {
          this.error(`Missing required parameter: ${p.name} (${p.in})`)
        }

        continue
      }

      switch (p.in) {
        // Cookie params are not supported by the CLI — ignore them.
        case 'cookie': {
          break
        }

        case 'header': {
          headerParams[p.name] = value
          break
        }

        case 'path': {
          pathParams[p.name] = value
          break
        }

        case 'query': {
          queryParams[p.name] = value
          break
        }
      }
    }

    return {headerParams, pathParams, queryParams}
  }

  private _validateBodyParams(bodyParams: StoredOperation['bodyParams'], parsedBody: Record<string, string>): void {
    for (const [name, def] of Object.entries(bodyParams)) {
      if (def.required && parsedBody[name] === undefined) {
        this.error(`Missing required body field: ${name}`)
      }
    }
  }
}
