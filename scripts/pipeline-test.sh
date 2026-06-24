#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CIRCUIT_DIR="${ROOT}/circuits/pipeline_test"
OUT_DIR="${ROOT}/target/groth16/pipeline_test"
BUILD_DIR="${OUT_DIR}/stellar"
CONTRACTS_DIR="${ROOT}/contracts/compliance_verifier"
NETWORK="${NETWORK:-testnet}"
SOURCE_ACCOUNT="${SOURCE_ACCOUNT:-deployer}"

export PATH="${ROOT}/.tools:${HOME}/.cargo/bin:${PATH}"

echo "=== ShadowWire Pipeline Test ==="
bash "${ROOT}/scripts/run-circuit.sh" "${CIRCUIT_DIR}"

PROOF_DIR="${OUT_DIR}/proof"
mkdir -p "${BUILD_DIR}"

node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" vk "${PROOF_DIR}/verification_key.json" > "${BUILD_DIR}/vk.hex"
node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" proof "${PROOF_DIR}/proof.json" > "${BUILD_DIR}/proof.hex"
node "${ROOT}/scripts/encode_bn254_for_soroban.mjs" public "${PROOF_DIR}/public.json" > "${BUILD_DIR}/public.hex"

echo "Building verifier contract..."
stellar contract build --manifest-path "${CONTRACTS_DIR}/Cargo.toml" --package compliance_verifier --optimize

WASM="${ROOT}/contracts/target/wasm32v1-none/release/compliance_verifier.wasm"

echo "Deploying to ${NETWORK}..."
CONTRACT_ID=$(stellar contract deploy --wasm "${WASM}" --network "${NETWORK}" --source-account "${SOURCE_ACCOUNT}" 2>&1 | grep -Eo 'C[A-Z2-7]{55}' | tail -1)

VK_HEX=$(tr -d '\r\n' < "${BUILD_DIR}/vk.hex")
PROOF_HEX=$(tr -d '\r\n' < "${BUILD_DIR}/proof.hex")
PUBLIC_HEX=$(tr -d '\r\n' < "${BUILD_DIR}/public.hex")

stellar contract invoke --id "${CONTRACT_ID}" --network "${NETWORK}" --source-account "${SOURCE_ACCOUNT}" -- set_vk --vk_bytes "${VK_HEX}"
RESULT=$(stellar contract invoke --id "${CONTRACT_ID}" --network "${NETWORK}" --source-account "${SOURCE_ACCOUNT}" -- verify --proof_bytes "${PROOF_HEX}" --pub_signals_bytes "${PUBLIC_HEX}")

echo "Contract ID: ${CONTRACT_ID}"
echo "On-chain verify result: ${RESULT}"

mkdir -p "${ROOT}"
node -e "
const fs=require('fs');
const p='${ROOT}/testnet-addresses.json';
const d=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)): {};
d.pipeline_test={contract_id:'${CONTRACT_ID}', network:'${NETWORK}', verify_result:${RESULT}};
fs.writeFileSync(p, JSON.stringify(d,null,2));
"
