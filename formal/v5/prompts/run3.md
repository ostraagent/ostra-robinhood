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

Prove each of the following properties (standing orders), or give a counterexample:

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
