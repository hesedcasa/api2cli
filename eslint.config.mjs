import {includeIgnoreFile} from '@eslint/compat'
import oclif from 'eslint-config-oclif'
import prettier from 'eslint-config-prettier'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import tseslint from 'typescript-eslint'

const gitignorePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.gitignore')

const config = [
  includeIgnoreFile(gitignorePath),
  {
    ignores: ['coverage/', 'dist/'],
  },
  ...oclif,
  // Disable type-checked (type-aware) rules for test files. Test fixtures and
  // mocks don't need full type information and shouldn't fail type-aware rules
  // such as no-unsafe-* / no-base-to-string. tsconfig.json excludes ./test, so
  // those rules have no project to resolve against anyway.
  {
    files: ['test/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  // typescript-eslint is a transitive dependency (via eslint-config-oclif), so
  // it isn't listed directly — relax the extraneous-dependency checks for this
  // file only.
  {
    files: ['eslint.config.mjs'],
    rules: {
      'import-x/no-extraneous-dependencies': 'off',
      'n/no-extraneous-import': 'off',
    },
  },
  // Relax overly-strict rules from eslint-config-oclif@7 across the project.
  {
    rules: {
      // Node's Buffer is the right type for the binary response bodies this CLI
      // streams to disk, and stored specs legitimately carry null values.
      '@typescript-eslint/no-restricted-types': 'off',
      // `import {join} from 'node:path'` is the convention throughout.
      'unicorn/import-style': 'off',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Stored specs and profiles are keyed by user-supplied API names.
      '@typescript-eslint/no-dynamic-delete': 'off',
      // Spec/response payloads are parsed JSON, so `any` flows in by nature.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      // `??` and `||` are not interchangeable for the empty-string defaults used here.
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      // fs/HTTP callbacks are typed as NodeJS.ErrnoException / Error on purpose.
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      // Command names and spec keys are built from untrusted strings; the `u`
      // flag would change matching semantics for existing patterns.
      'require-unicode-regexp': 'off',
      // Predicates such as `hostMatches` / `looksLikeGraphQLEndpoint` read better
      // without a forced `is` prefix.
      'unicorn/consistent-boolean-name': 'off',
      // oclif commands declare static members in the order oclif documents.
      'unicorn/consistent-class-member-order': 'off',
      'unicorn/no-break-in-nested-loop': 'off',
      // Store/profile records are keyed by user-supplied API and profile names.
      'unicorn/no-computed-property-existence-check': 'off',
      // GraphQL type unwrapping is genuinely recursive over wrapper types.
      'unicorn/no-useless-recursion': 'off',
      // oclif needs `protected`/`public` members on command classes.
      'unicorn/prefer-private-class-fields': 'off',
    },
  },
  {
    // oclif resolves hooks by directory name, so `command_not_found` is fixed.
    files: ['src/hooks/**/*.ts'],
    rules: {
      'unicorn/filename-case': 'off',
    },
  },
  // Additional relaxations for test files only. These are pure style rules that
  // conflict with common test patterns (mock stubs, env-var manipulation) and
  // with the http/https and whitespace literals the proxy tests assert on.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-dynamic-delete': 'off',
      'unicorn/no-computed-property-existence-check': 'off',
      'unicorn/prefer-https': 'off',
      'unicorn/prefer-math-constants': 'off',
      'unicorn/prefer-string-repeat': 'off',
    },
  },
  prettier,
]

export default config
