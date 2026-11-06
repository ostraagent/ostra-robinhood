/*
 * Random testing of PROPERTIES.md on the model, before any of them goes to Aristotle: millions of random operations
 * from model_init, each property checked where it applies. A counterexample here means the statement is wrong (or the
 * model is), and saves a proof run. Passing proves nothing; the proofs are Aristotle's.
 *
 * Usage: props_check [sequences] [steps] [seed]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../model/ostra_v5_model.h"

static uint64_t rng;
static uint64_t next64(void) {
    rng ^= rng << 13;
    rng ^= rng >> 7;
    rng ^= rng << 17;
    return rng;
}
static uint64_t rnd(uint64_t n) { return n == 0 ? 0 : next64() % n; }

static unsigned long long failures, finished;
/* How many times each check ran (by line), printed with -v: a check that never runs proves nothing. */
static unsigned long long evaluated[1024];
#define CHECK(cond, ...)                                  \
    do {                                                  \
        if (__LINE__ < 1024) evaluated[__LINE__]++;       \
        if (!(cond)) {                                    \
            if (failures < 20) {                          \
                printf("FAIL %s:%d: ", __FILE__, __LINE__); \
                printf(__VA_ARGS__);                      \
                printf("\n");                             \
            }                                             \
            failures++;                                   \
        }                                                 \
    } while (0)

static bool ok(Result r) { return r == R_OK || r == R_OK_EXTERNAL; }

static Policy in_force(const State *s) {
    Policy a, b;
    uint64_t at;
    policy_view(s, &a, &b, &at);
    return a;
}

static bool same_policy(const Policy *a, const Policy *b) {
    return a->actions == b->actions && a->perTx == b->perTx && a->daily == b->daily && a->maxDebt == b->maxDebt
        && a->maxTerm == b->maxTerm && a->maxFeeBps == b->maxFeeBps && a->coverBps == b->coverBps
        && a->repayLead == b->repayLead && a->repayKind == b->repayKind && a->repayVenue == b->repayVenue
        && a->vouchPerAgent == b->vouchPerAgent && a->vouchTotal == b->vouchTotal && a->maxPremiumBps == b->maxPremiumBps;
}

static uint64_t amount(void) {
    switch (rnd(5)) {
        case 0: return 0;
        case 1: return 1 + rnd(1000);
        case 2: return 1 + rnd(1000000);
        case 3: return 1 + rnd(1ull << 40);
        default: return (1ull << 62) + rnd(1ull << 62);
    }
}

static Policy random_policy(const State *s) {
    Policy p;
    if (rnd(3) == 0) {
        p = in_force(s);
        switch (rnd(6)) {
            case 0: p.actions = rnd(2) ? p.actions | (1ull << 3) : p.actions & ~1ull; break;
            case 1: p.perTx = rnd(2) ? p.perTx + 7 : p.perTx / 2; break;
            case 2: p.daily = rnd(2) ? p.daily + 7 : p.daily / 2; break;
            case 3: p.coverBps = (uint16_t)(rnd(2) ? 0 : 5000); break;
            case 4: p.repayLead = (uint32_t)(rnd(2) ? 2 * DAY : 0); break;
            default: p.maxPremiumBps = (uint16_t)(rnd(2) ? 150 : 0); break;
        }
        return p;
    }
    memset(&p, 0, sizeof(p));
    switch (rnd(4)) {
        case 0: p.actions = AGENT_ACTIONS; break;
        case 1: p.actions = next64() & AGENT_ACTIONS; break;
        case 2: p.actions = 1ull | (1ull << 26) | (1ull << 27) | (1ull << 32) | (1ull << 33) | (1ull << 34); break;
        default: p.actions = next64() & ((1ull << 47) - 1); break;
    }
    if (rnd(2)) {
        p.perTx = 50 + rnd(100);
        p.daily = 100 + rnd(300);
    } else {
        p.perTx = amount();
        p.daily = amount();
    }
    p.maxDebt = amount();
    p.maxTerm = (uint32_t)rnd(400 * DAY);
    p.maxFeeBps = (uint16_t)rnd(11000);
    p.coverBps = (uint16_t)(rnd(4) == 0 ? rnd(11000) : 0);
    p.repayLead = (uint32_t)rnd(8 * DAY);
    uint64_t k = rnd(8);
    p.repayKind = (uint8_t)(k < 5 ? 0 : k == 5 ? 1 : k == 6 ? 3 : 2);
    p.repayVenue = (uint32_t)(rnd(6) == 0 ? (p.repayKind == 0 ? 1 : 0) : p.repayKind == 0 ? 0 : 1 + rnd(5));
    p.vouchPerAgent = amount();
    p.vouchTotal = amount();
    p.maxPremiumBps = (uint16_t)rnd(250);
    return p;
}

