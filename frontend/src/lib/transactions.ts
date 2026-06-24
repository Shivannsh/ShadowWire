import * as StellarSdk from "@stellar/stellar-sdk";
import { config, rpc } from "@/lib/stellar";

export async function submitTransaction(signedXdr: string) {
  const transaction = StellarSdk.TransactionBuilder.fromXDR(
    signedXdr,
    config.networkPassphrase
  ) as StellarSdk.Transaction;

  const isSoroban = transaction.operations.some(
    (op) => op.type === "invokeHostFunction"
  );

  if (isSoroban) {
    return submitSorobanTransaction(transaction);
  }
  return submitClassicTransaction(transaction);
}

async function submitSorobanTransaction(transaction: StellarSdk.Transaction) {
  const response = await rpc.sendTransaction(transaction);

  if (response.status === "ERROR") {
    throw new Error(`Transaction failed: ${JSON.stringify(response.errorResult)}`);
  }

  let getResponse = await rpc.getTransaction(response.hash);
  let attempts = 0;
  while (getResponse.status === "NOT_FOUND" && attempts < 60) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    getResponse = await rpc.getTransaction(response.hash);
    attempts++;
  }

  if (getResponse.status === "SUCCESS") {
    return { hash: response.hash, result: getResponse.returnValue };
  }

  throw new Error(`Transaction failed: ${getResponse.status}`);
}

async function submitClassicTransaction(transaction: StellarSdk.Transaction) {
  const { horizon } = await import("@/lib/stellar");
  const response = await horizon.submitTransaction(transaction);
  return { hash: response.hash, ledger: response.ledger };
}

export async function invokeContract(
  sourceAddress: string,
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[]
): Promise<string> {
  const account = await rpc.getAccount(sourceAddress);
  const contract = new StellarSdk.Contract(contractId);

  let transaction = new StellarSdk.TransactionBuilder(account, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const simulation = await rpc.simulateTransaction(transaction);

  if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  transaction = StellarSdk.rpc.assembleTransaction(transaction, simulation).build();
  return transaction.toXDR();
}

export async function readContract<T>(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[] = []
): Promise<T> {
  const contract = new StellarSdk.Contract(contractId);
  const tx = new StellarSdk.TransactionBuilder(
    new StellarSdk.Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
    { fee: "100", networkPassphrase: config.networkPassphrase }
  )
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  const simulation = await rpc.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(simulation)) {
    throw new Error(`Simulation failed: ${simulation.error}`);
  }

  const result = simulation.result?.retval;
  if (!result) throw new Error("No return value from contract simulation");
  return StellarSdk.scValToNative(result) as T;
}
