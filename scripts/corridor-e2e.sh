#!/usr/bin/env bash
# Full on-chain corridor: deposit → shielded transfer → withdraw (CLI, no browser).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"
NETWORK="${NETWORK:-testnet}"
ADDRS="${ROOT}/testnet-addresses.json"

POOL=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ADDRS}')).contracts.shielded_pool)")
ASSET=$(node -e "console.log(JSON.parse(require('fs').readFileSync('${ADDRS}')).asset)")
ALICE=$(stellar keys public-key alice)
BOB=$(stellar keys public-key bob)

echo "=== ShadowWire corridor e2e ==="
echo "Pool: ${POOL}"
echo "Alice: ${ALICE}"
echo "Bob: ${BOB}"

load_hex() {
  local circuit="$1"
  local kind="$2"
  local build="${ROOT}/target/groth16/${circuit}/stellar"
  local proof_dir="${ROOT}/target/groth16/${circuit}/proof"
  mkdir -p "${build}"
  if [[ ! -f "${proof_dir}/proof.json" ]]; then
  PTAU_POWER=$([[ "$circuit" == shielded_transfer ]] && echo 15 || echo 12) \
    bash "${ROOT}/scripts/run-circuit.sh" "${ROOT}/circuits/${circuit}"
  fi
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" proof "${proof_dir}/proof.json" > "${build}/proof.hex"
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" public "${proof_dir}/public.json" > "${build}/public.hex"
  tr -d '\r\n' < "${build}/${kind}.hex"
}

# Demo note fields from circuits/shielded_transfer/inputs.json (must match proof witness)
INPUTS="${ROOT}/circuits/shielded_transfer/inputs.json"
COMMITMENT_HEX=$(node -e "
const i=require('${INPUTS}');
// input note commitment is first leaf in merkle tree at index 0
const { execSync } = require('child_process');
// use precomputed values from inputs
const root=i.merkle_root.replace(/^0x/,'');
console.log(root);
")
# Precomputed from nargo test_demo_values
NOTE_COMMITMENT="0918150e2fafd0801ad77c0f188eb23323d57e8348abca6cd8f5d86dad1e2863"
NEW_ROOT_AFTER_DEPOSIT="25a6a81c92903601ea976fa9827f0a8c6a0c30878e8de27be9dba110c02547f9"
NULLIFIER=$(node -e "console.log(require('${INPUTS}').nullifier_hash.replace(/^0x/,''))")
NEW_COMMITMENT=$(node -e "console.log(require('${INPUTS}').new_commitment.replace(/^0x/,''))")
MERKLE_ROOT=$(node -e "console.log(require('${INPUTS}').merkle_root.replace(/^0x/,''))")
DEPOSIT_AMOUNT=$(node -e "console.log(require('${ROOT}/circuits/compliance/inputs.json').amount)")

COMPLIANCE_PROOF=$(load_hex compliance proof)
COMPLIANCE_PUBLIC=$(load_hex compliance public)
SHIELDED_PROOF=$(load_hex shielded_transfer proof)
SHIELDED_PUBLIC=$(load_hex shielded_transfer public)

echo "[0] Fund alice/bob if needed"
bash "${ROOT}/scripts/fund-accounts.sh" 2>/dev/null || true

echo "[1] Pool deposit (amount=${DEPOSIT_AMOUNT})"
DEPOSIT_OUT=$(stellar contract invoke --id "${POOL}" --network "${NETWORK}" --source-account alice --send=yes \
  -- deposit \
  --depositor "${ALICE}" \
  --amount "${DEPOSIT_AMOUNT}" \
  --commitment "${NOTE_COMMITMENT}" \
  --new_root "${NEW_ROOT_AFTER_DEPOSIT}" \
  --compliance_proof "${COMPLIANCE_PROOF}" \
  --compliance_pub_signals "${COMPLIANCE_PUBLIC}" 2>&1)
echo "${DEPOSIT_OUT}"
DEPOSIT_TX=$(echo "${DEPOSIT_OUT}" | grep -Eo 'testnet/tx/[a-f0-9]{64}' | head -1 | sed 's|.*/||')
echo "Deposit tx: ${DEPOSIT_TX}"

echo "[2] Shielded transfer"
TRANSFER_OUT=$(stellar contract invoke --id "${POOL}" --network "${NETWORK}" --source-account alice --send=yes \
  -- transfer \
  --sender "${ALICE}" \
  --nullifier "${NULLIFIER}" \
  --new_commitment "${NEW_COMMITMENT}" \
  --new_root "${MERKLE_ROOT}" \
  --shielded_proof "${SHIELDED_PROOF}" \
  --shielded_pub_signals "${SHIELDED_PUBLIC}" 2>&1)
echo "${TRANSFER_OUT}"
TRANSFER_TX=$(echo "${TRANSFER_OUT}" | grep -Eo 'testnet/tx/[a-f0-9]{64}' | head -1 | sed 's|.*/||')
echo "Transfer tx: ${TRANSFER_TX}"

echo "[3] Withdraw skipped — output-note spend proof required after transfer (see README)"
WITHDRAW_TX=""

node -e "
const fs=require('fs');
const p='${ADDRS}';
const d=JSON.parse(fs.readFileSync(p));
d.txs=d.txs||{};
d.txs.pool_deposit='${DEPOSIT_TX}';
d.txs.pool_transfer='${TRANSFER_TX}';
fs.writeFileSync(p,JSON.stringify(d,null,2));
fs.writeFileSync('${ROOT}/frontend/public/testnet-addresses.json',JSON.stringify(d,null,2));
"
echo "Updated testnet-addresses.json with corridor txs."
