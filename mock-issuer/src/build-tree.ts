import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_ALICE, hashLeaf, merkleRoot } from "./merkle.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");

async function main() {
  const aliceLeaf = await hashLeaf(DEMO_ALICE);
  const { root: merkleRootValue, paths } = await merkleRoot([aliceLeaf]);
  const merklePath = paths.get(0)!.map((p) => p.toString());

  const inputs = {
    secret_salt: DEMO_ALICE.secretSalt.toString(),
    kyc_tier: DEMO_ALICE.kycTier.toString(),
    sanctioned_flag: DEMO_ALICE.sanctionedFlag.toString(),
    country_code: DEMO_ALICE.countryCode.toString(),
    merkle_path: merklePath,
    merkle_index: "0",
    merkle_root: merkleRootValue.toString(),
    min_kyc_tier: "1",
    max_amount: "1000000",
    amount: "500",
  };

  fs.writeFileSync(
    path.join(root, "circuits/compliance/inputs.json"),
    JSON.stringify(inputs, null, 2)
  );
  console.log("Wrote compliance inputs with merkle_root:", merkleRootValue.toString());
}

main();
