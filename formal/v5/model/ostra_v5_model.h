/*
 * A reference model, in C, of the logic OstraVault version 5 adds: the agent key, the policy that bounds it, the
 * allowlists, the budget and the standing orders, with the parts of the vault's owner spend, guard and recovery paths
 * that act on them.
 *
 * Sources it follows, line for line (ostra-robinhood, commit f527bed):
 *   src/OstraVaultV5.sol        applyPending, current, allowed, agentInForce, waiting, cancelWaiting, dropConsent,
 *                               revokeAgent, setterLive, stopOrders, used, count
 *   src/OstraVaultModuleV5.sol  agent, _rotateAgent, _agentAmount, run, _setPolicy, _tighter, _setAllow,
 *                               _setAgentKey, _setOrder, runOrder, _consent, stop, onLockOn, onRecovery, cancel
 *   src/OstraVault.sol          spend, spendAsAgent, _checkParamsShape (BadAction), _run (Transfer), guard (ops 0 and
 *                               7), supportRecovery, finishRecovery
 *
 * Every operation either succeeds and changes the state, or fails and leaves it exactly as it was (a revert).
 *
 * What is abstract:
 *   - Key roots, addresses and allowlist values are ids. The contracts only ever compare them for equality or with
 *     zero, except that an allowlist value of an address kind must fit in 160 bits: VALUE_WIDE is the one id that does
 *     not. Id 0 is the zero address, the zero value and "no key"; it also stands for a value no id names (the
 *     allowlist never holds 0).
 *   - A WOTS signature is modeled by the root it recovers to (`signer`): Wots.recoverKeyRoot returns the root of the key
 *     that signed the exact message, and the model checks it against the root in force, as the contracts do. An owner
 *     spend is taken as signed by the owner's key in force (or, finishing a recovery, by its new key).
 *   - Amounts, policy bounds and the token balance are below 2^64 base units (the contracts allow up to 2^128; at 6
 *     decimals 2^64 base units are about 18 trillion USDG). Timestamps are below 2^62 (model_warp refuses to go past).
 *   - Spends are well formed (the right parameter lengths); an action above 46 fails with BadAction as in the vault.
 *   - Code outside version 5 that a spend runs after the version 5 checks (a venue, a swap, a channel, Morpho, Priors,
 *     the version 3 withdrawal lock's daily limit), and a REFILL run's exit from its venue (_exitFor, which reads the
 *     vault's position there), is not modeled. It can only refuse (then nothing changes), move the
 *     token balance, or write the Priors fields. The model treats it as passing (R_OK_EXTERNAL, or R_OK for a Transfer
 *     and a PAY run, whose token transfer it models), and covers its effects with operations of their own:
 *     env_set_balance (any change of the balance: deposits, venues, owner spends outside version 5, Priors repays),
 *     env_priors_consent (a Priors consent that starts to wait, the one Priors field version 5's other logic reads).
 *     The Priors loans (ownLoans) are left out: nothing else reads them.
 *   - The version 3 withdrawal lock's own changes after their wait (turning it off, a new delay) are env_lock; turning
 *     it on is owner_spend_lock_on. A guard cancel that only drops version 3 or 4 changes leaves version 5's state as it
 *     is, as the model's failure does. The linked vault (version 3) changes by env_set_linked.
 *   - What a Priors spend counts against the budget (a loan's capped fee, a line's cost) depends on the pool, so it is
 *     an input (AgentCall.counted).
 *   - Bounded tables: MAX_ORDERS orders, MAX_EPOCHS allowlist epochs, NUM_VALUES ids. Past them an operation fails with
 *     R_MODEL_LIMIT where the contracts would go on, so the model's reachable states are those of the contracts that
 *     stay within the bounds.
 */
#ifndef OSTRA_V5_MODEL_H
#define OSTRA_V5_MODEL_H

#include <stdbool.h>
#include <stdint.h>

#define MAX_ORDERS 64u
#define MAX_EPOCHS 64u
#define NUM_VALUES 8u
#define TIME_LIMIT (1ull << 62)

#define ID_NONE 0u
#define VALUE_WIDE 6u
#define ADDR_SELF 7u

