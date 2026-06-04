import {Args, Command, Flags} from '@oclif/core'

import {type AuthScheme, readStore} from '../../../api-store.js'
import {buildAuthScheme, createApiAuthManager} from '../../../auth-store.js'

export default class AuthAdd extends Command {
  static args = {
    api: Args.string({description: 'API name', required: true}),
  }
  static description = 'Add an auth profile for an imported API'
  static examples = [
    '<%= config.bin %> api auth add petstore --type bearer --token sk-...',
    '<%= config.bin %> api auth add petstore --type apikey --api-key mykey -p prod',
    '<%= config.bin %> api auth add petstore --type basic --username user --password secret',
    '<%= config.bin %> api auth add petstore --type custom --header X-Tenant-ID=acme --header X-App-Key=secret',
    '<%= config.bin %> api auth add petstore --type bearer --token sk-... --base-url https://api.prod.example.com',
    '<%= config.bin %> api auth add petstore --type none',
  ]
  static flags = {
    'api-key': Flags.string({description: 'API key value (used with --type apikey)', required: false}),
    'api-key-header': Flags.string({default: 'X-API-Key', description: 'Header name for the API key', required: false}),
    'base-url': Flags.string({
      description: 'Base URL for this profile (overrides spec base URL at call time)',
      required: false,
    }),
    header: Flags.string({
      description: 'Custom header Key=Value (--type custom, repeatable)',
      multiple: true,
      required: false,
    }),
    password: Flags.string({description: 'Password for basic auth', required: false}),
    profile: Flags.string({char: 'p', default: 'default', description: 'Profile name', required: false}),
    token: Flags.string({description: 'Bearer token (used with --type bearer)', required: false}),
    type: Flags.string({
      description: 'Auth type',
      options: ['none', 'bearer', 'apikey', 'basic', 'custom'],
      required: true,
    }),
    username: Flags.string({description: 'Username for basic auth', required: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AuthAdd)

    const store = await readStore(this.config.configDir)
    if (!store.specs[args.api]) {
      this.error(`No spec found with name "${args.api}". Run 'api list' to see available specs.`)
    }

    const pm = createApiAuthManager(this.config, args.api)
    let existingProfiles: Record<string, AuthScheme> = {}
    try {
      existingProfiles = (await pm.readProfiles()) as Record<string, AuthScheme>
    } catch {}

    const profileName = flags.profile ?? 'default'
    if (existingProfiles[profileName]) {
      this.error(`Profile '${profileName}' already exists. Use 'api auth update ${args.api}' to modify it.`)
    }

    let auth: AuthScheme
    try {
      auth = buildAuthScheme(flags)
    } catch (error) {
      this.error((error as Error).message)
    }

    const isFirst = Object.keys(existingProfiles).length === 0
    await pm.saveProfiles({...existingProfiles, [profileName]: auth!})
    if (isFirst) await pm.setDefaultProfile(profileName)
    this.log(`Added profile "${profileName}" for "${args.api}": ${flags.type}`)
  }
}
