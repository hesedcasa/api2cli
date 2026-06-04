import {Args, Command, Flags} from '@oclif/core'

import {type AuthScheme, readStore} from '../../../api-store.js'
import {createApiAuthManager} from '../../../auth-store.js'

export default class AuthDelete extends Command {
  static args = {
    api: Args.string({description: 'API name', required: true}),
  }
  static description = 'Delete an auth profile for an imported API'
  static examples = ['<%= config.bin %> api auth delete petstore', '<%= config.bin %> api auth delete petstore -p prod']
  static flags = {
    profile: Flags.string({char: 'p', default: 'default', description: 'Profile name to delete', required: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AuthDelete)

    const store = await readStore(this.config.configDir)
    if (!store.specs[args.api]) {
      this.error(`No spec found with name "${args.api}". Run 'api list' to see available specs.`)
    }

    const profileName = flags.profile ?? 'default'
    const pm = createApiAuthManager(this.config, args.api)

    let profiles: Record<string, AuthScheme>
    try {
      profiles = (await pm.readProfiles()) as Record<string, AuthScheme>
    } catch {
      this.error(`No auth profiles found for "${args.api}".`)
    }

    if (!(profileName in profiles)) {
      this.error(`Profile '${profileName}' does not exist for "${args.api}".`)
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const {[profileName]: _, ...remaining} = profiles
    await pm.saveProfiles(remaining)

    const defaultProfile = await pm.getDefaultProfile().catch(() => 'default')
    if (profileName === defaultProfile) {
      const remainingKeys = Object.keys(remaining)
      await (remainingKeys.length > 0 ? pm.setDefaultProfile(remainingKeys[0]) : pm.clearDefaultProfile())
    }

    this.log(`Deleted profile '${profileName}' from "${args.api}".`)
  }
}
