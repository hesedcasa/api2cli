import {Args, Command} from '@oclif/core'

import {type AuthScheme, readStore} from '../../../api-store.js'
import {createApiAuthManager} from '../../../auth-store.js'

function redact(value: string): string {
  if (value.length <= 8) return '***'
  return value.slice(0, 4) + '***' + value.slice(-4)
}

function formatAuth(auth: AuthScheme): string {
  switch (auth.type) {
    case 'apikey': {
      return `  type   : apikey\n  header : ${auth.header}\n  key    : ${redact(auth.apiKey)}`
    }

    case 'basic': {
      return `  type     : basic\n  username : ${auth.username}\n  password : ${redact(auth.password)}`
    }

    case 'custom': {
      const headerLines = Object.entries(auth.headers)
        .map(([k, v]) => `  ${k} : ${redact(v)}`)
        .join('\n')
      return `  type: custom\n${headerLines}`
    }

    case 'http': {
      return `  type  : bearer\n  token : ${redact(auth.token)}`
    }

    default: {
      return '  type: none'
    }
  }
}

export default class AuthList extends Command {
  static args = {
    api: Args.string({description: 'API name', required: true}),
  }
  static description = 'List auth profiles for an imported API'
  static examples = ['<%= config.bin %> api auth list petstore']
  static flags = {}

  async run(): Promise<void> {
    const {args} = await this.parse(AuthList)

    const store = await readStore(this.config.configDir)
    if (!store.specs[args.api]) {
      this.error(`No spec found with name "${args.api}". Run 'api list' to see available specs.`)
    }

    const pm = createApiAuthManager(this.config, args.api)

    let profiles: Awaited<ReturnType<typeof pm.readProfiles>>
    try {
      profiles = await pm.readProfiles()
    } catch {
      this.log(`No auth profiles configured for "${args.api}". Run 'api auth add ${args.api}' to add one.`)
      return
    }

    if (Object.keys(profiles).length === 0) {
      this.log(`No auth profiles configured for "${args.api}". Run 'api auth add ${args.api}' to add one.`)
      return
    }

    const defaultProfile = await pm.getDefaultProfile().catch(() => 'default')

    this.log(`Auth profiles for "${args.api}":`)
    for (const [name, auth] of Object.entries(profiles) as [string, AuthScheme][]) {
      const marker = name === defaultProfile ? ' (default)' : ''
      this.log(`\n${name}${marker}:`)
      this.log(formatAuth(auth))
      if (auth.baseUrl) this.log(`  baseUrl: ${auth.baseUrl}`)
    }
  }
}
