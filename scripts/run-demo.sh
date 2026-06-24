#!/usr/bin/env bash
# Scripted demo: verify compliance + shielded proofs on-chain (no pool token transfer).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"

COMPLIANCE_V=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ROOT}/testnet-addresses.json')).contracts.compliance_verifier)")
SHIELDED_V=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ROOT}/testnet-addresses.json')).contracts.shielded_transfer_verifier)")

verify_circuit() {
  local name="$1"
  local contract="$2"
  local build="${ROOT}/target/groth16/${name}/stellar"
  local proof_dir="${ROOT}/target/groth16/${name}/proof"
  mkdir -p "${build}"
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" proof "${proof_dir}/proof.json" > "${build}/proof.hex"
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" public "${proof_dir}/public.json" > "${build}/public.hex"
  PROOF_HEX=$(tr -d '\r\n' < "${build}/proof.hex")
  PUBLIC_HEX=$(tr -d '\r\n' < "${build}/public.hex")
  echo "Verifying ${name} on ${contract}..."
  stellar contract invoke --id "${contract}" --network testnet --source-account deployer --send=yes \
    -- verify --proof_bytes "${PROOF_HEX}" --pub_signals_bytes "${PUBLIC_HEX}"
}

verify_circuit compliance "${COMPLIANCE_V}"
verify_circuit shielded_transfer "${SHIELDED_V}"
echo "Demo complete."