/* Actions (OstraVault.ACTION_*). */
#define ACTION_TRANSFER 0u
#define ACTION_OPEN_CHANNEL 1u
#define ACTION_SWAP 3u
#define ACTION_CLAIM_DIVIDEND 5u
#define ACTION_SET_GUARDIAN 6u
#define ACTION_SET_WITHDRAWAL_LOCK 14u
#define ACTION_CANCEL_PENDING_CHANGES 15u
#define ACTION_LEND 17u
#define ACTION_REDEEM 18u
#define ACTION_REPAY 22u
#define ACTION_ENTER 26u
#define ACTION_EXIT 27u
#define ACTION_SET_POLICY 29u
#define ACTION_SET_ALLOW 30u
#define ACTION_SET_AGENT_KEY 31u
#define ACTION_REVOKE_AGENT_KEY 32u
#define ACTION_SET_ORDER 33u
#define ACTION_CANCEL_ORDER 34u
#define ACTION_PRIORS_BORROW 35u
#define ACTION_ROOT_SPONSOR 41u
#define ACTION_ROOT_VOUCH 42u
#define ACTION_ROOT_FREEZE 44u
#define ACTION_LAST 46u

/* OstraVaultModuleV5.AGENT_ACTIONS: the actions an agent key may ever use. */
#define AGENT_ACTIONS 0x5e7f1c7e0c2bULL

/* Allowlist kinds (OstraVaultV5.ALLOW_*). */
#define ALLOW_RECIPIENT 1u
#define ALLOW_CHANNEL 2u
#define ALLOW_POOL 3u
#define ALLOW_LEND 4u
#define ALLOW_SPONSOR 5u
#define ALLOW_BORROWER 6u

/* Order kinds (OstraVaultV5.ORDER_*) and venue kinds (OstraVaultV4). */
#define ORDER_SWEEP 1u
#define ORDER_REFILL 2u
#define ORDER_PAY 3u
#define VENUE_RAETO_USDG 1u
#define VENUE_ERC4626 3u

#define DAY 86400ull
#define LIMIT_WINDOW DAY
#define MAX_AGENT_KEY_LIFE (90ull * DAY)
#define MIN_ORDER_INTERVAL 3600ull
#define MAX_ORDER_INTERVAL (365ull * DAY)
#define MAX_TERM (365ull * DAY)
#define MAX_REPAY_LEAD (7ull * DAY)
#define MAX_PREMIUM_BPS 200u
#define MIN_LOCK_DELAY (36ull * 3600ull)
#define MAX_LOCK_DELAY (14ull * DAY)
#define MIN_RECOVERY_DELAY (36ull * 3600ull)
#define MAX_RECOVERY_DELAY (14ull * DAY)
#define MAX_CONSENT_LIFE (30ull * DAY)

/* Outcomes. A failure names the contracts' error; R_NOT_ALLOWED + a and R_NOT_ALLOWLISTED + k carry the error's
 * argument (NotAllowed(a), NotAllowlisted(k)). */
typedef int32_t Result;
#define R_OK 0
#define R_OK_EXTERNAL 1    /* every version 5 check passed; what follows is code the model leaves out */
#define R_BAD_PARAMS 2     /* BadParams() */
#define R_LOCKED 3         /* Locked() */
#define R_NO_AGENT_KEY 4   /* NoAgentKey() */
#define R_WOTS_INVALID 5   /* WotsSignatureInvalid() */
#define R_NO_ORDER 6       /* NoOrder() */
#define R_TOO_EARLY 7      /* TooEarly(uint256) */
#define R_NOTHING_TO_DO 8  /* NothingToDo() */
#define R_OVER_PER_TX 9    /* OverPerTx(uint256) */
#define R_OVER_BUDGET 10   /* OverBudget(uint256) */
#define R_ZERO_AMOUNT 11   /* ZeroAmount() */
#define R_NOT_GUARDIAN 12  /* NotGuardian() */
#define R_NOT_LINKED 13    /* NotLinked() */
#define R_TOKEN 14         /* the token refused the transfer (the balance is short) */
#define R_OVERFLOW 15      /* Solidity's checked arithmetic (Panic 0x11) */
#define R_MODEL_LIMIT 16   /* past a bound of the model (never a revert of the contracts) */
#define R_BAD_ACTION 17    /* BadAction() */
#define R_NO_RECOVERY 18   /* NoRecovery() */
#define R_RECOVERY_NOT_READY 19 /* RecoveryNotReady() */
#define R_NOT_OWN_AGENT 20 /* NotOwnAgent(uint256) */
#define R_OUT_OF_POLICY 21 /* OutOfPolicy() */
#define R_NOT_ALLOWED 100     /* + action */
#define R_NOT_ALLOWLISTED 400 /* + kind */

