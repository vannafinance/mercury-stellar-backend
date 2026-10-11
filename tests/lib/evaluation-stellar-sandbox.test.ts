import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { makeTestnetSigner, verifyTestnet } from "../../scripts/evaluation/stellar-sandbox.mjs";

describe("evaluation sandbox signing boundary", () => {
  it.each([
    { ok: true, body: { result: { passphrase: Networks.PUBLIC } } },
    { ok: true, body: { error: { code: -1 } } },
    { ok: false, body: { result: { passphrase: Networks.TESTNET } } },
    { ok: true, body: { result: {} } },
  ])("refuses unverified RPC network %#", async ({ ok, body }) => {
    await expect(verifyTestnet("https://rpc.invalid", 1000, async () => new Response(JSON.stringify(body), { status: ok ? 200 : 503 }))).rejects.toThrow("RPC testnet verification failed");
  });

  it("accepts only the SDK testnet passphrase and requests getNetwork", async () => {
    let sent: any;
    await verifyTestnet("https://rpc.invalid", 1000, async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ result: { passphrase: Networks.TESTNET } }));
    });
    expect(sent.method).toBe("getNetwork");
  });

  it("rejects a different wallet before creating a signer", () => {
    expect(() => makeTestnetSigner(Keypair.random().secret(), Keypair.random().publicKey())).toThrow("Signer wallet mismatch");
  });

  it("signs the wallet source for testnet without broadcasting, rejects a foreign source", async () => {
    const owner = Keypair.random(), other = Keypair.random();
    const envelope = (source: string) => new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.manageData({ name: "evaluation-fixture", value: "local" })).setTimeout(60).build().toXDR();
    const sign = makeTestnetSigner(owner.secret(), owner.publicKey());
    await expect(sign(envelope(other.publicKey()))).rejects.toThrow("Envelope source mismatch");
    const signed = TransactionBuilder.fromXDR(await sign(envelope(owner.publicKey())), Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
    expect(owner.verify(signed.hash(), signed.signatures[0].signature())).toBe(true);
  });
});
