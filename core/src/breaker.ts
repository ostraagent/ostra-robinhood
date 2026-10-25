// OstraBreaker (Strategy 3, src/OstraBreaker.sol) for the agent's USDG vault. Decided by Edu on 25 Oct 2026: a vault
// that turns its withdrawal lock on is armed first, for every cash vault (sdk CASH_VAULTS), so that anyone (Ostra's
// breaker keeper above all) can redeem its shares back into it the moment a limit is crossed on chain; a vault without
// the lock is not armed (the breaker can act only under the lock), and the MCP's sweep checks it each minute instead.
//
// Arming runs in the order the vault requires: the breaker becomes a guardian (refused under the lock), the vault
// approves its limits (an EIP-1271 approval of breakerLimitsHash at the breaker's nonce for that vault and target),
// anyone sends them (OstraBreaker.configure, through the relayer or the local fee payer), and only then may the lock
// go on (turning it on drops earlier approvals). Each step is skipped when it is done already, so arming again after
// an interruption picks up where it stopped: the limits are kept here (`folder`) before the vault signs their approval
// and until they are sent, and a later arm at the same breaker nonce goes on with those: sent while the vault's approval
// of them reads, or approved again when that approval was signed and has not landed (the vault sends it first), and
// replaced only when it was never signed (an approval left behind would stay valid at that nonce for anyone to send).
// The limits are sdk DEFAULT_BREAKER_LIMITS, with the run measured from the cash vault's totalAssets read when the vault
// signs (breakerLimitsFor).

import { encodeFunctionData, getAddress, type Address, type Hash, type PublicClient } from "viem";
import {
  CASH_VAULTS,
  VAULT_ACTION,
  breakerLimitsFor,
  breakerLimitsHash,
  breakerReasons,
  decodeApproveHashParams,
  ostraBreakerAbi,
  ostraVaultAbi,
  readBreaker,
  readVaultGuard,
  type BreakerLimits,
  type BreakerState,
} from "@ostraagent/sdk";
import type { BorroService } from "./borro.ts";
import type { Config } from "./config.ts";
import type { Sender } from "./relay.ts";
import type { Folder } from "./storage.ts";
import type { VaultService } from "./vault.ts";

/** Gas of OstraBreaker.configure, with room (measured on a mainnet fork, 25 Oct 2026: 385,401 for a first watch); through the relayer it is priced by simulation. */
export const BREAKER_CONFIGURE_GAS = 500_000n;

const PENDING_FILE = "pending.json";
const EIP1271_MAGIC = "0x1626ba7e";
const erc1271Abi = [{ type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] }] as const;
type Pending = { vault: Address; target: Address; nonce: string; limits: { priceDropBps: number; assetsDropBps: number; maxUtilizationBps: number; minLiquidityBps: number; assetsMarkCap: string } };

