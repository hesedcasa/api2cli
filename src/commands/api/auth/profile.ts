import {Args, Command, Flags} from '@oclif/core'

import {readStore} from '../../../api-store.js'
import {createApiAuthManager} from '../../../auth-store.js'

export default class AuthProfile extends Command {
  static args = {
    api: Args.string({description: 'API name', required: true}),
  }
  static description = 'Get or set the default auth profile for an imported API'
  static examples = [
    '<%= config.bin %> api auth profile petstore',
    '<%= config.bin %> api auth profile petstore --default prod',
  ]
  static flags = {
    default: Flags.string({description: 'Profile to set as default', required: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(AuthProfile)

    const store = await readStore(this.config.configDir)
    if (!store.specs[args.api]) {
      this.error(`No spec found with name "${args.api}". Run 'api list' to see available specs.`)
    }

    const pm = createApiAuthManager(this.config, args.api)

    if (flags.default) {
      try {
        await pm.setDefaultProfile(flags.default)
        this.log(`Default profile for "${args.api}" set to '${flags.default}'.`)
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error))
      }

      return
    }

    try {
      const profile = await pm.getDefaultProfile()
      this.log(profile)
    } catch {
      this.log("No default profile set. Run 'api auth add' to add a profile.")
    }
  }
}
