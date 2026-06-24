#!/usr/bin/env bash
# ShadowWire pipeline runner — wraps Noir-Groth16 tooling for a given circuit directory.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOIR_GROTH16="${ROOT}/_ref/Noir-Groth16"
COMMON_SH="${ROOT}/scripts/lib/common.sh"
CIRCUIT_DIR="${1:-${ROOT}/circuits/pipeline_test}"
OUT_DIR="${OUT_DIR:-${ROOT}/target/groth16/$(basename "${CIRCUIT_DIR}")}"
PTAU_POWER="${PTAU_POWER:-12}"
# Auto-bump for larger circuits
if [[ "$(basename "${CIRCUIT_DIR}")" == "shielded_transfer" ]]; then
  PTAU_POWER="${PTAU_POWER:-15}"
fi
NOIR_CLI="${NOIR_CLI:-${ROOT}/.tools/noir-groth16-target/debug/noir-cli}"

export PATH="${ROOT}/.tools:${PATH}"
NARGO="${ROOT}/.tools/nargo-beta19"
if [[ ! -x "${NARGO}" ]]; then
  NARGO="${ROOT}/.tools/nargo"
fi
export PATH="$(dirname "${NARGO}"):${PATH}"

# shellcheck source=./lib/common.sh
source "${COMMON_SH}"

ng16_detect_platform
ng16_require_cmd nargo "$(ng16_hint_nargo)"
ng16_require_cmd node "$(ng16_hint_node)"
ng16_ensure_snarkjs "0.7.0"

if [[ ! -x "${NOIR_CLI}" ]]; then
  echo "Building noir-cli..."
  (cd "${NOIR_GROTH16}" && cargo build -p noir-cli)
fi

PACKAGE_NAME="$(awk -F '=' '/^[[:space:]]*name[[:space:]]*=/ {gsub(/[[:space:]]|"/, "", $2); print $2; exit}' "${CIRCUIT_DIR}/Nargo.toml")"
ARTIFACT_PATH="${CIRCUIT_DIR}/target/${PACKAGE_NAME}.json"
PTAU_INITIAL="${OUT_DIR}/pot${PTAU_POWER}_0000.ptau"
PTAU_FINAL="${OUT_DIR}/pot${PTAU_POWER}_final.ptau"
INTEROP_DIR="${OUT_DIR}/interop"
PROOF_DIR="${OUT_DIR}/proof"

mkdir -p "${OUT_DIR}"
rm -rf "${INTEROP_DIR}" "${PROOF_DIR}"

echo "[1/5] Compiling Noir circuit: ${CIRCUIT_DIR}"
(cd "${CIRCUIT_DIR}" && nargo compile)

echo "[2/5] Emitting R1CS + witness"
"${NOIR_CLI}" interop "${ARTIFACT_PATH}" "${CIRCUIT_DIR}/inputs.json" --out "${INTEROP_DIR}"
npx snarkjs wtns check "${INTEROP_DIR}/circuit.r1cs" "${INTEROP_DIR}/witness.wtns"

echo "[3/5] Powers of tau"
if [[ ! -f "${PTAU_FINAL}" ]]; then
  npx snarkjs powersoftau new bn128 "${PTAU_POWER}" "${PTAU_INITIAL}" -v
  npx snarkjs powersoftau prepare phase2 "${PTAU_INITIAL}" "${PTAU_FINAL}" -v
fi

mkdir -p "${PROOF_DIR}"
cp "${INTEROP_DIR}/circuit.r1cs" "${INTEROP_DIR}/witness.wtns" "${PROOF_DIR}/"

echo "[4/5] Groth16 setup + prove"
npx snarkjs groth16 setup "${PROOF_DIR}/circuit.r1cs" "${PTAU_FINAL}" "${PROOF_DIR}/circuit_0000.zkey"
npx snarkjs zkey contribute "${PROOF_DIR}/circuit_0000.zkey" "${PROOF_DIR}/circuit_final.zkey" --name="shadowwire" -e="shadowwire-local-entropy" -v
npx snarkjs zkey export verificationkey "${PROOF_DIR}/circuit_final.zkey" "${PROOF_DIR}/verification_key.json"
npx snarkjs groth16 prove "${PROOF_DIR}/circuit_final.zkey" "${PROOF_DIR}/witness.wtns" "${PROOF_DIR}/proof.json" "${PROOF_DIR}/public.json"

echo "[5/5] Local verify"
npx snarkjs groth16 verify "${PROOF_DIR}/verification_key.json" "${PROOF_DIR}/public.json" "${PROOF_DIR}/proof.json"
echo "Artifacts: ${OUT_DIR}"
