The folder holds ostra_v5_model.h and ostra_v5_model.c, a reference model in C of the logic that version 5 of the OstraVault smart contract adds: an agent key bounded by a policy, allowlists, a spending budget and standing orders. Verify the C code as it is, with C's own semantics for its uint64_t and smaller unsigned arithmetic. The header comment of ostra_v5_model.h says what the model abstracts.

Terms used below:

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

Prove each of the following properties (the budget), or give a counterexample:

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
