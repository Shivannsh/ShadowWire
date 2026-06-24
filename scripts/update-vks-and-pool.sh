#!/usr/bin/env bash
# Update verification keys on existing verifier contracts and redeploy the pool.
# Faster than a full redeploy — reuses the already-deployed Registry + Verifiers.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${ROOT}/contracts/target"
NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"
ASSET="${ASSET:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"

# Read existing contract addresses
ADDRESSES="${ROOT}/testnet-addresses.json"
COMPLIANCE_V=$(node -p "require('${ADDRESSES}').contracts.compliance_verifier")
SHIELDED_V=$(node -p  "require('${ADDRESSES}').contracts.shielded_transfer_verifier")
REGISTRY=$(node -p    "require('${ADDRESSES}').contracts.compliance_registry")
OLD_POOL=$(node -p    "require('${ADDRESSES}').contracts.shielded_pool")

echo "=== [1/4] Encoding verification keys ==="
for CIRCUIT in compliance shielded_transfer; do
  PROOF_DIR="${ROOT}/target/groth16/${CIRCUIT}/proof"
  STELLAR_DIR="${ROOT}/target/groth16/${CIRCUIT}/stellar"
  mkdir -p "${STELLAR_DIR}"
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" vk "${PROOF_DIR}/verification_key.json" > "${STELLAR_DIR}/vk.hex"
  echo "  ${CIRCUIT}: $(wc -c < "${STELLAR_DIR}/vk.hex") chars"
done

echo ""
echo "=== [2/4] Setting new VK on ComplianceVerifier: ${COMPLIANCE_V} ==="
VK_COMPLIANCE=$(tr -d '\r\n' < "${ROOT}/target/groth16/compliance/stellar/vk.hex")
VK_TX=$(stellar contract invoke \
  --id "${COMPLIANCE_V}" \
  --network "${NETWORK}" \
  --source-account "${SOURCE}" \
  --send=yes \
  -- set_vk --vk_bytes "${VK_COMPLIANCE}" 2>&1)
echo "  compliance set_vk tx: ${VK_TX}"

echo ""
echo "=== [3/4] Setting new VK on ShieldedTransferVerifier: ${SHIELDED_V} ==="
VK_SHIELDED=$(tr -d '\r\n' < "${ROOT}/target/groth16/shielded_transfer/stellar/vk.hex")
VK_TX2=$(stellar contract invoke \
  --id "${SHIELDED_V}" \
  --network "${NETWORK}" \
  --source-account "${SOURCE}" \
  --send=yes \
  -- set_vk --vk_bytes "${VK_SHIELDED}" 2>&1)
echo "  shielded set_vk tx: ${VK_TX2}"

echo ""
echo "=== [4/4] Rebuilding and redeploying ShieldedPool ==="
stellar contract build \
  --manifest-path "${ROOT}/contracts/shielded_pool/Cargo.toml" \
  --package shielded_pool \
  --optimize

POOL_WASM="${ROOT}/contracts/target/wasm32v1-none/release/shielded_pool.wasm"
POOL_OUT=$(stellar contract deploy \
  --wasm "${POOL_WASM}" \
  --network "${NETWORK}" \
  --source-account "${SOURCE}" \
  -- \
  --admin "$(stellar keys public-key ${SOURCE})" \
  --asset "${ASSET}" \
  --compliance_verifier "${COMPLIANCE_V}" \
  --shielded_verifier "${SHIELDED_V}" \
  --registry "${REGISTRY}" \
  --corridor_id 1 \
  --initial_root "0000000000000000000000000000000000000000000000000000000000000000" 2>&1)
echo "${POOL_OUT}" >&2
NEW_POOL=$(echo "${POOL_OUT}" | grep -Eo 'C[A-Z2-7]{55}' | tail -1)
echo "  New pool: ${NEW_POOL}"

# Update testnet-addresses.json
node -e "
const fs = require('fs');
const p = '${ROOT}/testnet-addresses.json';
const d = JSON.parse(fs.readFileSync(p));
d.contracts.shielded_pool = '${NEW_POOL}';
// Keep old pool address for reference
d.contracts.shielded_pool_v1 = '${OLD_POOL}';
d.txs = d.txs || {};
d.txs.compliance_vk_update = '${VK_TX}'.replace(/\\n/g,'').trim().slice(0,64) || 'see-logs';
d.txs.shielded_vk_update   = '${VK_TX2}'.replace(/\\n/g,'').trim().slice(0,64) || 'see-logs';
d.txs.pool_v2_deploy       = '${NEW_POOL}';
fs.writeFileSync(p, JSON.stringify(d, null, 2));
fs.mkdirSync('${ROOT}/frontend/public', { recursive: true });
fs.writeFileSync('${ROOT}/frontend/public/testnet-addresses.json', JSON.stringify(d, null, 2));
console.log('testnet-addresses.json updated');
"

echo ""
echo "=== Done ==="
echo "ComplianceVerifier:          ${COMPLIANCE_V}"
echo "ShieldedTransferVerifier:    ${SHIELDED_V}"
echo "ShieldedPool (v2, 2-output): ${NEW_POOL}"
