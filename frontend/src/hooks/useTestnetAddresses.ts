"use client";

import { useEffect, useState } from "react";
import { loadTestnetAddresses, type TestnetAddresses } from "@/lib/addresses";

export function useTestnetAddresses() {
  const [addresses, setAddresses] = useState<TestnetAddresses | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadTestnetAddresses()
      .then(setAddresses)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  return { addresses, error, loading };
}
