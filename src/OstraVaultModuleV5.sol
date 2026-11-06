// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {Wots} from "./Wots.sol";
import {IOstraVaultFactory, OstraVaultV3} from "./OstraVaultV3.sol";
import {OstraVaultV4} from "./OstraVaultV4.sol";
import {OstraVaultV5} from "./OstraVaultV5.sol";
import {IOstraVaultGuarded, MarketParams, OstraVaultModule} from "./OstraVaultModule.sol";
import {IERC4626Venue, IRaetoVault, OstraVaultModuleV4} from "./OstraVaultModuleV4.sol";

/// @notice What the Priors spends call on Priors' CreditPoolV2 (priors-agents/priors src/CreditPoolV2.sol).
interface IPriorsPool {
    struct Agent {
        bool enrolled;
        bool isRoot;
        bool defaulted;
        bool frozen;
        bool importedFromV1;
        uint64 enrolledAt;
        uint64 lastBorrowAt;
        uint64 lastRepayAt;
        uint256 sponsor;
        uint256 delegatedIn;
        uint256 delegatedOut;
        uint256 principalOut;
        uint256 activeLoans;
        uint256 premiumBps;
        uint256 premiumCap;
        uint256 loansRepaid;
        uint256 volumeRepaid;
        uint256 feesPaid;
        uint256 recourseHonored;
        uint256 childrenDefaulted;
        uint256 qualifiedRepaid;
        uint256 dollarSecondsRepaid;
    }

    struct Loan {
        uint256 agentId;
        uint256 sponsorId;
        uint256 principal;
        uint256 fee;
        uint256 sponsorCut;
        uint256 reserveCut;
        uint256 premium;
        address owner;
        uint64 issuedAt;
        uint64 dueAt;
        uint64 defaultableAt;
        uint64 minScoreTerm;
        uint64 closedAt;
        uint8 status;
    }

    struct Params {
        uint256 minLoan;
        uint256 maxLoan;
        uint64 minTerm;
        uint64 maxTerm;
        uint64 grace;
        uint64 minScoreTerm;
        uint256 feeBps;
        uint256 sponsorFeeBps;
        uint256 protocolFeeBps;
        uint256 minStake;
        uint256 maxUtilizationBps;
        uint256 keeperBounty;
    }

    struct Consent {
        uint256 agentId;
        uint256 sponsorId;
        address owner;
        uint256 maxPremiumBps;
        uint256 nonce;
        uint256 deadline;
    }

    function usdg() external view returns (address);
    function registry() external view returns (address);
    function getAgent(uint256 id) external view returns (Agent memory);
    function getParams() external view returns (Params memory);
    function getLoan(uint256 loanId) external view returns (Loan memory);
    function nonces(uint256 agentId) external view returns (uint256);
    function consentDigest(Consent calldata c) external view returns (bytes32);
    function borrow(uint256 agentId, uint256 amount, uint64 term, address to, uint256 maxFee)
        external
        returns (uint256 loanId);
    function repay(uint256 loanId, uint256 expectedAgentId, uint256 maxDue) external;
    function leave(uint256 agentId) external;
    function enrollRoot(uint256 rootId, uint256 assets) external;
    function addStake(uint256 rootId, uint256 assets) external;
    function unlock(uint256 rootId, uint256 shares, address to) external returns (uint256 assets);
    function claimSponsorFees(uint256 sponsorId, address to) external returns (uint256 amount);
    function vouchWithConsent(
        uint256 sponsorId,
        uint256 agentId,
        uint256 amount,
        uint256 premiumBps,
        Consent calldata c,
        bytes calldata sig
    ) external;
    function vouch(uint256 sponsorId, uint256 agentId, uint256 amount) external;
    function unvouch(uint256 sponsorId, uint256 agentId, uint256 amount) external;
    function freeze(uint256 agentId, bool frozen) external;
}

/// @notice What cover reads of OstraPad: a job's provider, budget, evaluator fee, status, decision and expiry.
interface IOstraPadJobs {
    struct Job {
        address client;
        address provider;
        address evaluator;
        uint128 budget;
        uint128 evaluatorFee;
        uint8 status;
        bool pool;
        bool approved;
        bool feePaid;
        uint8 round;
        uint8 revealed;
        uint64 expiresAt;
        uint64 acceptedAt;
        uint64 revealBy;
        uint64 submittedAt;
        uint64 assignedAt;
        uint64 appealBy;
        uint64 drawBlock;
        uint64 drawAt;
        bytes32 clientCommit;
        bytes32 providerCommit;
        bytes32 seed;
        bytes32 deliverable;
    }

    function job(bytes32 id) external view returns (Job memory);
}

