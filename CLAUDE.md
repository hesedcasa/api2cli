# CLAUDE.md

## End-to-end tests

`test/e2e/**` runs the built `bin/run.js` as a real subprocess against three live APIs — Linear (GraphQL), Vercel and Context7 (OpenAPI). `npm run test:e2e` then reruns the same suite through the pinned sdkck host CLI with the current build packed and installed as its `@hesed/api2cli` plugin — the host switch (`E2E_HOST_CLI=sdkck` + `E2E_SDKCK_HOME`, set by `scripts/e2e.sh` and the CI workflow) lives in `test/e2e/helpers.ts`; the plugin must be installed before any `sdkck api` call, or sdkck auto-installs the published release, and the tarball must be a `file:` URL (bare paths read as GitHub `org/repo`); sdkck itself is pinned to an exact release with a verified sha512 because the host runs the plugin in-process with the live credentials in its environment (version and hash live in both `scripts/e2e.sh` and the CI workflow — bump deliberately). It is excluded from `npm test` and needs credentials exported first, because nothing in this repo loads `.env`:

```bash
set -a; . ./.env; set +a
npm run test:e2e              # build, run, then sweep
npm run test:e2e -- --keep    # leave fixtures behind for inspection
npm run e2e:mocha             # run without rebuilding
npm run e2e:sweep             # delete fixtures older than an hour
```

`e2e:sweep` also deletes the _current_ run's fixtures when `E2E_RUN_ID` is set — `scripts/e2e.sh` and the CI workflow both set it, so a mocha killed before its `after` hooks ran (a job timeout, a local Ctrl-C) still gets cleaned up instead of waiting an hour for the stale sweep to reach it.

Six rules specific to this suite:

- **Every command prints a `METHOD <url>` request line to stdout before the response.** `runCliJson` strips it via `stripRequestLine`; don't `JSON.parse` raw stdout.
- **Fixtures are created with raw `fetch` in `test/e2e/fixtures.ts`, never through the CLI** — they are the oracle the CLI is checked against. (The lifecycle tests are the deliberate exception: the mutation commands under test must run through the CLI, so their titles carry the run prefix and `cleanupRun` reclaims them anyway.)
- **Every fixture issue is titled with the `[e2e <run-id>]` prefix.** The prefix search is anchored on `[e2e ` (see `findIssuesByTitle`), so both `cleanupRun` and `sweepStale` are structurally bounded to suite-created issues.
- **The subprocess config dir is isolated with `API_CONFIG_DIR`** (oclif's bin-scoped `CONFIG_DIR` override). Tests never touch `~/.config/api`; the shared dir is built once per mocha process by `getSharedConfigDir()` and removed by the root `after` hook in `helpers.ts`.
- **No regex literals in `test/**`.** `require-unicode-regexp`is configured to demand the`v`flag, and the`v`flag requires TS target`es2024`while this repo targets`es2022`, so eslint and tsc contradict each other. Use string methods instead.
- **`api call` takes no positional parameters.** Required query/path params go through the repeatable `--param key=value` flag; positionals are a feature of the dynamic command form (`api context7 searchLibraries react hooks`).

## Endpoint sweep

`test/e2e/sweep.e2e.test.ts` exercises **every** operation in the three imported specs live — `api call` with spec-derived junk params, 6 at a time, retrying 429s and transport failures — and gates each API at ≥50% attempted coverage. That gate is what keeps "more than half the endpoints are tested" true as the specs grow. The planning/judging logic lives in `test/sweep-helpers.ts` (not under `test/e2e/`: ts-node cannot resolve downward imports from `test/` into `test/e2e/`) and is unit-pinned by `test/sweep-probe.test.ts`, which runs in plain `npm test`.

The sweep's side-effect guarantees:

- **GraphQL mutations are poisoned, never trusted.** Every structured (object/list) argument gets an unknown `__e2e_probe__` field, which fails GraphQL variable coercion server-side before any resolver runs.
- **Unpoisonable mutations are skipped, not executed.** Argless mutations and all-optional-scalar mutations (any string coerces for `String!`) count as skipped against coverage rather than being fired live. Same for raw-body endpoints (`rawBodyContentType` set — the CLI cannot build the request) and REST mutators with no required path/query/body param for the server to reject.
- **The audit is the backstop.** A mutation that nonetheless returns 2xx (REST), or resolves its payload without `success: false` (GraphQL), is a failing violation. Such an operation lands in `ACCEPTED_MUTATIONS` only with a justification quoting the observed payload (currently: the two delete-by-junk-id idempotent no-ops, and `passkeyLoginStart`, whose challenge for a nonexistent authId can never verify).
- **Probes are traceable.** Every probe value is the literal `__e2e_probe__`; anything bearing it on a live account came from the sweep.

Pinned-as-observed behaviours (deliberate, do not "fix" the tests):

- A non-OK HTTP response is a stderr warning and **exit 0** — only `--output` turns failures into errors.
- `this.error` exits **2**, not 1.
- GraphQL errors arrive as HTTP 200 with an `errors` body, so mutations with invalid input also exit 0.
- Vercel answers an invalid token with **403** (`invalidToken`), not 401.
- The Vercel token cannot create projects (403), so Vercel and Context7 paths are read-only; Linear is the only API the suite mutates.
- Linear **soft-deletes**: a deleted issue reads back with `archivedAt` set and `trashed` true during its ~30-day grace period, and disappears from the default `issues` filter — there is no Jira-style 404 to assert. On live issues Linear renders `trashed` as **null**, not false, so "not trashed" is `.to.not.be.true`.
- `issueDelete` resolves its `DeleteEntity` interface to the concrete Issue fields (id, identifier, trashed, …) — but no `__typename`, which the converter never requests.