typedef struct {
    uint64_t actions;
    uint64_t perTx;
    uint64_t daily;
    uint64_t maxDebt;
    uint32_t maxTerm;
    uint16_t maxFeeBps;
    uint16_t coverBps;
    uint32_t repayLead;
    uint8_t repayKind;
    uint32_t repayVenue;
    uint64_t vouchPerAgent;
    uint64_t vouchTotal;
    uint16_t maxPremiumBps;
} Policy;

typedef struct {
    uint64_t from;  /* 0: not on the list */
    uint64_t epoch;
} Allow;

typedef struct {
    uint8_t kind;  /* 0: none */
    uint8_t venueKind;
    uint32_t interval;
    uint32_t runsLeft;
    uint64_t lastRun;
    uint64_t endAt;
    uint64_t epoch;
    uint32_t target;
    uint32_t agentGen;  /* 0: set by the owner */
    uint64_t amount;
    uint64_t threshold;
} Order;

typedef struct {
    uint64_t now;

    /* OstraVault (versions 1 to 4), as far as version 5 reads or writes it. */
    uint64_t keyRoot;        /* the owner's one-time key root */
    uint64_t nonce;          /* the owner's spend nonce */
    bool locked;             /* the withdrawal lock in force is on */
    uint32_t lockDelay;
    bool recovering;         /* a guardian recovery is under way (OstraVault._recovering) */
    uint64_t recoveryRoot;   /* its new key root */
    uint64_t recoveryAt;     /* when it may finish */
    uint32_t linkedVault;
    uint64_t balance;        /* the vault's token balance */

    /* OstraVaultV5.Layout (the Priors loans apart). */
    uint64_t agentRoot;
    uint64_t agentNonce;
    uint64_t agentFrom;
    uint64_t agentExpiry;
    Policy policy;
    Policy pendingPolicy;
    uint64_t pendingPolicyAt;
    uint64_t budgetAt;
    uint64_t budgetUsed;
    Allow allows[7][NUM_VALUES]; /* [kind][value]; kind 0 unused */
    uint64_t epoch;
    uint64_t waitingUntil;
    uint64_t endedAt[MAX_EPOCHS];
    Order orders[MAX_ORDERS + 1]; /* ids 1..MAX_ORDERS */
    uint64_t orderCount;
    uint64_t orderEpoch;
    uint32_t agentGen;
    uint64_t pendingConsentAt;
} State;

typedef struct {
    uint8_t kind;
    uint8_t venueKind;
    uint32_t target;
    uint64_t amount;
    uint64_t threshold;
    uint32_t interval;
    uint32_t runs;
    uint64_t endAt;
} OrderParams;

/* A version 5 spend's own action and parameters (29 to 34), for the owner or the agent key. */
typedef struct {
    uint8_t action;
    Policy policy;         /* SetPolicy */
    uint8_t allowKind;     /* SetAllow */
    uint32_t allowValue;
    bool allowOn;
    uint64_t root;         /* SetAgentKey */
    uint64_t expiry;
    OrderParams order;     /* SetOrder */
    uint64_t orderId;      /* CancelOrder */
} V5Call;

/* An agent spend: the action, and what OstraVaultModuleV5._agentAmount reads of its parameters. */
typedef struct {
    uint8_t action;
    uint32_t to;            /* Transfer, Swap, ClaimDividend: recipient; Repay: onBehalf */
    uint32_t value;         /* OpenChannel: receiver; Swap: PoolId; Lend, Redeem: the vault; RootSponsor, RootVouch: agent id */
    uint64_t amount;        /* Transfer, OpenChannel: amount; Swap: amountIn; Repay: maxAssets */
    uint64_t counted;       /* PriorsBorrow, RootSponsor, RootVouch: what it counts (from the pool) */
    bool frozen;            /* RootFreeze */
    V5Call v5;              /* actions 32 to 34 */
} AgentCall;

