#!/usr/bin/env -S node --loader ts-node/esm --disable-warning=ExperimentalWarning

import {Config, execute} from '@oclif/core'

// Mirrors bin/run.js: register the dynamic API commands before argv
// normalization so oclif's space-form id collation stops at
// `spec:operationId` instead of absorbing positional arguments into the id.
// dev.js is a repo-local entry point that is never published, so its import
// from src/ (this file's reason to exist — it runs src under ts-node) trips
// the unpublished-import rule.
// eslint-disable-next-line n/no-unpublished-import
import {registerApiCommands} from '../src/api-dynamic-commands.js'

const originalLoad = Config.load.bind(Config)
Config.load = async (...args) => {
  const config = await originalLoad(...args)
  await registerApiCommands(config).catch(() => {})
  return config
}

await execute({development: true, dir: import.meta.url})
