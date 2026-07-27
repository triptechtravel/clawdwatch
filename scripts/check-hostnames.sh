#!/usr/bin/env bash
# Fail if an internal hostname reaches the public repository.
#
# This project was extracted from a private deployment, which is exactly the
# situation where real hostnames leak into fixtures and docs. Patterns live in
# a file the scan excludes, so the guard never matches its own definition.
set -uo pipefail

PATTERNS='campermate|geozone\.co\.nz|rowntree\.co\.nz'

if rg --hidden \
      --glob '!.git' \
      --glob '!node_modules' \
      --glob '!package-lock.json' \
      --glob '!scripts/check-hostnames.sh' \
      -i "$PATTERNS" . ; then
  echo "::error::Private hostname found. Use example.com in code, tests, and docs."
  exit 1
fi

echo "No private hostnames found."
