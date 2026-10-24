// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IOstraVaultFactory, IOstraVaultView, OstraVaultV3} from "./OstraVaultV3.sol";
import {IMorphoBlue, IOstraVaultGuarded, IVaultV2Factory, MarketParams} from "./OstraVaultModule.sol";

/// @notice What OstraBreaker reads of a Morpho Vault V2 (vault-v2 src/VaultV2.sol).
interface IVaultV2Watched {
    function asset() external view returns (address);
    function totalAssets() external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function liquidityAdapter() external view returns (address);
    function liquidityData() external view returns (bytes memory);
    function lastUpdate() external view returns (uint64);
}

/// @notice What OstraBreaker reads of a MorphoMarketV1AdapterV2 (vault-v2 src/adapters/MorphoMarketV1AdapterV2.sol).
interface IMarketAdapterWatched {
    function parentVault() external view returns (address);
    function adaptiveCurveIrm() external view returns (address);
    function expectedSupplyAssets(bytes32 marketId) external view returns (uint256);
}

/// @notice MorphoMarketV1AdapterV2Factory: whether an address is a market adapter it created.
interface IMarketAdapterFactory {
    function isMorphoMarketV1AdapterV2(address account) external view returns (bool);
}

/// @title OstraBreaker
/// @notice An automatic way out of a Morpho Vault V2 for Ostra vaults that lend into one (Strategy 3, the guardian
///         breaker). An Ostra vault opts in by making this contract one of its guardians, signing its limits for a
///         Vault V2 (an EIP-1271 approval, ApproveHash) and turning its withdrawal lock on (a guardian's powers need
///         the lock). From then on anyone may call trip(vault, target): when one of the vault's limits is crossed on
///         chain, this contract calls the vault's guard op 3, which redeems the vault's shares of `target` back into
///         the vault itself. The value never leaves the vault: a trip that was not needed only costs a new Lend.
///         It never supports a recovery, never cancels or sweeps (guard ops 0 to 2, 4), has no owner and holds nothing.
///
/// Limits, per vault and Vault V2, in basis points; 0 turns a limit off:
/// * priceDropBps: the share price (previewRedeem of PRICE_SCALE whole shares) fell more than this below its highest
///   mark. The mark is the highest price this contract has read for `target` (configure, poke, trip). A Vault V2's
///   price only falls when it realizes a loss or its management fee outruns its interest, and a donation cannot push it
///   up faster than the vault's maxRate allows, so raising the mark by anyone is safe.
/// * assetsDropBps: the Vault V2's totalAssets fell more than this below its assets mark: a run on the vault. The mark
///   is `assetsMarkCap`, which the vault signs (its totalAssets when it signs), so a run is measured from the signing,
///   also while an approval made under the lock waits its delay; after a trip it only goes down, to the total then. So
///   a deposit made only to raise it, then withdrawn, cannot fake a run. As the Vault V2 grows, the limit only gets
///   less sensitive until the vault signs new limits. An approval that was never sent stays valid at its nonce, so a
///   vault replacing limits it approved but did not send withdraws the older approval first (ApproveHash, false):
///   sent later, an old cap above today's total trips the vault, which only redeems it into itself.
/// * maxUtilizationBps: the liquidity market (the market of the Vault V2's liquidity adapter, which serves exits)
///   is used at least this much: its borrowers hold so much that exits can soon find no liquidity.
/// * minLiquidityBps: what the Vault V2 can pay out now (its idle assets and the liquidity adapter's position, at most
///   its market's free liquidity) is below this many basis points of the vault's position (20_000: twice it).
///
/// Settled state only: a flash loan can move a market's use and a Vault V2's totals for one transaction and put them
/// back. So ASSETS counts only when the Vault V2 was not touched in this block's second (its lastUpdate is older), and
/// UTILIZATION and LIQUIDITY only when neither the Vault V2 nor its liquidity market was (the market's lastUpdate is
/// older too): what a trip sees then held from an earlier block, which a flash loan cannot do. PRICE needs no such rule
/// (a price falls only on a real loss). A trip that is refused for this is simply sent again a second later; anyone
/// touching the Vault V2 or its market every second can delay those three, never PRICE, and the owner can always
/// redeem itself (Redeem). A trip that reads settled state keeps it for the rest of that second (the target's snapshot):
/// the next vault's trip in the same second, which the first one's redeem has touched, is judged on it, so a crisis
/// lets every watching vault out in the same second. The snapshot is taken before anything in that second could move
/// what it holds. The Vault V2's allocator, which can point its liquidity adapter at another market without accruing,
/// is trusted here as it is by every depositor.
///
/// A trip redeems as much of the position as can be paid out now (all of it when it fits), so a trip in a nearly empty
/// market takes what is there and can be called again. The limits are signed for this contract, this chain, the
/// vault, `target` and the next nonce of that vault and target here, so an approval works once.
contract OstraBreaker is ReentrancyGuardTransient {
    /// @notice A vault's limits for one Vault V2, in basis points (0: that limit is off).
    struct Limits {
        uint16 priceDropBps;
        uint16 assetsDropBps;
        uint16 maxUtilizationBps;
        uint32 minLiquidityBps;
        /// @notice The highest the assets mark may be (0 only with assetsDropBps 0).
        uint128 assetsMarkCap;
    }

    /// @notice What the breaker watches for a vault and a Vault V2.
    struct Watch {
        Limits limits;
        uint256 assetsMark;
    }

    /// @notice What check() reads now.
    struct State {
        uint256 price;
        uint256 priceMark;
        uint256 totalAssets;
        uint256 assetsMark;
        uint256 utilizationBps;
        bool hasLiquidityMarket;
        uint256 payout;
        uint256 shares;
        uint256 position;
        /// @notice The Vault V2, or its liquidity market, was touched in this block's second: only PRICE counts for
        ///         what was (see "Settled state only").
        bool vaultTouched;
        bool marketTouched;
        /// @notice ASSETS, UTILIZATION and LIQUIDITY were judged on the target's snapshot of this second (snapshotOf);
        ///         totalAssets, utilizationBps and payout above are the live readings all the same.
        bool fromSnapshot;
        uint8 reasons;
    }

    /// @notice A target's settled readings, taken by the first trip in a second that found them settled.
    struct Snapshot {
        uint64 at;
        bool hasLiquidityMarket;
        uint32 utilizationBps;
        uint128 totalAssets;
        uint128 payout;
    }

    uint8 public constant PRICE = 1;
    uint8 public constant ASSETS = 2;
    uint8 public constant UTILIZATION = 4;
    uint8 public constant LIQUIDITY = 8;

    uint256 public constant BPS = 10_000;
    /// @notice The most minLiquidityBps may be: 100 times the position.
    uint32 public constant MAX_LIQUIDITY_BPS = 1_000_000;
    /// @notice The shares a price is read for: a billion shares of the Vault V2's smallest units of a whole share.
    uint256 public constant PRICE_SCALE = 1e9;

    bytes20 private constant DOMAIN = "OSTRA/BREAKER/EVM/v1";
    bytes4 private constant EIP1271_MAGIC = 0x1626ba7e;
    /// @dev OstraVaultModule.guard op 3: redeem Vault V2 shares back into the vault.
    uint8 private constant GUARD_REDEEM = 3;

    /// @notice The OstraVaultFactory every vault this breaker serves comes from.
    IOstraVaultFactory public immutable FACTORY;
    /// @notice Morpho's VaultV2Factory: a watched target must be a Vault V2 it made.
    IVaultV2Factory public immutable VAULT_V2_FACTORY;
    /// @notice Morpho Blue, where a liquidity adapter's market is read.
    IMorphoBlue public immutable MORPHO;
    /// @notice MorphoMarketV1AdapterV2Factory: only a liquidity adapter it made is read as a market adapter.
    IMarketAdapterFactory public immutable ADAPTER_FACTORY;

    mapping(address vault => mapping(address target => uint64)) public nonces;
    mapping(address target => uint256) public priceMark;
    mapping(address vault => mapping(address target => Watch)) private watches;
    mapping(address target => Snapshot) private snapshots;

    event Watched(address indexed vault, address indexed target, Limits limits, uint256 assetsMark, uint64 nonce);
    event Unwatched(address indexed vault, address indexed target, uint64 nonce);
    event PriceMarked(address indexed target, uint256 price);
    event Tripped(address indexed vault, address indexed target, uint8 reasons, uint256 shares, address indexed by);

    error NotOstraVault();
    error BadTarget();
    error BadLimits();
    error NotSigned();
    error NotWatched();
    error NothingLent();
    error Healthy();
    error NothingPayable();

    constructor(address factory, address vaultV2Factory, address morpho, address adapterFactory) {
        if (factory.code.length == 0 || vaultV2Factory.code.length == 0 || morpho.code.length == 0 || adapterFactory.code.length == 0) {
            revert BadTarget();
        }
        FACTORY = IOstraVaultFactory(factory);
        VAULT_V2_FACTORY = IVaultV2Factory(vaultV2Factory);
        MORPHO = IMorphoBlue(morpho);
        ADAPTER_FACTORY = IMarketAdapterFactory(adapterFactory);
    }

    // ---------------------------------------------------------------------------------------------
    // Limits
    // ---------------------------------------------------------------------------------------------

    /// @notice The hash `vault` approves (ApproveHash) to set `limits` for `target` at nonce `nonce`.
    function limitsHash(address vault, address target, Limits calldata limits, uint64 nonce) public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN, block.chainid, address(this), vault, target, limits, nonce));
    }

    /// @notice Sets `vault`'s limits for `target`, as the vault approved them (EIP-1271) for the next nonce of that vault
    ///         and target here; all four limits 0 stop watching. Anyone may send it. The assets mark is the signed
    ///         assetsMarkCap.
    function configure(address vault, address target, Limits calldata limits) external nonReentrant {
        if (!OstraVaultV3.isOstraVault(FACTORY, vault)) revert NotOstraVault();
        if (!VAULT_V2_FACTORY.isVaultV2(target) || IVaultV2Watched(target).asset() != IOstraVaultView(vault).token()) {
            revert BadTarget();
        }
        if (
            limits.priceDropBps >= BPS || limits.assetsDropBps >= BPS || limits.maxUtilizationBps > BPS
                || limits.minLiquidityBps > MAX_LIQUIDITY_BPS || (limits.assetsDropBps != 0 && limits.assetsMarkCap == 0)
        ) revert BadLimits();
        uint64 nonce = nonces[vault][target];
        if (IERC1271(vault).isValidSignature(limitsHash(vault, target, limits, nonce), "") != EIP1271_MAGIC) {
            revert NotSigned();
        }
        nonces[vault][target] = nonce + 1;
        Watch storage w = watches[vault][target];
        if (limits.priceDropBps == 0 && limits.assetsDropBps == 0 && limits.maxUtilizationBps == 0 && limits.minLiquidityBps == 0)
        {
            delete watches[vault][target];
            emit Unwatched(vault, target, nonce);
            return;
        }
        w.limits = limits;
        w.assetsMark = limits.assetsMarkCap;
        _markPrice(target);
        emit Watched(vault, target, limits, w.assetsMark, nonce);
    }

    /// @notice `target`'s snapshot (at: the second it was taken; only that second's trips use it).
    function snapshotOf(address target) external view returns (Snapshot memory) {
        return snapshots[target];
    }

    /// @notice What the breaker watches for `vault` and `target` (all limits 0: nothing).
    function watchOf(address vault, address target) external view returns (Watch memory) {
        return watches[vault][target];
    }

    /// @notice Raises `target`'s price mark to its price now, if that is higher. Anyone may call it.
    function poke(address target) external nonReentrant {
        if (!VAULT_V2_FACTORY.isVaultV2(target)) revert BadTarget();
        _markPrice(target);
    }

    // ---------------------------------------------------------------------------------------------
    // Check and trip
    // ---------------------------------------------------------------------------------------------

    /// @notice What a trip of `vault` out of `target` would find now: `reasons` is the limits crossed (PRICE, ASSETS,
    ///         UTILIZATION, LIQUIDITY), against the price mark as it stands (a trip raises it first).
    function check(address vault, address target) public view returns (State memory s) {
        Watch storage w = watches[vault][target];
        Limits memory l = w.limits;
        s = _read(vault, target);
        s.priceMark = priceMark[target];
        s.assetsMark = w.assetsMark;
        // What ASSETS, UTILIZATION and LIQUIDITY are judged on: the live readings when settled, else this second's
        // snapshot when a trip took one, else nothing (only PRICE counts).
        bool vaultSettled = !s.vaultTouched;
        bool settled = vaultSettled && !s.marketTouched;
        Snapshot memory j = snapshots[target];
        if (!settled && j.at == block.timestamp) {
            (settled, vaultSettled, s.fromSnapshot) = (true, true, true);
        } else {
            j = _snapshot(s);
        }

        if (l.priceDropBps != 0 && s.price * BPS < s.priceMark * (BPS - l.priceDropBps)) s.reasons |= PRICE;
        if (l.assetsDropBps != 0 && vaultSettled && uint256(j.totalAssets) * BPS < s.assetsMark * (BPS - l.assetsDropBps)) {
            s.reasons |= ASSETS;
        }
        if (l.maxUtilizationBps != 0 && settled && j.hasLiquidityMarket && j.utilizationBps >= l.maxUtilizationBps) {
            s.reasons |= UTILIZATION;
        }
        if (l.minLiquidityBps != 0 && settled && s.position != 0 && uint256(j.payout) * BPS < s.position * l.minLiquidityBps) {
            s.reasons |= LIQUIDITY;
        }
    }

    /// @dev `s`'s readings as a snapshot of this second. The narrowing saturates (utilization is at most BPS; a
    ///      total or payout above uint128 cannot exist in a Vault V2, whose totals are uint128).
    function _snapshot(State memory s) private view returns (Snapshot memory) {
        return Snapshot({
            at: uint64(block.timestamp),
            hasLiquidityMarket: s.hasLiquidityMarket,
            utilizationBps: s.utilizationBps > type(uint32).max ? type(uint32).max : uint32(s.utilizationBps),
            totalAssets: s.totalAssets > type(uint128).max ? type(uint128).max : uint128(s.totalAssets),
            payout: s.payout > type(uint128).max ? type(uint128).max : uint128(s.payout)
        });
    }

    /// @dev The live readings of `target` and `vault`'s position in it (no marks, no reasons).
    function _read(address vault, address target) private view returns (State memory s) {
        IVaultV2Watched t = IVaultV2Watched(target);
        s.price = _price(target);
        s.totalAssets = t.totalAssets();
        s.shares = IERC20(target).balanceOf(vault);
        s.position = s.shares == 0 ? 0 : t.previewRedeem(s.shares);
        uint256 idle = IERC20(t.asset()).balanceOf(target);
        (bool has, uint256 fromMarket, uint256 utilization, bool marketTouched) = _liquidityMarket(t);
        s.hasLiquidityMarket = has;
        s.utilizationBps = utilization;
        s.payout = idle + fromMarket;
        s.vaultTouched = t.lastUpdate() >= block.timestamp;
        s.marketTouched = marketTouched;
    }

    /// @notice When one of `vault`'s limits for `target` is crossed, redeems the vault's shares of `target` back into
    ///         the vault (guard op 3), as many as `target` can pay out now. Anyone may call it. Refused when the vault
    ///         does not watch `target`, holds none of its shares, no limit is crossed, or nothing can be paid out; the
    ///         vault itself refuses when this contract is not its guardian or its lock is off.
    function trip(address vault, address target) external nonReentrant returns (uint8 reasons, uint256 shares) {
        Watch storage w = watches[vault][target];
        Limits memory l = w.limits;
        if (l.priceDropBps == 0 && l.assetsDropBps == 0 && l.maxUtilizationBps == 0 && l.minLiquidityBps == 0) {
            revert NotWatched();
        }
        _markPrice(target);
        State memory s = check(vault, target);
        if (s.shares == 0) revert NothingLent();
        if (s.reasons == 0) revert Healthy();
        reasons = s.reasons;
        // All the shares when they fit what can be paid out; else the most whose value fits it less one unit, which
        // Morpho Blue's share rounding can leave behind (previewDeposit rounds down, so previewRedeem of the result is
        // at most that). Shares that would redeem for nothing are never given up.
        if (s.position <= s.payout) {
            shares = s.shares;
        } else {
            shares = s.payout > 1 ? IVaultV2Watched(target).previewDeposit(s.payout - 1) : 0;
            if (shares > s.shares) shares = s.shares;
        }
        if (shares == 0 || IVaultV2Watched(target).previewRedeem(shares) == 0) revert NothingPayable();
        // Settled readings, read before this redeem touches the target: kept for the other vaults' trips this second.
        if (!s.vaultTouched && !s.marketTouched) {
            snapshots[target] = _snapshot(s);
        }
        IOstraVaultGuarded(vault).guard(GUARD_REDEEM, abi.encode(target, shares));
        // A run measured from here on (the vault may lend again without tripping at once), never from higher than
        // before: a deposit made just before the trip cannot raise the mark.
        uint256 total = IVaultV2Watched(target).totalAssets();
        if (total < w.assetsMark) w.assetsMark = total;
        emit Tripped(vault, target, reasons, shares, msg.sender);
    }

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    function _price(address target) private view returns (uint256) {
        return IVaultV2Watched(target).previewRedeem(PRICE_SCALE * 10 ** IERC20Metadata(target).decimals());
    }

    function _markPrice(address target) private {
        uint256 p = _price(target);
        if (p > priceMark[target]) {
            priceMark[target] = p;
            emit PriceMarked(target, p);
        }
    }

    /// @dev The liquidity adapter's market, when the adapter is a MorphoMarketV1AdapterV2 of `t` and its liquidity data
    ///      names a market of `t`'s asset on the adapter's IRM that Morpho Blue has: what an exit can take from it now
    ///      (the adapter's position, at most the market's free liquidity), the market's use in basis points, and
    ///      whether it was touched in this block's second. Otherwise an exit has only the idle assets.
    function _liquidityMarket(IVaultV2Watched t) private view returns (bool, uint256, uint256, bool) {
        address a = t.liquidityAdapter();
        if (a == address(0) || !ADAPTER_FACTORY.isMorphoMarketV1AdapterV2(a)) return (false, 0, 0, false);
        IMarketAdapterWatched adapter = IMarketAdapterWatched(a);
        if (adapter.parentVault() != address(t)) return (false, 0, 0, false);
        bytes memory data = t.liquidityData();
        if (data.length != 160) return (false, 0, 0, false);
        MarketParams memory m = abi.decode(data, (MarketParams));
        if (m.loanToken != t.asset() || m.irm != adapter.adaptiveCurveIrm()) return (false, 0, 0, false);
        bytes32 id = keccak256(abi.encode(m));
        IMorphoBlue.Market memory mk = MORPHO.market(id);
        if (mk.lastUpdate == 0) return (false, 0, 0, false);
        uint256 free = mk.totalSupplyAssets > mk.totalBorrowAssets ? mk.totalSupplyAssets - mk.totalBorrowAssets : 0;
        uint256 supplied = adapter.expectedSupplyAssets(id);
        uint256 utilization =
            mk.totalSupplyAssets == 0 ? 0 : uint256(mk.totalBorrowAssets) * BPS / mk.totalSupplyAssets;
        return (true, supplied < free ? supplied : free, utilization, mk.lastUpdate >= block.timestamp);
    }
}
