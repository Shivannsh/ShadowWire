#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"
export CARGO_TARGET_DIR="${ROOT}/contracts/target"
NETWORK="${NETWORK:-testnet}"
SOURCE="${SOURCE:-deployer}"
# SRT test asset SAC on testnet (Stellar Reference Token via testanchor)
ASSET="${ASSET:-CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC}"

echo "=== ShadowWire Deploy (${NETWORK}) ==="

build() {
  stellar contract build --manifest-path "${ROOT}/contracts/${1}/Cargo.toml" --package "${1}" --optimize
}

deploy() {
  local pkg="$1"
  local wasm="${ROOT}/contracts/target/wasm32v1-none/release/${pkg}.wasm"
  local out
  if [[ "$pkg" == "compliance_registry" ]]; then
    out=$(stellar contract deploy --wasm "${wasm}" --network "${NETWORK}" --source-account "${SOURCE}" -- \
      --admin "$(stellar keys public-key "${SOURCE}")" 2>&1)
  elif [[ "$pkg" == "shielded_pool" ]]; then
    out=$(stellar contract deploy --wasm "${wasm}" --network "${NETWORK}" --source-account "${SOURCE}" -- \
      --admin "$(stellar keys public-key "${SOURCE}")" \
      --asset "${ASSET}" \
      --compliance_verifier "${COMPLIANCE_V}" \
      --shielded_verifier "${SHIELDED_V}" \
      --registry "${REGISTRY}" \
      --initial_root "0000000000000000000000000000000000000000000000000000000000000000" 2>&1)
  else
    out=$(stellar contract deploy --wasm "${wasm}" --network "${NETWORK}" --source-account "${SOURCE}" 2>&1)
  fi
  echo "$out" >&2
  echo "$out" | grep -Eo 'C[A-Z2-7]{55}' | tail -1
}

setup_verifier() {
  local circuit_dir="$1"
  local id="$2"
  local ptaupower=12
  [[ "$(basename "$circuit_dir")" == "shielded_transfer" ]] && ptaupower=15
  PTAU_POWER=$ptaupower bash "${ROOT}/scripts/run-circuit.sh" "${circuit_dir}" >&2
  local proof_dir="${ROOT}/target/groth16/$(basename ${circuit_dir})/proof"
  local build_dir="${ROOT}/target/groth16/$(basename ${circuit_dir})/stellar"
  mkdir -p "${build_dir}"
  node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" vk "${proof_dir}/verification_key.json" > "${build_dir}/vk.hex"
  VK_HEX=$(tr -d '\r\n' < "${build_dir}/vk.hex")
  stellar contract invoke --id "${id}" --network "${NETWORK}" --source-account "${SOURCE}" -- set_vk --vk_bytes "${VK_HEX}" >&2
}

bash "${ROOT}/scripts/fund-accounts.sh" 2>/dev/null || true

build compliance_registry
build compliance_verifier
build shielded_transfer_verifier
build shielded_pool

REGISTRY=$(deploy compliance_registry)
COMPLIANCE_V=$(deploy compliance_verifier)
SHIELDED_V=$(deploy shielded_transfer_verifier)

setup_verifier "${ROOT}/circuits/compliance" "${COMPLIANCE_V}"
setup_verifier "${ROOT}/circuits/shielded_transfer" "${SHIELDED_V}"

POOL=$(deploy shielded_pool)

DEPLOYER=$(stellar keys public-key deployer 2>/dev/null || echo "")
ALICE=$(stellar keys public-key alice 2>/dev/null || echo "")
BOB=$(stellar keys public-key bob 2>/dev/null || echo "")

node -e "
const fs=require('fs');
const p='${ROOT}/testnet-addresses.json';
const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)): {};
Object.assign(d,{
  network:'${NETWORK}',
  asset:'${ASSET}',
  accounts:{deployer:'${DEPLOYER}',alice:'${ALICE}',bob:'${BOB}'},
  contracts:{
    compliance_registry:'${REGISTRY}',
    compliance_verifier:'${COMPLIANCE_V}',
    shielded_transfer_verifier:'${SHIELDED_V}',
    shielded_pool:'${POOL}'
  },
  txs:{}
});
fs.writeFileSync(p,JSON.stringify(d,null,2));
fs.mkdirSync('${ROOT}/frontend/public',{recursive:true});
fs.writeFileSync('${ROOT}/frontend/public/testnet-addresses.json',JSON.stringify(d,null,2));
"

echo "Registry: ${REGISTRY}"
echo "Compliance Verifier: ${COMPLIANCE_V}"
echo "Shielded Verifier: ${SHIELDED_V}"
echo "Pool: ${POOL}"
