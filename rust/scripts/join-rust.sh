#!/usr/bin/env bash
# One-line join for the Rust stack (also served at /join.sh from Rust hub).
# curl -sSL https://noeticompute.com/join.sh | bash
set -euo pipefail

export NOETIS_HUB="${NOETIS_HUB:-https://noeticompute.com}"
curl -sSL "${NOETIS_HUB}/install.sh" | bash
