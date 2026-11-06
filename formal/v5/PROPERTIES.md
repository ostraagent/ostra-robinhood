# Properties of the version 5 model

These are the properties sent to Aristotle about the C model in `model/` (`ostra_v5_model.h` and `ostra_v5_model.c`).
Each run sends the folder `model/` and one group below as its prompt. The statements name the model's functions and
fields, so that a verdict reads directly against the code.

Terms used throughout:

- **Success.** An operation succeeds when it returns `R_OK`, or `R_OK_EXTERNAL` (every version 5 check passed and the
  rest is code the model leaves out). On any other result the state is unchanged.
- **Operations.** The public functions that change a `State`: `model_warp`, `owner_spend_v5`, `owner_spend_lock_on`,
  `owner_spend_cancel_pending`, `owner_spend_other`, `owner_spend_priors_consent`, `agent_spend`, `run_order`,
  `guard_stop`, `guard_cancel`, `recovery_support`, `finish_recovery`, and the `env_` functions (`env_set_balance`, `env_priors_consent`, `env_lock`,
  `env_set_linked`), which stand for what code outside version 5 does to the state the model has.
- **Reachable.** A state reached from `model_init(s, now, keyRoot, ...)` (any arguments, with `keyRoot != 0` and
  `now < 2^62`) by any finite sequence of operations with any arguments. (`model_warp` keeps `now` below `2^62`.)
  **Every property below is about reachable states:** each state it names (`s`, `s0`, the state an operation starts
  from) is reachable, and each operation it names is called on such a state.
- **Locked.** `s.locked` is the withdrawal lock in force: a change of the lock that waits (version 3) counts only once
  it applies, which `env_lock` stands for.
- **Policy in force** in a state `s`: `s.pendingPolicy` if `s.pendingPolicyAt != 0 && s.now >= s.pendingPolicyAt`,
  otherwise `s.policy` (the first output of `policy_view`).

## Run 1: the agent key's authority

1. **What an agent spend needs.** If `agent_spend(s, signer, next, call)` succeeds from state `s0`, then in `s0`:
   `s0.recovering` is false; `s0.agentRoot != 0`; `s0.agentFrom <= s0.now < s0.agentExpiry`; `signer == s0.agentRoot`;
   `call->action < 64`; and bit `call->action` is set in both `AGENT_ACTIONS` and the `actions` of the policy in force
   in `s0`.
2. **Never the guardians, the lock, the policy or the allowlist.** No successful `agent_spend` has `call->action` in
   {2, 4, 6, 7, 8, 9, 12, 13, 14, 15, 16, 23, 24, 25, 29, 30, 31, 39, 40, 45}, nor any action of 47 or more.
3. **A one-time key signs once.** If `agent_spend(s, signer, next, call)` succeeds from `s0` to `s1`, then
   `next != s0.agentRoot` and `next != s1.keyRoot`; and `s1.agentRoot == next` with
   `s1.agentNonce == s0.agentNonce + 1`, except for `call->action == ACTION_REVOKE_AGENT_KEY`, after which
   `s1.agentRoot == 0` and `s1.agentNonce == s0.agentNonce + 2`.
4. **No root is both keys.** In every reachable state, `agentRoot == 0 || agentRoot != keyRoot`.
5. **The ends of the agent key.** After a successful `owner_spend_lock_on` or `guard_stop`, and after a successful
   `recovery_support` from a state with `recovering` false, `agentRoot == 0`; after such a `guard_stop` or
   `recovery_support`,
   `order_live(s, id)` is false for every `id`. While `s.recovering` is true, `agent_spend` and `run_order` fail; while
   `s.recovering && s.locked`, so does `owner_spend_v5` with action `ACTION_SET_AGENT_KEY` or `ACTION_SET_ORDER` (with
   the lock off, an owner spend ends the recovery first).

## Run 2: the budget

6. **Per spend.** If `budget_count(s, p, amount)` returns `R_OK` with `amount > 0`, then `amount <= p->perTx`, and
   afterwards `s.budgetUsed == u + amount <= p->daily` and `s.budgetAt == s.now`, where `u` is
   `budget_used(s0, p->daily)` in the state before.
7. **Over time.** Take a reachable state and a sequence of calls `budget_count(s, p, a_i)`, `i = 1..m`, with the same
   policy `p` (so the same `daily = D`), each returning `R_OK` with `a_i > 0`, at times `t_1 <= ... <= t_m` (only
   `model_warp` in between, or operations that do not change `budgetUsed` or `budgetAt`). Then
   `86400 * (a_1 + ... + a_m) <= 86400 * D + D * (t_m - t_1)`, as mathematical integers. In particular, while the
   policy stays the same, no 24 hours see more than `2 * D` counted (what the agent key's spends and the PAY runs count;
   9 says which spends count what).
