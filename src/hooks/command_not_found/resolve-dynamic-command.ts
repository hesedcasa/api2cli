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
 * mis-joined id back into the real `spec:operationId` command plus the
 * arguments that got wrongly absorbed, and retry.
 *
 * The split needs one care: the join collapsed both argument boundaries and
 * any colon *inside* an argument into the same character — a JSON payload's
 * `"key":` sequences are indistinguishable from the separators between two
 * arguments. What breaks the tie is the operation itself, which knows how many
 * positional arguments it takes: the first N-1 colon-split pieces are the
 * first N-1 positionals (URL/query parameters — colon-free in practice), and
 * every remaining piece is rejoined with ':' into the LAST positional, which
 * is where JSON payloads live (`{"title":"x"}` arrives as several fragments
 * and leaves as one argument). `opts.argv` (the tokens oclif kept after the
 * absorbed id — trailing flags, usually) is appended unchanged.
 *
 * When the id can't be recovered this way, the hook must fail without
 * winning the race against other, still-pending `command_not_found` hooks —
 * e.g. `@oclif/plugin-not-found`'s interactive "Did you mean X?" prompt,
 * which must not get cut off before the user can respond. oclif runs every
 * `command_not_found` hook concurrently via `Promise.all` and re-throws (thus
 * short-circuiting the other hooks) whenever a hook's error carries a
 * non-zero `error.oclif.exit` — which `this.error(...)` always sets. So we
 * throw a plain `Error` instead: it has no `.oclif.exit`, so oclif just
 * records the failure and lets every hook finish naturally.
 *
 * Resolving successfully (e.g. returning `undefined`) instead of throwing
 * would be worse: oclif treats *any* settled hook as "handled" and returns
 * its result immediately, skipping the standard not-found fallback — so a
 * plain typo would silently exit 0 whenever no other `command_not_found`
 * hook is installed to catch it. Throwing keeps this hook's failure
 * available for oclif's own fallback (`throw hookResult.failures[0].error`)
 * to surface with the expected non-zero exit if nothing else handles it.
 */
const hook: Hook<'command_not_found'> = async function (opts) {
  const parts = opts.id.split(':')
  if (parts.length > 2) {
    const [specName, operationId] = parts
    const store = await readStore(opts.config.configDir).catch(() => null)
    const op = store?.specs[specName]?.operations.find((o) => o.operationId === operationId)
    if (op) {
      // Mirrors the positional args the dynamic command class declares:
      // required URL/query/header parameters first, then required body params.
      const positionalCount =
        op.parameters.filter((p) => p.required).length + Object.values(op.bodyParams).filter((p) => p.required).length
      const raw = parts.slice(2)
      // More fragments than positionals means colons inside the last
      // argument: hand the first N-1 fragments to the first N-1 positionals
      // and rejoin the rest. With N=1 this is the whole tail as one argument.
      const swallowedArgs =
        raw.length <= positionalCount
          ? raw
          : [...raw.slice(0, positionalCount - 1), raw.slice(positionalCount - 1).join(':')]

      return opts.config.runCommand(`${specName}:${operationId}`, [...swallowedArgs, ...(opts.argv ?? [])])
    }
  }

  throw new Error(`command ${opts.id} not found`)
}

export default hook
