// The agent's private balance in Ostra Swap's private pool (ostra-swap src/OstraPrivatePool.sol, decided 22 Oct 2026:
// agents use it through MCP, no wallet of their own). Its tokens are notes: commitments to (token, amount, tag) in
// the pool's trees, where tag = P(rho || sk). Spending a note takes a proof made here by the agent's prover
// (ostra-prove): the pool sees which token and how much leaves, never which note or whose.
//
//   * shield: the agent's vault of the token transfers it to the pool's shield escrow for a fresh tag
//     (shieldEscrowAddress), and the relayer has the pool take it in the same transaction (shieldFromEscrow): a
//     vault can transfer but not approve. Paid like the agent's other requests (x402 from the buyer vault).
//   * swap: one note's v is swapped through OstraRouter into a new note of the output token; the relayer is paid a
//     fee in the note's token out of the note itself (GET /v1/private/price), so no vault and no channel shows. The
//     rest of the note becomes a change note.
//   * unshield: one note's v goes to an address (default: the agent's vault of that token), with the same fee.
//
// Every secret comes from the master seed (keys.ts): the agent's sk, shield n's nonce (n counted up and kept before
// each use) and a spend's change and output nonces (from the note spent, used once since a note is spent once), so the
// seed and the chain say whose every note is. recover() rebuilds the notes from them alone: the shields of shield
// nonces 1, 2, ... in the pool's Shielded events (until SHIELD_SCAN_GAP nonces in a row have none), then each note's
// spend, if its nullifier was spent (Unshielded or PrivateSwapped), to its change note and a swap's output note, until
// every note found is unspent. It runs by itself on first use in an OSTRA_HOME without the shield count (a new agent,
// or a seed restored elsewhere), so the shield count starts past every nonce used and no nonce is used twice. It reads
// all of the pool's events, never ones filtered by the agent's tags or nullifiers, up to the block the trees are
// checked at, once the logs RPC has reached the agent's own RPC, and refuses events that do not add up to the notes the
// trees hold; only tokens notes hold count, and notes kept here that the events do not show spent stay. Not found: a
// shield whose vault Transfer reached its escrow but that the pool never took (no Shielded event), until refresh() on
// the machine that signed it, or anyone, calls shieldFromEscrow for it. The notes, the
// pool's trees (from its NoteAdded events) and each operation in flight are kept in the PRIVATE_SWAP_DIR folder;
// refresh() finishes an operation whose answer was lost: a shield escrow paid without its note taken, a spend that
// landed. A shield's record is kept until its vault's nonce has passed the signed Transfer (it may land later: the
// vault sends a signed spend again before its next one), and a note with a spend in flight is not spent again.
//
// Spends go through the Ostra relayer, paid from the note: sent by the agent's own fee payer they would all show
// the account that also sent its vault's transactions, so without a relayer they are refused unless
// localSpends says otherwise (tests and forks). The relayer's fee is checked before a proof pays it: at most
// PRIVATE_FEE_MAX_FACTOR times the gas the relayer prices a spend at (PRIVATE_FEE_GAS) at the gas price now.
//
// What stays public: the token, the amounts in and out, the pair, the time, the relayer and its fee, and for a
// shield the vault it came from. A spend is relayed alone; a note's v and fee cannot exceed it (one note per spend).

