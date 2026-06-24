#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"
NETWORK="${NETWORK:-testnet}"

for name in deployer alice bob; do
  if ! stellar keys public-key "${name}" >/dev/null 2>&1; then
    stellar keys generate "${name}" --network "${NETWORK}" --fund
  else
    stellar keys fund "${name}" --network "${NETWORK}" 2>/dev/null || true
  fi
  echo "${name}: $(stellar keys public-key ${name})"
done
