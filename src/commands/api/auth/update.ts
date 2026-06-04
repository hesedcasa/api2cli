import {Args, Command, Flags} from '@oclif/core'

import {type AuthScheme, readStore} from '../../../api-store.js'
import {buildAuthScheme, createApiAuthManager} from '../../../auth-store.js'

export default class AuthUpdate extends Command {
  static args = {
    api: Args.string({description: 'API name', required: true}),
  }
  static description = 'Update an auth profile for an imported API'
  static examples = [
    '<%= config.bin %> api auth update petstore --type bearer --token sk-new',
    '<%= config.bin %> api auth update petstore --type apikey --api-key newkey -p prod',
    '<%= config.bin %> api auth update petstore --type bearer --token sk-... --base-url https://api.prod.example.com -p prod',
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
    const {args, flags} = await this.parse(AuthUpdate)

    const store = await readStore(this.config.configDir)
    if (!store.specs[args.api]) {
      this.error(`No spec found with name "${args.api}". Run 'api list' to see available specs.`)
    }

    const profileName = flags.profile ?? 'default'
    const pm = createApiAuthManager(this.config, args.api)

    let existingProfiles: Record<string, AuthScheme> = {}
    try {
      existingProfiles = (await pm.readProfiles()) as Record<string, AuthScheme>
    } catch {}

    if (!existingProfiles[profileName]) {
      this.error(`Profile '${profileName}' does not exist. Use 'api auth add ${args.api}' to create it.`)
    }

    let auth: AuthScheme
    try {
      auth = buildAuthScheme(flags)
    } catch (error) {
      this.error((error as Error).message)
    }

    await pm.saveProfiles({...existingProfiles, [profileName]: auth!})
    this.log(`Updated profile "${profileName}" for "${args.api}": ${flags.type}`)
  }
}