/* A vault before its first version 5 spend: a new one, or one just upgraded to version 5, whose version 3 state may
 * already have the lock on (`locked`, with its `lockDelay`) and a recovery under way (`recovering`, to `recoveryRoot`
 * from `recoveryAt`). Version 5's own state is all zero. Arguments no vault can have are replaced: a lock delay out of
 * bounds by the shortest, a linked vault of an id no vault has by none, a recovery to root 0 by none. */
void model_init(State *s, uint64_t now, uint64_t keyRoot, uint64_t balance, uint32_t linkedVault, bool locked,
                uint32_t lockDelay, bool recovering, uint64_t recoveryRoot, uint64_t recoveryAt);

/* Time passes. */
Result model_warp(State *s, uint64_t dt);

/* OstraVault.spend with action 29 to 34 (`call`). */
Result owner_spend_v5(State *s, uint64_t nextKeyRoot, const V5Call *call);
/* OstraVault.spend with SetWithdrawalLock turning the lock on (to a withdrawal address with code), from off. */
Result owner_spend_lock_on(State *s, uint64_t nextKeyRoot, uint32_t delay);
/* OstraVault.spend with CancelPendingChanges. */
Result owner_spend_cancel_pending(State *s, uint64_t nextKeyRoot);
/* OstraVault.spend with any other action that succeeds (a version 1 to 4 spend, or a Priors spend whose failure lands),
 * leaving the balance at `balance`. */
Result owner_spend_other(State *s, uint64_t nextKeyRoot, uint64_t balance);
/* OstraVault.spend with PriorsConsent (37) for an agent the vault owns or not (`ownsAgent`, the identity registry's
 * answer), a sponsor (allowlist value), the most premium and the deadline; the pool's digest is approved for EIP-1271
 * (version 3's field, not modeled). A failure that lands (sent by an account with no code) is owner_spend_other. */
Result owner_spend_priors_consent(State *s, uint64_t nextKeyRoot, bool ownsAgent, uint32_t sponsor,
                                  uint64_t maxPremiumBps, uint64_t deadline);

/* OstraVault.spendAsAgent, whose WOTS signature recovers to `signer`. */
Result agent_spend(State *s, uint64_t signer, uint64_t nextKeyRoot, const AgentCall *call);

/* OstraVault.runOrder; `moved` gets what the run moves (PAY: paid; SWEEP: entered; REFILL: asked of the venue). */
Result run_order(State *s, uint64_t id, uint64_t *moved);

/* OstraVault.guard op 7 (stop the agent key and every order) and op 0 (cancel the changes waiting), by a guardian or
 * the withdrawal address (`authorized`) or anyone else. */
Result guard_stop(State *s, bool authorized);
Result guard_cancel(State *s, bool authorized);

/* OstraVault.supportRecovery by a guardian whose support reaches the threshold (a recovery to `newKeyRoot` after
 * `delay`), and OstraVault.finishRecovery. */
Result recovery_support(State *s, uint64_t newKeyRoot, uint32_t delay);
Result finish_recovery(State *s);

/* What code outside version 5 does to the state the model has (see the header comment). */
Result env_set_balance(State *s, uint64_t balance);
Result env_priors_consent(State *s);
Result env_lock(State *s, bool on, uint32_t delay);
Result env_set_linked(State *s, uint32_t linkedVault);

/* Views (OstraVault.agentKey, policy, budgetAvailable, allowEntry, order). */
bool agent_in_force(const State *s);
void policy_view(const State *s, Policy *inForce, Policy *pending, uint64_t *pendingAt);
uint64_t budget_available(const State *s);
bool allowed(const State *s, uint8_t kind, uint32_t value);
bool order_live(const State *s, uint64_t id);

/* Helpers the properties name. budget_count is OstraVaultV5.count: what the agent key's spends and the PAY runs count
 * against `p` (it changes the state even when it fails; its callers then discard their copy). */
uint64_t budget_used(const State *s, uint64_t daily);
Result budget_count(State *s, const Policy *p, uint64_t amount);
bool policy_tighter(const Policy *n, const Policy *c);

#endif
