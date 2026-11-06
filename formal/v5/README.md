# Vault version 5: a model for formal proofs

Version 5 of OstraVault lets an agent key spend from a vault within a policy: allowlists, a per-spend bound, a daily
budget, standing orders, and the ways the agent key ends (the owner's revoke, the withdrawal lock, a guardian stop, a
recovery). This folder holds a model of that logic in C, written so that
[Aristotle](https://aristotle.harmonic.fun) can prove properties of it, and the tests that tie the model to the
contracts.

| Path | What it is |
|---|---|
| `model/` | The model: `ostra_v5_model.h` (state, operations, and what is abstract) and `ostra_v5_model.c`. This folder is what goes to Aristotle. |
| `PROPERTIES.md` | The 19 properties, in four groups, one Aristotle run each. |
| `prompts/` | The prompt of each run, made from `PROPERTIES.md`. |
| `diff/replay.c` | Replays on the model a trace recorded against the real contracts, and compares every step. |
| `../../test/formal/V5ModelDiff.fork.t.sol` | The differential test: a fresh vault on a fork of Robinhood Chain, with Spark Savings USDG as a venue, a linked vault and an ERC-8004 agent of its own, driven through random owner spends, agent spends, order runs, guardian calls, recoveries, deposits and time; each step's outcome (success, or which error), the vault's views and its version 5 storage after it are recorded, and the model must agree at every step. |
| `check/props_check.c` | Random testing of the property statements on the model, run before any proof is asked for. |

## What a proof here says, and what it does not

A property proved by Aristotle holds for the model, for every input and every reachable state, not only for the
inputs a test tried. The differential test checks that the model and the contracts agree on random sequences (every
step's outcome, the views, the version 5 storage the views do not show, what each order run moved); it is a test, not
a proof, that the model is the contracts. Mutants of the model (a bound off by one, a check left out) make it fail.
The model's own header lists what it abstracts:

- key roots, addresses and allowlist values are ids (the contracts only compare them);
- a WOTS signature is modeled by the root it recovers to;
- amounts are below 2^64 base units (about 18 trillion USDG), timestamps below 2^62;
- code outside version 5 that runs after its checks (venues, swaps, channels, Morpho, the Priors pool, the withdrawal
  lock's daily limit of version 3) is not modeled: it can only refuse, move the token balance, or write fields the
  model leaves out. What it does to the state the model has is an operation of its own (`env_set_balance`,
  `env_priors_consent`, `env_lock`, `env_set_linked`), so the states the contracts reach, within the bounds below, are states the model reaches;
- the Priors credit spends are covered as far as the budget and a consent's wait go (what they count is an input);
- the tables are bounded (64 orders, 64 allowlist epochs, 8 ids); past them the model refuses where the contracts
  would go on.

The model starts from a new vault or from one just upgraded to version 5, with its lock on and a recovery under way or
not. The differential test starts from a new vault and does not exercise `env_lock`, `env_set_linked` or the agent
key's PriorsConsent; it requires, before it counts as passed, that every kind of run it is meant to cover happened
(agent spends through and over their bounds, SWEEP, REFILL and PAY runs, consents, a finished recovery, guardian
stops and cancels).

## Running the checks

```bash
gcc -std=c11 -O2 -o formal/v5/diff/build/replay formal/v5/diff/replay.c formal/v5/model/ostra_v5_model.c
gcc -std=c11 -O2 -o formal/v5/diff/build/props_check formal/v5/check/props_check.c formal/v5/model/ostra_v5_model.c
formal/v5/diff/build/props_check 1000000 80
OSTRA_MODEL_REPLAY=$PWD/formal/v5/diff/build/replay FOUNDRY_FUZZ_RUNS=2000 \
  forge test --ffi --match-path test/formal/V5ModelDiff.fork.t.sol
```

With `OSTRA_MODEL_STATS=<file>`, the replay appends one line per step (`<op> <outcome>`): what the runs covered.

## Results

Aristotle project `ae86c061-f5f2-4a53-8bde-aae773cccbb5`. Each run is one prompt in `prompts/`; Aristotle adds a
memory safety property (no undefined behavior) for each function it reaches.

| Run | Properties | Verdict |
|---|---|---|
| 1. The agent key's authority | P1 to P5, and 46 memory safety properties | 51 proved, 0 refuted (7 Nov 2026) |
| 2. The budget | P6 to P9 | pending |
| 3. Standing orders | P10 to P14 | pending |
| 4. Changes under the lock | P15 to P19 | pending |

Run 1 also proved that the state `model_init` leaves is reachable and that every operation, called on a reachable
state with any arguments, leaves a reachable state; so P1 to P5 hold for every state that `model_init` followed by a
finite sequence of operations produces. The memory safety properties cover every function of `ostra_v5_model.c`
except `budget_available`, which no operation calls. The proofs assume what C asks of a caller (pointers to valid,
initialized, non-overlapping objects), the C standard's specification of `memset`, and x86-64 Linux type sizes, and
they are partial correctness: what holds when a call returns.
