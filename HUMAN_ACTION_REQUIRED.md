# Human action required — ShadowWire submission checklist

These steps **cannot** be automated and must be completed by you before the June 29 noon UTC DoraHacks deadline.

## 1. Install Freighter

- https://www.freighter.app/
- Create/import a testnet account
- Switch network to **Testnet**

## 2. SEP-24 deposit (Alice)

1. `npm run issuer` (terminal 1) — mock KYC / proof API on `:3001`
2. `npm run frontend` (terminal 2) — open http://localhost:3000/alice
3. Connect Freighter
4. Click **Fund XLM** if needed
5. Click **Open SEP-24 deposit** — complete the `testanchor.stellar.org` popup

## 3. Shielded corridor (Alice → Bob)

1. On Alice page: **Shield into pool** then **Send privately** (Bob's pubkey from `testnet-addresses.json`)
2. On Bob page: claim note secret Alice shares off-chain, **Withdraw to wallet**
3. Compare explorer links — transfer tx shows nullifier + commitment only (no amount)

## 4. SEP-24 withdrawal (Bob)

On Bob page: **Open SEP-24 withdraw** and complete anchor popup.

## 5. Record demo video (2–3 min)

Show architecture, SEP-24 flows, pool deposit + private transfer on stellar.expert, privacy comparison, pool root changing.

## 6. Submit to DoraHacks

- **Deadline:** June 29, 2026 **noon UTC**
- Repo: https://github.com/Shivannsh/ShadowWire
- Include README + video + tx hashes from `testnet-addresses.json`

## On-chain evidence (CLI demo — use in video B-roll)

| Step | Tx hash |
|------|---------|
| Compliance Groth16 verify | `59f013d64676fab0fc1bd52dd56f9fec9bc1e351922dc0694d709b921eb7e4f7` |
| Pool deposit | `52808dfa238ec5ec3de7fb051475a6b5f578573fda40302e8ad42597838d64dc` |
| Shielded transfer | `a32e0bf05aa2f51c7eb4a55e57d819d40b57f5c8ddc88e0aeb486c6751b66a66` |
