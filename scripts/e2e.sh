#!/usr/bin/env bash
# Runs the end-to-end suite against the three live APIs (Linear, Vercel,
# Context7).
#
# Nothing in this repo loads .env, so export the credentials first:
#
#   set -a; . ./.env; set +a
#   npm run test:e2e
#   npm run test:e2e -- --keep            # skip the post-run sweep
#   npm run test:e2e -- --grep "comment"  # extra args go through to mocha
#
# There is no container to start: these are third-party cloud APIs, so the
# live accounts play the role a disposable container plays elsewhere. The
# suite only mutates Linear (fixture issues titled "[e2e <run>] ..."), and
# everything it creates is reclaimed by the sweep below.
set -euo pipefail

cd "$(dirname "$0")/.."

KEEP=0
MOCHA_ARGS=()

for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) MOCHA_ARGS+=("$arg") ;;
  esac
done

missing=()
for var in LINEAR_API_KEY VERCEL_API_KEY CONTEXT7_API_KEY; do
  if [ -z "${!var:-}" ]; then
    missing+=("$var")
  fi
done

if [ "${#missing[@]}" -gt 0 ]; then
  echo "error: missing credentials: ${missing[*]}" >&2
  echo "Nothing in this repo loads .env. Run:  set -a; . ./.env; set +a" >&2
  exit 1
fi

# Pins the fixture title prefix for this invocation so the post-run sweep,
# which is a separate process from mocha, can reclaim *this* run's fixtures
# and not only the ones older than an hour.
E2E_RUN_ID="${E2E_RUN_ID:-local-$$}"
export E2E_RUN_ID

# Runs on the way out, including after a failing mocha. A sweep failure leaves
# fixtures in the live Linear workspace, so it must not be swallowed: it
# surfaces as a non-zero exit unless the tests already failed, in which case
# that status is the more useful one to keep.
cleanup() {
  local status=$?

  if [ "$KEEP" -ne 0 ]; then
    echo "==> Leaving fixtures in place (--keep); clean up later with: npm run e2e:sweep"
    exit "$status"
  fi

  echo "==> Sweeping any fixtures left behind"
  if npm run --silent e2e:sweep; then
    exit "$status"
  fi

  echo "error: sweeping fixtures failed; the Linear workspace may still hold e2e issues" >&2
  if [ "$status" -eq 0 ]; then
    exit 1
  fi

  exit "$status"
}
trap cleanup EXIT

echo "==> Building the CLI"
# Not `npm run build`: that is `shx rm -rf dist && tsc -b`, and with the
# composite tsbuildinfo living at the repo root, `tsc -b` considers a build
# whose dist/ was just deleted "up to date" and emits nothing — every
# subprocess then dies with MODULE_NOT_FOUND. --force rebuilds regardless of
# the buildinfo's view of the world.
rm -rf dist
npx tsc -b --force

echo "==> Running end-to-end tests against Linear, Vercel and Context7"
# Delegates to the `e2e:mocha` script rather than calling mocha directly, so
# both entry points share one glob and one timeout.
# The +expansion guard keeps `set -u` happy with an empty array on bash 3.2.
npm run --silent e2e:mocha -- ${MOCHA_ARGS[@]+"${MOCHA_ARGS[@]}"}