8. **What is counted is what moves.** A successful `agent_spend` from `s0` to `s1` with action `ACTION_TRANSFER` to
   `to != ADDR_SELF` lowers `balance` by exactly `call->amount`, and `budget_used(s1, d) == budget_used(s0, d) +
   call->amount`, where `d` is the `daily` of the policy in force in `s0`. A successful `run_order` of a PAY order lowers
   `balance` by exactly the order's `amount`, raises the budget used in the same way by that amount, and sets `*moved`
   to it.
9. **What an agent spend counts.** A successful `agent_spend` from `s0` to `s1` gives
   `budget_used(s1, d) == budget_used(s0, d) + c`, where `d` is the `daily` of the policy in force in `s0` and `c` is
   `call->amount` for `ACTION_TRANSFER`, `ACTION_OPEN_CHANNEL`, `ACTION_SWAP` and `ACTION_REPAY`, `call->counted` for
   `ACTION_PRIORS_BORROW`, `ACTION_ROOT_SPONSOR` and `ACTION_ROOT_VOUCH`, and 0 for every other action; and `c` is at
   most the `perTx` of that policy.

## Run 3: standing orders

10. **When an order runs.** If `run_order(s, id, &moved)` succeeds from `s0`, then in `s0` order `id` has `kind != 0`,
    `epoch == s0.orderEpoch`, `endAt == 0 || s0.now < endAt`, `agentGen == 0` or (`agentGen == s0.agentGen` and the
    agent key in force), and `lastRun == 0 || s0.now >= lastRun + interval`; afterwards its `lastRun` is `s0.now`
    (or the order is gone, for the last run of a PAY order).
11. **Runs of a PAY order.** A PAY order set with `runs = r` (by either key) runs successfully at most `r` times.
12. **How much a run moves.** If `run_order` succeeds, `moved <= ` the order's `amount`; for a SWEEP order the balance
    before the run less `moved` is at least the order's `threshold`; for a REFILL order the balance before the run plus
    `moved` is at most the order's `threshold`.
13. **Orders the agent key set.** No operation lowers `s.agentGen`, and every successful `owner_spend_v5` with
    `ACTION_SET_AGENT_KEY` or `ACTION_REVOKE_AGENT_KEY`, `agent_spend` with `ACTION_REVOKE_AGENT_KEY`,
    `owner_spend_lock_on`, `guard_stop`, and `recovery_support` from a state with `recovering` false raises it. So an
    order with `agentGen != 0` never runs successfully once, after it was set, any of these succeeded.
14. **The agent key cancels only its own.** A successful `agent_spend` with action `ACTION_CANCEL_ORDER` and order id
    `id` has `id != 0`, does not change `orderEpoch`, and leaves every order with `agentGen == 0` as it was.

## Run 4: changes under the withdrawal lock

15. **Loosening waits.** If `s.locked`, a successful `owner_spend_v5` with action `ACTION_SET_POLICY` and policy `n`
    either makes `n` the policy in force with `policy_tighter(n, old)` true (where `old` is the policy in force before),
    or leaves the policy in force unchanged and sets `pendingPolicy == n` and `pendingPolicyAt == s.now + s.lockDelay`.
16. **The policy in force only tightens at once.** In any reachable state with `locked` true, for any operation other
    than `model_warp`, if the policy in force afterwards differs from the policy in force before, then it is tighter
    (`policy_tighter(after, before)`).
17. **Allowlist entries and agent keys wait.** If `s.locked`, a successful `owner_spend_v5` that adds an allowlist entry
    sets its `from` to `s.now + s.lockDelay`, and one with `ACTION_SET_AGENT_KEY` sets `agentFrom` to
    `s.now + s.lockDelay`. `allowed(s, kind, value)` is false whenever `s.now < s.allows[kind][value].from`.
18. **A cancel ends what waits, for good.** After a successful `guard_cancel` or `owner_spend_cancel_pending` at time
    `t`, every allowlist entry whose `from` was greater than `t` is never `allowed` again (at any later time, after any
    operations) unless it is set again by a successful `owner_spend_v5` with action `ACTION_SET_ALLOW`.
19. **Nothing new waits during a recovery under the lock.** If `s.recovering && s.locked`, `owner_spend_v5` with action
    `ACTION_SET_POLICY` and a policy that is not `policy_tighter` than the one in force fails, and so does one with
    action `ACTION_SET_ALLOW` that adds an entry (`allowOn` true).
