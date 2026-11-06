/* The reference model of OstraVault version 5's logic: see ostra_v5_model.h for what it follows and what is abstract.
 * Each operation works on a copy of the state and writes it back only when it succeeds, as a revert would. */
#include "ostra_v5_model.h"

#include <string.h>

#define U64_MAX 0xffffffffffffffffull

/* ---------------------------------------------------------------------------------------------------------------- */
/* Arithmetic                                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

static uint64_t sat_add(uint64_t a, uint64_t b) {
    return a > U64_MAX - b ? U64_MAX : a + b;
}

static uint64_t sat_mul(uint64_t a, uint64_t b) {
    if (a == 0 || b == 0) return 0;
    return a > U64_MAX / b ? U64_MAX : a * b;
}

/* min(dt * rate / LIMIT_WINDOW, U64_MAX), exactly: with dt = q * W + r and rate = a * W + b (r, b < W),
 * dt * rate / W = q * rate + r * a + (r * b) / W, and r * b < W * W fits in 64 bits. */
static uint64_t drained(uint64_t dt, uint64_t rate) {
    uint64_t q = dt / LIMIT_WINDOW, r = dt % LIMIT_WINDOW;
    uint64_t a = rate / LIMIT_WINDOW, b = rate % LIMIT_WINDOW;
    return sat_add(sat_mul(q, rate), sat_add(sat_mul(r, a), (r * b) / LIMIT_WINDOW));
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* OstraVaultV5 (the library)                                                                                       */
/* ---------------------------------------------------------------------------------------------------------------- */

static void apply_pending(State *s) {
    if (s->pendingPolicyAt != 0 && s->now >= s->pendingPolicyAt) {
        s->policy = s->pendingPolicy;
        memset(&s->pendingPolicy, 0, sizeof(Policy));
        s->pendingPolicyAt = 0;
    }
}

static Policy current(const State *s) {
    return s->pendingPolicyAt != 0 && s->now >= s->pendingPolicyAt ? s->pendingPolicy : s->policy;
}

bool allowed(const State *s, uint8_t kind, uint32_t value) {
    if (kind == 0 || kind > ALLOW_BORROWER || value >= NUM_VALUES) return false;
    const Allow *a = &s->allows[kind][value];
    if (a->from == 0 || s->now < a->from) return false;
    if (a->epoch == s->epoch) return true;
    return a->epoch < MAX_EPOCHS && a->from <= s->endedAt[a->epoch];
}

bool agent_in_force(const State *s) {
    return s->agentRoot != 0 && s->now >= s->agentFrom && s->now < s->agentExpiry;
}

static bool waiting(const State *s) {
    return s->pendingPolicyAt > s->now || (s->agentRoot != 0 && s->agentFrom > s->now) || s->waitingUntil > s->now
        || s->pendingConsentAt > s->now;
}

static Result revoke_agent(State *s) {
    if (s->agentNonce == U64_MAX || s->agentGen == 0xffffffffu) return R_OVERFLOW;
    s->agentRoot = 0;
    s->agentFrom = 0;
    s->agentExpiry = 0;
    s->agentNonce += 1;
    s->agentGen += 1;
    return R_OK;
}

static Result cancel_waiting(State *s) {
    apply_pending(s);
    memset(&s->pendingPolicy, 0, sizeof(Policy));
    s->pendingPolicyAt = 0;
    if (s->agentRoot != 0 && s->agentFrom > s->now) {
        Result r = revoke_agent(s);
        if (r != R_OK) return r;
    }
    if (s->waitingUntil > s->now) {
        uint64_t e = s->epoch;
        if (e + 1 >= MAX_EPOCHS) return R_MODEL_LIMIT;
        s->endedAt[e] = s->now;
        s->epoch = e + 1;
        s->waitingUntil = 0;
    }
    /* dropConsent */
    s->pendingConsentAt = 0;
    return R_OK;
}

static bool setter_live(const State *s, const Order *o) {
    return o->agentGen == 0 || (o->agentGen == s->agentGen && agent_in_force(s));
}

static Result stop_orders(State *s) {
    if (s->orderEpoch == U64_MAX) return R_OVERFLOW;
    s->orderEpoch += 1;
    return R_OK;
}

uint64_t budget_used(const State *s, uint64_t daily) {
    uint64_t d = drained(s->now - s->budgetAt, daily);
    return s->budgetUsed > d ? s->budgetUsed - d : 0;
}

/* OstraVaultV5.count: u + amount > daily, written so that nothing overflows. */
Result budget_count(State *s, const Policy *p, uint64_t amount) {
    if (amount == 0) return R_OK;
    if (amount > p->perTx) return R_OVER_PER_TX;
    uint64_t u = budget_used(s, p->daily);
    if (u > p->daily || amount > p->daily - u) return R_OVER_BUDGET;
    s->budgetUsed = u + amount;
    s->budgetAt = s->now;
    return R_OK;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* OstraVaultModuleV5: the version 5 spends                                                                          */
/* ---------------------------------------------------------------------------------------------------------------- */

static bool action_bit(uint64_t actions, uint8_t action) {
    uint64_t mask = AGENT_ACTIONS & actions;
    return action < 64 && ((mask >> action) & 1u) != 0;
}

bool policy_tighter(const Policy *n, const Policy *c) {
    return (n->actions & ~c->actions) == 0 && n->perTx <= c->perTx && n->daily <= c->daily && n->maxDebt <= c->maxDebt
        && n->maxTerm <= c->maxTerm && n->maxFeeBps <= c->maxFeeBps
        && (c->coverBps == 0 || (n->coverBps != 0 && n->coverBps <= c->coverBps)) && n->repayLead == c->repayLead
        && n->repayKind == c->repayKind && n->repayVenue == c->repayVenue && n->vouchPerAgent <= c->vouchPerAgent
        && n->vouchTotal <= c->vouchTotal && n->maxPremiumBps <= c->maxPremiumBps;
}

static Result set_policy(State *s, const Policy *n, bool locked, bool frozen) {
    if ((n->actions & ~AGENT_ACTIONS) != 0 || n->maxTerm > MAX_TERM || n->maxFeeBps > 10000 || n->coverBps > 10000
        || n->repayLead > MAX_REPAY_LEAD || n->maxPremiumBps > MAX_PREMIUM_BPS) {
        return R_BAD_PARAMS;
    }
    if (n->repayKind == 0) {
        if (n->repayVenue != ID_NONE) return R_BAD_PARAMS;
    } else if ((n->repayKind != VENUE_RAETO_USDG && n->repayKind != VENUE_ERC4626) || n->repayVenue == ID_NONE) {
        return R_BAD_PARAMS;
    }
    if (!locked || policy_tighter(n, &s->policy)) {
        s->policy = *n;
        memset(&s->pendingPolicy, 0, sizeof(Policy));
        s->pendingPolicyAt = 0;
    } else {
        if (frozen) return R_LOCKED;
        s->pendingPolicy = *n;
        s->pendingPolicyAt = s->now + s->lockDelay;
    }
    return R_OK;
}

static bool address_kind(uint8_t kind) {
    return kind == ALLOW_RECIPIENT || kind == ALLOW_CHANNEL || kind == ALLOW_LEND;
}

static Result set_allow(State *s, uint8_t kind, uint32_t value, bool on, bool locked, bool frozen) {
    if (kind == 0 || kind > ALLOW_BORROWER || value == ID_NONE) return R_BAD_PARAMS;
    if (address_kind(kind) && value == VALUE_WIDE) return R_BAD_PARAMS;
    if (value >= NUM_VALUES) return R_MODEL_LIMIT;
    Allow *a = &s->allows[kind][value];
    if (!on) {
        if (a->from != 0) {
            a->from = 0;
            a->epoch = 0;
        }
        return R_OK;
    }
    if (allowed(s, kind, value)) return R_BAD_PARAMS;
    if (frozen) return R_LOCKED;
    uint64_t from = s->now + (locked ? s->lockDelay : 0);
    a->from = from;
    a->epoch = s->epoch;
    if (from > s->waitingUntil && from > s->now) s->waitingUntil = from;
    return R_OK;
}

static Result set_agent_key(State *s, uint64_t root, uint64_t expiry, bool locked, bool recovering) {
    if (recovering) return R_LOCKED;
    if (root == 0 || root == s->keyRoot) return R_BAD_PARAMS;
    uint64_t from = s->now + (locked ? s->lockDelay : 0);
    if (expiry <= from || expiry > s->now + MAX_AGENT_KEY_LIFE) return R_BAD_PARAMS;
    if (s->agentNonce == U64_MAX || s->agentGen == 0xffffffffu) return R_OVERFLOW;
    s->agentRoot = root;
    s->agentFrom = from;
    s->agentExpiry = expiry;
    s->agentNonce += 1;
    s->agentGen += 1;
    return R_OK;
}

static Result set_order(State *s, const OrderParams *o, bool recovering, bool byAgent) {
    if (recovering) return R_LOCKED;
    if (o->amount == 0 || o->target == ID_NONE || o->target == ADDR_SELF || o->interval < MIN_ORDER_INTERVAL
        || o->interval > MAX_ORDER_INTERVAL || (o->endAt != 0 && o->endAt <= s->now)) {
        return R_BAD_PARAMS;
    }
    if (o->kind == ORDER_PAY) {
        if (o->venueKind != 0 || o->threshold != 0 || o->runs == 0) return R_BAD_PARAMS;
    } else if (o->kind == ORDER_SWEEP) {
        if (o->venueKind == 0 || o->venueKind > VENUE_ERC4626 || o->runs != 0) return R_BAD_PARAMS;
    } else if (o->kind == ORDER_REFILL) {
        if ((o->venueKind != VENUE_RAETO_USDG && o->venueKind != VENUE_ERC4626) || o->runs != 0 || o->threshold == 0) {
            return R_BAD_PARAMS;
        }
    } else {
        return R_BAD_PARAMS;
    }
    if (s->orderCount >= MAX_ORDERS) return R_MODEL_LIMIT;
    uint64_t id = ++s->orderCount;
    Order *n = &s->orders[id];
    n->kind = o->kind;
    n->venueKind = o->venueKind;
    n->interval = o->interval;
    n->runsLeft = o->runs;
    n->lastRun = 0;
    n->endAt = o->endAt;
    n->epoch = s->orderEpoch;
    n->target = o->target;
    n->agentGen = byAgent ? s->agentGen : 0;
    n->amount = o->amount;
    n->threshold = o->threshold;
    return R_OK;
}

static Result cancel_order(State *s, uint64_t id, bool byAgent) {
    const Order *o = id >= 1 && id <= MAX_ORDERS ? &s->orders[id] : 0;
    if (byAgent && (id == 0 || (o != 0 && o->kind != 0 && o->agentGen == 0))) {
        return R_NOT_ALLOWED + ACTION_CANCEL_ORDER;
    }
    if (id == 0) return stop_orders(s);
    if (o != 0 && o->kind != 0) memset(&s->orders[id], 0, sizeof(Order));
    return R_OK;
}

/* OstraVaultModuleV5.run for actions 29 to 34. */
static Result v5_run(State *s, const V5Call *c, bool recovering, bool byAgent) {
    apply_pending(s);
    bool locked = s->locked;
    bool frozen = recovering && locked;
    switch (c->action) {
        case ACTION_SET_POLICY:
            return set_policy(s, &c->policy, locked, frozen);
        case ACTION_SET_ALLOW:
            return set_allow(s, c->allowKind, c->allowValue, c->allowOn, locked, frozen);
        case ACTION_SET_AGENT_KEY:
            return set_agent_key(s, c->root, c->expiry, locked, recovering);
        case ACTION_REVOKE_AGENT_KEY:
            return revoke_agent(s);
        case ACTION_SET_ORDER:
            return set_order(s, &c->order, recovering, byAgent);
        case ACTION_CANCEL_ORDER:
            return cancel_order(s, c->orderId, byAgent);
        default:
            return R_MODEL_LIMIT;
    }
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* OstraVault: owner spends                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

/* OstraVault.spend up to _run: the next key, the agent key's end when the owner takes its root, the rotation, and a
 * recovery under way stopped (the lock off). */
static Result owner_prologue(State *s, uint64_t nextKeyRoot) {
    if (nextKeyRoot == 0) return R_BAD_PARAMS;
    if (nextKeyRoot == s->agentRoot) {
        Result r = revoke_agent(s);
        if (r != R_OK) return r;
    }
    if (s->nonce == U64_MAX) return R_OVERFLOW;
    s->keyRoot = nextKeyRoot;
    s->nonce += 1;
    if (!s->locked) s->recovering = false;
    return R_OK;
}

Result owner_spend_v5(State *s, uint64_t nextKeyRoot, const V5Call *call) {
    State t = *s;
    Result r = owner_prologue(&t, nextKeyRoot);
    if (r != R_OK) return r;
    if (call->action < ACTION_SET_POLICY || call->action > ACTION_CANCEL_ORDER) return R_MODEL_LIMIT;
    r = v5_run(&t, call, t.recovering, false);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

Result owner_spend_lock_on(State *s, uint64_t nextKeyRoot, uint32_t delay) {
    if (s->locked) return R_MODEL_LIMIT; /* changes to a lock that is on are version 3's, not modeled */
    State t = *s;
    Result r = owner_prologue(&t, nextKeyRoot);
    if (r != R_OK) return r;
    if (delay < MIN_LOCK_DELAY || delay > MAX_LOCK_DELAY) return R_BAD_PARAMS;
    t.locked = true;
    t.lockDelay = delay;
    /* OstraVaultModuleV5.onLockOn */
    r = revoke_agent(&t);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

Result owner_spend_other(State *s, uint64_t nextKeyRoot, uint64_t balance) {
    State t = *s;
    Result r = owner_prologue(&t, nextKeyRoot);
    if (r != R_OK) return r;
    t.balance = balance;
    *s = t;
    return R_OK;
}

Result owner_spend_priors_consent(State *s, uint64_t nextKeyRoot, bool ownsAgent, uint32_t sponsor,
                                  uint64_t maxPremiumBps, uint64_t deadline) {
    State t = *s;
    Result r = owner_prologue(&t, nextKeyRoot);
    if (r != R_OK) return r;
    /* OstraVaultModuleV5.run, then _priors and _consent */
    apply_pending(&t);
    bool locked = t.locked;
    bool frozen = t.recovering && locked;
    if (!ownsAgent) return R_NOT_OWN_AGENT;
    if (!allowed(&t, ALLOW_SPONSOR, sponsor)) return R_NOT_ALLOWLISTED + ALLOW_SPONSOR;
    if (maxPremiumBps > t.policy.maxFeeBps || maxPremiumBps > MAX_PREMIUM_BPS) return R_OUT_OF_POLICY;
    if (frozen) return R_LOCKED;
    uint64_t from = t.now + (locked ? t.lockDelay : 0);
    if (deadline <= from || deadline > t.now + MAX_CONSENT_LIFE) return R_BAD_PARAMS;
    /* dropConsent, then the new one waits (from > now) or counts at once */
    t.pendingConsentAt = from > t.now ? from : 0;
    *s = t;
    return R_OK;
}

Result owner_spend_cancel_pending(State *s, uint64_t nextKeyRoot) {
    State t = *s;
    Result r = owner_prologue(&t, nextKeyRoot);
    if (r != R_OK) return r;
    /* OstraVaultModuleV4 drops version 3 and 4's (none in the model), then OstraVaultModuleV5.cancel. */
    r = cancel_waiting(&t);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* OstraVault: agent spends                                                                                         */
/* ---------------------------------------------------------------------------------------------------------------- */

static Result need(const State *s, uint8_t kind, uint32_t value) {
    return allowed(s, kind, value) ? R_OK : R_NOT_ALLOWLISTED + kind;
}

/* OstraVaultModuleV5._agentAmount. */
static Result agent_amount(const State *s, const AgentCall *c, uint64_t *amount) {
    Result r;
    *amount = 0;
    switch (c->action) {
        case ACTION_TRANSFER:
            r = need(s, ALLOW_RECIPIENT, c->to);
            if (r != R_OK) return r;
            *amount = c->amount;
            return R_OK;
        case ACTION_OPEN_CHANNEL:
            r = need(s, ALLOW_CHANNEL, c->value);
            if (r != R_OK) return r;
            *amount = c->amount;
            return R_OK;
        case ACTION_SWAP:
            r = need(s, ALLOW_POOL, c->value);
            if (r != R_OK) return r;
            if (c->to != ADDR_SELF) {
                r = need(s, ALLOW_RECIPIENT, c->to);
                if (r != R_OK) return r;
            }
            *amount = c->amount;
            return R_OK;
        case ACTION_CLAIM_DIVIDEND:
            if (c->to != ADDR_SELF && c->to != s->linkedVault) return R_NOT_LINKED;
            return R_OK;
        case ACTION_LEND:
        case ACTION_REDEEM:
            return need(s, ALLOW_LEND, c->value);
        case ACTION_REPAY:
            if (c->to != s->linkedVault) return R_NOT_LINKED;
            *amount = c->amount;
            return R_OK;
        case ACTION_PRIORS_BORROW:
            *amount = c->counted;
            return R_OK;
        case ACTION_ROOT_SPONSOR:
        case ACTION_ROOT_VOUCH:
            r = need(s, ALLOW_BORROWER, c->value);
            if (r != R_OK) return r;
            *amount = c->counted;
            return R_OK;
        case ACTION_ROOT_FREEZE:
            if (!c->frozen) return R_NOT_ALLOWED + ACTION_ROOT_FREEZE;
            return R_OK;
        default:
            return R_OK;
    }
}

/* OstraVault._run's Transfer, as far as version 5 and the token go (the withdrawal lock's daily limit is version 3's). */
static Result transfer(State *s, uint32_t to, uint64_t amount) {
    if (amount == 0) return R_ZERO_AMOUNT;
    if (to == ID_NONE || s->balance < amount) return R_TOKEN;
    if (to != ADDR_SELF) s->balance -= amount;
    return R_OK;
}

Result agent_spend(State *s, uint64_t signer, uint64_t nextKeyRoot, const AgentCall *call) {
    /* OstraVault._checkParamsShape */
    if (call->action > ACTION_LAST) return R_BAD_ACTION;
    State t = *s;
    /* OstraVaultModuleV5.agent */
    if (t.recovering) return R_LOCKED;
    apply_pending(&t);
    if (!agent_in_force(&t)) return R_NO_AGENT_KEY;
    uint64_t root = t.agentRoot;
    if (signer != root) return R_WOTS_INVALID;
    if (t.agentNonce == U64_MAX) return R_OVERFLOW;
    t.agentRoot = nextKeyRoot;
    t.agentNonce += 1;
    if (nextKeyRoot == root || nextKeyRoot == t.keyRoot) return R_BAD_PARAMS;
    Policy p = t.policy;
    if (!action_bit(p.actions, call->action)) return R_NOT_ALLOWED + call->action;
    uint64_t amount;
    Result r = agent_amount(&t, call, &amount);
    if (r != R_OK) return r;
    r = budget_count(&t, &p, amount);
    if (r != R_OK) return r;
    /* OstraVault._run, by the agent key */
    if (call->action == ACTION_TRANSFER) {
        r = transfer(&t, call->to, call->amount);
    } else if (call->action >= ACTION_SET_POLICY && call->action <= ACTION_CANCEL_ORDER) {
        if (call->v5.action != call->action) return R_MODEL_LIMIT;
        r = v5_run(&t, &call->v5, t.recovering, true);
    } else {
        r = R_OK_EXTERNAL;
    }
    if (r != R_OK && r != R_OK_EXTERNAL) return r;
    *s = t;
    return r;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Standing orders                                                                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

bool order_live(const State *s, uint64_t id) {
    if (id < 1 || id > MAX_ORDERS) return false;
    const Order *o = &s->orders[id];
    return o->kind != 0 && o->epoch == s->orderEpoch && (o->endAt == 0 || s->now < o->endAt) && setter_live(s, o);
}

Result run_order(State *s, uint64_t id, uint64_t *moved) {
    *moved = 0;
    if (s->recovering) return R_LOCKED;
    State t = *s;
    apply_pending(&t);
    if (id < 1 || id > MAX_ORDERS) return R_NO_ORDER;
    Order *o = &t.orders[id];
    if (o->kind == 0 || o->epoch != t.orderEpoch || (o->endAt != 0 && t.now >= o->endAt) || !setter_live(&t, o)) {
        return R_NO_ORDER;
    }
    if (o->lastRun != 0 && t.now < o->lastRun + o->interval) return R_TOO_EARLY;
    o->lastRun = t.now;
    Policy p = t.policy;
    uint64_t amount = o->amount;
    Result r;
    if (o->kind == ORDER_PAY) {
        if (!action_bit(p.actions, ACTION_TRANSFER)) return R_NOT_ALLOWED + ACTION_TRANSFER;
        r = need(&t, ALLOW_RECIPIENT, o->target);
        if (r != R_OK) return r;
        r = budget_count(&t, &p, amount);
        if (r != R_OK) return r;
        uint32_t target = o->target;
        uint32_t left = o->runsLeft - 1;
        if (left == 0) memset(o, 0, sizeof(Order));
        else o->runsLeft = left;
        if (t.balance < amount) return R_TOKEN;
        if (target != ADDR_SELF) t.balance -= amount;
        r = R_OK;
    } else if (o->kind == ORDER_SWEEP) {
        if (!action_bit(p.actions, ACTION_ENTER)) return R_NOT_ALLOWED + ACTION_ENTER;
        if (t.balance <= o->threshold) return R_NOTHING_TO_DO;
        if (t.balance - o->threshold < amount) amount = t.balance - o->threshold;
        /* OstraVaultModuleV4.runVenue Enter: the amount leaves for the venue */
        t.balance -= amount;
        r = R_OK_EXTERNAL;
    } else {
        if (!action_bit(p.actions, ACTION_EXIT)) return R_NOT_ALLOWED + ACTION_EXIT;
        if (t.balance >= o->threshold) return R_NOTHING_TO_DO;
        if (o->threshold - t.balance < amount) amount = o->threshold - t.balance;
        /* _exitFor: what comes back from the venue is not modeled */
        r = R_OK_EXTERNAL;
    }
    *s = t;
    *moved = amount;
    return r;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Guardians and recovery                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

Result guard_stop(State *s, bool authorized) {
    if (!s->locked) return R_LOCKED;
    if (!authorized) return R_NOT_GUARDIAN;
    State t = *s;
    Result r = revoke_agent(&t);
    if (r != R_OK) return r;
    r = stop_orders(&t);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

Result guard_cancel(State *s, bool authorized) {
    if (!s->locked) return R_LOCKED;
    if (!authorized) return R_NOT_GUARDIAN;
    /* Nothing of version 3 or 4 waits in the model: with nothing of version 5 either, OstraVaultModuleV4 refuses. */
    if (!waiting(s)) return R_BAD_PARAMS;
    State t = *s;
    Result r = cancel_waiting(&t);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

Result recovery_support(State *s, uint64_t newKeyRoot, uint32_t delay) {
    if (newKeyRoot == 0) return R_BAD_PARAMS;
    if (delay < MIN_RECOVERY_DELAY || delay > MAX_RECOVERY_DELAY) return R_MODEL_LIMIT; /* the vault's setting */
    /* One recovery per round: while one is under way, a support only counts. */
    if (s->recovering) return R_OK;
    State t = *s;
    t.recovering = true;
    t.recoveryRoot = newKeyRoot;
    t.recoveryAt = t.now + delay;
    /* OstraVaultModuleV5.onRecovery */
    Result r = cancel_waiting(&t);
    if (r == R_OK) r = revoke_agent(&t);
    if (r == R_OK) r = stop_orders(&t);
    if (r != R_OK) return r;
    *s = t;
    return R_OK;
}

Result finish_recovery(State *s) {
    if (!s->recovering) return R_NO_RECOVERY;
    if (s->now < s->recoveryAt) return R_RECOVERY_NOT_READY;
    s->keyRoot = s->recoveryRoot;
    s->recovering = false;
    return R_OK;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Code outside version 5                                                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

Result env_set_balance(State *s, uint64_t balance) {
    s->balance = balance;
    return R_OK;
}

/* The waiting part of OstraVaultModuleV5._consent: nothing new while a recovery is under way under the lock; one consent
 * waits at a time, the lock's delay. */
Result env_priors_consent(State *s) {
    if (s->recovering && s->locked) return R_LOCKED;
    s->pendingConsentAt = 0;
    if (s->locked) s->pendingConsentAt = s->now + s->lockDelay;
    return R_OK;
}

/* A version 3 change of the lock in force, once its wait is over: off, or a new delay. */
Result env_lock(State *s, bool on, uint32_t delay) {
    if (!s->locked) return R_MODEL_LIMIT;
    if (on && (delay < MIN_LOCK_DELAY || delay > MAX_LOCK_DELAY)) return R_BAD_PARAMS;
    s->locked = on;
    s->lockDelay = on ? delay : 0;
    return R_OK;
}

Result env_set_linked(State *s, uint32_t linkedVault) {
    if (linkedVault == ADDR_SELF || linkedVault == VALUE_WIDE || linkedVault >= NUM_VALUES) return R_MODEL_LIMIT;
    s->linkedVault = linkedVault;
    return R_OK;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Setup, time, views                                                                                               */
/* ---------------------------------------------------------------------------------------------------------------- */

void model_init(State *s, uint64_t now, uint64_t keyRoot, uint64_t balance, uint32_t linkedVault, bool locked,
                uint32_t lockDelay, bool recovering, uint64_t recoveryRoot, uint64_t recoveryAt) {
    memset(s, 0, sizeof(State));
    s->now = now;
    s->keyRoot = keyRoot;
    s->balance = balance;
    s->locked = locked;
    if (locked) s->lockDelay = lockDelay < MIN_LOCK_DELAY || lockDelay > MAX_LOCK_DELAY ? (uint32_t)MIN_LOCK_DELAY : lockDelay;
    s->recovering = recovering && recoveryRoot != 0;
    if (s->recovering) {
        s->recoveryRoot = recoveryRoot;
        s->recoveryAt = recoveryAt;
    }
    s->linkedVault = linkedVault == ADDR_SELF || linkedVault == VALUE_WIDE || linkedVault >= NUM_VALUES ? ID_NONE : linkedVault;
}

Result model_warp(State *s, uint64_t dt) {
    if (s->now >= TIME_LIMIT || dt >= TIME_LIMIT - s->now) return R_MODEL_LIMIT;
    s->now += dt;
    return R_OK;
}

void policy_view(const State *s, Policy *inForce, Policy *pending, uint64_t *pendingAt) {
    *inForce = current(s);
    memset(pending, 0, sizeof(Policy));
    *pendingAt = 0;
    if (s->pendingPolicyAt > s->now) {
        *pending = s->pendingPolicy;
        *pendingAt = s->pendingPolicyAt;
    }
}

uint64_t budget_available(const State *s) {
    uint64_t daily = current(s).daily;
    uint64_t u = budget_used(s, daily);
    return u >= daily ? 0 : daily - u;
}
