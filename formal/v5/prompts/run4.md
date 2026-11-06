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

Prove each of the following properties (changes under the withdrawal lock), or give a counterexample:

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
