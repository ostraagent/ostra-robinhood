/*
 * Replays a trace recorded against the real contracts (test/formal/V5ModelDiff.fork.t.sol) on the C model, and checks
 * that every step has the same outcome and leaves the same state as seen through the vault's views.
 *
 * Usage: replay 0x<part> [0x<part> ...]: the trace, in hex, in as many parts as it takes (one argument has a limit).
 * The trace is a list of big-endian 64-bit words:
 *   header:  5, now, keyRoot, nonce, balance, linkedVault
 *   a step:  op, nargs, args..., outcome, moved, nsnap, snapshot...
 *            (moved: what a successful run order moved; for one that failed, 1 when the vault held nothing in the
 *            order's venue; else 0)
 * Prints "OK <steps>" when everything matches, otherwise "MISMATCH ..." and the first difference. With
 * OSTRA_MODEL_STATS set to a file, appends a line "<op> <outcome>" for every step there (what the runs covered); a
 * run order's op is written 60 + the order's kind (63 PAY, 61 SWEEP, 62 REFILL, 60 no order), and a line "S" ends
 * each trace that matched.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../model/ostra_v5_model.h"

#define OP_WARP 1
#define OP_OWNER_V5 2
#define OP_OWNER_LOCK_ON 3
#define OP_OWNER_CANCEL_PENDING 4
#define OP_AGENT 5
#define OP_RUN_ORDER 6
#define OP_GUARD_STOP 7
#define OP_GUARD_CANCEL 8
#define OP_RECOVERY 9
#define OP_FINISH_RECOVERY 10
#define OP_DEPOSIT 11
#define OP_OWNER_OTHER 12
#define OP_OWNER_CONSENT 13

/* The real call reverted with an error the trace does not name (a token's, a venue's). */
#define OUTCOME_OTHER 9999

#define MAX_WORDS 200000
#define MAX_SNAP 2048
#define SNAP_BALANCE 1

static uint64_t words[MAX_WORDS];
static size_t nwords, pos;

static int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static int parse(const char *hex) {
    if (hex[0] == '0' && (hex[1] == 'x' || hex[1] == 'X')) hex += 2;
    size_t n = strlen(hex);
    if (n % 16 != 0 || nwords + n / 16 > MAX_WORDS) return 0;
    for (size_t i = 0; i < n / 16; i++) {
        uint64_t w = 0;
        for (size_t k = 0; k < 16; k++) {
            int v = hexval(hex[i * 16 + k]);
            if (v < 0) return 0;
            w = (w << 4) | (uint64_t)v;
        }
        words[nwords++] = w;
    }
    return 1;
}

static int take(uint64_t *w) {
    if (pos >= nwords) return 0;
    *w = words[pos++];
    return 1;
}

static void put_policy(uint64_t *out, size_t *n, const Policy *p) {
    out[(*n)++] = p->actions;
    out[(*n)++] = p->perTx;
    out[(*n)++] = p->daily;
    out[(*n)++] = p->maxDebt;
    out[(*n)++] = p->maxTerm;
    out[(*n)++] = p->maxFeeBps;
    out[(*n)++] = p->coverBps;
    out[(*n)++] = p->repayLead;
    out[(*n)++] = p->repayKind;
    out[(*n)++] = p->repayVenue;
    out[(*n)++] = p->vouchPerAgent;
    out[(*n)++] = p->vouchTotal;
    out[(*n)++] = p->maxPremiumBps;
}