const vaultV2TotalAbi = [{ type: "function", name: "totalAssets", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

export type BreakerParts = {
  client: PublicClient;
  config: Config;
  /** The agent's USDG vault. */
  buyer: VaultService;
  borro: BorroService;
  sender: Sender;
  /** Where the limits approved and not sent yet are kept. */
  folder: Folder;
};

export type BreakerWatch = BreakerState & { reasonNames: string[] };

export type ArmStep = { target: Address; step: "guardian" | "approve" | "configure"; done: "now" | "already"; txHash?: Hash; note?: string };

/** Whether `a` and `b` are the same limits. */
function sameLimits(a: BreakerLimits, b: BreakerLimits): boolean {
  return a.priceDropBps === b.priceDropBps && a.assetsDropBps === b.assetsDropBps && a.maxUtilizationBps === b.maxUtilizationBps && a.minLiquidityBps === b.minLiquidityBps && a.assetsMarkCap === b.assetsMarkCap;
}

export class BreakerService {
  readonly #p: BreakerParts;

  constructor(p: BreakerParts) {
    this.#p = p;
  }

  /** The deployment's OstraBreaker, or null (a deployment without one: version 2, or before its deployment). */
  get address(): Address | null {
    const b = this.#p.config.deployment.breaker;
    return b === undefined ? null : getAddress(b);
  }

  #breaker(): Address {
    const b = this.address;
    if (b === null) throw new Error("this deployment has no OstraBreaker yet (it comes with vault version 3)");
    return b;
  }

  async #pending(vault: Address, target: Address): Promise<Pending | null> {
    const text = await this.#p.folder.read(PENDING_FILE);
    if (text === undefined) return null;
    try {
      const p = JSON.parse(text) as Pending;
      return getAddress(p.vault) === vault && getAddress(p.target) === getAddress(target) ? p : null;
    } catch {
      return null;
    }
  }

  /** The breaker, whether it guards the USDG vault, the vault's lock, and its watch of each cash vault with the limits crossed now. */
  async status(): Promise<{ breaker: Address | null; vault: Address; guardian: boolean; locked: boolean; watches: BreakerWatch[] }> {
    const vault = getAddress(await this.#p.buyer.vaultAddress());
    const breaker = this.address;
    const g = await readVaultGuard(this.#p.client, vault);
    const locked = g.lockedSince !== 0n;
    if (breaker === null) return { breaker, vault, guardian: false, locked, watches: [] };
    const guardian = (await this.#p.client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "isGuardian", args: [breaker] })) as boolean;
    const watches: BreakerWatch[] = [];
    for (const t of CASH_VAULTS) {
      const s = await readBreaker(this.#p.client, breaker, vault, t);
      watches.push({ ...s, reasonNames: breakerReasons(s.reasons) });
    }
    return { breaker, vault, guardian, locked, watches };
  }

  /**
   * Arms the breaker on the USDG vault for every cash vault (see the file comment); refused under the lock (the breaker
   * cannot become a guardian then, and an approval would wait the lock's delay). A cash vault already watched is left
   * as it is. Returns each step, done now or found done.
   */
  async arm(): Promise<{ breaker: Address; vault: Address; steps: ArmStep[] }> {
    const breaker = this.#breaker();
    const { client, config, buyer, borro, sender } = this.#p;
    const vault = getAddress(await buyer.vaultAddress());
    if ((await readVaultGuard(client, vault)).lockedSince !== 0n) {
      throw new Error("the vault's withdrawal lock is on: the breaker is set up before the lock (a guardian cannot be added under it, and an approval would wait its delay); nothing was signed");
    }
    const steps: ArmStep[] = [];
    const guardian = (await client.readContract({ address: vault, abi: ostraVaultAbi, functionName: "isGuardian", args: [breaker] })) as boolean;
    if (guardian) steps.push({ target: breaker, step: "guardian", done: "already" });
    else {
      const r = await buyer.setGuardian(breaker, true);
      if (r.status === "resent_pending") throw new Error(`a spend signed earlier was sent first (${r.note}): arm again; nothing else was signed`);
      steps.push({ target: breaker, step: "guardian", done: r.status === "sent" ? "now" : "already", ...(r.status === "sent" ? { txHash: r.txHash } : {}) });
    }
    for (const target of CASH_VAULTS) {
      const s = await readBreaker(client, breaker, vault, target);
      if (s.watched) {
        steps.push({ target, step: "configure", done: "already" });
        continue;
      }
      // Limits kept from an earlier arm at this nonce: sent while the vault's approval of them reads; approved again when
      // that approval was signed and has not landed (approveHash sends it first: then it reads, or arm is called again).
      let limits: BreakerLimits | null = null;
      const kept = await this.#pending(vault, target);
      if (kept !== null && BigInt(kept.nonce) === s.nonce) {
        const l = { ...kept.limits, assetsMarkCap: BigInt(kept.limits.assetsMarkCap) };
        const h = breakerLimitsHash(config.chainId, breaker, vault, target, l, s.nonce);
        const reads = async () => ((await client.readContract({ address: vault, abi: erc1271Abi, functionName: "isValidSignature", args: [h, "0x"] })) as string).toLowerCase() === EIP1271_MAGIC;
        if (await reads()) {
          limits = l;
          steps.push({ target, step: "approve", done: "already" });
        } else {
          const pending = (await buyer.spendSlot())?.pending ?? null;
          const a = pending !== null && pending.action === VAULT_ACTION.APPROVE_HASH ? decodeApproveHashParams(pending.params) : null;
          if (a !== null && a.approved && a.hash.toLowerCase() === h.toLowerCase()) {
            const again = await borro.approveHash(h, true);
            if (!(await reads())) throw new Error(`the vault's approval of the kept limits was sent (${again.status === "sent" ? again.txHash : again.note}) and does not read yet: arm again`);
            limits = l;
            steps.push({ target, step: "approve", done: "now", ...(again.status === "sent" ? { txHash: again.txHash } : { note: again.note }) });
          }
        }
      }
      if (limits === null) {
        const total = (await client.readContract({ address: target, abi: vaultV2TotalAbi, functionName: "totalAssets" })) as bigint;
        limits = breakerLimitsFor(total);
        const hash = breakerLimitsHash(config.chainId, breaker, vault, target, limits, s.nonce);
        // Kept before it is signed: an approval that lands while this process stops is found by the next arm.
        await this.#p.folder.write(PENDING_FILE, JSON.stringify({ vault, target, nonce: s.nonce.toString(), limits: { ...limits, assetsMarkCap: limits.assetsMarkCap.toString() } } satisfies Pending));
        const approve = await borro.approveHash(hash, true);
        steps.push({ target, step: "approve", done: "now", ...(approve.status === "sent" ? { txHash: approve.txHash } : { note: approve.note }) });
        if (approve.status !== "sent") throw new Error(`the approval of the limits did not go out (${approve.note}): arm again`);
      }
      await buyer.requireEth(BREAKER_CONFIGURE_GAS, "send the breaker's limits", sender);
      const data = encodeFunctionData({ abi: ostraBreakerAbi, functionName: "configure", args: [vault, target, { priceDropBps: limits.priceDropBps, assetsDropBps: limits.assetsDropBps, maxUtilizationBps: limits.maxUtilizationBps, minLiquidityBps: limits.minLiquidityBps, assetsMarkCap: limits.assetsMarkCap }] });
      const txHash = await sender.send([{ to: breaker, data }]);
      const after = await readBreaker(client, breaker, vault, target);
      if (!after.watched || !sameLimits(after.limits, limits)) throw new Error(`the limits were sent (${txHash}) but the breaker does not watch ${target} with them: arm again`);
      await this.#p.folder.remove(PENDING_FILE);
      steps.push({ target, step: "configure", done: "now", txHash });
    }
    return { breaker, vault, steps };
  }
}
