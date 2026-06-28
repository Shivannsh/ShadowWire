/**
 * Corridor policy — the cross-border lane a transfer travels.
 *
 * A corridor binds a sending jurisdiction to a receiving jurisdiction and the
 * compliance limits that apply (min KYC tier, max amount). corridor_id is a
 * public input to the compliance circuit, so the proof is cryptographically bound
 * to one corridor and cannot be replayed in another.
 */

export interface Corridor {
  id:              number;
  sendingCountry:  string;  // ISO-3166 numeric (matches the send-side KYC leaf)
  receivingCountry: string; // ISO-3166 numeric (matches the receive-side KYC leaf)
  sendingLabel:    string;
  receivingLabel:  string;
  minKycTier:      string;
  maxAmount:       string;
}

// The demo corridor: US -> Nigeria. corridor_id 1 matches the pool's CID storage.
export const CORRIDORS: Corridor[] = [
  {
    id: 1,
    sendingCountry: "840", receivingCountry: "566",
    sendingLabel: "United States", receivingLabel: "Nigeria",
    minKycTier: "1", maxAmount: "1000000",
  },
];

export function getCorridor(id: number): Corridor {
  const c = CORRIDORS.find(c => c.id === id);
  if (!c) throw new Error(`Unknown corridor_id ${id}`);
  return c;
}