/* The state as the vault's views show it, in the order the test records it. */
static size_t snapshot(const State *s, uint64_t *out) {
    size_t n = 0;
    Policy inForce, pending;
    uint64_t pendingAt;
    out[n++] = s->now;
    out[n++] = s->balance; /* SNAP_BALANCE */
    out[n++] = s->nonce;
    out[n++] = s->keyRoot;
    out[n++] = s->agentRoot;
    out[n++] = s->agentNonce;
    out[n++] = s->agentFrom;
    out[n++] = s->agentExpiry;
    out[n++] = agent_in_force(s) ? 1 : 0;
    policy_view(s, &inForce, &pending, &pendingAt);
    put_policy(out, &n, &inForce);
    put_policy(out, &n, &pending);
    out[n++] = pendingAt;
    out[n++] = budget_available(s);
    out[n++] = s->orderCount;
    for (uint64_t id = 1; id <= s->orderCount && id <= MAX_ORDERS; id++) {
        const Order *o = &s->orders[id];
        out[n++] = o->kind;
        out[n++] = o->venueKind;
        out[n++] = o->interval;
        out[n++] = o->runsLeft;
        out[n++] = o->lastRun;
        out[n++] = o->endAt;
        out[n++] = o->epoch;
        out[n++] = o->target;
        out[n++] = o->agentGen;
        out[n++] = o->amount;
        out[n++] = o->threshold;
        out[n++] = order_live(s, id) ? 1 : 0;
    }
    for (uint8_t kind = 1; kind <= ALLOW_BORROWER; kind++) {
        for (uint32_t v = 1; v < NUM_VALUES; v++) {
            out[n++] = allowed(s, kind, v) ? 1 : 0;
            out[n++] = s->allows[kind][v].from;
        }
    }
    out[n++] = s->locked ? 1 : 0;
    /* Storage the views do not show (read from the vault's ERC-7201 slot by the test). */
    out[n++] = s->budgetUsed;
    out[n++] = s->budgetAt;
    out[n++] = s->orderEpoch;
    out[n++] = s->agentGen;
    out[n++] = s->epoch;
    out[n++] = s->waitingUntil;
    out[n++] = s->pendingConsentAt;
    for (uint8_t kind = 1; kind <= ALLOW_BORROWER; kind++) {
        for (uint32_t v = 1; v < NUM_VALUES; v++) out[n++] = s->allows[kind][v].epoch;
    }
    /* Version 3: the recovery, the lock's delay, the linked vault. */
    out[n++] = s->recovering ? 1 : 0;
    out[n++] = s->lockDelay;
    out[n++] = s->linkedVault;
    return n;
}

static int read_v5(V5Call *c, uint64_t action, const uint64_t *a, uint64_t na) {
    memset(c, 0, sizeof(*c));
    c->action = (uint8_t)action;
    switch (action) {
        case ACTION_SET_POLICY:
            if (na != 13) return 0;
            c->policy.actions = a[0];
            c->policy.perTx = a[1];
            c->policy.daily = a[2];
            c->policy.maxDebt = a[3];
            c->policy.maxTerm = (uint32_t)a[4];
            c->policy.maxFeeBps = (uint16_t)a[5];
            c->policy.coverBps = (uint16_t)a[6];
            c->policy.repayLead = (uint32_t)a[7];
            c->policy.repayKind = (uint8_t)a[8];
            c->policy.repayVenue = (uint32_t)a[9];
            c->policy.vouchPerAgent = a[10];
            c->policy.vouchTotal = a[11];
            c->policy.maxPremiumBps = (uint16_t)a[12];
            return 1;
        case ACTION_SET_ALLOW:
            if (na != 3) return 0;
            c->allowKind = (uint8_t)a[0];
            c->allowValue = (uint32_t)a[1];
            c->allowOn = a[2] != 0;
            return 1;
        case ACTION_SET_AGENT_KEY:
            if (na != 2) return 0;
            c->root = a[0];
            c->expiry = a[1];
            return 1;
        case ACTION_REVOKE_AGENT_KEY:
            return na == 0;
        case ACTION_SET_ORDER:
            if (na != 8) return 0;
            c->order.kind = (uint8_t)a[0];
            c->order.venueKind = (uint8_t)a[1];
            c->order.target = (uint32_t)a[2];
            c->order.amount = a[3];
            c->order.threshold = a[4];
            c->order.interval = (uint32_t)a[5];
            c->order.runs = (uint32_t)a[6];
            c->order.endAt = a[7];
            return 1;
        case ACTION_CANCEL_ORDER:
            if (na != 1) return 0;
            c->orderId = a[0];
            return 1;
        default:
            return 0;
    }
}

