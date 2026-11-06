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

Prove each of the following properties (the agent key's authority), or give a counterexample:

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