import { getAddress, parseAbiItem, type Address, type Hash, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { LAUNCH_PAIRS, WETH, chainlinkEthUsd, signVaultTransfer } from "@ostraagent/sdk";
import {
  FIELD_P,
  LOG_WINDOW_BLOCKS,
  NoRouteError,
  PRIVATE_SWAP_FEE_BPS,
  PoolIndex,
  PoolTrees,
  changeNote,
  findRoute,
  noteKeys,
  ostraPrivatePoolAbi,
  packDigest,
  privateSwapCall,
  provePrivateSwap,
  proveUnshield,
  shieldEscrowAddress,
  shieldFromEscrowCall,
  shieldedNote,
  swapOutputNote,
  tagOf,
  unshieldCall,
  type Digest,
  type PoolIndexData,
  type PoolTreesData,
  type PrivateNote,
  type PrivateSwapTerms,
  type Prover,
  type Spend,
  type SwapDeployment,
} from "@ostraagent/swap";
import { formatUnitsAmount, parseUnitsAmount } from "./amount.ts";
import { chainTime, tokenBalance, tokenDecimals } from "./chain.ts";
import type { Config } from "./config.ts";
import type { Keys } from "./keys.ts";
import { RelayerError, RelayerUnavailableError, VAULT_SPEND_GAS, type Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import { spendCall, type VaultOperationResult, type VaultService } from "./vault.ts";

export const PRIVATE_SWAP_DIR = "ostra-swap-private";
/** Gas a shield from a vault is reserved for: the vault's Transfer and shieldFromEscrow (measured on a fork 22 Oct 2026: 3.15M with the escrow's creation and the tree's insertion). */
export const PRIVATE_SHIELD_GAS = VAULT_SPEND_GAS + 3_600_000n;
/** How long a spend's proof stays valid (its deadline): the relayer wants at least 5 minutes left when it sends. */
export const PRIVATE_SPEND_DEADLINE_SECONDS = 3_600n;
const MAX_SLIPPAGE_BPS = 1_000;
/**
 * The gas the relayer prices a private spend at (relayer src/private.ts PRIVATE_GAS: measured 13.9M for an unshield
 * and 15.5M for a swap with their proofs' calldata).
 */
export const PRIVATE_FEE_GAS = { unshield: 16_000_000n, swap: 19_000_000n } as const;
/**
 * The most a relayer's fee may be worth, as a multiple of PRIVATE_FEE_GAS at the gas price now: the relayer adds its
 * margin (10%), headroom for the gas price (25%) and, for a token it sells later, a haircut (3%), about 1.42 times.
 */
export const PRIVATE_FEE_MAX_FACTOR = 3n;
/** Shield nonces searched past the last one found in the pool's events before a missing count is taken as found. */
const SHIELD_SCAN_GAP = 20n;
/** Seconds recover() waits for the logs RPC to reach the block the agent's own RPC is at. */
const LOGS_CATCH_UP_TRIES = 30;
/**
 * How long a shield record waits for its Shielded log once its vault's nonce is past the Transfer and the escrow is
 * empty (the logs RPC may be behind), before it is taken as never signed or never sendable and dropped.
 */
const SHIELD_LOG_WAIT_MS = 60 * 60 * 1000;

const NOTES = "notes.json";
const TREES = "trees.json";
const NEXT_RHO = "next-rho";
const POOL_INDEX = "pool-index.json";
const PENDING_PREFIX = "pending-";

type NoteRecord = { asset: Address; amount: string; rho: Digest; commitment: Digest; tree: number; index: number };

/** A shield signed: its vault's Transfer under `vaultNonce` pays `escrow`, which the pool takes for `tag`. */
type PendingShield = {
  kind: "shield";
  id: string;
  token: Address;
  rho: Digest;
  tag: Digest;
  escrow: Address;
  vaultNonce: string;
  block: string;
  at: number;
  /** When the vault's nonce was first seen past vaultNonce with the escrow empty and no log of it (ms). */
  emptySince?: number;
};
type PendingSpend = {
  kind: "spend";
  id: string;
  /** The note spent. */
  note: Digest;
  nullifier: Digest;
  asset: Address;
  change: { rho: Digest; amount: string; commitment: Digest };
  /** A private swap's output note: its nonce, token and tag. */
  out: { rho: Digest; tokenOut: Address; tag: Digest } | null;
  deadline: string;
  block: string;
  at: number;
};
type Pending = PendingShield | PendingSpend;

type ShieldedLog = { token: Address; amount: bigint; commitment: Digest };
type PoolLog =
  | { eventName: "Shielded"; args: { from: Address; token: Address; amount: bigint; tag: Hex; commitment: Hex } }
  | { eventName: "Unshielded"; args: { nullifier: Hex; recipient: Address; token: Address; amount: bigint; fee: bigint; relayer: Address } }
  | {
      eventName: "PrivateSwapped";
      args: { nullifier: Hex; tokenIn: Address; tokenOut: Address; amountIn: bigint; amountOut: bigint; fee: bigint; relayer: Address; outTag: Hex; outCommitment: Hex };
    };
type SpendLog = { kind: "unshield"; v: bigint; fee: bigint } | { kind: "swap"; v: bigint; fee: bigint; tokenOut: Address; amountOut: bigint; outCommitment: Digest };

export type PrivateBalance = { token: Address; amount: string; notes: number; largestNote: string }[];

/** What recover() found: the shields of the seed, the notes it followed, and the notes unspent now. */
export type PrivateRecovery = { pool: Address; shields: number; followed: number; tokens: PrivateBalance; notes: number };

export type PrivateSpendResult = {
  status: "sent";
  txHash: Hash;
  /** What left the note (swapped, or sent to `recipient`), and the relayer's fee out of the note, in its token. */
  amountIn: string;
  fee: string;
  /** A swap's output, now a note of the agent's. */
  amountOut?: string;
  tokenOut?: Address;
  recipient?: Address;
  change: string;
};

export type PrivateBalanceParts = {
  client: PublicClient;
  /** Serves eth_getLogs over the pool's whole life (Robinhood Chain's public RPC). */
  logsClient: PublicClient;
  config: Config;
  swap: SwapDeployment;
  keys: Keys;
  /** ostra-prove (null: the prover is not installed, and nothing private can be done). */
  prover: Prover | null;
  /** The agent's vault for a token (the buyer vault for USDG). */
  vaultFor: (token: Address) => VaultService;
  /** Sends what finishes an operation without a vault spend (shieldFromEscrow alone; a spend without a relayer). */
  sender: Sender;
  folder: Folder;
  /** Without a relayer, spends are sent by `sender`, which links them to the agent: for tests and forks only. */
  localSpends?: boolean;
};

const shieldedEvent = parseAbiItem("event Shielded(address indexed from, address indexed token, uint256 amount, bytes32 tag, bytes32 commitment)");
const swappedEvent = parseAbiItem(
  "event PrivateSwapped(bytes32 indexed nullifier, address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 fee, address relayer, bytes32 outTag, bytes32 outCommitment)",
);
const unshieldedEvent = parseAbiItem("event Unshielded(bytes32 indexed nullifier, address indexed recipient, address indexed token, uint256 amount, uint256 fee, address relayer)");

const address = (text: string, what: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new RangeError(`${what} is not an address`);
  return getAddress(text);
};

/** The tokens a private note may hold: the relayer relays spends of USDG, WETH, OSTRA and the listed stock tokens only. */
export function privateTokens(config: Config): Address[] {
  return [config.deployment.token, WETH, ...LAUNCH_PAIRS.filter((p) => p.kind === "ostra" || p.kind === "stock").map((p) => getAddress(p.address))];
}

export class PrivateBalanceService {
  readonly #p: PrivateBalanceParts;
  readonly #pool: Address;
  #trees: PoolTrees | null = null;
  #index: PoolIndex | null = null;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(p: PrivateBalanceParts) {
    this.#p = p;
    this.#pool = getAddress(p.swap.privatePool);
  }

  get pool(): Address {
    return this.#pool;
  }

  /** Runs `fn` after every earlier operation: two operations never pick the same note or the same nonce. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(fn, fn);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #prover(): Prover {
    if (this.#p.prover === null) throw new Error("the prover (ostra-prove) is not installed: private notes need it to prove a spend; nothing was signed");
    return this.#p.prover;
  }

  /** 8 field elements drawn from a secret of the seed (`secret` of its block): each 31 bits below P, drawn again from the next block when not. */
  #digest(secret: (block: bigint) => Uint8Array): Digest {
    const out: bigint[] = [];
    for (let block = 0n; out.length < 8; block++) {
      const bytes = secret(block);
      for (let i = 0; i < 32 && out.length < 8; i += 4) {
        const w = BigInt((((bytes[i] as number) << 24) | ((bytes[i + 1] as number) << 16) | ((bytes[i + 2] as number) << 8) | (bytes[i + 3] as number)) >>> 0) & 0x7fffffffn;
        if (w < FIELD_P) out.push(w);
      }
    }
    return packDigest(out);
  }

  #sk(): Digest {
    return this.#digest((block) => this.#p.keys.noteSecret(this.#p.config.chainId, this.#pool, "sk", 0n, block));
  }

  #shieldRho(n: bigint): Digest {
    return this.#digest((block) => this.#p.keys.noteSecret(this.#p.config.chainId, this.#pool, "rho", n, block));
  }

  /** The nonce of the change ("change") or output ("out") note of the spend of the note `spent`. */
  #spendRho(purpose: "change" | "out", spent: Digest): Digest {
    return this.#digest((block) => this.#p.keys.spendNoteSecret(this.#p.config.chainId, this.#pool, purpose, spent, block));
  }

  /** recover() when there is no shield count yet (a new agent, or a seed restored elsewhere) and there is a prover. */
  async #ensureRecovered(): Promise<void> {
    await this.#p.folder.ensure();
    if (this.#p.prover !== null && (await this.#p.folder.read(NEXT_RHO)) === undefined) await this.#recover();
  }

  /** The next shield nonce: its number is kept before it is used, so no nonce is used twice. */
  async #nextShieldRho(): Promise<Digest> {
    const text = await this.#p.folder.read(NEXT_RHO);
    if (text === undefined) throw new Error("the shield count is missing");
    const n = BigInt(text.trim());
    await this.#p.folder.write(NEXT_RHO, `${n + 1n}\n`);
    return this.#shieldRho(n);
  }

  /**
   * All of the pool's Shielded events, by tag, and its spends (Unshielded and PrivateSwapped), by nullifier, up to
   * block `head`: read whole, so the RPC learns nothing of which are the agent's. Also how many notes they add (a
   * shield one, an unshield its change, a private swap its change and its output), to check against the trees.
   */
  async #poolEvents(head: bigint): Promise<{ shielded: Map<string, ShieldedLog[]>; spends: Map<string, SpendLog>; notes: number }> {
    const shielded = new Map<string, ShieldedLog[]>();
    const spends = new Map<string, SpendLog>();
    let notes = 0;
    for (let from = BigInt(this.#p.swap.fromBlock); from <= head; from += LOG_WINDOW_BLOCKS) {
      const to = from + LOG_WINDOW_BLOCKS - 1n < head ? from + LOG_WINDOW_BLOCKS - 1n : head;
      for (const l of await this.#poolLogs(from, to)) {
        if (l.eventName === "Shielded") {
          const tag = l.args.tag.toLowerCase();
          shielded.set(tag, [...(shielded.get(tag) ?? []), { token: getAddress(l.args.token), amount: l.args.amount, commitment: l.args.commitment }]);
          notes += 1;
        } else if (l.eventName === "Unshielded") {
          spends.set(l.args.nullifier.toLowerCase(), { kind: "unshield", v: l.args.amount, fee: l.args.fee });
          notes += 1;
        } else {
          spends.set(l.args.nullifier.toLowerCase(), { kind: "swap", v: l.args.amountIn, fee: l.args.fee, tokenOut: getAddress(l.args.tokenOut), amountOut: l.args.amountOut, outCommitment: l.args.outCommitment });
          notes += 2;
        }
      }
    }
    return { shielded, spends, notes };
  }

  /** The pool's Shielded, Unshielded and PrivateSwapped logs in [from, to]; a range the RPC refuses as too many logs is split in halves. */
  async #poolLogs(from: bigint, to: bigint): Promise<PoolLog[]> {
    try {
      return (await this.#p.logsClient.getLogs({ address: this.#pool, events: [shieldedEvent, unshieldedEvent, swappedEvent], fromBlock: from, toBlock: to, strict: true })) as PoolLog[];
    } catch (err) {
      if (from >= to || !/exceeds limit|too many|query returned more than/i.test(String((err as Error).message ?? err))) throw err;
      const mid = from + (to - from) / 2n;
      return [...(await this.#poolLogs(from, mid)), ...(await this.#poolLogs(mid + 1n, to))];
    }
  }

  /** Rebuilds the agent's notes from the seed and the pool's events (see the file comment); the notes kept here become the unspent ones found. */
  recover(): Promise<PrivateRecovery> {
    return this.#serial(async () => {
      await this.#refresh();
      return this.#recover();
    });
  }

  async #recover(): Promise<PrivateRecovery> {
    const prover = this.#prover();
    const sk = this.#sk();
    // The block this agent's own RPC is at: the logs RPC must have it, or a spend that landed would look unspent.
    const own = await this.#p.client.getBlockNumber({ cacheTime: 0 });
    // The trees, checked against the pool at their head (PoolTrees.sync), then the events up to that same block: as
    // many notes as the trees hold, or the logs are incomplete.
    // A sync that fails (the logs RPC answered a block number ahead of its logs) is tried again too.
    let trees: PoolTrees | null = null;
    let failure: unknown = null;
    for (let i = 0; i <= LOGS_CATCH_UP_TRIES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1_000));
      try {
        trees = await this.#syncedTrees();
        failure = null;
      } catch (err) {
        failure = err;
        continue;
      }
      if (BigInt(trees.data().searchedTo) >= own) break;
    }
    if (trees === null || failure !== null) throw failure ?? new Error("the pool's trees could not be read");
    const head = BigInt(trees.data().searchedTo);
    if (head < own) throw new Error(`the logs RPC (OSTRA_LOGS_RPC_URL) is at block ${head}, behind block ${own}: recover again in a minute`);
    const events = await this.#poolEvents(head);
    const held = trees.data().trees.reduce((n, t) => n + t.leaves.length, 0);
    if (events.notes !== held) throw new Error(`the pool's events up to block ${head} add ${events.notes} notes, its trees hold ${held}: the logs RPC answered incompletely, recover again`);
    const tokens = new Set(privateTokens(this.#p.config));
    const placed = (commitment: Digest) => {
      const at = trees.find(commitment);
      if (at === null) throw new Error(`the note ${commitment} is in the pool's events but not in its trees`);
      return at;
    };
    // The shields of nonces 1, 2, ... (past the count kept here, if there is one): each Shielded event with the
    // nonce's tag whose commitment is that note's, in a token notes hold (anyone can shield another token to a tag).
    const kept = await this.#p.folder.read(NEXT_RHO);
    const counted = kept === undefined ? 0n : BigInt(kept.trim()) - 1n;
    const queue: PrivateNote[] = [];
    let last = 0n;
    for (let i = 1n; i <= (last + SHIELD_SCAN_GAP > counted ? last + SHIELD_SCAN_GAP : counted); i++) {
      const rho = this.#shieldRho(i);
      const found = events.shielded.get((await tagOf(prover, sk, rho)).toLowerCase());
      if (found === undefined) continue;
      last = i;
      for (const e of found) {
        if (!tokens.has(e.token)) continue;
        const keys = await noteKeys(prover, sk, rho, e.token, e.amount);
        if (keys.commitment.toLowerCase() !== e.commitment.toLowerCase()) continue;
        queue.push({ asset: e.token, amount: e.amount, rho, commitment: e.commitment, ...placed(e.commitment) });
      }
    }
    const shields = queue.length;
    // Each note to its spend, and the spend to the notes it made.
    const unspent: PrivateNote[] = [];
    const seen = new Set<string>();
    let followed = 0;
    for (let note = queue.pop(); note !== undefined; note = queue.pop()) {
      if (seen.has(note.commitment.toLowerCase())) continue;
      seen.add(note.commitment.toLowerCase());
      followed += 1;
      const { nullifier } = await noteKeys(prover, sk, note.rho, note.asset, note.amount);
      const spend = events.spends.get(nullifier.toLowerCase());
      if (spend === undefined) {
        unspent.push(note);
        continue;
      }
      // The change note is added in the spend's own transaction: the trees hold it (placed throws otherwise).
      const change = note.amount - spend.v - spend.fee;
      if (change > 0n) {
        const rho = this.#spendRho("change", note.commitment);
        const keys = await noteKeys(prover, sk, rho, note.asset, change);
        queue.push({ asset: note.asset, amount: change, rho, commitment: keys.commitment, ...placed(keys.commitment) });
      }
      if (spend.kind === "swap" && tokens.has(spend.tokenOut)) {
        const rho = this.#spendRho("out", note.commitment);
        const keys = await noteKeys(prover, sk, rho, spend.tokenOut, spend.amountOut);
        if (keys.commitment.toLowerCase() === spend.outCommitment.toLowerCase()) queue.push({ asset: spend.tokenOut, amount: spend.amountOut, rho, commitment: keys.commitment, ...placed(keys.commitment) });
      }
    }
    // A note kept here that the scan did not reach stays when it is a real note of this seed's (its commitment from its
    // own rho, token and amount, in the trees, in a token notes hold) that the events do not show spent; a wrong record
    // goes.
    const found = new Set(unspent.map((n) => n.commitment.toLowerCase()));
    const local: NoteRecord[] = [];
    for (const n of await this.#notes()) {
      if (found.has(n.commitment.toLowerCase()) || !tokens.has(getAddress(n.asset)) || trees.find(n.commitment) === null) continue;
      const keys = await noteKeys(prover, sk, n.rho, n.asset, BigInt(n.amount));
      if (keys.commitment.toLowerCase() === n.commitment.toLowerCase() && !events.spends.has(keys.nullifier.toLowerCase())) local.push(n);
    }
    const records = [...unspent.map((n) => ({ asset: n.asset, amount: n.amount.toString(), rho: n.rho, commitment: n.commitment, tree: n.tree, index: n.index })), ...local];
    await this.#saveNotes(records);
    // The shield count past every nonce found (never lowered: a nonce counted but not shielded is not used again).
    const next = counted + 1n > last + 1n ? counted + 1n : last + 1n;
    await this.#p.folder.write(NEXT_RHO, `${next}\n`);
    return { pool: this.#pool, shields, followed, notes: records.length, tokens: await this.#summary(records) };
  }

  /** Per token: what `notes` hold, how many, and the largest. */
  async #summary(notes: { asset: Address; amount: string }[]): Promise<PrivateBalance> {
    const by = new Map<Address, bigint[]>();
    for (const n of notes) by.set(n.asset, [...(by.get(n.asset) ?? []), BigInt(n.amount)]);
    const tokens: PrivateBalance = [];
    for (const [token, list] of by) {
      const decimals = await tokenDecimals(this.#p.client, token);
      const total = list.reduce((s, x) => s + x, 0n);
      const largest = list.reduce((m, x) => (x > m ? x : m), 0n);
      tokens.push({ token, amount: formatUnitsAmount(total, decimals), notes: list.length, largestNote: formatUnitsAmount(largest, decimals) });
    }
    return tokens;
  }

  /** The notes a spend in flight spends: not spent again until refresh() finishes or drops that spend. */
  async #notesInFlight(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const name of await this.#p.folder.list()) {
      if (!name.startsWith(PENDING_PREFIX)) continue;
      const text = await this.#p.folder.read(name);
      if (text === undefined) continue;
      const p = JSON.parse(text) as Pending;
      if (p.kind === "spend") out.add(p.note.toLowerCase());
    }
    return out;
  }

  /** Refuses a spend without a relayer unless localSpends allows it (see the file comment). */
  #requireRelayer(): void {
    if (this.#p.config.relayerUrl === null && this.#p.localSpends !== true) {
      throw new Error("a private spend goes through the Ostra relayer: sent by this agent's own fee payer it would show the account that sends its vault's transactions; nothing was signed");
    }
  }

  async #notes(): Promise<NoteRecord[]> {
    const text = await this.#p.folder.read(NOTES);
    return text === undefined ? [] : (JSON.parse(text) as { version: 1; notes: NoteRecord[] }).notes;
  }

  async #saveNotes(notes: NoteRecord[]): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(NOTES, `${JSON.stringify({ version: 1, notes })}\n`);
  }

  async #addNotes(add: PrivateNote[], remove: Digest[] = []): Promise<void> {
    const drop = new Set(remove.map((c) => c.toLowerCase()));
    const notes = (await this.#notes()).filter((n) => !drop.has(n.commitment.toLowerCase()));
    for (const n of add) {
      if (notes.some((m) => m.commitment.toLowerCase() === n.commitment.toLowerCase())) continue;
      notes.push({ asset: n.asset, amount: n.amount.toString(), rho: n.rho, commitment: n.commitment, tree: n.tree, index: n.index });
    }
    await this.#saveNotes(notes);
  }

  /** The pool's trees, synced to the latest block. */
  async #syncedTrees(): Promise<PoolTrees> {
    if (this.#trees === null) {
      const text = await this.#p.folder.read(TREES);
      this.#trees = new PoolTrees(this.#pool, BigInt(this.#p.swap.fromBlock), text === undefined ? undefined : (JSON.parse(text) as PoolTreesData));
    }
    await this.#trees.sync(this.#p.logsClient);
    await this.#p.folder.ensure();
    await this.#p.folder.write(TREES, JSON.stringify(this.#trees.data()));
    return this.#trees;
  }

  async #poolIndex(): Promise<PoolIndex> {
    if (this.#index === null) {
      const text = await this.#p.folder.read(POOL_INDEX);
      this.#index = new PoolIndex(text === undefined ? undefined : (JSON.parse(text) as PoolIndexData));
    }
    return this.#index;
  }

  #checkToken(token: Address): void {
    if (!privateTokens(this.#p.config).includes(token)) throw new RangeError(`${token} is not a token private notes hold: USDG, WETH, OSTRA or a listed stock token (the relayer relays spends of these only)`);
  }

  async #keep(p: Pending): Promise<void> {
    await this.#p.folder.ensure();
    await this.#p.folder.write(`${PENDING_PREFIX}${p.id}.json`, `${JSON.stringify(p)}\n`);
  }

  async #done(id: string): Promise<void> {
    await this.#p.folder.remove(`${PENDING_PREFIX}${id}.json`);
  }

  /** The agent's notes now (operations in flight finished first), and per token what they hold. */
  balance(): Promise<{ pool: Address; tokens: PrivateBalance; inFlight: number }> {
    return this.#serial(async () => {
      const failures = await this.#refresh();
      await this.#ensureRecovered();
      return { pool: this.#pool, tokens: await this.#summary(await this.#notes()), inFlight: failures.length };
    });
  }

  /** Shields `amount` of `token` from the agent's vault of it into a new note (see the file comment). */
  shield(a: { token: string; amount: string }): Promise<VaultOperationResult | { status: "sent"; txHash: Hash; token: Address; amount: string; note: Digest }> {
    return this.#serial(async () => {
      const token = address(a.token, "token");
      this.#checkToken(token);
      const prover = this.#prover();
      const decimals = await tokenDecimals(this.#p.client, token);
      const amount = parseUnitsAmount(a.amount, decimals);
      if (amount === 0n) throw new RangeError("amount must be greater than zero");
      const from = this.#p.vaultFor(token);
      const s = await from.state();
      if (!s.exists && from.kind === "buyer") throw new Error("this agent has no vault yet; call open_vault first");
      if (s.balance < amount) throw new Error(`the vault in ${token} (${s.vault}) holds ${formatUnitsAmount(s.balance, decimals)}, less than ${a.amount}; nothing was signed`);
      if (!s.exists) await from.open();
      const sk = this.#sk();
      await this.#ensureRecovered();
      let pending: PendingShield | null = null;
      const result = await from.operate({
        gas: PRIVATE_SHIELD_GAS,
        moves: amount,
        what: "shield",
        build: async ({ v, vault, keychain, chainId }) => {
          const balance = await tokenBalance(this.#p.client, token, vault);
          if (balance < amount) throw new Error(`the vault holds ${formatUnitsAmount(balance, decimals)} now, less than ${a.amount}; nothing was signed`);
          const rho = await this.#nextShieldRho();
          const tag = await tagOf(prover, sk, rho);
          const escrow = shieldEscrowAddress(this.#pool, token, tag);
          pending = { kind: "shield", id: tag.slice(2, 18), token, rho, tag, escrow, vaultNonce: v.nonce.toString(), block: (await this.#p.client.getBlockNumber({ cacheTime: 0 })).toString(), at: Date.now() };
          await this.#keep(pending);
          const signed = await signVaultTransfer(keychain, v, { chainId, to: escrow, amount });
          return [spendCall(vault, signed), shieldFromEscrowCall(this.#pool, token, tag)];
        },
      });
      if (result.status !== "sent") return result;
      const kept = pending as PendingShield | null;
      if (kept === null) throw new Error("the shield was sent without its record");
      const note = await shieldedNote(prover, sk, kept.rho, await this.#p.client.getTransactionReceipt({ hash: result.txHash }), this.#pool);
      await this.#addNotes([note]);
      await this.#done(kept.id);
      return { status: "sent", txHash: result.txHash, token, amount: formatUnitsAmount(note.amount, decimals), note: note.commitment };
    });
  }

  /** The smallest note of `token` holding at least `need`, or an error naming the largest. */
  async #pick(token: Address, need: bigint, decimals: number, what: string): Promise<PrivateNote> {
    const busy = await this.#notesInFlight();
    const notes = (await this.#notes()).filter((n) => n.asset === token && !busy.has(n.commitment.toLowerCase())).sort((x, y) => (BigInt(x.amount) < BigInt(y.amount) ? -1 : 1));
    const n = notes.find((x) => BigInt(x.amount) >= need);
    if (n === undefined) {
      const largest = notes.length === 0 ? 0n : BigInt((notes[notes.length - 1] as NoteRecord).amount);
      const waiting = busy.size === 0 ? "" : ` (${busy.size} note(s) wait for a spend in flight to finish)`;
      throw new Error(`no private note of ${token} holds ${formatUnitsAmount(need, decimals)} (${what}); the largest free one holds ${formatUnitsAmount(largest, decimals)}${waiting}: a spend takes one note; nothing was signed`);
    }
    return { ...n, amount: BigInt(n.amount) };
  }

  /** The relayer's fee for a spend of `kind` in `token` now, and its account (no relayer: no fee, sent by the local fee payer). */
  async #price(token: Address, kind: "swap" | "unshield"): Promise<{ fee: bigint; relayer: Address }> {
    const url = this.#p.config.relayerUrl;
    if (url === null) return { fee: 0n, relayer: "0x0000000000000000000000000000000000000000" };
    const body = await this.#http("GET", `${url}/v1/private/price?token=${token}&kind=${kind}`);
    const b = body as { fee?: unknown; relayer?: unknown };
    if (typeof b.fee !== "string" || !/^[0-9]+$/.test(b.fee) || typeof b.relayer !== "string") throw new Error("the relayer's private price has no fee or relayer");
    return { fee: BigInt(b.fee), relayer: getAddress(b.relayer) };
  }

  async #http(method: "GET" | "POST", url: string, body?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(url, { method, ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }), signal: AbortSignal.timeout(180_000) });
    } catch (err) {
      throw new RelayerUnavailableError(`the relayer cannot be reached: ${(err as Error).message}`);
    }
    const parsed = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown; required?: unknown } | null;
    if (res.status !== 200) {
      const e = new RelayerError(res.status, typeof parsed?.error === "string" ? parsed.error : "error", typeof parsed?.message === "string" ? parsed.message : `HTTP ${res.status}`);
      (e as RelayerError & { required?: unknown }).required = parsed?.required;
      throw e;
    }
    return parsed;
  }

  /** Sends a spend: through the relayer (paid by the proof's fee), or by the local fee payer without one. */
  async #send(call: { to: Address; data: Hex }): Promise<Hash> {
    const url = this.#p.config.relayerUrl;
    if (url === null) return this.#p.sender.send([call]);
    const b = (await this.#http("POST", `${url}/v1/relay`, JSON.stringify({ calls: [call] }))) as { txHash?: unknown };
    if (typeof b.txHash !== "string") throw new Error("the relayer answered without a transaction");
    return b.txHash as Hash;
  }

  /**
   * Proves and sends one spend of a note, proving again once with the fee the relayer names when it finds the fee
   * too low (the gas price moved). `prove` gets the fee and the relayer; `pending` is kept before the send.
   */
  async #spend<T extends { spend: Spend }>(
    note: PrivateNote,
    need: (fee: bigint) => bigint,
    kind: "swap" | "unshield",
    prove: (fee: bigint, relayer: Address, deadline: bigint, trees: PoolTrees) => Promise<T & { call: { to: Address; data: Hex }; out: PendingSpend["out"] }>,
  ): Promise<{ proved: T; txHash: Hash; fee: bigint; receipt: TransactionReceipt }> {
    let { fee, relayer } = await this.#price(note.asset, kind);
    for (let attempt = 0; ; attempt++) {
      if (note.amount < need(fee)) throw new Error(`the note holds ${note.amount}, less than the amount and the relayer's fee ${fee}; nothing was signed`);
      await this.#checkFee(note.asset, fee, kind);
      const trees = await this.#syncedTrees();
      const deadline = (await chainTime(this.#p.client)) + PRIVATE_SPEND_DEADLINE_SECONDS;
      const proved = await prove(fee, relayer, deadline, trees);
      const s = proved.spend;
      const pending: PendingSpend = {
        kind: "spend",
        id: s.terms.nullifier.slice(2, 18),
        note: note.commitment,
        nullifier: s.terms.nullifier,
        asset: note.asset,
        change: { rho: s.change.rho, amount: s.change.amount.toString(), commitment: s.change.commitment },
        out: proved.out,
        deadline: deadline.toString(),
        block: (await this.#p.client.getBlockNumber({ cacheTime: 0 })).toString(),
        at: Date.now(),
      };
      await this.#keep(pending);
      let txHash: Hash;
      try {
        txHash = await this.#send(proved.call);
      } catch (err) {
        const required = (err as { required?: unknown }).required;
        if (err instanceof RelayerError && err.code === "fee_too_low" && attempt === 0 && typeof required === "string" && /^[0-9]+$/.test(required)) {
          await this.#done(pending.id);
          fee = BigInt(required);
          continue;
        }
        // A refusal (4xx) was not sent; anything else may have been, and the record stays until the pool or the deadline says.
        if (err instanceof RelayerError && err.status >= 400 && err.status < 500) await this.#done(pending.id);
        throw err;
      }
      const receipt = await this.#p.client.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
      return { proved, txHash, fee, receipt };
    }
  }

  /** Refuses a relayer fee worth more than PRIVATE_FEE_MAX_FACTOR times PRIVATE_FEE_GAS[kind] at the gas price now. */
  async #checkFee(token: Address, fee: bigint, kind: "swap" | "unshield"): Promise<void> {
    if (fee === 0n) return;
    const ceiling = PRIVATE_FEE_GAS[kind] * (await this.#p.client.getGasPrice()) * PRIVATE_FEE_MAX_FACTOR;
    let worth: bigint;
    if (token === WETH) worth = fee;
    else if (token === this.#p.config.deployment.token) {
      // USDG (6 decimals) at Chainlink ETH/USD (8 decimals): wei = units * 1e12 * 1e8 / answer.
      const { answer } = await chainlinkEthUsd(this.#p.client)();
      worth = (fee * 10n ** 20n) / answer;
    } else {
      try {
        worth = (await findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index: await this.#poolIndex(), tokenIn: token, tokenOut: WETH, amountIn: fee, feeBps: PRIVATE_SWAP_FEE_BPS, slippageBps: 0 })).expectedOut;
      } catch (err) {
        if (err instanceof NoRouteError) throw new Error(`the relayer's fee in ${token} cannot be priced against WETH now; nothing was sent`);
        throw err;
      }
    }
    if (worth > ceiling) {
      throw new Error(`the relayer asks a fee of ${fee} units of ${token}, worth about ${worth} wei, more than ${PRIVATE_FEE_MAX_FACTOR} times the ${PRIVATE_FEE_GAS[kind]} gas of a private ${kind} at the gas price now (${ceiling} wei); nothing was sent`);
    }
  }

  /** Swaps `amount` of tokenIn out of one private note into a new private note of tokenOut (see the file comment). */
  swap(a: { tokenIn: string; tokenOut: string; amount: string; slippageBps?: number }): Promise<PrivateSpendResult> {
    return this.#serial(async () => {
      const tokenIn = address(a.tokenIn, "tokenIn");
      const tokenOut = address(a.tokenOut, "tokenOut");
      if (tokenIn === tokenOut) throw new RangeError("tokenIn and tokenOut are the same");
      this.#checkToken(tokenIn);
      this.#checkToken(tokenOut);
      const slippageBps = a.slippageBps ?? 100;
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) throw new RangeError(`slippage must be 0 to ${MAX_SLIPPAGE_BPS} bps`);
      this.#requireRelayer();
      const prover = this.#prover();
      await this.#refresh();
      await this.#ensureRecovered();
      const [inDecimals, outDecimals] = await Promise.all([tokenDecimals(this.#p.client, tokenIn), tokenDecimals(this.#p.client, tokenOut)]);
      const v = parseUnitsAmount(a.amount, inDecimals);
      if (v === 0n) throw new RangeError("amount must be greater than zero");
      const { fee: priced } = await this.#price(tokenIn, "swap");
      const note = await this.#pick(tokenIn, v + priced, inDecimals, `${a.amount} and the relayer's fee`);
      const index = await this.#poolIndex();
      const route = await findRoute({ client: this.#p.client, logsClient: this.#p.logsClient, index, tokenIn, tokenOut, amountIn: v, feeBps: PRIVATE_SWAP_FEE_BPS, slippageBps });
      await this.#p.folder.write(POOL_INDEX, JSON.stringify(index.data()));
      const sk = this.#sk();
      const changeRho = this.#spendRho("change", note.commitment);
      const outRho = this.#spendRho("out", note.commitment);
      const outTag = await tagOf(prover, sk, outRho);
      const r = await this.#spend(note, (fee) => v + fee, "swap", async (fee, relayer, deadline, trees) => {
        const { spend, swap } = await provePrivateSwap({ prover, sk, note, trees, chainId: this.#p.config.chainId, pool: this.#pool, fee, relayer, deadline, route, outRho, changeRho });
        return { spend, swap, call: privateSwapCall(this.#pool, spend, swap), out: { rho: outRho, tokenOut, tag: outTag } };
      });
      const { spend, swap } = r.proved as { spend: Spend; swap: PrivateSwapTerms };
      const out = await swapOutputNote(prover, sk, outRho, spend, swap, r.receipt, this.#pool);
      const change = changeNote(spend, r.receipt, this.#pool);
      await this.#addNotes(change === null ? [out] : [out, change], [note.commitment]);
      await this.#done(spend.terms.nullifier.slice(2, 18));
      return {
        status: "sent",
        txHash: r.txHash,
        amountIn: formatUnitsAmount(v, inDecimals),
        fee: formatUnitsAmount(r.fee, inDecimals),
        amountOut: formatUnitsAmount(out.amount, outDecimals),
        tokenOut,
        change: formatUnitsAmount(spend.change.amount, inDecimals),
      };
    });
  }

  /** Sends `amount` of `token` out of one private note to `destination` (default: the agent's vault of that token). */
  unshield(a: { token: string; amount: string; destination?: string }): Promise<PrivateSpendResult> {
    return this.#serial(async () => {
      const token = address(a.token, "token");
      this.#checkToken(token);
      this.#requireRelayer();
      const prover = this.#prover();
      await this.#refresh();
      await this.#ensureRecovered();
      const decimals = await tokenDecimals(this.#p.client, token);
      const v = parseUnitsAmount(a.amount, decimals);
      if (v === 0n) throw new RangeError("amount must be greater than zero");
      const recipient = a.destination === undefined ? await this.#p.vaultFor(token).vaultAddress() : address(a.destination, "destination");
      if (recipient === "0x0000000000000000000000000000000000000000") throw new RangeError("the destination must not be the zero address");
      const { fee: priced } = await this.#price(token, "unshield");
      const note = await this.#pick(token, v + priced, decimals, `${a.amount} and the relayer's fee`);
      const sk = this.#sk();
      const changeRho = this.#spendRho("change", note.commitment);
      const r = await this.#spend(note, (fee) => v + fee, "unshield", async (fee, relayer, deadline, trees) => {
        const spend = await proveUnshield({ prover, sk, note, trees, chainId: this.#p.config.chainId, pool: this.#pool, fee, relayer, deadline, v, recipient, changeRho });
        return { spend, call: unshieldCall(this.#pool, spend, recipient), out: null };
      });
      const spend = r.proved.spend;
      const change = changeNote(spend, r.receipt, this.#pool);
      await this.#addNotes(change === null ? [] : [change], [note.commitment]);
      await this.#done(spend.terms.nullifier.slice(2, 18));
      return { status: "sent", txHash: r.txHash, amountIn: formatUnitsAmount(v, decimals), fee: formatUnitsAmount(r.fee, decimals), recipient, change: formatUnitsAmount(spend.change.amount, decimals) };
    });
  }

  /** refresh() for the sweep: one at a time with the operations. Returns what is still in flight or failed. */
  refresh(): Promise<{ id: string; error: string }[]> {
    return this.#serial(() => this.#refresh());
  }

  /**
   * Finishes what an operation left: a shield escrow paid whose note was not taken (taken now), a shield or a spend
   * that landed without its answer (its notes recorded from the chain), a spend past its deadline that never landed
   * (dropped: its note is still the agent's). Returns the operations still in flight, and failures.
   */
  async #refresh(): Promise<{ id: string; error: string }[]> {
    const left: { id: string; error: string }[] = [];
    for (const name of await this.#p.folder.list()) {
      if (!name.startsWith(PENDING_PREFIX)) continue;
      const text = await this.#p.folder.read(name);
      if (text === undefined) continue;
      const p = JSON.parse(text) as Pending;
      try {
        const finished = p.kind === "shield" ? await this.#finishShield(p) : await this.#finishSpend(p);
        if (finished) await this.#done(p.id);
        else left.push({ id: p.id, error: "in flight" });
      } catch (err) {
        left.push({ id: p.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return left;
  }

  async #finishShield(p: PendingShield): Promise<boolean> {
    const prover = this.#prover();
    const sk = this.#sk();
    // Taken (by the agent or anyone): a Shielded log from its escrow with its tag; the note is the agent's either way.
    let found = false;
    const logs = await this.#p.logsClient.getLogs({ address: this.#pool, event: shieldedEvent, args: { from: p.escrow }, fromBlock: BigInt(p.block), toBlock: "latest" });
    for (const l of logs) {
      if (l.args.tag?.toLowerCase() !== p.tag.toLowerCase() || l.transactionHash === null) continue;
      await this.#addNotes([await shieldedNote(prover, sk, p.rho, await this.#p.client.getTransactionReceipt({ hash: l.transactionHash }), this.#pool)]);
      found = true;
    }
    // Until the vault's nonce passes the signed Transfer, it may still land (sent again before the vault's next spend).
    const s = await this.#p.vaultFor(p.token).state();
    if (s.nonce === null || s.nonce <= BigInt(p.vaultNonce)) return false;
    // Paid and not taken: the pool takes it now.
    if ((await tokenBalance(this.#p.client, p.token, p.escrow)) > 0n) {
      try {
        const txHash = await this.#p.sender.send([shieldFromEscrowCall(this.#pool, p.token, p.tag)]);
        await this.#addNotes([await shieldedNote(prover, sk, p.rho, await this.#p.client.waitForTransactionReceipt({ hash: txHash }), this.#pool)]);
        return true;
      } catch (err) {
        // The agent's shield is a note already; what else the escrow holds was sent to it by someone else.
        if (found) return true;
        throw err;
      }
    }
    // Landed and empty: taken, so its log is found once the logs RPC has the block. A Transfer never signed, or
    // signed and then passed by another spend under the same nonce, leaves no log: dropped after SHIELD_LOG_WAIT_MS.
    if (found) return true;
    if (p.emptySince === undefined) {
      await this.#keep({ ...p, emptySince: Date.now() });
      return false;
    }
    return Date.now() - p.emptySince > SHIELD_LOG_WAIT_MS;
  }

  async #finishSpend(p: PendingSpend): Promise<boolean> {
    const spent = (await this.#p.client.readContract({ address: this.#pool, abi: ostraPrivatePoolAbi, functionName: "isSpent", args: [p.nullifier] })) as boolean;
    if (!spent) return (await chainTime(this.#p.client)) > BigInt(p.deadline);
    const event = p.out === null ? unshieldedEvent : swappedEvent;
    const logs = await this.#p.logsClient.getLogs({ address: this.#pool, event, args: { nullifier: p.nullifier }, fromBlock: BigInt(p.block), toBlock: "latest" } as never);
    const hash = (logs[0] as { transactionHash: Hash | null } | undefined)?.transactionHash;
    if (hash === undefined || hash === null) return false;
    const receipt = await this.#p.client.getTransactionReceipt({ hash });
    const spend = { terms: { asset: p.asset, nullifier: p.nullifier }, change: { rho: p.change.rho, amount: BigInt(p.change.amount), commitment: p.change.commitment } } as unknown as Spend;
    const add: PrivateNote[] = [];
    const change = changeNote(spend, receipt, this.#pool);
    if (change !== null) add.push(change);
    if (p.out !== null) add.push(await swapOutputNote(this.#prover(), this.#sk(), p.out.rho, spend, { tokenOut: p.out.tokenOut, outTag: p.out.tag } as PrivateSwapTerms, receipt, this.#pool));
    await this.#addNotes(add, [p.note]);
    return true;
  }

}