int main(int argc, char **argv) {
    if (argc < 2) {
        printf("MISMATCH no trace");
        return 0;
    }
    for (int i = 1; i < argc; i++) {
        if (!parse(argv[i])) {
            printf("MISMATCH bad trace");
            return 0;
        }
    }
    uint64_t magic, now, keyRoot, nonce, balance, linked;
    if (!take(&magic) || magic != 5 || !take(&now) || !take(&keyRoot) || !take(&nonce) || !take(&balance)
        || !take(&linked)) {
        printf("MISMATCH bad header");
        return 0;
    }
    static State s;
    model_init(&s, now, keyRoot, balance, (uint32_t)linked, false, 0, false, 0, 0);
    /* The owner's spends before version 5 is used (the guardian and the recovery policy). */
    s.nonce = nonce;
    static uint64_t mine[MAX_SNAP];
    size_t steps = 0;
    const char *statsPath = getenv("OSTRA_MODEL_STATS");
    FILE *stats = statsPath != NULL ? fopen(statsPath, "a") : NULL;
    while (pos < nwords) {
        uint64_t op, na, args[32], outcome, theirMoved, nsnap;
        if (!take(&op) || !take(&na) || na > 32) {
            printf("MISMATCH bad step %zu", steps);
            return 0;
        }
        for (uint64_t i = 0; i < na; i++) {
            if (!take(&args[i])) {
                printf("MISMATCH bad step %zu", steps);
                return 0;
            }
        }
        if (!take(&outcome) || !take(&theirMoved) || !take(&nsnap) || nsnap > MAX_SNAP || pos + nsnap > nwords) {
            printf("MISMATCH bad step %zu", steps);
            return 0;
        }
        const uint64_t *theirs = &words[pos];
        pos += nsnap;

        static State before;
        before = s;
        Result r;
        uint64_t moved = 0;
        V5Call v5;
        AgentCall ac;
        switch (op) {
            case OP_WARP:
                r = model_warp(&s, args[0]);
                break;
            case OP_OWNER_V5:
                if (na < 2 || !read_v5(&v5, args[1], &args[2], na - 2)) {
                    printf("MISMATCH bad owner step %zu", steps);
                    return 0;
                }
                r = owner_spend_v5(&s, args[0], &v5);
                break;
            case OP_OWNER_LOCK_ON:
                r = owner_spend_lock_on(&s, args[0], (uint32_t)args[1]);
                break;
            case OP_OWNER_CANCEL_PENDING:
                r = owner_spend_cancel_pending(&s, args[0]);
                break;
            case OP_AGENT:
                memset(&ac, 0, sizeof(ac));
                if (na < 3) {
                    printf("MISMATCH bad agent step %zu", steps);
                    return 0;
                }
                ac.action = (uint8_t)args[2];
                if (ac.action == ACTION_TRANSFER) {
                    if (na != 5) {
                        printf("MISMATCH bad agent step %zu", steps);
                        return 0;
                    }
                    ac.to = (uint32_t)args[3];
                    ac.amount = args[4];
                } else if (na == 8) {
                    ac.to = (uint32_t)args[3];
                    ac.value = (uint32_t)args[4];
                    ac.amount = args[5];
                    ac.counted = args[6];
                    ac.frozen = args[7] != 0;
                } else if (ac.action >= ACTION_REVOKE_AGENT_KEY && ac.action <= ACTION_CANCEL_ORDER) {
                    if (!read_v5(&ac.v5, ac.action, &args[3], na - 3)) {
                        printf("MISMATCH bad agent step %zu", steps);
                        return 0;
                    }
                } else if (na != 3) {
                    printf("MISMATCH bad agent step %zu", steps);
                    return 0;
                }
                r = agent_spend(&s, args[0], args[1], &ac);
                break;
            case OP_RUN_ORDER:
                r = run_order(&s, args[0], &moved);
                break;
            case OP_GUARD_STOP:
                r = guard_stop(&s, args[0] != 0);
                break;
            case OP_GUARD_CANCEL:
                r = guard_cancel(&s, args[0] != 0);
                break;
            case OP_RECOVERY:
                r = recovery_support(&s, args[0], (uint32_t)args[1]);
                break;
            case OP_FINISH_RECOVERY:
                r = finish_recovery(&s);
                break;
            case OP_DEPOSIT:
                r = env_set_balance(&s, args[0]);
                break;
            case OP_OWNER_OTHER:
                r = owner_spend_other(&s, args[0], args[1]);
                break;
            case OP_OWNER_CONSENT:
                r = owner_spend_priors_consent(&s, args[0], args[1] != 0, (uint32_t)args[2], args[3], args[4]);
                break;
            default:
                printf("MISMATCH unknown op %llu at step %zu", (unsigned long long)op, steps);
                return 0;
        }

        if (r == R_MODEL_LIMIT) {
            printf("MISMATCH step %zu op %llu: past a bound of the model", steps, (unsigned long long)op);
            return 0;
        }
        int same;
        if (r == R_OK_EXTERNAL) {
            /* The model checked what version 5 checks; the code after it decided. A REFILL's venue exit (_exitFor)
             * refuses with NothingToDo when the vault holds nothing there (the test marks that with moved 1). */
            bool refill = op == OP_RUN_ORDER && args[0] >= 1 && args[0] <= MAX_ORDERS
                && before.orders[args[0]].kind == ORDER_REFILL && theirMoved == 1;
            /* An agent's Priors spend (35 to 46) runs the Priors code, which reads the pool and may refuse with any of
             * its errors (NotOwnAgent, OutOfPolicy, NotAllowlisted(5) for the sponsor, ...). */
            bool priors = op == OP_AGENT && na >= 3 && args[2] >= ACTION_PRIORS_BORROW && args[2] <= ACTION_LAST
                /* but never one of version 5's own refusals of an agent spend, which come before */
                && outcome != R_LOCKED && outcome != R_NO_AGENT_KEY && outcome != R_WOTS_INVALID
                && outcome != R_OVER_PER_TX && outcome != R_OVER_BUDGET && outcome != R_BAD_ACTION
                && !(outcome >= R_NOT_ALLOWED && outcome < R_NOT_ALLOWLISTED)
                && outcome != R_NOT_ALLOWLISTED + ALLOW_BORROWER;
            same = outcome == R_OK || outcome == OUTCOME_OTHER || (refill && outcome == R_NOTHING_TO_DO) || priors;
            if (outcome != R_OK) {
                s = before;
            } else if (nsnap > SNAP_BALANCE
                       && (op == OP_AGENT || (op == OP_RUN_ORDER && args[0] >= 1 && args[0] <= MAX_ORDERS
                                              && before.orders[args[0]].kind == ORDER_REFILL))) {
                /* What a venue sent back, or the agent spend's own code moved: the contracts' balance (env_set_balance).
                 * A SWEEP's amount stays the model's, compared below. */
                env_set_balance(&s, theirs[SNAP_BALANCE]);
            }
        } else if (r == R_TOKEN) {
            same = outcome == OUTCOME_OTHER;
        } else {
            same = outcome == (uint64_t)r;
        }
        if (!same) {
            printf("MISMATCH step %zu op %llu: contracts %llu, model %d, args", steps, (unsigned long long)op,
                   (unsigned long long)outcome, (int)r);
            for (uint64_t i = 0; i < na; i++) printf(" %llu", (unsigned long long)args[i]);
            return 0;
        }
        if (op == OP_RUN_ORDER && outcome == R_OK && moved != theirMoved) {
            printf("MISMATCH step %zu: the run moved %llu, the model %llu", steps, (unsigned long long)theirMoved,
                   (unsigned long long)moved);
            return 0;
        }
        size_t n = snapshot(&s, mine);
        if (n != nsnap) {
            printf("MISMATCH step %zu op %llu: snapshot length contracts %llu, model %zu", steps,
                   (unsigned long long)op, (unsigned long long)nsnap, n);
            return 0;
        }
        for (size_t i = 0; i < n; i++) {
            if (mine[i] != theirs[i]) {
                printf("MISMATCH step %zu op %llu: snapshot word %zu contracts %llu, model %llu", steps,
                       (unsigned long long)op, i, (unsigned long long)theirs[i], (unsigned long long)mine[i]);
                return 0;
            }
        }
        if (stats != NULL) {
            uint64_t code = op;
            if (op == OP_RUN_ORDER) code = 60 + (args[0] >= 1 && args[0] <= MAX_ORDERS ? before.orders[args[0]].kind : 0);
            fprintf(stats, "%llu %llu\n", (unsigned long long)code, (unsigned long long)outcome);
        }
        steps++;
    }
    if (stats != NULL) {
        fprintf(stats, "S\n");
        fclose(stats);
    }
    printf("OK %zu", steps);
    return 0;
}
