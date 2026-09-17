#!/usr/bin/env node

import {Config, execute} from '@oclif/core'

import {registerApiCommands} from '../dist/api-dynamic-commands.js'

// Patch Config.load so every config instance automatically gets the dynamic
// API commands registered the moment it exists — in particular *before*
// main.run() normalizes argv. With `topicSeparator: ' '`, oclif's id
// collation checks whether the command matched so far takes positional
// arguments; when the dynamic commands are not yet registered (the init hook
// runs after normalization) it keeps absorbing tokens into one unresolvable
// id and positional arguments — JSON payloads especially — are lost. The
// command_not_found hook reconstructs them as a fallback, but registering
// early means the raw argv passes through untouched in the first place.
// registerApiCommands is idempotent, so the later init hook is a no-op.
const originalLoad = Config.load.bind(Config)
Config.load = async (...args) => {
  const config = await originalLoad(...args)
  await registerApiCommands(config).catch(() => {})
  return config
}

await execute({dir: import.meta.url})
