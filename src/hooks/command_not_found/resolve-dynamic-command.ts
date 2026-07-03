import type {Hook} from '@oclif/core'

import {readStore} from '../../api-store.js'

/**
 * With `topicSeparator: ' '`, oclif decides where a space-separated command id
 * ends and its positional arguments begin by checking each candidate id
 * against the *statically* known command list — which is built once when the
 * CLI config loads, before the `init` hook (register-api-commands) has had a
 * chance to inject the per-operation dynamic commands. So a call like
 * `<spec> <operationId> <arg1> <arg2>` never finds a matching id early enough
 * to stop, and every token — including what should be positional arguments —
 * gets swallowed into one unresolvable id: `spec:operationId:arg1:arg2`.
 *
 * By the time this `command_not_found` hook runs, the `init` hook has already
 * registered the dynamic commands, so we can recover here: split the
 * mis-joined id back into the real `spec:operationId` command plus the args
 * that got wrongly absorbed, and retry.
 */
const hook: Hook<'command_not_found'> = async function (opts) {
  const parts = opts.id.split(':')
  if (parts.length > 2) {
    const [specName, operationId, ...swallowedArgs] = parts
    const store = await readStore(opts.config.configDir).catch(() => null)
    const op = store?.specs[specName]?.operations.find((o) => o.operationId === operationId)
    if (op) {
      return opts.config.runCommand(`${specName}:${operationId}`, [...swallowedArgs, ...(opts.argv ?? [])])
    }
  }

  this.error(`command ${opts.id} not found`)
}

export default hook
