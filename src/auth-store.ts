import type {Config} from '@oclif/core'

import {createProfileManager} from '@hesed/plugin-lib'
import {rename, unlink} from 'node:fs/promises'
import {join} from 'node:path'

import {type AuthScheme, parseKV} from './api-store.js'

function authFile(apiName: string): string {
  return `auth-${apiName}.json`
}

export function createApiAuthManager(config: Config, apiName: string, profile?: string) {
  return createProfileManager<AuthScheme>(config, profile, authFile(apiName))
}

export async function deleteAuthFile(configDir: string, apiName: string): Promise<void> {
  await unlink(join(configDir, authFile(apiName))).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
  })
}

export async function renameAuthFile(configDir: string, oldName: string, newName: string): Promise<void> {
  await rename(join(configDir, authFile(oldName)), join(configDir, authFile(newName))).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    },
  )
}

export function buildAuthScheme(flags: {
  'api-key'?: string
  'api-key-header'?: string
  'base-url'?: string
  header?: string[]
  password?: string
  token?: string
  type: string
  username?: string
}): AuthScheme {
  const baseUrl = flags['base-url'] || undefined
  switch (flags.type) {
    case 'apikey': {
      if (!flags['api-key']) throw new Error('--api-key is required when --type is apikey')
      return {apiKey: flags['api-key'], baseUrl, header: flags['api-key-header'] ?? 'X-API-Key', type: 'apikey'}
    }

    case 'basic': {
      if (!flags.username) throw new Error('--username is required when --type is basic')
      if (!flags.password) throw new Error('--password is required when --type is basic')
      return {baseUrl, password: flags.password, type: 'basic', username: flags.username}
    }

    case 'bearer': {
      if (!flags.token) throw new Error('--token is required when --type is bearer')
      return {baseUrl, scheme: 'bearer', token: flags.token, type: 'http'}
    }

    case 'custom': {
      if (!flags.header || flags.header.length === 0) throw new Error('--header is required when --type is custom')
      return {baseUrl, headers: parseKV(flags.header), type: 'custom'}
    }

    case 'none': {
      return {baseUrl, type: 'none'}
    }

    default: {
      throw new Error(`Unknown auth type: "${flags.type}"`)
    }
  }
}