/// @notice The ERC-8004 Identity Registry, an ERC-721.
interface IIdentityOwner {
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @notice The vault's own key root (OstraVault.keyRoot), which an agent key must never be.
interface IOstraVaultKey {
    function keyRoot() external view returns (bytes32);
}

/// @title OstraVaultModuleV5
/// @notice OstraVault's version 5: the agent key and the policy that bounds it, standing orders, and Priors credit. Run
///         by delegatecall from a vault, after the vault applied the lock and link changes whose wait is over (and, for
///         an owner spend, checked the WOTS signature and rotated its key). Like the other modules it holds nothing, has
///         no owner and no state of its own: in a vault's context it reads and writes OstraVaultV3's, OstraVaultV4's and
///         OstraVaultV5's fields (and the vault's balances), and called directly it refuses (OnlyDelegated).
///
/// Spends (params; every one checks its params' exact length):
/// * 29 SetPolicy: abi.encode(OstraVaultV5.Policy).
/// * 30 SetAllow: abi.encode(uint8 kind, bytes32 value, bool allowed). Address kinds take the address as the value.
/// * 31 SetAgentKey: abi.encode(bytes32 root, uint64 expiry). At most MAX_AGENT_KEY_LIFE from now; the vault's own
///   key root is refused.
/// * 32 RevokeAgentKey: empty.
/// * 33 SetOrder: abi.encode(OrderParams). 34 CancelOrder: abi.encode(uint256 id); id 0 cancels every order. The agent
///   key cancels only orders an agent key set (or one already gone), one at a time.
/// * 35 PriorsBorrow: abi.encode(uint256 agentId, uint256 amount, uint64 term, uint256 maxFee, bytes32[8] jobs).
/// * 36 PriorsRepay: abi.encode(uint256 loanId, uint256 maxDue).
/// * 37 PriorsConsent: abi.encode(uint256 agentId, uint256 sponsorId, uint256 maxPremiumBps, uint256 deadline).
/// * 38 PriorsLeave: abi.encode(uint256 agentId).
/// * 39 RootEnroll, 40 RootAddStake: abi.encode(uint256 rootId, uint256 assets).
/// * 41 RootSponsor: abi.encode(SponsorParams). 42 RootVouch, 43 RootUnvouch: abi.encode(uint256 rootId,
///   uint256 agentId, uint256 amount). 44 RootFreeze: abi.encode(uint256 agentId, bool frozen). 45 RootUnlock:
///   abi.encode(uint256 rootId, uint256 shares). 46 RootClaimFees: abi.encode(uint256 rootId).
/// A Priors spend (35 to 46) signed by the owner's key that fails moves nothing and lands (PriorsFailed), as a failed
/// Morpho or venue spend does, when it is sent on its own: no other party can hold the owner's key by making it fail
/// (a line frozen or pulled back, a loan repaid or defaulted, a consent used, expired or withdrawn). Some of these
/// (a PriorsRepay of a loan no longer open or never this vault's, a PriorsLeave, RootUnvouch or RootFreeze of a
/// sponsorship already gone, a RootSponsor whose consent nonce was used) land as nothing to do, without the event. A
/// failed agent-key spend reverts and keeps its key.
///
/// Changes (policy, allowlist entries, the agent key, a Priors consent) loosen or tighten as OstraVaultV5 says; while a
/// recovery waits under the lock nothing new may start to wait (no new loan, no new or larger line, no frozen line
/// reopened), and while any recovery waits no agent key or order may be set.
///
/// Priors: the pool, its code hash, USDG and the ERC-8004 Identity Registry are fixed here. A loan is borrowed only to
/// this vault, only within the policy, and only on a line from an allowed sponsor; only loans this vault borrowed
/// itself are ever repaid from it (an identity can be sent to any vault with a loan open). A loan's fee (it is paid in
/// full however early the loan is repaid), a root's stake, and what a line it backs puts at risk (the line plus the fee
/// and premium of a loan at the pool's longest term, and a premium raised on a line it already backs) count against the
/// lock's daily limit as the version 3 rules say for value that leaves, and for the agent key against its policy
/// budget. Pool parameters changed later (a higher fee or longer term) are not counted again.
///
/// The agent key's Exit (27) runs through OstraVaultModuleV4's guard op 5 (strict, refused while the venue reports a
/// loss) whether or not the lock is on, and so do the exits orders and repays make for anyone; the agent key gives
/// lines from a root only to agents on its allowlist.
contract OstraVaultModuleV5 {
    using SafeERC20 for IERC20;

    uint8 internal constant ACTION_TRANSFER = 0;
    uint8 internal constant ACTION_OPEN_CHANNEL = 1;
    uint8 internal constant ACTION_SWAP = 3;
    uint8 internal constant ACTION_CLAIM_DIVIDEND = 5;
    uint8 internal constant ACTION_LEND = 17;
    uint8 internal constant ACTION_REDEEM = 18;
    uint8 internal constant ACTION_REPAY = 22;
    uint8 internal constant ACTION_ENTER = 26;
    uint8 internal constant ACTION_EXIT = 27;
    uint8 internal constant ACTION_SET_POLICY = 29;
    uint8 internal constant ACTION_SET_ALLOW = 30;
    uint8 internal constant ACTION_SET_AGENT_KEY = 31;
    uint8 internal constant ACTION_REVOKE_AGENT_KEY = 32;
    uint8 internal constant ACTION_SET_ORDER = 33;
    uint8 internal constant ACTION_CANCEL_ORDER = 34;
    uint8 internal constant ACTION_PRIORS_BORROW = 35;
    uint8 internal constant ACTION_PRIORS_REPAY = 36;
    uint8 internal constant ACTION_PRIORS_CONSENT = 37;
    uint8 internal constant ACTION_PRIORS_LEAVE = 38;
    uint8 internal constant ACTION_ROOT_ENROLL = 39;
    uint8 internal constant ACTION_ROOT_ADD_STAKE = 40;
    uint8 internal constant ACTION_ROOT_SPONSOR = 41;
    uint8 internal constant ACTION_ROOT_VOUCH = 42;
    uint8 internal constant ACTION_ROOT_UNVOUCH = 43;
    uint8 internal constant ACTION_ROOT_FREEZE = 44;
    uint8 internal constant ACTION_ROOT_UNLOCK = 45;
    uint8 internal constant ACTION_ROOT_CLAIM_FEES = 46;
    uint8 internal constant GUARD_EXIT = 5;
    uint8 internal constant GUARD_AGENT_STOP = 7;
    uint8 internal constant GUARD_CLEAR_CRANK = 8;
    /// @dev OstraVaultModuleV4.PRICE_SCALE: an ERC4626 venue's price is read for a billion whole shares.
    uint256 internal constant PRICE_SCALE = 1e9;

    /// @notice The actions an agent key may ever use (a policy picks among them): 0 Transfer, 1 OpenChannel, 3 Swap,
    ///         5 ClaimDividend, 10 SetProfile, 11 SetTokenMetadata, 17 Lend, 18 Redeem, 19 PostCollateral,
    ///         20 WithdrawCollateral, 21 Borrow, 22 Repay, 26 Enter, 27 Exit, 28 Forward, 32 RevokeAgentKey, 33 SetOrder,
    ///         34 CancelOrder, 35 to 38 (Priors), 41 to 44 and 46 (Priors root). Never the guardians, the recovery, the
    ///         lock, the link, the crank, a pool's rules, a dev buy, the identity, a hash approval, Guard, the venues,
    ///         the policy, the allowlist, setting an agent key (it may only end its own), or a root's stake.
    uint64 public constant AGENT_ACTIONS = 0x5e7f1c7e0c2b;
    uint256 public constant MAX_AGENT_KEY_LIFE = 90 days;
    uint256 public constant MIN_ORDER_INTERVAL = 1 hours;
    uint256 public constant MAX_ORDER_INTERVAL = 365 days;
    uint256 public constant DEFAULT_REPAY_LEAD = 1 days;
    uint256 public constant MAX_REPAY_LEAD = 7 days;
    uint256 public constant MAX_CONSENT_LIFE = 30 days;
    uint256 public constant MAX_TERM = 365 days;
    /// @notice CreditPoolV2.MAX_PREMIUM_BPS.
    uint256 public constant MAX_PREMIUM_BPS = 200;
    uint256 public constant COVER_JOBS = 8;
    /// @dev CreditPoolV2.LoanStatus.Active.
    uint8 internal constant LOAN_ACTIVE = 1;
    /// @dev OstraPad.Status: Accepted, Submitted, Decided, Appealed.
    uint8 internal constant JOB_ACCEPTED = 2;
    uint8 internal constant JOB_SUBMITTED = 3;
    uint8 internal constant JOB_DECIDED = 4;
    uint8 internal constant JOB_APPEALED = 5;
    /// @dev OstraVaultModule.GUARD_MIN_GAS, and OpenZeppelin's ReentrancyGuardReentrantCall().
    uint256 internal constant GUARD_MIN_GAS = 600_000;
    /// @notice The gas a Priors spend starts with at least (its run is caught, so a submitter must not be able to make it
    ///         fail by its gas limit); well above the most any Priors spend uses in the fork tests.
    uint256 public constant PRIORS_MIN_GAS = 2_000_000;
    bytes4 private constant REENTRANT_CALL = 0x3ee5aeb5;

    bytes24 private constant AGENT_DOMAIN = "OSTRA/VAULT/EVM/AGENT/v1";

    /// @notice The OstraVaultFactory every Ostra vault comes from (a Guard spend's vault must be one it made).
    IOstraVaultFactory public immutable FACTORY;
    /// @notice OstraVaultModuleV4, whose Enter (runVenue) and guard op 5 orders and repays run, by delegatecall.
    address public immutable MODULE_V4;
    /// @notice Priors' CreditPoolV2, and its runtime code hash: every Priors spend refuses other code.
    IPriorsPool public immutable POOL;
    bytes32 public immutable POOL_CODEHASH;
    /// @notice The pool's token: Priors spends only for a vault of this token.
    IERC20 public immutable USDG;
    /// @notice The ERC-8004 Identity Registry (the pool's): who owns an agent.
    IIdentityOwner public immutable IDENTITY_REGISTRY;
    /// @notice OstraPad, whose escrowed jobs cover a loan.
    IOstraPadJobs public immutable PAD;
    address private immutable SELF;

    struct OrderParams {
        uint8 kind;
        uint8 venueKind;
        address target;
        uint128 amount;
        uint128 threshold;
        uint32 interval;
        uint32 runs;
        uint64 endAt;
    }

    struct BorrowParams {
        uint256 agentId;
        uint256 amount;
        uint64 term;
        uint256 maxFee;
        bytes32[8] jobs;
    }

    struct SponsorParams {
        uint256 rootId;
        uint256 agentId;
        uint256 amount;
        uint256 premiumBps;
        uint256 maxPremiumBps;
        uint256 nonce;
        uint256 deadline;
        address owner;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    event AgentSpent(uint64 indexed nonce, uint8 indexed action, bytes32 nextKeyRoot);
    event OrderSet(uint256 indexed id, OrderParams order);
    event OrderCancelled(uint256 indexed id);
    event OrderRan(uint256 indexed id, uint256 amount, address indexed by);
    event PriorsBorrowed(uint256 indexed agentId, uint256 indexed loanId, uint256 amount, uint64 term);
    event PriorsRepaid(uint256 indexed agentId, uint256 indexed loanId, uint256 amount, address indexed by);
    event PriorsConsented(uint256 indexed agentId, uint256 indexed sponsorId, bytes32 digest, uint64 validFrom);
    event PriorsLeft(uint256 indexed agentId);
    event RootSpent(uint8 indexed action, uint256 indexed rootId, uint256 indexed agentId, uint256 amount);
    /// @notice A loan this vault borrowed was closed on the pool without it (repaid by someone else, or defaulted) and
    ///         is no longer counted as its own.
    event LoanCleared(uint256 indexed loanId, uint8 status);
    /// @notice A Priors spend (35 to 46) failed, moved nothing and landed; `reason` is its error's selector.
    event PriorsFailed(uint8 indexed action, bytes4 reason);

    error OnlyDelegated();
    error BadParams();
    error BadAction();
    error Locked();
    error WrongToken();
    error NoAgentKey();
    error WotsSignatureInvalid();
    error NotAllowed(uint8 action);
    error NotAllowlisted(uint8 kind);
    error NoOrder();
    error TooEarly(uint256 at);
    error NothingToDo();
    error PoolChanged();
    error NotOwnAgent(uint256 agentId);
    error NotOwnLoan(uint256 loanId);
    error OutOfPolicy();
    error NotCovered(uint256 escrowed);
    error BadTransfer();
    error OutOfGas();
    error InLoss();
    error NotLinked();
    error InsufficientOutput();

    constructor(
        address factory,
        address moduleV4,
        address pool,
        bytes32 poolCodehash,
        address usdg,
        address identityRegistry,
        address pad
    ) {
        // The factory may not exist yet (a fresh stack makes the modules first, then the factory that names them).
        if (
            factory == address(0) || moduleV4.code.length == 0 || pool.code.length == 0 || pool.codehash != poolCodehash
                || identityRegistry.code.length == 0 || pad.code.length == 0
        ) revert BadParams();
        if (IPriorsPool(pool).usdg() != usdg || IPriorsPool(pool).registry() != identityRegistry) revert BadParams();
        FACTORY = IOstraVaultFactory(factory);
        MODULE_V4 = moduleV4;
        POOL = IPriorsPool(pool);
        POOL_CODEHASH = poolCodehash;
        USDG = IERC20(usdg);
        IDENTITY_REGISTRY = IIdentityOwner(identityRegistry);
        PAD = IOstraPadJobs(pad);
        SELF = address(this);
    }

    // ---------------------------------------------------------------------------------------------
    // The agent key
    // ---------------------------------------------------------------------------------------------

    /// @notice An agent spend's signature, key rotation and policy (OstraVault.spendAsAgent, before it runs the action
    ///         as an owner spend would). `recovering`: a guardian recovery of the vault is under way.
    function agent(uint8 action, bytes32 nextKeyRoot, bytes calldata params, bytes calldata signature, bool recovering)
        external
    {
        _onlyDelegated();
        if (recovering) revert Locked();
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.applyPending(l);
        if (!OstraVaultV5.agentInForce(l)) revert NoAgentKey();
        bytes32 root = _rotateAgent(l, action, nextKeyRoot, params, signature);
        // A one-time key signs once: the next agent key is neither this one nor the owner's.
        if (nextKeyRoot == root || nextKeyRoot == IOstraVaultKey(address(this)).keyRoot()) revert BadParams();
        OstraVaultV5.Policy memory p = l.policy;
        if ((AGENT_ACTIONS & p.actions) >> action & 1 == 0) revert NotAllowed(action);
        OstraVaultV5.count(l, p, _agentAmount(l, action, params));
    }

    /// @dev Checks the agent key's signature of the spend and rotates the key and its nonce before anything else, so
    ///      the signature can never be used again. Returns the key that signed.
    function _rotateAgent(
        OstraVaultV5.Layout storage l,
        uint8 action,
        bytes32 nextKeyRoot,
        bytes calldata params,
        bytes calldata signature
    ) private returns (bytes32 root) {
        root = l.agentRoot;
        uint64 n = l.agentNonce;
        bytes memory message = abi.encodePacked(AGENT_DOMAIN, block.chainid, address(this), n, nextKeyRoot, action, params);
        if (Wots.recoverKeyRoot(signature, message) != root) revert WotsSignatureInvalid();
        l.agentRoot = nextKeyRoot;
        l.agentNonce = n + 1;
        emit AgentSpent(n, action, nextKeyRoot);
    }

    /// @dev What an agent spend counts against the policy, after checking its allowlists.
    function _agentAmount(OstraVaultV5.Layout storage l, uint8 action, bytes calldata params)
        private
        view
        returns (uint256)
    {
        if (action == ACTION_TRANSFER) {
            (address to, uint256 amount) = abi.decode(params, (address, uint256));
            _need(l, OstraVaultV5.ALLOW_RECIPIENT, to);
            return amount;
        }
        if (action == ACTION_OPEN_CHANNEL) {
            (, address receiver,,,, uint128 amount) =
                abi.decode(params, (address, address, address, uint40, bytes32, uint128));
            _need(l, OstraVaultV5.ALLOW_CHANNEL, receiver);
            return amount;
        }
        if (action == ACTION_SWAP) {
            (PoolKey memory key,, uint128 amountIn,, address recipient) =
                abi.decode(params, (PoolKey, bool, uint128, uint128, address));
            if (!OstraVaultV5.allowed(l, OstraVaultV5.ALLOW_POOL, PoolId.unwrap(key.toId()))) {
                revert NotAllowlisted(OstraVaultV5.ALLOW_POOL);
            }
            if (recipient != address(this)) _need(l, OstraVaultV5.ALLOW_RECIPIENT, recipient);
            return amountIn;
        }
        if (action == ACTION_CLAIM_DIVIDEND) {
            // Dividends (another token, of an amount known only when claimed) stay with the owner: this vault or its
            // linked vault, never a recipient of the allowlist.
            address recipient = abi.decode(params, (address));
            if (recipient != address(this) && recipient != OstraVaultV3.layout().linkedVault) revert NotLinked();
            return 0;
        }
        if (action == ACTION_LEND || action == ACTION_REDEEM) {
            (address vault,,) = abi.decode(params, (address, uint256, uint256));
            _need(l, OstraVaultV5.ALLOW_LEND, vault);
            return 0;
        }
        if (action == ACTION_REPAY) {
            // Only the debt of this vault's own linked vault: any vault may name this one its link.
            (,,, address onBehalf, uint256 maxAssets) =
                abi.decode(params, (MarketParams, uint256, uint256, address, uint256));
            if (onBehalf != OstraVaultV3.layout().linkedVault) revert NotLinked();
            return maxAssets;
        }
        if (action == ACTION_PRIORS_BORROW) {
            // The fee leaves the vault however early the loan is repaid: at most the capped maximum fee counts.
            if (params.length < 128) revert BadParams();
            (, uint256 amount, uint64 term, uint256 maxFee) = abi.decode(params[:128], (uint256, uint256, uint64, uint256));
            uint256 cap = amount * l.policy.maxFeeBps * term / (10_000 * 30 days);
            return maxFee < cap ? maxFee : cap;
        }
        if (action == ACTION_ROOT_SPONSOR || action == ACTION_ROOT_VOUCH) {
            if (params.length < 96) revert BadParams();
            (, uint256 agentId, uint256 amount) = abi.decode(params[:96], (uint256, uint256, uint256));
            if (!OstraVaultV5.allowed(l, OstraVaultV5.ALLOW_BORROWER, bytes32(agentId))) {
                revert NotAllowlisted(OstraVaultV5.ALLOW_BORROWER);
            }
            // What a default can burn: the line and the fee of a loan on it at the pool's longest term.
            uint256 premiumBps;
            if (action == ACTION_ROOT_SPONSOR) {
                if (params.length < 128) revert BadParams();
                premiumBps = uint256(bytes32(params[96:128]));
                return _sponsorCost(uint256(bytes32(params[:32])), agentId, amount, premiumBps);
            }
            return _lineCost(amount, POOL.getAgent(agentId).premiumBps);
        }
        if (action == ACTION_ROOT_FREEZE) {
            // The agent key may freeze a line, never reopen one.
            (, bool frozen_) = abi.decode(params, (uint256, bool));
            if (!frozen_) revert NotAllowed(ACTION_ROOT_FREEZE);
            return 0;
        }
        return 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Version 5 spends
    // ---------------------------------------------------------------------------------------------

    /// @notice Runs one version 5 spend (29 to 46) for the vault that delegates to it, owner's or agent's alike;
    ///         `byAgent`: the agent key signed it.
    function run(uint8 action, bytes calldata params, IERC20 token, bool recovering, bool byAgent) external {
        _onlyDelegated();
        OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.applyPending(l);
        bool locked = l3.lock.withdrawal != address(0);
        // While a recovery is under way and the lock is on, the key may be a thief's: nothing new may start to wait.
        bool frozen = recovering && locked;
        if (action == ACTION_SET_POLICY) {
            _setPolicy(l, l3, params, locked, frozen);
        } else if (action == ACTION_SET_ALLOW) {
            _setAllow(l, l3, params, locked, frozen);
        } else if (action == ACTION_SET_AGENT_KEY) {
            _setAgentKey(l, l3, params, locked, recovering);
        } else if (action == ACTION_REVOKE_AGENT_KEY) {
            _len(params, 0);
            OstraVaultV5.revokeAgent(l, address(0));
        } else if (action == ACTION_SET_ORDER) {
            _setOrder(l, params, recovering, byAgent);
        } else if (action == ACTION_CANCEL_ORDER) {
            _len(params, 32);
            uint256 id = abi.decode(params, (uint256));
            // The agent key cancels only orders an agent key set, one at a time; the owner any, or all (id 0).
            if (byAgent && (id == 0 || (l.orders[id].kind != 0 && l.orders[id].agentGen == 0))) {
                revert NotAllowed(ACTION_CANCEL_ORDER);
            }
            // Id 0: every order. Gone already (run out, or cancelled): nothing to do, and the spend lands.
            if (id == 0) {
                OstraVaultV5.stopOrders(l, address(0));
            } else if (l.orders[id].kind != 0) {
                delete l.orders[id];
                emit OrderCancelled(id);
            }
        } else if (action >= ACTION_PRIORS_BORROW && action <= ACTION_ROOT_CLAIM_FEES) {
            // A Priors spend that fails (a line frozen or pulled back, a loan repaid or defaulted meanwhile, a consent
            // used or expired, a policy or pool refusal) moves nothing but lands, as a failed Morpho or venue spend
            // does, so the owner's one-time key is never held by a message that can no longer succeed. Not for the
            // agent key (a failed agent spend reverts and keeps its key, as its swaps do; the owner can always replace
            // that key), and only for a spend sent on its own (_landed). Run in this module again by delegatecall, to
            // catch its revert; it starts with at least PRIORS_MIN_GAS, so a submitter cannot make it fail by its gas.
            if (gasleft() < PRIORS_MIN_GAS) revert OutOfGas();
            (bool ok, bytes memory ret) =
                SELF.delegatecall(abi.encodeCall(this.runPriors, (action, params, token, locked, frozen)));
            if (!ok) {
                if (byAgent) _bubble(ret);
                _landed(ret);
                bytes4 reason;
                if (ret.length >= 4) reason = bytes4(ret);
                emit PriorsFailed(action, reason);
            }
        } else {
            revert BadAction();
        }
    }

    /// @notice A Priors spend (35 to 46), run by `run` in this module again by delegatecall, so that its failure can
    ///         land.
    function runPriors(uint8 action, bytes calldata params, IERC20 token, bool locked, bool frozen) external {
        _onlyDelegated();
        OstraVaultV3.Layout storage l3 = OstraVaultV3.layout();
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        if (action <= ACTION_PRIORS_LEAVE) _priors(l, l3, action, params, token, locked, frozen);
        else _root(l, l3, action, params, token, frozen);
    }

    function _setPolicy(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        bytes calldata params,
        bool locked,
        bool frozen
    ) private {
        _len(params, 416);
        OstraVaultV5.Policy memory n = abi.decode(params, (OstraVaultV5.Policy));
        if (
            n.actions & ~AGENT_ACTIONS != 0 || n.maxTerm > MAX_TERM || n.maxFeeBps > 10_000 || n.coverBps > 10_000
                || n.repayLead > MAX_REPAY_LEAD || n.maxPremiumBps > MAX_PREMIUM_BPS
        ) revert BadParams();
        if (n.repayKind == 0) {
            if (n.repayVenue != address(0)) revert BadParams();
        } else if (
            (n.repayKind != OstraVaultV4.RAETO_USDG && n.repayKind != OstraVaultV4.ERC4626) || n.repayVenue == address(0)
        ) {
            revert BadParams();
        }
        uint64 at;
        if (!locked || _tighter(n, l.policy)) {
            // Tightening is at once, and drops a loosening still waiting; so is anything while the lock is off.
            at = uint64(block.timestamp);
            l.policy = n;
            delete l.pendingPolicy;
            l.pendingPolicyAt = 0;
        } else {
            if (frozen) revert Locked();
            at = uint64(block.timestamp) + l3.lock.delay;
            l.pendingPolicy = n;
            l.pendingPolicyAt = at;
        }
        emit OstraVaultV5.PolicySet(n, at);
    }

    /// @dev Whether `n` is at least as strict as `c` in every field: no new action, no higher bound, cover not turned
    ///      off or widened, the repay fields unchanged.
    function _tighter(OstraVaultV5.Policy memory n, OstraVaultV5.Policy memory c) private pure returns (bool) {
        return n.actions & ~c.actions == 0 && n.perTx <= c.perTx && n.daily <= c.daily && n.maxDebt <= c.maxDebt
            && n.maxTerm <= c.maxTerm && n.maxFeeBps <= c.maxFeeBps
            && (c.coverBps == 0 || (n.coverBps != 0 && n.coverBps <= c.coverBps)) && n.repayLead == c.repayLead
            && n.repayKind == c.repayKind && n.repayVenue == c.repayVenue && n.vouchPerAgent <= c.vouchPerAgent
            && n.vouchTotal <= c.vouchTotal && n.maxPremiumBps <= c.maxPremiumBps;
    }

    function _setAllow(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        bytes calldata params,
        bool locked,
        bool frozen
    ) private {
        _len(params, 96);
        (uint8 kind, bytes32 value, bool on) = abi.decode(params, (uint8, bytes32, bool));
        if (kind == 0 || kind > OstraVaultV5.ALLOW_BORROWER || value == bytes32(0)) revert BadParams();
        // Address kinds take the address as the value; the pool kind a PoolId, the Priors kinds an agent id.
        bool addressKind = kind == OstraVaultV5.ALLOW_RECIPIENT || kind == OstraVaultV5.ALLOW_CHANNEL
            || kind == OstraVaultV5.ALLOW_LEND;
        if (addressKind && uint256(value) >> 160 != 0) revert BadParams();
        bytes32 key = OstraVaultV5.allowKey(kind, value);
        if (!on) {
            // Removing is at once; gone already: nothing to do, and the spend lands.
            if (l.allows[key].from != 0) {
                delete l.allows[key];
                emit OstraVaultV5.AllowSet(kind, value, false, uint64(block.timestamp));
            }
            return;
        }
        if (OstraVaultV5.allowed(l, kind, value)) revert BadParams();
        if (frozen) revert Locked();
        uint64 from = uint64(block.timestamp) + (locked ? l3.lock.delay : 0);
        l.allows[key] = OstraVaultV5.Allow({from: from, epoch: l.epoch});
        if (from > l.waitingUntil && from > block.timestamp) l.waitingUntil = from;
        emit OstraVaultV5.AllowSet(kind, value, true, from);
    }

    function _setAgentKey(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        bytes calldata params,
        bool locked,
        bool recovering
    ) private {
        _len(params, 64);
        (bytes32 root, uint64 expiry) = abi.decode(params, (bytes32, uint64));
        if (recovering) revert Locked();
        if (root == bytes32(0) || root == IOstraVaultKey(address(this)).keyRoot()) revert BadParams();
        uint64 from = uint64(block.timestamp) + (locked ? l3.lock.delay : 0);
        if (expiry <= from || expiry > block.timestamp + MAX_AGENT_KEY_LIFE) revert BadParams();
        // The nonce moves on: nothing an earlier agent key signed counts for this one.
        l.agentRoot = root;
        l.agentFrom = from;
        l.agentExpiry = expiry;
        ++l.agentNonce;
        // A new generation: the orders an earlier agent key set stop.
        ++l.agentGen;
        emit OstraVaultV5.AgentKeySet(root, from, expiry);
    }

    function _setOrder(OstraVaultV5.Layout storage l, bytes calldata params, bool recovering, bool byAgent) private {
        _len(params, 256);
        OrderParams memory o = abi.decode(params, (OrderParams));
        if (recovering) revert Locked();
        if (
            o.amount == 0 || o.target == address(0) || o.target == address(this) || o.interval < MIN_ORDER_INTERVAL
                || o.interval > MAX_ORDER_INTERVAL || (o.endAt != 0 && o.endAt <= block.timestamp)
        ) revert BadParams();
        if (o.kind == OstraVaultV5.ORDER_PAY) {
            if (o.venueKind != 0 || o.threshold != 0 || o.runs == 0) revert BadParams();
        } else if (o.kind == OstraVaultV5.ORDER_SWEEP) {
            if (o.venueKind == 0 || o.venueKind > OstraVaultV4.ERC4626 || o.runs != 0) revert BadParams();
        } else if (o.kind == OstraVaultV5.ORDER_REFILL) {
            if (
                (o.venueKind != OstraVaultV4.RAETO_USDG && o.venueKind != OstraVaultV4.ERC4626) || o.runs != 0
                    || o.threshold == 0
            ) revert BadParams();
        } else {
            revert BadParams();
        }
        uint256 id = ++l.orderCount;
        l.orders[id] = OstraVaultV5.Order({
            kind: o.kind,
            venueKind: o.venueKind,
            interval: o.interval,
            runsLeft: o.runs,
            lastRun: 0,
            endAt: o.endAt,
            epoch: l.orderEpoch,
            target: o.target,
            agentGen: byAgent ? l.agentGen : 0,
            amount: o.amount,
            threshold: o.threshold
        });
        emit OrderSet(id, o);
    }

    // ---------------------------------------------------------------------------------------------
    // Standing orders
    // ---------------------------------------------------------------------------------------------

    /// @notice OstraVault.runOrder: anyone, once the order's interval has passed since its last run. Judged against the
    ///         policy in force now; a run that cannot happen reverts.
    function runOrder(uint256 id, IERC20 token, bool recovering) external {
        _onlyDelegated();
        if (recovering) revert Locked();
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.applyPending(l);
        OstraVaultV5.Order storage o = l.orders[id];
        uint8 kind = o.kind;
        if (
            kind == 0 || o.epoch != l.orderEpoch || (o.endAt != 0 && block.timestamp >= o.endAt)
                || !OstraVaultV5.setterLive(l, o)
        ) revert NoOrder();
        if (o.lastRun != 0 && block.timestamp < uint256(o.lastRun) + o.interval) {
            revert TooEarly(uint256(o.lastRun) + o.interval);
        }
        o.lastRun = uint64(block.timestamp);
        OstraVaultV5.Policy memory p = l.policy;
        address target = o.target;
        uint256 amount = o.amount;
        if (kind == OstraVaultV5.ORDER_PAY) {
            _bit(p, ACTION_TRANSFER);
            _need(l, OstraVaultV5.ALLOW_RECIPIENT, target);
            OstraVaultV5.count(l, p, amount);
            OstraVaultV3.outflow(OstraVaultV3.layout(), amount);
            uint32 left = o.runsLeft - 1;
            if (left == 0) delete l.orders[id];
            else o.runsLeft = left;
            token.safeTransfer(target, amount);
        } else if (kind == OstraVaultV5.ORDER_SWEEP) {
            _bit(p, ACTION_ENTER);
            uint256 balance = token.balanceOf(address(this));
            uint256 threshold = o.threshold;
            if (balance <= threshold) revert NothingToDo();
            if (balance - threshold < amount) amount = balance - threshold;
            // OstraVaultModuleV4's own Enter, with every check it makes (the venue in force and unchanged, the position
            // risen by the amount, the lock's limit for what it counts).
            _delegate(
                MODULE_V4,
                abi.encodeCall(
                    OstraVaultModuleV4.runVenue, (ACTION_ENTER, abi.encode(o.venueKind, target, amount, uint256(0)), token)
                )
            );
        } else {
            _bit(p, ACTION_EXIT);
            uint256 balance = token.balanceOf(address(this));
            uint256 threshold = o.threshold;
            if (balance >= threshold) revert NothingToDo();
            if (threshold - balance < amount) amount = threshold - balance;
            _exitFor(o.venueKind, target, amount, token);
        }
        emit OrderRan(id, amount, msg.sender);
    }

    /// @dev Brings at least `need` of the token (as far as the position goes) home from a RAETO_USDG or ERC4626 venue,
    ///      through OstraVaultModuleV4's guard op 5: refused while a Raeto venue reports a loss, and the balance must rise
    ///      by the position's fall less the venue's rounding.
    function _exitFor(uint8 kind, address venue, uint256 need, IERC20 token) private {
        uint256 units;
        if (kind == OstraVaultV4.RAETO_USDG) {
            units = IRaetoVault(venue).principalOf(address(this));
            if (need < units) units = need;
        } else if (kind == OstraVaultV4.ERC4626) {
            units = IERC4626Venue(venue).balanceOf(address(this));
            uint256 shares = IERC4626Like(venue).previewWithdraw(need);
            if (shares < units) units = shares;
        } else {
            revert BadParams();
        }
        if (units == 0) revert NothingToDo();
        _home(kind, venue, units, token);
    }

    /// @dev OstraVaultModuleV4's guard op 5 (strict; refused while a Raeto venue reports a loss), and refused while an
    ///      ERC4626 venue's share price is below the highest this vault read (what the breaker holds to).
    function _home(uint8 kind, address venue, uint256 units, IERC20 token) private {
        if (kind == OstraVaultV4.ERC4626) {
            OstraVaultV4.Venue storage v = OstraVaultV4.layout().venues[OstraVaultV4.key(kind, venue)];
            uint256 price = IERC4626Venue(venue).convertToAssets(PRICE_SCALE * 10 ** IERC4626Venue(venue).decimals());
            if (price < v.priceMark) revert InLoss();
        }
        _delegate(
            MODULE_V4, abi.encodeCall(OstraVaultModuleV4.guard, (GUARD_EXIT, abi.encode(kind, venue, units), token))
        );
    }

    /// @notice The agent key's Exit (OstraVault routes an agent spend 27 here): strict and never in a loss, whether or
    ///         not the lock is on, at least `minOut` back; a RAETO_STOCK Exit of 0 (the USDG a liquidation left this
    ///         vault, which only comes in) runs as OstraVaultModuleV4's own. A refused exit reverts and keeps the key.
    function agentExit(bytes calldata params, IERC20 token) external {
        _onlyDelegated();
        (uint8 kind, address venue, uint256 amount, uint256 minOut) =
            abi.decode(params, (uint8, address, uint256, uint256));
        if (kind == OstraVaultV4.RAETO_STOCK && amount == 0) {
            _delegate(MODULE_V4, abi.encodeCall(OstraVaultModuleV4.runVenue, (ACTION_EXIT, params, token)));
            return;
        }
        if (amount == 0) revert BadParams();
        uint256 balance = token.balanceOf(address(this));
        _home(kind, venue, amount, token);
        if (token.balanceOf(address(this)) < balance + minOut) revert InsufficientOutput();
    }

    // ---------------------------------------------------------------------------------------------
    // Priors
    // ---------------------------------------------------------------------------------------------

    /// @notice OstraVault.repayDue: anyone, from the policy's repay lead before a loan this vault borrowed is due. A
    ///         balance that falls short is first topped up from the policy's repay venue. Not stopped by a recovery:
    ///         paying the vault's own debt only ever protects its owner.
    function repayDue(uint256 loanId, IERC20 token) external {
        _onlyDelegated();
        _priorsReady(token);
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.applyPending(l);
        if (!l.ownLoans[loanId]) revert NotOwnLoan(loanId);
        IPriorsPool.Loan memory ln = POOL.getLoan(loanId);
        // Repaid on the pool by someone else, or defaulted: no longer this vault's to repay.
        if (ln.status != LOAN_ACTIVE) {
            delete l.ownLoans[loanId];
            emit LoanCleared(loanId, ln.status);
            return;
        }
        OstraVaultV5.Policy memory p = l.policy;
        uint256 lead = p.repayLead == 0 ? DEFAULT_REPAY_LEAD : p.repayLead;
        if (block.timestamp + lead < ln.dueAt) revert TooEarly(ln.dueAt - lead);
        uint256 due = ln.principal + ln.fee;
        uint256 balance = token.balanceOf(address(this));
        if (balance < due && p.repayVenue != address(0)) _exitFor(p.repayKind, p.repayVenue, due - balance, token);
        _repay(l, loanId, ln.agentId, due, token);
    }

    function _priors(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        uint8 action,
        bytes calldata params,
        IERC20 token,
        bool locked,
        bool frozen
    ) private {
        _priorsReady(token);
        if (action == ACTION_PRIORS_BORROW) {
            _len(params, 384);
            // A loan is a liability and its fee leaves the vault: nothing new while the key may be a thief's.
            if (frozen) revert Locked();
            _borrow(l, l3, abi.decode(params, (BorrowParams)), token);
        } else if (action == ACTION_PRIORS_REPAY) {
            _len(params, 64);
            (uint256 loanId, uint256 maxDue) = abi.decode(params, (uint256, uint256));
            // Already repaid (repayDue, or anyone on the pool) or never this vault's: nothing to do, and the spend lands,
            // so that nobody can hold the key on a repay that can no longer happen.
            if (!l.ownLoans[loanId]) return;
            IPriorsPool.Loan memory ln = POOL.getLoan(loanId);
            if (ln.status != LOAN_ACTIVE) {
                delete l.ownLoans[loanId];
                emit LoanCleared(loanId, ln.status);
                return;
            }
            uint256 due = ln.principal + ln.fee;
            if (due > maxDue) revert OutOfPolicy();
            _repay(l, loanId, ln.agentId, due, token);
        } else if (action == ACTION_PRIORS_CONSENT) {
            _consent(l, l3, params, locked, frozen);
        } else {
            _len(params, 32);
            uint256 agentId = abi.decode(params, (uint256));
            _ownAgent(agentId);
            // No sponsor any more (it unvouched, froze an undrawn line, or handed off): nothing to do, and the spend
            // lands, so that the sponsor cannot hold this vault's key.
            if (POOL.getAgent(agentId).sponsor == 0) return;
            POOL.leave(agentId);
            emit PriorsLeft(agentId);
        }
    }

    /// @dev PriorsConsent: approves, for EIP-1271, the pool's own digest of this vault's consent to an allowed sponsor.
    function _consent(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        bytes calldata params,
        bool locked,
        bool frozen
    ) private {
        _len(params, 128);
        (uint256 agentId, uint256 sponsorId, uint256 maxPremiumBps, uint256 deadline) =
            abi.decode(params, (uint256, uint256, uint256, uint256));
        _ownAgent(agentId);
        if (!OstraVaultV5.allowed(l, OstraVaultV5.ALLOW_SPONSOR, bytes32(sponsorId))) {
            revert NotAllowlisted(OstraVaultV5.ALLOW_SPONSOR);
        }
        if (maxPremiumBps > l.policy.maxFeeBps || maxPremiumBps > MAX_PREMIUM_BPS) revert OutOfPolicy();
        // A consent lets a sponsor open a line, so it waits as a hash approval does (version 3).
        if (frozen) revert Locked();
        uint64 from = uint64(block.timestamp) + (locked ? l3.lock.delay : 0);
        if (deadline <= from || deadline > block.timestamp + MAX_CONSENT_LIFE) revert BadParams();
        bytes32 digest = _consentDigest(agentId, sponsorId, maxPremiumBps, deadline);
        // One consent waits at a time, so the cancels (CancelPendingChanges, guard op 0, a recovery) can drop it.
        OstraVaultV5.dropConsent(l, address(0));
        if (from > block.timestamp) {
            l.pendingConsent = digest;
            l.pendingConsentAt = from;
        }
        l3.hashValidFrom[OstraVaultV3.approvalKey(l3, digest)] = from;
        emit OstraVaultV3.HashApproved(digest, from);
        emit PriorsConsented(agentId, sponsorId, digest, from);
    }

    /// @dev The pool, whose code is pinned, computes the EIP-712 digest of this vault's consent itself, at the agent's
    ///      current nonce.
    function _consentDigest(uint256 agentId, uint256 sponsorId, uint256 maxPremiumBps, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return POOL.consentDigest(
            IPriorsPool.Consent({
                agentId: agentId,
                sponsorId: sponsorId,
                owner: address(this),
                maxPremiumBps: maxPremiumBps,
                nonce: POOL.nonces(agentId),
                deadline: deadline
            })
        );
    }

    function _borrow(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        BorrowParams memory b,
        IERC20 token
    ) private {
        _ownAgent(b.agentId);
        OstraVaultV5.Policy memory p = l.policy;
        IPriorsPool.Agent memory a = POOL.getAgent(b.agentId);
        uint256 debt = a.principalOut + b.amount;
        if (p.maxDebt == 0 || debt > p.maxDebt || b.term > p.maxTerm) revert OutOfPolicy();
        if (!OstraVaultV5.allowed(l, OstraVaultV5.ALLOW_SPONSOR, bytes32(a.sponsor))) {
            revert NotAllowlisted(OstraVaultV5.ALLOW_SPONSOR);
        }
        // The fee (base and premium) never above the policy's rate, whatever the signed maximum.
        uint256 cap = b.amount * p.maxFeeBps * b.term / (10_000 * 30 days);
        if (b.maxFee > cap) b.maxFee = cap;
        if (p.coverBps != 0) {
            uint256 escrowed = _escrowed(b.jobs);
            if (debt * 10_000 > uint256(p.coverBps) * escrowed) revert NotCovered(escrowed);
        }
        uint256 balance = token.balanceOf(address(this));
        uint256 loanId = POOL.borrow(b.agentId, b.amount, b.term, address(this), b.maxFee);
        if (token.balanceOf(address(this)) < balance + b.amount) revert BadTransfer();
        // The fee is paid in full however early the loan is repaid: it counts as value that leaves, now.
        OstraVaultV3.outflow(l3, POOL.getLoan(loanId).fee);
        l.ownLoans[loanId] = true;
        emit PriorsBorrowed(b.agentId, loanId, b.amount, b.term);
    }

    /// @dev The OstraPad budgets (the evaluator fee is apart) this vault provides that are still in escrow: accepted or
    ///      submitted and not past expiry, or decided or appealed with an approval. Ids strictly rising, zeros only at
    ///      the end.
    function _escrowed(bytes32[8] memory jobs) private view returns (uint256 total) {
        bool ended;
        bytes32 previous;
        for (uint256 i = 0; i < COVER_JOBS; ++i) {
            bytes32 id = jobs[i];
            if (id == bytes32(0)) {
                ended = true;
                continue;
            }
            if (ended || uint256(id) <= uint256(previous)) revert BadParams();
            previous = id;
            IOstraPadJobs.Job memory j = PAD.job(id);
            if (j.provider != address(this)) continue;
            bool live = ((j.status == JOB_ACCEPTED || j.status == JOB_SUBMITTED) && block.timestamp < j.expiresAt)
                || ((j.status == JOB_DECIDED || j.status == JOB_APPEALED) && j.approved);
            if (live) total += j.budget;
        }
    }

    /// @dev Repays a loan this vault borrowed, in full: an allowance of exactly what is due, back to zero, and the
    ///      balance down by exactly that.
    function _repay(OstraVaultV5.Layout storage l, uint256 loanId, uint256 agentId, uint256 due, IERC20 token)
        private
    {
        uint256 balance = token.balanceOf(address(this));
        token.forceApprove(address(POOL), due);
        POOL.repay(loanId, agentId, due);
        token.forceApprove(address(POOL), 0);
        // At most what is due left (a sponsor's hook may send something in meanwhile; never a reason to refuse).
        if (token.balanceOf(address(this)) + due < balance) revert BadTransfer();
        delete l.ownLoans[loanId];
        emit PriorsRepaid(agentId, loanId, due, msg.sender);
    }

    function _root(
        OstraVaultV5.Layout storage l,
        OstraVaultV3.Layout storage l3,
        uint8 action,
        bytes calldata params,
        IERC20 token,
        bool frozen
    ) private {
        _priorsReady(token);
        // A new or larger line (or a frozen one reopened, below) puts stake at risk: nothing new while the key may be a
        // thief's.
        if (frozen && (action == ACTION_ROOT_SPONSOR || action == ACTION_ROOT_VOUCH)) revert Locked();
        if (action == ACTION_ROOT_ENROLL || action == ACTION_ROOT_ADD_STAKE) {
            _len(params, 64);
            (uint256 rootId, uint256 assets) = abi.decode(params, (uint256, uint256));
            _ownAgent(rootId);
            if (assets == 0) revert BadParams();
            // Stake can be burnt for a default it backs: it counts as value that leaves.
            OstraVaultV3.outflow(l3, assets);
            uint256 balance = token.balanceOf(address(this));
            token.forceApprove(address(POOL), assets);
            if (action == ACTION_ROOT_ENROLL) POOL.enrollRoot(rootId, assets);
            else POOL.addStake(rootId, assets);
            token.forceApprove(address(POOL), 0);
            if (token.balanceOf(address(this)) + assets < balance) revert BadTransfer();
            emit RootSpent(action, rootId, 0, assets);
        } else if (action == ACTION_ROOT_SPONSOR) {
            _len(params, 352);
            SponsorParams memory s = abi.decode(params, (SponsorParams));
            _ownAgent(s.rootId);
            // The borrower's consent was used meanwhile (an agent spend of this root may copy it from a spend in
            // flight): nothing to do, and the spend lands.
            if (s.nonce != POOL.nonces(s.agentId)) return;
            OstraVaultV5.Policy memory p = l.policy;
            if (s.premiumBps > p.maxPremiumBps) revert OutOfPolicy();
            _vouchRoom(p, s.rootId, s.agentId, s.amount);
            OstraVaultV3.outflow(l3, _sponsorCost(s.rootId, s.agentId, s.amount, s.premiumBps));
            bytes memory sig = s.v == 0 ? bytes("") : abi.encodePacked(s.r, s.s, s.v);
            POOL.vouchWithConsent(
                s.rootId,
                s.agentId,
                s.amount,
                s.premiumBps,
                IPriorsPool.Consent({
                    agentId: s.agentId,
                    sponsorId: s.rootId,
                    owner: s.owner,
                    maxPremiumBps: s.maxPremiumBps,
                    nonce: s.nonce,
                    deadline: s.deadline
                }),
                sig
            );
            emit RootSpent(action, s.rootId, s.agentId, s.amount);
        } else if (action == ACTION_ROOT_VOUCH || action == ACTION_ROOT_UNVOUCH) {
            _len(params, 96);
            (uint256 rootId, uint256 agentId, uint256 amount) = abi.decode(params, (uint256, uint256, uint256));
            _ownAgent(rootId);
            if (action == ACTION_ROOT_VOUCH) {
                _vouchRoom(l.policy, rootId, agentId, amount);
                OstraVaultV3.outflow(l3, _lineCost(amount, POOL.getAgent(agentId).premiumBps));
                POOL.vouch(rootId, agentId, amount);
            } else {
                // The line is gone already (the borrower left, or another root took it over): nothing to do, and the
                // spend lands, so that the borrower cannot hold the root's key.
                if (POOL.getAgent(agentId).sponsor != rootId) return;
                POOL.unvouch(rootId, agentId, amount);
            }
            emit RootSpent(action, rootId, agentId, amount);
        } else if (action == ACTION_ROOT_FREEZE) {
            _len(params, 64);
            (uint256 agentId, bool frozen_) = abi.decode(params, (uint256, bool));
            // Reopening a line is new risk: not while the key may be a thief's. Freezing always works.
            if (frozen && !frozen_) revert Locked();
            // The pool lets only the owner of the agent's sponsor freeze it. No sponsor, or one this vault does not hold
            // (the borrower left, or another root took over): nothing to do, and the spend lands.
            uint256 sponsor = POOL.getAgent(agentId).sponsor;
            if (sponsor == 0 || IDENTITY_REGISTRY.ownerOf(sponsor) != address(this)) return;
            POOL.freeze(agentId, frozen_);
            emit RootSpent(action, 0, agentId, frozen_ ? 1 : 0);
        } else if (action == ACTION_ROOT_UNLOCK) {
            _len(params, 64);
            (uint256 rootId, uint256 shares) = abi.decode(params, (uint256, uint256));
            _ownAgent(rootId);
            uint256 balance = token.balanceOf(address(this));
            uint256 assets = POOL.unlock(rootId, shares, address(this));
            if (token.balanceOf(address(this)) < balance + assets) revert BadTransfer();
            emit RootSpent(action, rootId, 0, assets);
        } else {
            _len(params, 32);
            uint256 rootId = abi.decode(params, (uint256));
            _ownAgent(rootId);
            uint256 balance = token.balanceOf(address(this));
            uint256 amount = POOL.claimSponsorFees(rootId, address(this));
            if (token.balanceOf(address(this)) < balance + amount) revert BadTransfer();
            emit RootSpent(action, rootId, 0, amount);
        }
    }

    /// @dev What a line of `amount` at `premiumBps` puts at risk: a default burns the backer's stake for the principal
    ///      and the unpaid fee, at most the pool's base fee plus the premium for the pool's longest term.
    function _lineCost(uint256 amount, uint256 premiumBps) private view returns (uint256) {
        IPriorsPool.Params memory pp = POOL.getParams();
        return amount + amount * (pp.feeBps + premiumBps) * pp.maxTerm / (10_000 * 30 days);
    }

    /// @dev What a RootSponsor puts at risk: the new part of the line at `premiumBps`, and, when `rootId` already backs
    ///      `agentId`'s line, the higher premium on that line (the premium applies to every later loan on the whole line).
    function _sponsorCost(uint256 rootId, uint256 agentId, uint256 amount, uint256 premiumBps)
        private
        view
        returns (uint256 cost)
    {
        cost = _lineCost(amount, premiumBps);
        IPriorsPool.Agent memory a = POOL.getAgent(agentId);
        if (a.sponsor == rootId && premiumBps > a.premiumBps) {
            cost += a.delegatedIn * (premiumBps - a.premiumBps) * POOL.getParams().maxTerm / (10_000 * 30 days);
        }
    }

    /// @dev A vouch of `amount` from `rootId` to `agentId` keeps the agent's line within vouchPerAgent and the root's
    ///      lines within vouchTotal.
    function _vouchRoom(OstraVaultV5.Policy memory p, uint256 rootId, uint256 agentId, uint256 amount) private view {
        IPriorsPool.Agent memory a = POOL.getAgent(agentId);
        uint256 line = (a.sponsor == rootId ? a.delegatedIn : 0) + amount;
        if (line > p.vouchPerAgent || POOL.getAgent(rootId).delegatedOut + amount > p.vouchTotal) revert OutOfPolicy();
    }

    function _priorsReady(IERC20 token) private view {
        if (address(token) != address(USDG)) revert WrongToken();
        if (address(POOL).codehash != POOL_CODEHASH) revert PoolChanged();
    }

    function _ownAgent(uint256 agentId) private view {
        if (IDENTITY_REGISTRY.ownerOf(agentId) != address(this)) revert NotOwnAgent(agentId);
    }

    // ---------------------------------------------------------------------------------------------
    // Cancels, guardians, recovery
    // ---------------------------------------------------------------------------------------------

    /// @notice Drops the version 5 changes still waiting: CancelPendingChanges (`by` zero) and guard op 0 (`by` the
    ///         guardian or the withdrawal address).
    function cancel(address by) external {
        _onlyDelegated();
        OstraVaultV5.cancelWaiting(OstraVaultV5.layout(), by);
    }

    /// @notice Guard op 7, for a guardian or the withdrawal address `by` (checked by the vault, under its lock): ends the
    ///         agent key and every standing order. params empty.
    function stop(address by, bytes calldata params) external {
        _onlyDelegated();
        _len(params, 0);
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.revokeAgent(l, by);
        OstraVaultV5.stopOrders(l, by);
    }

    /// @notice The withdrawal lock was just turned on (OstraVault, after a SetWithdrawalLock spend): as the hash approvals
    ///         given before it, the agent key and the orders it set stop counting (they may be a thief's).
    function onLockOn() external {
        _onlyDelegated();
        OstraVaultV5.revokeAgent(OstraVaultV5.layout(), address(this));
    }

    /// @notice A guardian recovery reached its threshold (OstraVault.supportRecovery): the key may be a thief's, so the
    ///         version 5 changes waiting, the agent key and every standing order end.
    function onRecovery() external {
        _onlyDelegated();
        OstraVaultV5.Layout storage l = OstraVaultV5.layout();
        OstraVaultV5.cancelWaiting(l, address(this));
        OstraVaultV5.revokeAgent(l, address(this));
        OstraVaultV5.stopOrders(l, address(this));
    }

    /// @notice A Guard spend (24) with op 7 or 8: params abi.encode(address vault, uint8 op, bytes32 arg, uint256 amount),
    ///         arg and amount zero. As a guardian or the withdrawal address of `vault`, calls vault.guard(op, ""); lands
    ///         whatever it answers, as Guard does (only when sent on its own).
    function guardSpend(bytes calldata params) external {
        _onlyDelegated();
        (address vault, uint8 op, bytes32 arg, uint256 amount) = abi.decode(params, (address, uint8, bytes32, uint256));
        if ((op != GUARD_AGENT_STOP && op != GUARD_CLEAR_CRANK) || arg != bytes32(0) || amount != 0) revert BadParams();
        if (vault == address(this) || !OstraVaultV3.isOstraVault(FACTORY, vault)) revert BadParams();
        if (gasleft() < GUARD_MIN_GAS) revert OutOfGas();
        (bool ok, bytes memory ret) = vault.call(abi.encodeCall(IOstraVaultGuarded.guard, (op, bytes(""))));
        // Refused only because the other vault is in the middle of a call (its reentrancy lock): not a refusal on the
        // merits, so the spend reverts and keeps its key, to be sent again.
        if (!ok && ret.length >= 4 && bytes4(ret) == REENTRANT_CALL) _bubble(ret);
        if (!ok) _landed(ret);
        bytes4 reason;
        if (!ok && ret.length >= 4) reason = bytes4(ret);
        emit OstraVaultModule.Guarded(vault, op, ok, reason);
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    function _onlyDelegated() private view {
        if (address(this) == SELF) revert OnlyDelegated();
    }

    function _len(bytes calldata params, uint256 n) private pure {
        if (params.length != n) revert BadParams();
    }

    function _need(OstraVaultV5.Layout storage l, uint8 kind, address a) private view {
        if (!OstraVaultV5.allowed(l, kind, bytes32(uint256(uint160(a))))) revert NotAllowlisted(kind);
    }

    function _bit(OstraVaultV5.Policy memory p, uint8 action) private pure {
        if ((AGENT_ACTIONS & p.actions) >> action & 1 == 0) revert NotAllowed(action);
    }

    function _delegate(address module, bytes memory data) private {
        (bool ok, bytes memory ret) = module.delegatecall(data);
        if (!ok) _bubble(ret);
    }

    function _bubble(bytes memory ret) private pure {
        assembly ("memory-safe") {
            revert(add(ret, 0x20), mload(ret))
        }
    }

    /// @dev A failed Guard spend may land only when it was sent on its own, as a transaction's own call from an account
    ///      with no code (OstraVaultModule._landed).
    function _landed(bytes memory ret) private view {
        if (msg.sender != tx.origin || msg.sender.code.length != 0) _bubble(ret);
    }
}

/// @notice ERC-4626's previewWithdraw: the shares a withdrawal of `assets` burns, rounded up.
interface IERC4626Like {
    function previewWithdraw(uint256 assets) external view returns (uint256);
}
