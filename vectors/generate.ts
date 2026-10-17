// Test vectors for the Solidity WOTS and LtHash, produced by the Ostra TypeScript SDK, which
// is the reference implementation (byte-compatible with the Solana program). The keys come
// from a fixed public master secret and exist only to produce these vectors.
//
// Usage: node vectors/generate.ts   (OSTRA_SDK_SRC defaults to /srv/apps/ostra/sdk/src)

import { writeFileSync } from "node:fs";
import { join } from "node:path";

const sdkSrc = process.env.OSTRA_SDK_SRC ?? "/srv/apps/ostra/sdk/src";
const wots = await import(join(sdkSrc, "wots.ts"));
const lthash = await import(join(sdkSrc, "lthash.ts"));
const hash = await import(join(sdkSrc, "hash.ts"));

const hex = (bytes: Uint8Array): string => "0x" + hash.toHex(bytes);
const label = (text: string): Uint8Array => hash.keccak256([hash.utf8(text)]);

// WOTS: 64 signatures from one keychain, one key per index, over messages of 32 to 140 bytes.
const records = new Map<string, unknown>();
const store = {
  async load(_keychain: Uint8Array, index: bigint) {
    return records.get(index.toString());
  },
  async saveIfAbsent(record: { index: string }) {
    if (records.has(record.index)) return false;
    records.set(record.index, record);
    return true;
  },
};
const keychain = new wots.WotsKeychain(
  label("OSTRA/EVM/TEST-VECTORS/master"),
  label("OSTRA/EVM/TEST-VECTORS/keychain"),
  store,
);

const LENGTHS = [32, 64, 96, 140];
const signatures: string[] = [];
const messages: string[] = [];
const keyRoots: string[] = [];
const steps: number[] = [];
for (let i = 0; i < 64; i++) {
  const len = LENGTHS[i % LENGTHS.length] as number;
  const message = new Uint8Array(len);
  for (let off = 0; off < len; off += 32) {
    const block = hash.keccak256([hash.utf8(`OSTRA/EVM/TEST-VECTORS/message/${i}`), Uint8Array.of(off)]);
    message.set(block.subarray(0, Math.min(32, len - off)), off);
  }
  const index = BigInt(i);
  const signature: Uint8Array = await keychain.sign(index, message);
  const keyRoot: Uint8Array = keychain.keyRoot(index);
  if (!wots.wotsVerify(signature, message, keyRoot)) throw new Error(`vector ${i} does not verify`);
  signatures.push(hex(signature));
  messages.push(hex(message));
  keyRoots.push(hex(keyRoot));
  steps.push(wots.wotsVerifierSteps(signature.subarray(0, wots.WOTS_SALT_LEN), message));
}

// LtHash: 90 leaves of 10 tokens with 6 decimals (one standard leaf of USDG).
const LEAF_AMOUNT = 10_000_000n;
const LEAF_COUNT = 90;
const leafRoots: Uint8Array[] = [];
for (let i = 0; i < LEAF_COUNT; i++) leafRoots.push(label(`OSTRA/EVM/TEST-VECTORS/leaf/${i}`));
const leaves = leafRoots.map((root) => lthash.encodeLeaf(root, LEAF_AMOUNT));
const acc: Uint8Array = lthash.lthashOfLeaves(leaves);
const accFirst: Uint8Array = lthash.lthashOfLeaves([leaves[0]]);
const total = LEAF_AMOUNT * BigInt(LEAF_COUNT);

const vectors = {
  wots: { signatures, messages, keyRoots, steps },
  lthash: {
    keyRoots: leafRoots.map(hex),
    amounts: leafRoots.map(() => Number(LEAF_AMOUNT)),
    acc: hex(acc),
    accFirst: hex(accFirst),
    leafCount: LEAF_COUNT,
    totalAmount: Number(total),
    stateHash: hex(lthash.batchStateHash(acc, LEAF_COUNT, total)),
  },
};

const out = join(import.meta.dirname, "vectors.json");
writeFileSync(out, JSON.stringify(vectors, null, 1) + "\n");
const sorted = [...steps].sort((a, b) => a - b);
console.log(`wrote ${out}: 64 WOTS vectors (steps ${sorted[0]}..${sorted[sorted.length - 1]}), ${LEAF_COUNT} LtHash leaves`);
