// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IPrivateRoundsMarket {
    enum RoundStatus {
        NONE,
        DRAFT,
        OPEN,
        CLOSED,
        CANCELLED
    }

    enum PurchaseStatus {
        NONE,
        PENDING,
        SETTLED,
        REFUNDED
    }

    struct Round {
        uint256 id;
        uint64 startTime;
        uint64 endTime;
        uint256 tokenPriceUsdc6;
        uint256 maxUsdc;
        uint256 soldUsdc;
        RoundStatus status;
    }

    struct Purchase {
        uint256 id;
        uint256 roundId;
        address buyer;
        uint256 usdcAmount;
        bytes32 aceRecipientCommitment;
        uint64 createdAt;
        PurchaseStatus status;
        bytes32 aceTransferRef;
    }

    function setOracleStatus(address oracle, bool authorized) external;
    function setTreasury(address treasury) external;
    function setCompliance(address compliance) external;
    function setIdentityRegistry(address identityRegistry) external;
    function setSettlementTimeoutSeconds(uint64 timeoutSeconds) external;
    function setRoundAllowlist(uint256 roundId, address investor, uint256 capUsdc) external;
    function setRoundAllowlistBatch(uint256 roundId, address[] calldata investors, uint256[] calldata capsUsdc) external;
    function createRound(
        uint256 roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 tokenPriceUsdc6,
        uint256 maxUsdc
    ) external;
    function openRound(uint256 roundId) external;
    function closeRound(uint256 roundId) external;
    function cancelRound(uint256 roundId) external;
    function buyRound(uint256 roundId, uint256 usdcAmount, bytes32 aceRecipientCommitment) external returns (uint256 purchaseId);
    function markPurchaseSettled(uint256 purchaseId, bytes32 aceTransferRef) external;
    function refundPurchase(uint256 purchaseId) external;
    function refundPurchaseByOracle(uint256 purchaseId, bytes32 reason) external;
    function roundAllowlistCap(uint256 roundId, address investor) external view returns (uint256);
    function roundPurchasedUsdc(uint256 roundId, address investor) external view returns (uint256);
    function rounds(uint256 roundId) external view returns (Round memory);
    function purchases(uint256 purchaseId) external view returns (Purchase memory);
}
