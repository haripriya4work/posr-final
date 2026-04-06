// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract ValidatorRegistry {

    // ── Enums ────────────────────────────────────────────────────────────────
    enum FailureSeverity  { NONE, LAZY, MALICIOUS }
    enum ComplianceLevel  { UNVERIFIED, KYC_DONE, CLEAN_RECORD, SEBI_FLAGGED }

    // ── Structs ──────────────────────────────────────────────────────────────
    struct Validator {
        address addr;

        // Economic
        uint256 stake;                  // ETH staked (wei)
        uint256 stakeAtRegistration;    // for R_consistency

        // Multi-dimensional reputation sub-scores (0–100 each)
        int256  R_accuracy;             // correctness score
        int256  R_latency;              // speed score
        int256  R_integrity;            // collusion resistance
        int256  R_compliance;           // regulatory compliance
        int256  R_consistency;          // stake stability

        // Activity tracking
        bool    isActive;
        bool    isSlashed;
        uint256 successStreak;
        uint256 failureStreak;
        uint256 lastActiveBlock;
        uint256 totalVerifications;

        // Collusion detection
        uint256 collusionFlags;         // how many times flagged
    }

    // ── State ────────────────────────────────────────────────────────────────
    address public owner;
    address public exchange;

    mapping(address => Validator)               public validators;
    mapping(address => ComplianceLevel)         public complianceLevel;
    // validator → trader → count of verifications
    mapping(address => mapping(address => uint256)) public validatorTraderCount;

    address[] public validatorList;
    address   public currentValidator;

    // Weight config (basis points, α for stake vs reputation)
    uint256 public stakeWeight_bps      = 7500;   // α = 0.75
    uint256 public reputationWeight_bps = 2500;   // 1−α = 0.25

    // Reputation sub-score weights (basis points, sum = 10000)
    uint256 public w1_accuracy    = 3500;
    uint256 public w2_latency     = 2500;
    uint256 public w3_integrity   = 2500;
    uint256 public w4_compliance  = 1000;
    uint256 public w5_consistency = 500;

    uint256 public slashPercent   = 50;
    uint256 public decayInterval  = 100;   // blocks

    // Volatility flag: 0=normal, 1=elevated, 2=extreme (budget/RBI day)
    uint8   public marketVolatility = 0;

    // Collusion threshold: if validator verifies same trader > X% → flag
    uint256 public collusionThresholdPct = 40;

    // ── Events ───────────────────────────────────────────────────────────────
    event ValidatorRegistered   (address indexed validator, uint256 stake);
    event ValidatorSelected     (address indexed validator, uint256 weight);
    event ReputationUpdated     (address indexed validator, int256 delta, int256 newComposite, FailureSeverity severity);
    event ValidatorSlashed      (address indexed validator, uint256 slashedAmount);
    event WeightConfigUpdated   (uint256 stakeWeight_bps, uint256 repWeight_bps);
    event ComplianceUpdated     (address indexed validator, ComplianceLevel level);
    event ConflictOfInterest    (address indexed validator, address indexed trader, uint256 pct);
    event VolatilityUpdated     (uint8 level);
    event SubScoresUpdated      (address indexed validator, int256 acc, int256 lat, int256 integ, int256 comp, int256 cons);

    // ── Modifiers ────────────────────────────────────────────────────────────
    modifier onlyOwner()    { require(msg.sender == owner,                          "Not owner");    _; }
    modifier onlyExchange() { require(msg.sender == exchange || msg.sender == owner,"Not exchange"); _; }

    constructor() { owner = msg.sender; }

    // ── Admin ────────────────────────────────────────────────────────────────
    function setExchange(address _exchange) external onlyOwner {
        exchange = _exchange;
    }

    function setWeightConfig(uint256 _stakeBps, uint256 _repBps) external onlyOwner {
        require(_stakeBps + _repBps == 10000, "Must sum to 10000");
        stakeWeight_bps      = _stakeBps;
        reputationWeight_bps = _repBps;
        emit WeightConfigUpdated(_stakeBps, _repBps);
    }

    function setSubScoreWeights(
        uint256 _w1, uint256 _w2, uint256 _w3, uint256 _w4, uint256 _w5
    ) external onlyOwner {
        require(_w1+_w2+_w3+_w4+_w5 == 10000, "Must sum to 10000");
        w1_accuracy=_w1; w2_latency=_w2; w3_integrity=_w3;
        w4_compliance=_w4; w5_consistency=_w5;
    }

    function setComplianceLevel(address _val, ComplianceLevel _level) external onlyOwner {
        complianceLevel[_val] = _level;
        Validator storage v = validators[_val];

        // Apply compliance effect to R_compliance sub-score
        if (_level == ComplianceLevel.UNVERIFIED)   v.R_compliance = 30;
        if (_level == ComplianceLevel.KYC_DONE)     v.R_compliance = 50;
        if (_level == ComplianceLevel.CLEAN_RECORD) v.R_compliance = 80;
        if (_level == ComplianceLevel.SEBI_FLAGGED) { v.R_compliance = 0; v.isActive = false; }

        emit ComplianceUpdated(_val, _level);
    }

    function setMarketVolatility(uint8 _level) external onlyOwner {
        require(_level <= 2, "Max level 2");
        marketVolatility = _level;
        emit VolatilityUpdated(_level);
    }

    function setCollusionThreshold(uint256 _pct) external onlyOwner {
        require(_pct > 0 && _pct <= 100, "Invalid pct");
        collusionThresholdPct = _pct;
    }

    // ── Registration ─────────────────────────────────────────────────────────
    function registerValidator() external payable {
        require(msg.value >= 1 ether,           "Min stake: 1 ETH");
        require(!validators[msg.sender].isActive,"Already registered");

        validators[msg.sender] = Validator({
            addr:               msg.sender,
            stake:              msg.value,
            stakeAtRegistration:msg.value,
            R_accuracy:         50,
            R_latency:          50,
            R_integrity:        50,
            R_compliance:       50,
            R_consistency:      50,
            isActive:           true,
            isSlashed:          false,
            successStreak:      0,
            failureStreak:      0,
            lastActiveBlock:    block.number,
            totalVerifications: 0,
            collusionFlags:     0
        });
        validatorList.push(msg.sender);
        emit ValidatorRegistered(msg.sender, msg.value);
    }

    // ── Weight Calculation ───────────────────────────────────────────────────
    /**
     * @notice Compute composite reputation R(v) from 5 sub-scores
     *         R = (w1·acc + w2·lat + w3·int + w4·comp + w5·cons) / 10000
     */
    function calculateCompositeReputation(address _val) public view returns (uint256) {
        Validator storage v = validators[_val];
        if (!v.isActive || v.isSlashed) return 0;
        if (complianceLevel[_val] == ComplianceLevel.SEBI_FLAGGED) return 0;

        // Clamp each sub-score 0–100 before using
        uint256 acc  = _clamp(v.R_accuracy,   0, 100);
        uint256 lat  = _clamp(v.R_latency,    0, 100);
        uint256 intg = _clamp(v.R_integrity,  0, 100);
        uint256 comp = _clamp(v.R_compliance, 0, 100);
        uint256 cons = _clamp(v.R_consistency,0, 100);

        uint256 composite = (
            w1_accuracy   * acc  +
            w2_latency    * lat  +
            w3_integrity  * intg +
            w4_compliance * comp +
            w5_consistency* cons
        ) / 10000;

        return composite; // 0–100
    }

    /**
     * @notice W(v) = α·S(v) + (1−α)·R_composite(v)
     *         S(v) = stake in ETH (integer), scaled to comparable range
     */
    function calculateWeight(address _val) public view returns (uint256) {
        Validator storage v = validators[_val];
        if (!v.isActive || v.isSlashed) return 0;
        if (complianceLevel[_val] == ComplianceLevel.SEBI_FLAGGED) return 0;

        uint256 stakeETH  = v.stake / 1 ether;
        uint256 rep       = calculateCompositeReputation(_val);

        uint256 w = (stakeWeight_bps * stakeETH + reputationWeight_bps * rep) / 10000;

        // Streak bonus: 3+ consecutive successes → +10% (Resnick et al.)
        if (v.successStreak >= 3) w = w + (w / 10);

        // CLEAN_RECORD compliance bonus: +20% (SEBI DLT paper)
        if (complianceLevel[_val] == ComplianceLevel.CLEAN_RECORD) w = w + (w / 5);

        return w;
    }

    // ── Validator Selection ──────────────────────────────────────────────────
    function selectValidator() external returns (address) {
        uint256 maxWeight = 0;
        address best      = address(0);

        for (uint i = 0; i < validatorList.length; i++) {
            address a = validatorList[i];
            if (!validators[a].isActive || validators[a].isSlashed) continue;
            if (complianceLevel[a] == ComplianceLevel.SEBI_FLAGGED) continue;
            _applyDecay(a);
            _applyConsistencyCheck(a);
            uint256 w = calculateWeight(a);
            if (w > maxWeight) { maxWeight = w; best = a; }
        }

        require(best != address(0), "No active validators");
        currentValidator = best;
        emit ValidatorSelected(best, maxWeight);
        return best;
    }

    // ── Reputation Update (called by StockExchange) ──────────────────────────
    /**
     * @notice Update all 5 sub-scores after a trade verification
     * @param _val       Validator address
     * @param success    Whether verification was correct
     * @param severity   NONE / LAZY / MALICIOUS
     * @param latencyBlocks  Blocks elapsed between trade submission and verification
     * @param trader     The trader whose trade was verified (for collusion detection)
     */
    function updateReputation(
        address _val,
        bool success,
        FailureSeverity severity,
        uint256 latencyBlocks,
        address trader
    ) external onlyExchange {
        Validator storage v = validators[_val];
        require(v.isActive, "Validator not active");

        v.lastActiveBlock    = block.number;
        v.totalVerifications++;

        // ── R_accuracy update ────────────────────────────────────────────────
        int256 accDelta;
        if (success) {
            accDelta = 5;
            v.successStreak++;
            v.failureStreak = 0;
            // Streak bonus every 3 successes (Resnick et al.)
            if (v.successStreak % 3 == 0) accDelta += 2;
            // Volatility bonus: harder to succeed during extreme events
            if (marketVolatility == 2) accDelta += 3;
        } else {
            v.failureStreak++;
            v.successStreak = 0;
            if      (severity == FailureSeverity.LAZY)      accDelta = -3;
            else if (severity == FailureSeverity.MALICIOUS) {
                accDelta = -15;
                v.R_accuracy = 0;
                _slashStake(_val);
                return; // slashed — stop processing
            } else accDelta = -5;
            // Volatility penalty: no excuses during known events
            if (marketVolatility == 2) accDelta -= 3;
        }
        v.R_accuracy += accDelta;
        v.R_accuracy  = _clampInt(v.R_accuracy, -100, 100);

        // ── R_latency update (SEBI T+0 alignment) ───────────────────────────
        int256 latDelta;
        if      (latencyBlocks <= 2)  latDelta =  3;   // very fast
        else if (latencyBlocks <= 5)  latDelta =  1;   // acceptable
        else if (latencyBlocks <= 15) latDelta =  0;   // neutral
        else if (latencyBlocks <= 30) latDelta = -2;   // slow
        else                          latDelta = -5;   // unacceptable
        v.R_latency += latDelta;
        v.R_latency  = _clampInt(v.R_latency, 0, 100);

        // ── R_integrity update (collusion detection) ─────────────────────────
        // Track validator→trader verification frequency
        validatorTraderCount[_val][trader]++;
        if (v.totalVerifications >= 10) {
            uint256 traderPct = (validatorTraderCount[_val][trader] * 100) / v.totalVerifications;
            if (traderPct > collusionThresholdPct) {
                v.R_integrity -= 8;
                v.collusionFlags++;
                emit ConflictOfInterest(_val, trader, traderPct);
            } else if (success) {
                // Diversity bonus: verifying different traders builds integrity
                v.R_integrity += 1;
            }
        } else if (success) {
            v.R_integrity += 1;
        }
        v.R_integrity = _clampInt(v.R_integrity, 0, 100);

        // ── R_compliance: set by owner via setComplianceLevel, not updated here
        // ── R_consistency: updated in _applyConsistencyCheck during selection

        int256 newComposite = int256(calculateCompositeReputation(_val));
        emit ReputationUpdated(_val, accDelta, newComposite, severity);
        emit SubScoresUpdated(_val, v.R_accuracy, v.R_latency, v.R_integrity, v.R_compliance, v.R_consistency);
    }

    // ── Internal Helpers ─────────────────────────────────────────────────────
    function _slashStake(address _val) internal {
        Validator storage v = validators[_val];
        uint256 slashAmount  = (v.stake * slashPercent) / 100;
        v.stake             -= slashAmount;
        v.isSlashed          = true;
        v.isActive           = false;
        payable(owner).transfer(slashAmount);
        emit ValidatorSlashed(_val, slashAmount);
    }

    function _applyDecay(address _val) internal {
        Validator storage v      = validators[_val];
        uint256 blocksSince      = block.number - v.lastActiveBlock;
        if (blocksSince >= decayInterval) {
            uint256 ticks        = blocksSince / decayInterval;
            v.R_accuracy        -= int256(ticks);
            v.R_latency         -= int256(ticks / 2);
            if (v.R_accuracy < 0)  v.R_accuracy = 0;
            if (v.R_latency  < 0)  v.R_latency  = 0;
        }
    }

    function _applyConsistencyCheck(address _val) internal {
        Validator storage v = validators[_val];
        uint256 retentionPct = (v.stake * 100) / v.stakeAtRegistration;
        if      (retentionPct >= 100) v.R_consistency = _clampInt(v.R_consistency + 2, 0, 100);
        else if (retentionPct >= 80)  v.R_consistency = _clampInt(v.R_consistency - 2, 0, 100);
        else                          v.R_consistency = _clampInt(v.R_consistency - 5, 0, 100);
    }

    function _clamp(int256 val, int256 lo, int256 hi) internal pure returns (uint256) {
        if (val < lo) return uint256(lo);
        if (val > hi) return uint256(hi);
        return uint256(val);
    }

    function _clampInt(int256 val, int256 lo, int256 hi) internal pure returns (int256) {
        if (val < lo) return lo;
        if (val > hi) return hi;
        return val;
    }

    // ── View Functions ───────────────────────────────────────────────────────
    function getValidator(address _val) external view returns (
        uint256 stake,
        int256  R_accuracy,
        int256  R_latency,
        int256  R_integrity,
        int256  R_compliance,
        int256  R_consistency,
        uint256 compositeRep,
        uint256 weight,
        bool    isActive,
        bool    isSlashed,
        uint256 successStreak,
        uint256 failureStreak,
        uint256 totalVerifications,
        uint256 collusionFlags
    ) {
        Validator storage v = validators[_val];
        return (
            v.stake,
            v.R_accuracy, v.R_latency, v.R_integrity, v.R_compliance, v.R_consistency,
            calculateCompositeReputation(_val),
            calculateWeight(_val),
            v.isActive, v.isSlashed,
            v.successStreak, v.failureStreak,
            v.totalVerifications, v.collusionFlags
        );
    }

    function getAllValidators()  external view returns (address[] memory) { return validatorList; }
    function getValidatorCount() external view returns (uint256)          { return validatorList.length; }

    receive() external payable {}
}
