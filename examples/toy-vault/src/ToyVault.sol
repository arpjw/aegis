// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================================
// Minimal interfaces
// ============================================================================

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Chainlink AggregatorV3Interface (abridged).
interface IAggregatorV3 {
    function latestRoundData()
        external
        view
        returns (
            uint80  roundId,
            int256  answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80  answeredInRound
        );
}

// ============================================================================
// Minimal ERC-20 (share token base)
// ============================================================================

abstract contract ERC20 {
    string  public name;
    string  public symbol;
    uint8   public constant decimals = 18;

    uint256 internal _totalSupply;
    mapping(address => uint256) internal _balances;
    mapping(address => mapping(address => uint256)) internal _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_) {
        name   = name_;
        symbol = symbol_;
    }

    function totalSupply()                               public view returns (uint256)  { return _totalSupply; }
    function balanceOf(address a)                        public view returns (uint256)  { return _balances[a]; }
    function allowance(address o, address s)             public view returns (uint256)  { return _allowances[o][s]; }

    function approve(address spender, uint256 amount) public returns (bool) {
        _allowances[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) public returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) _allowances[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(_balances[from] >= amount, "ERC20: insufficient balance");
        unchecked {
            _balances[from] -= amount;
            _balances[to]   += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal {
        _totalSupply  += amount;
        _balances[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _burn(address from, uint256 amount) internal {
        require(_balances[from] >= amount, "ERC20: insufficient balance");
        unchecked {
            _balances[from] -= amount;
            _totalSupply    -= amount;
        }
        emit Transfer(from, address(0), amount);
    }
}

// ============================================================================
// ToyVault -- ERC-4626-style yield vault with three intentional defects.
// See examples/toy-vault/README.md for full documentation.
// DO NOT DEPLOY.
// ============================================================================

/**
 * @title  ToyVault
 * @notice Minimal yield vault that accepts a single ERC-20 asset, issues
 *         proportional shares, charges a withdrawal fee, and exposes an
 *         oracle-derived asset price view.
 *
 * @dev    Three intentional security and gas defects have been planted for
 *         use as an Aegis audit tooling demonstration. They are documented
 *         with inline DEFECT markers and in the accompanying README.
 */
contract ToyVault is ERC20 {

    // =========================================================================
    // DEFECT 3 -- Sub-optimal storage layout (GAS finding)
    //
    // The six mutable state variables below are declared in an order that
    // forces the EVM to use six separate 32-byte storage slots:
    //
    //   slot n+0  oracle          address  (20 B used, 12 B wasted)
    //   slot n+1  feeRate         uint256  (32 B, fully used)
    //   slot n+2  totalFees       uint256  (32 B, fully used)
    //   slot n+3  depositsPaused  bool     ( 1 B used, 31 B wasted)
    //   slot n+4  withdrawsPaused bool     ( 1 B used, 31 B wasted)
    //   slot n+5  feeRecipient    address  (20 B used, 12 B wasted)
    //
    // Optimal ordering packs slots n+0 and n+3/n+4 together, and packs
    // feeRecipient into its own slot, reducing the total from 6 to 4 slots:
    //
    //   slot n+0  oracle (20 B) + depositsPaused (1 B) + withdrawsPaused (1 B)
    //   slot n+1  feeRate (32 B)
    //   slot n+2  totalFees (32 B)
    //   slot n+3  feeRecipient (20 B)
    //
    // Every function that reads two or more of these fields pays an avoidable
    // cold SLOAD (2,100 gas) per wasted slot. deposit() and redeem() each
    // read four of these variables, incurring ~4,200 excess gas per call
    // relative to a packed layout.
    // =========================================================================
    address public oracle;            // slot n+0  (20 B, 12 B wasted)
    uint256 public feeRate;           // slot n+1  (full)
    uint256 public totalFees;         // slot n+2  (full)
    bool    public depositsPaused;    // slot n+3  (1 B, 31 B wasted)
    bool    public withdrawsPaused;   // slot n+4  (1 B, 31 B wasted)
    address public feeRecipient;      // slot n+5  (20 B, 12 B wasted)

    IERC20 public immutable asset;

    // =========================================================================
    // Events (follows ERC-4626 event signatures)
    // =========================================================================
    event Deposit(
        address indexed caller,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );
    event Withdraw(
        address indexed caller,
        address indexed receiver,
        address indexed owner,
        uint256 assets,
        uint256 shares
    );

    // =========================================================================
    // Constructor
    // =========================================================================
    constructor(
        address asset_,
        address oracle_,
        address feeRecipient_,
        uint256 feeRate_          // basis points; 100 == 1 %
    ) ERC20("ToyVault Shares", "tvSHARES") {
        asset        = IERC20(asset_);
        oracle       = oracle_;
        feeRecipient = feeRecipient_;
        feeRate      = feeRate_;
    }

    // =========================================================================
    // DEFECT 2 -- Missing Chainlink oracle staleness check (HIGH / P1)
    //
    // latestRoundData() returns five values. This implementation silently
    // discards updatedAt and answeredInRound and only inspects answer.
    //
    // Missing checks:
    //   (a) updatedAt staleness window:
    //       require(block.timestamp - updatedAt <= MAX_STALENESS, "stale");
    //   (b) Round completeness:
    //       require(answeredInRound >= roundId, "incomplete round");
    //   (c) L2 sequencer uptime (required on Arbitrum, Optimism, Base):
    //       check the Chainlink Sequencer Uptime Feed before using any price.
    //
    // Impact: a feed that stops updating returns its last committed price
    // indefinitely. For feeds with a 1-hour heartbeat, an outage of 90 minutes
    // produces a silently accepted stale price. Any protocol logic that relies
    // on assetPrice() for share valuation, collateral checks, or liquidations
    // is exploitable during a feed outage.
    // =========================================================================
    function assetPrice() public view returns (uint256) {
        (, int256 answer, , , ) = IAggregatorV3(oracle).latestRoundData();
        // updatedAt and answeredInRound are discarded -- staleness not checked.
        require(answer > 0, "ToyVault: non-positive price");
        return uint256(answer);
    }

    // =========================================================================
    // Vault accounting
    // =========================================================================

    /// @notice Total assets under management, net of accrued fees.
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) - totalFees;
    }

    // =========================================================================
    // DEFECT 1 -- ERC-4626 share inflation attack (CRITICAL / P0)
    //
    // The share conversion functions below implement the naive ERC-4626 ratio
    // without a virtual-shares offset. This exposes the classic "first
    // depositor" inflation attack:
    //
    //   Step 1. Attacker deposits 1 wei; receives 1 share (zero-supply path).
    //   Step 2. Attacker transfers D tokens directly to the vault address
    //           (not via deposit), inflating totalAssets to D+1 without
    //           minting new shares.
    //   Step 3. Victim deposits V tokens:
    //             shares = V * 1 / (D+1)
    //           For V <= D this rounds down to 0, reverting the victim's deposit.
    //           For V > D the victim receives 1 share -- the same as the attacker.
    //   Step 4. Attacker redeems 1 of 2 shares for ~(D+1+V)/2 tokens, profiting
    //           at the victim's expense.
    //
    // Mitigation -- virtual shares (OpenZeppelin ERC4626 v5 default):
    //   shares = assets * (supply + 10**offset) / (totalAssets + 1)
    //
    // The offset shifts the precision floor far below any realistic deposit,
    // making rounding-based extraction economically infeasible.
    // =========================================================================
    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = _totalSupply;
        if (supply == 0) return assets;
        return assets * supply / totalAssets();   // rounds down -- no virtual offset
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = _totalSupply;
        if (supply == 0) return shares;
        return shares * totalAssets() / supply;   // rounds down -- no virtual offset
    }

    // =========================================================================
    // Core vault operations
    // =========================================================================

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        require(!depositsPaused, "ToyVault: deposits paused");
        shares = convertToShares(assets);
        require(shares > 0, "ToyVault: zero shares minted");
        asset.transferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner_)
        external
        returns (uint256 assets)
    {
        require(!withdrawsPaused, "ToyVault: withdrawals paused");
        if (msg.sender != owner_) _allowances[owner_][msg.sender] -= shares;

        assets = convertToAssets(shares);
        uint256 fee = assets * feeRate / 10_000;
        totalFees  += fee;

        _burn(owner_, shares);
        asset.transfer(receiver, assets - fee);
        emit Withdraw(msg.sender, receiver, owner_, assets, shares);
    }

    // =========================================================================
    // Admin -- unprotected (bonus findings; access control missing throughout)
    // =========================================================================

    /// @dev Any caller can replace the price oracle. Missing: onlyOwner.
    function setOracle(address oracle_) external {
        oracle = oracle_;
    }

    /// @dev Any caller can pause deposits. Missing: onlyOwner.
    function setDepositsPaused(bool paused) external {
        depositsPaused = paused;
    }

    /// @dev Any caller can pause withdrawals. Missing: onlyOwner.
    function setWithdrawalsPaused(bool paused) external {
        withdrawsPaused = paused;
    }

    /// @dev Transfers accrued fees to feeRecipient. No access control.
    function collectFees() external {
        uint256 fees = totalFees;
        totalFees = 0;
        asset.transfer(feeRecipient, fees);
    }
}