static OrderParams random_order(void) {
    OrderParams o;
    memset(&o, 0, sizeof(o));
    uint64_t r = rnd(10);
    o.kind = (uint8_t)(r < 6 ? ORDER_PAY : r < 8 ? ORDER_SWEEP : r == 8 ? ORDER_REFILL : rnd(2) * 4);
    if (o.kind == ORDER_SWEEP) o.venueKind = (uint8_t)(rnd(10) == 0 ? 4 : 1 + rnd(3));
    else if (o.kind == ORDER_REFILL) o.venueKind = (uint8_t)(rnd(10) == 0 ? 2 : rnd(2) ? 1 : 3);
    else o.venueKind = (uint8_t)(rnd(10) == 0 ? 1 : 0);
    uint32_t t = (uint32_t)rnd(8);
    o.target = t == VALUE_WIDE ? 1 : t;
    o.amount = rnd(8) == 0 ? 0 : 1 + rnd(200);
    static const uint64_t th[4] = {0, 500, 5000, 100000};
    o.threshold = o.kind == ORDER_PAY ? (rnd(10) == 0 ? 1 : 0) : th[rnd(4)];
    static const uint32_t iv[5] = {1800, 3600, 7200, 86400, 400 * 86400};
    o.interval = iv[rnd(5)];
    static const uint32_t runs[4] = {0, 1, 2, 5};
    o.runs = o.kind == ORDER_PAY ? runs[rnd(10) == 0 ? 0 : 1 + rnd(3)] : runs[rnd(10) == 0 ? 1 : 0];
    return o;
}

/* Ghost state for the properties over sequences. */
typedef struct {
    uint32_t setRuns[MAX_ORDERS + 1];
    uint32_t ran[MAX_ORDERS + 1];
    bool deadGen[MAX_ORDERS + 1]; /* set by the agent key, whose generation has changed since */
    bool cancelled[7][NUM_VALUES]; /* had from > t at a cancel, not set again since */
    /* budget window */
    bool windowOpen;
    Policy windowPolicy;
    uint64_t windowStart, windowSum, windowLast;
} Ghost;

