// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ValidatorRegistry.sol";

/**
 * @title StockExchange — Enhanced with Latency Tracking
 * @notice Executes trades and routes validation through PoS-R validators.
 *         Passes latency (blocks elapsed) and trader address to registry
 *         so the multi-dimensional reputation system can score validators
 *         on speed and conflict-of-interest.
 */
contract StockExchange {

    ValidatorRegistry public registry;

    // ── Trade Struct ─────────────────────────────────────────────────────────
    struct Trade {
        uint256 id;
        address trader;
        string  ticker;
        string  sector;         // BANKING, IT, PHARMA, AUTO, ENERGY
        uint256 amount;         // wei (escrow)
        uint256 quantity;
        bool    isVerified;
        bool    isSuccess;
        address validator;
        uint256 submittedBlock; // block when trade was submitted
        uint256 verifiedBlock;  // block when trade was verified
        uint256 latencyBlocks;  // verifiedBlock - submittedBlock
    }

    uint256 public tradeCounter;
    mapping(uint256 => Trade) public trades;
    uint256[] public tradeIds;

    // ── Events ───────────────────────────────────────────────────────────────
    event TradeSubmitted(uint256 indexed tradeId, address indexed trader, string ticker, string sector, uint256 amount);
    event TradeVerified (uint256 indexed tradeId, address indexed validator, bool success, uint256 latencyBlocks);

    constructor(address _registry) {
        registry = ValidatorRegistry(payable(_registry));
    }

    // ── Submit Trade ─────────────────────────────────────────────────────────
    function submitTrade(
        string calldata ticker,
        string calldata sector,
        uint256 quantity
    ) external payable returns (uint256) {
        require(msg.value > 0,   "Send ETH as trade value");
        require(quantity  > 0,   "Quantity must be > 0");

        tradeCounter++;
        trades[tradeCounter] = Trade({
            id:             tradeCounter,
            trader:         msg.sender,
            ticker:         ticker,
            sector:         sector,
            amount:         msg.value,
            quantity:       quantity,
            isVerified:     false,
            isSuccess:      false,
            validator:      address(0),
            submittedBlock: block.number,
            verifiedBlock:  0,
            latencyBlocks:  0
        });
        tradeIds.push(tradeCounter);
        emit TradeSubmitted(tradeCounter, msg.sender, ticker, sector, msg.value);
        return tradeCounter;
    }

    // ── Verify Trade ─────────────────────────────────────────────────────────
    function verifyTrade(
        uint256 tradeId,
        bool success,
        ValidatorRegistry.FailureSeverity severity
    ) external {
        require(tradeId <= tradeCounter && tradeId > 0, "Invalid trade ID");
        Trade storage t = trades[tradeId];
        require(!t.isVerified, "Already verified");

        address currentVal = registry.currentValidator();
        require(msg.sender == currentVal, "Only current validator");

        // ── Compute latency ──────────────────────────────────────────────────
        uint256 latency = block.number - t.submittedBlock;

        t.isVerified    = true;
        t.isSuccess     = success;
        t.validator     = msg.sender;
        t.verifiedBlock = block.number;
        t.latencyBlocks = latency;

        // ── Update multi-dimensional reputation ──────────────────────────────
        registry.updateReputation(
            msg.sender,
            success,
            severity,
            latency,
            t.trader        // passed for collusion detection
        );

        // ── Settlement ───────────────────────────────────────────────────────
        if (success) {
            // Return escrow to trader on success
            payable(t.trader).transfer(t.amount);
        }
        // On failure: funds held in contract (escrow / penalty logic)

        emit TradeVerified(tradeId, msg.sender, success, latency);
    }

    // ── Validator Selection ──────────────────────────────────────────────────
    function triggerValidatorSelection() external returns (address) {
        return registry.selectValidator();
    }

    // ── Views ────────────────────────────────────────────────────────────────
    function getTrade(uint256 tradeId) external view returns (Trade memory) {
        return trades[tradeId];
    }

    function getAllTrades() external view returns (Trade[] memory) {
        Trade[] memory all = new Trade[](tradeIds.length);
        for (uint i = 0; i < tradeIds.length; i++) {
            all[i] = trades[tradeIds[i]];
        }
        return all;
    }

    function getTradeCount() external view returns (uint256) { return tradeCounter; }

    receive() external payable {}
}