static void one_sequence(uint64_t steps) {
    State s;
    Ghost g;
    memset(&g, 0, sizeof(g));
    uint64_t roots = 1;
    /* A new vault, or one upgraded with its lock on and perhaps a recovery under way. */
    bool upLocked = rnd(4) == 0;
    bool upRecovering = rnd(8) == 0;
    uint64_t start = 1700000000ull + rnd(100000);
    uint64_t recoveryRoot = upRecovering ? roots + 1 : 0;
    if (upRecovering) roots++;
    model_init(&s, start, 1, 1000000 + rnd(100000), (uint32_t)rnd(2), upLocked, (uint32_t)(MIN_LOCK_DELAY + rnd(3) * DAY),
               upRecovering, recoveryRoot, start + rnd(3 * DAY));
    for (uint64_t i = 0; i < steps; i++) {
        State s0 = s;
        Policy before = in_force(&s0);
        Result r = R_OK;
        uint64_t moved = 0;
        int op = (int)rnd(106);
        uint64_t nextOwner;
        uint64_t q = rnd(40);
        nextOwner = q == 0 ? 0 : (q == 1 && s.agentRoot != 0) ? s.agentRoot : ++roots;
        V5Call c;
        memset(&c, 0, sizeof(c));
        AgentCall a;
        memset(&a, 0, sizeof(a));
        int kind = 0;
        uint64_t orderId = 0;
        if (op < 12) {
            static const uint64_t dts[9] = {0, 1, 3540, 3600, 21600, 86400, 129600, 259200, 1296000};
            r = model_warp(&s, dts[rnd(9)]);
            kind = 1;
        } else if (op < 22) {
            c.action = ACTION_SET_POLICY;
            c.policy = random_policy(&s);
            r = owner_spend_v5(&s, nextOwner, &c);
            kind = 2;
        } else if (op < 34) {
            c.action = ACTION_SET_ALLOW;
            c.allowKind = (uint8_t)rnd(7);
            c.allowValue = (uint32_t)rnd(8);
            c.allowOn = rnd(5) != 0;
            r = owner_spend_v5(&s, nextOwner, &c);
            kind = 3;
        } else if (op < 42) {
            c.action = ACTION_SET_AGENT_KEY;
            uint64_t w = rnd(20);
            c.root = w == 0 ? 0 : w == 1 ? nextOwner : ++roots;
            static const uint64_t lives[8] = {0, 3600, 3 * DAY, 30 * DAY, 89 * DAY, 90 * DAY, 90 * DAY + 1, 100 * DAY};
            c.expiry = s.now + lives[rnd(8)] + (s.locked && rnd(2) ? s.lockDelay : 0);
            r = owner_spend_v5(&s, nextOwner, &c);
            kind = 4;
        } else if (op < 44) {
            c.action = ACTION_REVOKE_AGENT_KEY;
            r = owner_spend_v5(&s, nextOwner, &c);
            kind = 14;
        } else if (op < 52) {
            c.action = ACTION_SET_ORDER;
            c.order = random_order();
            c.order.endAt = rnd(5) < 3 ? 0 : rnd(2) ? s.now : s.now + 1 + rnd(10 * DAY);
            r = owner_spend_v5(&s, nextOwner, &c);
            kind = 5;
        } else if (op < 55) {
            c.action = ACTION_CANCEL_ORDER;
            c.orderId = rnd(s.orderCount + 2);
            r = owner_spend_v5(&s, nextOwner, &c);
        } else if (op < 58) {
            static const uint32_t delays[5] = {129600, 3 * 86400, 14 * 86400, 14 * 86400 + 1, 3600};
            r = s.locked ? R_MODEL_LIMIT : owner_spend_lock_on(&s, nextOwner, delays[rnd(5)]);
            kind = 6;
        } else if (op < 61) {
            r = owner_spend_cancel_pending(&s, nextOwner);
            kind = 7;
        } else if (op < 85) {
            uint64_t sg = rnd(10);
            uint64_t signer = sg < 8 ? s.agentRoot : sg < 9 ? s.keyRoot : 1 + rnd(roots);
            uint64_t w = rnd(20);
            uint64_t nextAgent = w == 0 ? signer : w == 1 ? s.keyRoot : w == 2 ? 0 : ++roots;
            uint64_t pick = rnd(20);
            if (pick < 12) {
                a.action = ACTION_TRANSFER;
                uint32_t v = (uint32_t)rnd(12);
                a.to = v > 5 ? (v == 11 ? ADDR_SELF : v == 10 ? 0 : 1) : v;
                Policy p = in_force(&s);
                uint64_t m = rnd(6);
                a.amount = m == 0 ? 0 : m == 1 ? (p.perTx < (1ull << 63) ? p.perTx + 1 : p.perTx) : m == 2 ? p.perTx
                         : 1 + rnd(p.perTx == 0 ? 1000 : p.perTx);
            } else if (pick < 14) {
                a.action = ACTION_SET_ORDER;
                a.v5.action = ACTION_SET_ORDER;
                a.v5.order = random_order();
            } else if (pick < 16) {
                a.action = ACTION_CANCEL_ORDER;
                a.v5.action = ACTION_CANCEL_ORDER;
                a.v5.orderId = rnd(s.orderCount + 2);
            } else if (pick < 17) {
                a.action = ACTION_REVOKE_AGENT_KEY;
                a.v5.action = ACTION_REVOKE_AGENT_KEY;
            } else {
                /* Any action, its parameters random: the policy and the allowlist must still hold it. */
                a.action = (uint8_t)rnd(64);
                a.to = (uint32_t)rnd(8);
                a.value = (uint32_t)rnd(8);
                a.amount = rnd(2) ? 1 + rnd(200) : 0;
                a.counted = rnd(2) ? 1 + rnd(200) : 0;
                a.frozen = rnd(2);
                a.v5.action = a.action;
                if (a.action == ACTION_SET_ORDER) a.v5.order = random_order();
            }
            r = agent_spend(&s, signer, nextAgent, &a);
            kind = 8;
            if (ok(r)) {
                /* 1 */
                CHECK(!s0.recovering && s0.agentRoot != 0 && s0.agentFrom <= s0.now && s0.now < s0.agentExpiry
                          && signer == s0.agentRoot,
                      "P1 key");
                Policy pf = before;
                CHECK(a.action < 64 && ((AGENT_ACTIONS >> a.action) & 1) && ((pf.actions >> a.action) & 1), "P1 bit");
                /* 2 */
                static const int forbidden[] = {2, 4, 6, 7, 8, 9, 12, 13, 14, 15, 16, 23, 24, 25, 29, 30, 31, 39, 40, 45};
                for (size_t k = 0; k < sizeof(forbidden) / sizeof(forbidden[0]); k++) {
                    CHECK(a.action != forbidden[k], "P2 %d", forbidden[k]);
                }
                CHECK(a.action < 47, "P2 high");
                /* 3 */
                if (a.action == ACTION_REVOKE_AGENT_KEY) {
                    CHECK(s.agentRoot == 0 && s.agentNonce == s0.agentNonce + 2, "P3 revoke");
                } else {
                    CHECK(s.agentRoot == nextAgent && s.agentNonce == s0.agentNonce + 1, "P3 root");
                }
                CHECK(nextAgent != s0.agentRoot && nextAgent != s.keyRoot, "P3 next");
                /* 8, 9 */
                if (a.action == ACTION_TRANSFER && a.to != ADDR_SELF) {
                    CHECK(s.balance == s0.balance - a.amount, "P8 balance");
                }
                {
                    uint64_t c = 0;
                    if (a.action == ACTION_TRANSFER || a.action == ACTION_OPEN_CHANNEL || a.action == ACTION_SWAP
                        || a.action == ACTION_REPAY) {
                        c = a.amount;
                    } else if (a.action == ACTION_PRIORS_BORROW || a.action == ACTION_ROOT_SPONSOR
                               || a.action == ACTION_ROOT_VOUCH) {
                        c = a.counted;
                    }
                    CHECK(budget_used(&s, pf.daily) == budget_used(&s0, pf.daily) + c, "P9 counted");
                    CHECK(c <= pf.perTx, "P9 perTx");
                }
                /* 14 */
                if (a.action == ACTION_CANCEL_ORDER) {
                    CHECK(a.v5.orderId != 0 && s.orderEpoch == s0.orderEpoch, "P14 epoch");
                    for (uint64_t id = 1; id <= MAX_ORDERS; id++) {
                        if (s0.orders[id].kind != 0 && s0.orders[id].agentGen == 0) {
                            CHECK(memcmp(&s.orders[id], &s0.orders[id], sizeof(Order)) == 0, "P14 owner order");
                        }
                    }
                }
            }
        } else if (op < 95) {
            uint64_t count = s.orderCount;
            orderId = rnd(count + 2);
            if (rnd(4) != 0) {
                for (uint64_t k = 1; k <= count; k++) {
                    if (order_live(&s, k)) {
                        orderId = k;
                        if (rnd(2)) break;
                    }
                }
            }
            r = run_order(&s, orderId, &moved);
            kind = 9;
            if (ok(r)) {
                const Order *o = &s0.orders[orderId];
                /* 10 */
                CHECK(o->kind != 0 && o->epoch == s0.orderEpoch && (o->endAt == 0 || s0.now < o->endAt), "P10 live");
                CHECK(o->agentGen == 0 || (o->agentGen == s0.agentGen && agent_in_force(&s0)), "P10 setter");
                CHECK(o->lastRun == 0 || s0.now >= o->lastRun + o->interval, "P10 interval");
                CHECK(s.orders[orderId].lastRun == s0.now || s.orders[orderId].kind == 0, "P10 lastRun");
                /* 11 */
                if (o->kind == ORDER_PAY) {
                    g.ran[orderId]++;
                    CHECK(g.ran[orderId] <= g.setRuns[orderId], "P11 runs");
                }
                /* 12 */
                CHECK(moved <= o->amount, "P12 amount");
                if (o->kind == ORDER_SWEEP) CHECK(s0.balance - moved >= o->threshold, "P12 sweep");
                if (o->kind == ORDER_REFILL) CHECK(s0.balance + moved <= o->threshold, "P12 refill");
                /* 13 */
                CHECK(!g.deadGen[orderId], "P13 dead generation");
                /* 8, 9 */
                if (o->kind == ORDER_PAY) {
                    CHECK(s.balance == s0.balance - o->amount && moved == o->amount, "P8 pay");
                    CHECK(budget_used(&s, before.daily) == budget_used(&s0, before.daily) + o->amount, "P8 pay counted");
                } else if (o->kind == ORDER_REFILL) {
                    CHECK(s.balance == s0.balance, "P9 refill");
                }
            }
        } else if (op < 97) {
            bool auth = rnd(4) != 0;
            r = guard_stop(&s, auth);
            kind = 10;
        } else if (op < 98) {
            r = guard_cancel(&s, rnd(4) != 0);
            kind = 11;
        } else if (op < 101) {
            r = recovery_support(&s, rnd(20) == 0 ? 0 : ++roots, (uint32_t)(MIN_RECOVERY_DELAY + rnd(2) * DAY));
            kind = 12;
        } else {
            /* Rarer things: a recovery that finishes, code outside version 5. */
            uint64_t e = rnd(7);
            if (e == 0) {
                r = finish_recovery(&s);
                if (ok(r)) finished++;
            }
            else if (e == 1) r = env_set_balance(&s, rnd(3) == 0 ? rnd(10000) : rnd(2000000));
            else if (e == 2) r = env_priors_consent(&s);
            else if (e == 3) r = env_lock(&s, rnd(2), (uint32_t)(MIN_LOCK_DELAY + rnd(3) * DAY));
            else if (e == 4) r = env_set_linked(&s, (uint32_t)rnd(6));
            else if (e == 5) r = owner_spend_other(&s, nextOwner, s.balance > 10 ? s.balance - rnd(10) : s.balance);
            else r = owner_spend_priors_consent(&s, nextOwner, rnd(5) != 0, (uint32_t)rnd(8), rnd(250),
                                                s.now + (s.locked ? s.lockDelay : 0) + rnd(32 * DAY));
            kind = 13;
        }

        /* Failure leaves the state as it was. */
        if (!ok(r)) CHECK(memcmp(&s, &s0, sizeof(State)) == 0, "revert changed the state (op %d r %d)", op, r);

        /* 4 */
        CHECK(s.agentRoot == 0 || s.agentRoot != s.keyRoot, "P4");
        /* 5 */
        if (ok(r) && (kind == 6 || kind == 10 || (kind == 12 && !s0.recovering))) {
            CHECK(s.agentRoot == 0, "P5 root");
            if (kind != 6) {
                for (uint64_t id = 1; id <= MAX_ORDERS; id++) CHECK(!order_live(&s, id), "P5 orders");
            }
        }
        if (s0.recovering) {
            if (kind == 8 || kind == 9) CHECK(!ok(r), "P5 recovering");
            if (s0.locked && (kind == 4 || kind == 5)) CHECK(!ok(r), "P5 recovering locked");
        }
        /* 9: only these lower the balance */
        /* 13: the generation never goes down; the ends of the agent key raise it */
        CHECK(s.agentGen >= s0.agentGen, "P13 lowered");
        if (ok(r) && (kind == 6 || kind == 10 || (kind == 12 && !s0.recovering))) CHECK(s.agentGen > s0.agentGen, "P13 end");
        if (ok(r) && (kind == 4 || kind == 14)) CHECK(s.agentGen > s0.agentGen, "P13 new key or revoke");
        if (ok(r) && kind == 8 && a.action == ACTION_REVOKE_AGENT_KEY) CHECK(s.agentGen > s0.agentGen, "P13 agent revoke");

        /* 11: a new PAY order */
        if (ok(r) && s.orderCount > s0.orderCount) {
            const Order *n = &s.orders[s.orderCount];
            g.setRuns[s.orderCount] = n->runsLeft;
            g.ran[s.orderCount] = 0;
        }
        /* 13 */
        if (s.agentGen != s0.agentGen) {
            for (uint64_t id = 1; id <= MAX_ORDERS; id++) {
                if (s.orders[id].kind != 0 && s.orders[id].agentGen != 0) g.deadGen[id] = true;
            }
        }
        if (ok(r) && s.orderCount > s0.orderCount) g.deadGen[s.orderCount] = false;

        /* 15, 16, 17, 19 */
        Policy after = in_force(&s);
        if (s0.locked && kind != 1 && !same_policy(&after, &before)) CHECK(policy_tighter(&after, &before), "P16");
        if (s0.locked && ok(r) && kind == 2) {
            if (same_policy(&after, &c.policy)) CHECK(policy_tighter(&c.policy, &before), "P15 tighter");
            else CHECK(same_policy(&after, &before) && same_policy(&s.pendingPolicy, &c.policy)
                           && s.pendingPolicyAt == s0.now + s0.lockDelay, "P15 waits");
        }
        if (s0.locked && ok(r) && kind == 3 && c.allowOn) {
            CHECK(s.allows[c.allowKind][c.allowValue].from == s0.now + s0.lockDelay, "P17 allow");
        }
        if (s0.locked && ok(r) && kind == 4) CHECK(s.agentFrom == s0.now + s0.lockDelay, "P17 key");
        if (s0.recovering && s0.locked && kind == 2 && !policy_tighter(&c.policy, &before)) CHECK(!ok(r), "P19 policy");
        if (s0.recovering && s0.locked && kind == 3 && c.allowOn) CHECK(!ok(r), "P19 allow");

        /* 17, 18 */
        for (uint8_t k = 1; k <= ALLOW_BORROWER; k++) {
            for (uint32_t v = 0; v < NUM_VALUES; v++) {
                if (allowed(&s, k, v)) CHECK(s.now >= s.allows[k][v].from, "P17 from");
                if (ok(r) && kind == 3 && c.allowOn && c.allowKind == k && c.allowValue == v) g.cancelled[k][v] = false;
                if (g.cancelled[k][v]) CHECK(!allowed(&s, k, v), "P18 kind %u value %u", k, v);
                if (ok(r) && (kind == 7 || kind == 11) && s0.allows[k][v].from > s0.now) g.cancelled[k][v] = true;
            }
        }

        /* 7: the window, over the counts of agent transfers and PAY runs under one policy */
        if (ok(r) && (kind == 8 || kind == 9) && (s.budgetAt != s0.budgetAt || s.budgetUsed != s0.budgetUsed)) {
            Policy p = s.policy;
            State s0n = s0;
            s0n.now = s.now;
            uint64_t a_i = s.budgetUsed - budget_used(&s0n, p.daily);
            if (!g.windowOpen || !same_policy(&p, &g.windowPolicy)) {
                g.windowOpen = true;
                g.windowPolicy = p;
                g.windowStart = s.now;
                g.windowSum = 0;
            }
            g.windowSum += a_i;
            g.windowLast = s.now;
            unsigned __int128 lhs = (unsigned __int128)86400 * g.windowSum;
            unsigned __int128 rhs = (unsigned __int128)86400 * p.daily + (unsigned __int128)p.daily * (s.now - g.windowStart);
            CHECK(lhs <= rhs, "P7 window");
        }
        if (s.budgetUsed != s0.budgetUsed || s.budgetAt != s0.budgetAt) {
            if (!(ok(r) && (kind == 8 || kind == 9))) g.windowOpen = false;
        }
        /* 6 */
        if (rnd(50) == 0) {
            State t = s;
            Policy p = in_force(&s);
            uint64_t am = rnd(2) ? 1 + rnd(p.perTx + 1) : amount();
            uint64_t u = budget_used(&t, p.daily);
            if (budget_count(&t, &p, am) == R_OK && am > 0) {
                CHECK(am <= p.perTx && t.budgetUsed == u + am && t.budgetUsed <= p.daily && t.budgetAt == t.now, "P6");
            }
        }
    }
}

int main(int argc, char **argv) {
    uint64_t sequences = argc > 1 ? strtoull(argv[1], 0, 10) : 20000;
    uint64_t steps = argc > 2 ? strtoull(argv[2], 0, 10) : 60;
    rng = argc > 3 ? strtoull(argv[3], 0, 10) : 0x9e3779b97f4a7c15ull;
    for (uint64_t i = 0; i < sequences; i++) one_sequence(steps);
    if (getenv("PROPS_VERBOSE") != NULL) {
        for (int l = 0; l < 1024; l++) {
            if (evaluated[l] != 0) printf("line %d: %llu\n", l, evaluated[l]);
        }
    }
    printf("recoveries finished: %llu\n", finished);
    printf("%s: %llu sequences of %llu steps, %llu failures\n", failures ? "FAILED" : "PASSED",
           (unsigned long long)sequences, (unsigned long long)steps, failures);
    return failures ? 1 : 0;
}
