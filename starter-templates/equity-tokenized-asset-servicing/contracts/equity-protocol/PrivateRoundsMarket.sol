// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IComplianceV2.sol";
import "../interfaces/IIdentityRegistry.sol";
import "../interfaces/IPrivateRoundsMarket.sol";

error NotOracle();
error InvalidAddress();
error InvalidRoundWindow();
error RoundAlreadyExists();
error RoundNotFound();
error RoundNotOpen();
error RoundNotClosable();
error RoundNotDraft();
error RoundAlreadyCancelled();
error NotAuthorizedInvestor();
error RoundCapExceeded();
error InvestorCapExceeded();
error InvalidPurchase();
error InvalidPurchaseStatus();
error RefundNotAvailableYet();

/// @title PrivateRoundsMarket
/// @notice Issuer-custodied private rounds market with USDC escrow + offchain ACE settlement.
contract PrivateRoundsMarket is IPrivateRoundsMarket, Ownable, ReentrancyGuard {
    IERC20 public immutable usdc;
    IComplianceV2 public compliance;
    IIdentityRegistry public identityRegistry;
    address public treasury;
    uint64 public settlementTimeoutSeconds;
    uint256 public nextPurchaseId = 1;

    mapping(address => bool) public oracles;
    mapping(uint256 => Round) private _rounds;
    mapping(uint256 => Purchase) private _purchases;
    mapping(uint256 => mapping(address => uint256)) public override roundAllowlistCap;
    mapping(uint256 => mapping(address => uint256)) public override roundPurchasedUsdc;

    event OracleStatusUpdated(address indexed oracle, bool authorized);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event ComplianceUpdated(address indexed previousCompliance, address indexed newCompliance);
    event IdentityRegistryUpdated(address indexed previousRegistry, address indexed newRegistry);
    event SettlementTimeoutUpdated(uint64 previousTimeout, uint64 newTimeout);
    event RoundAllowlistUpdated(uint256 indexed roundId, address indexed investor, uint256 capUsdc);
    event RoundCreated(
        uint256 indexed roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 tokenPriceUsdc6,
        uint256 maxUsdc
    );
    event RoundOpened(uint256 indexed roundId);
    event RoundClosed(uint256 indexed roundId);
    event RoundCancelled(uint256 indexed roundId);
    event PurchaseRequested(
        uint256 indexed purchaseId,
        uint256 indexed roundId,
        address indexed buyer,
        uint256 usdcAmount,
        bytes32 aceRecipientCommitment
    );
    event PurchaseSettled(
        uint256 indexed purchaseId,
        bytes32 indexed aceTransferRef,
        uint256 usdcAmount,
        address treasury
    );
    event PurchaseRefunded(
        uint256 indexed purchaseId,
        address indexed buyer,
        uint256 usdcAmount,
        bytes32 reason
    );

    modifier onlyOracle() {
        if (msg.sender != owner() && !oracles[msg.sender]) revert NotOracle();
        _;
    }

    constructor(
        address _usdc,
        address _compliance,
        address _identityRegistry,
        address _treasury,
        uint64 _settlementTimeoutSeconds
    ) {
        if (_usdc == address(0) || _compliance == address(0) || _identityRegistry == address(0) || _treasury == address(0)) {
            revert InvalidAddress();
        }
        if (_settlementTimeoutSeconds == 0) revert InvalidRoundWindow();

        usdc = IERC20(_usdc);
        compliance = IComplianceV2(_compliance);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        treasury = _treasury;
        settlementTimeoutSeconds = _settlementTimeoutSeconds;
    }

    function rounds(uint256 roundId) external view override returns (Round memory) {
        return _rounds[roundId];
    }

    function purchases(uint256 purchaseId) external view override returns (Purchase memory) {
        return _purchases[purchaseId];
    }

    function setOracleStatus(address oracle, bool authorized) external override onlyOwner {
        if (oracle == address(0)) revert InvalidAddress();
        oracles[oracle] = authorized;
        emit OracleStatusUpdated(oracle, authorized);
    }

    function setTreasury(address _treasury) external override onlyOwner {
        if (_treasury == address(0)) revert InvalidAddress();
        address previous = treasury;
        treasury = _treasury;
        emit TreasuryUpdated(previous, _treasury);
    }

    function setCompliance(address _compliance) external override onlyOwner {
        if (_compliance == address(0)) revert InvalidAddress();
        address previous = address(compliance);
        compliance = IComplianceV2(_compliance);
        emit ComplianceUpdated(previous, _compliance);
    }

    function setIdentityRegistry(address _identityRegistry) external override onlyOwner {
        if (_identityRegistry == address(0)) revert InvalidAddress();
        address previous = address(identityRegistry);
        identityRegistry = IIdentityRegistry(_identityRegistry);
        emit IdentityRegistryUpdated(previous, _identityRegistry);
    }

    function setSettlementTimeoutSeconds(uint64 timeoutSeconds) external override onlyOwner {
        if (timeoutSeconds == 0) revert InvalidRoundWindow();
        uint64 previous = settlementTimeoutSeconds;
        settlementTimeoutSeconds = timeoutSeconds;
        emit SettlementTimeoutUpdated(previous, timeoutSeconds);
    }

    function setRoundAllowlist(uint256 roundId, address investor, uint256 capUsdc) external override onlyOracle {
        if (_rounds[roundId].id == 0) revert RoundNotFound();
        roundAllowlistCap[roundId][investor] = capUsdc;
        emit RoundAllowlistUpdated(roundId, investor, capUsdc);
    }

    function setRoundAllowlistBatch(
        uint256 roundId,
        address[] calldata investors,
        uint256[] calldata capsUsdc
    ) external override onlyOracle {
        if (investors.length != capsUsdc.length) revert InvalidRoundWindow();
        if (_rounds[roundId].id == 0) revert RoundNotFound();

        for (uint256 i = 0; i < investors.length; i++) {
            roundAllowlistCap[roundId][investors[i]] = capsUsdc[i];
            emit RoundAllowlistUpdated(roundId, investors[i], capsUsdc[i]);
        }
    }

    function createRound(
        uint256 roundId,
        uint64 startTime,
        uint64 endTime,
        uint256 tokenPriceUsdc6,
        uint256 maxUsdc
    ) external override onlyOracle {
        if (roundId == 0 || _rounds[roundId].id != 0) revert RoundAlreadyExists();
        if (startTime >= endTime) revert InvalidRoundWindow();
        if (tokenPriceUsdc6 == 0 || maxUsdc == 0) revert InvalidRoundWindow();

        _rounds[roundId] = Round({
            id: roundId,
            startTime: startTime,
            endTime: endTime,
            tokenPriceUsdc6: tokenPriceUsdc6,
            maxUsdc: maxUsdc,
            soldUsdc: 0,
            status: RoundStatus.DRAFT
        });

        emit RoundCreated(roundId, startTime, endTime, tokenPriceUsdc6, maxUsdc);
    }

    function openRound(uint256 roundId) external override onlyOracle {
        Round storage round = _requireRound(roundId);
        if (round.status != RoundStatus.DRAFT && round.status != RoundStatus.CLOSED) revert RoundNotDraft();
        round.status = RoundStatus.OPEN;
        emit RoundOpened(roundId);
    }

    function closeRound(uint256 roundId) external override onlyOracle {
        Round storage round = _requireRound(roundId);
        if (round.status != RoundStatus.OPEN) revert RoundNotClosable();
        round.status = RoundStatus.CLOSED;
        emit RoundClosed(roundId);
    }

    function cancelRound(uint256 roundId) external override onlyOracle {
        Round storage round = _requireRound(roundId);
        if (round.status == RoundStatus.CANCELLED) revert RoundAlreadyCancelled();
        round.status = RoundStatus.CANCELLED;
        emit RoundCancelled(roundId);
    }

    function buyRound(
        uint256 roundId,
        uint256 usdcAmount,
        bytes32 aceRecipientCommitment
    ) external override nonReentrant returns (uint256 purchaseId) {
        if (usdcAmount == 0) revert InvalidPurchase();

        Round storage round = _requireRound(roundId);
        if (round.status != RoundStatus.OPEN) revert RoundNotOpen();
        if (round.status == RoundStatus.CANCELLED) revert RoundAlreadyCancelled();
        if (block.timestamp < round.startTime || block.timestamp > round.endTime) revert RoundNotOpen();

        if (!identityRegistry.isVerified(msg.sender)) revert NotAuthorizedInvestor();
        if (!compliance.isInvestorAuthorized(msg.sender)) revert NotAuthorizedInvestor();

        uint256 cap = roundAllowlistCap[roundId][msg.sender];
        if (cap == 0) revert NotAuthorizedInvestor();

        uint256 purchasedSoFar = roundPurchasedUsdc[roundId][msg.sender];
        if (purchasedSoFar + usdcAmount > cap) revert InvestorCapExceeded();
        if (round.soldUsdc + usdcAmount > round.maxUsdc) revert RoundCapExceeded();

        bool ok = usdc.transferFrom(msg.sender, address(this), usdcAmount);
        require(ok, "USDC transferFrom failed");

        round.soldUsdc += usdcAmount;
        roundPurchasedUsdc[roundId][msg.sender] = purchasedSoFar + usdcAmount;

        purchaseId = nextPurchaseId++;
        _purchases[purchaseId] = Purchase({
            id: purchaseId,
            roundId: roundId,
            buyer: msg.sender,
            usdcAmount: usdcAmount,
            aceRecipientCommitment: aceRecipientCommitment,
            createdAt: uint64(block.timestamp),
            status: PurchaseStatus.PENDING,
            aceTransferRef: bytes32(0)
        });

        emit PurchaseRequested(purchaseId, roundId, msg.sender, usdcAmount, aceRecipientCommitment);
    }

    function markPurchaseSettled(uint256 purchaseId, bytes32 aceTransferRef) external override onlyOracle nonReentrant {
        Purchase storage purchase = _requirePendingPurchase(purchaseId);
        purchase.status = PurchaseStatus.SETTLED;
        purchase.aceTransferRef = aceTransferRef;

        bool ok = usdc.transfer(treasury, purchase.usdcAmount);
        require(ok, "USDC transfer to treasury failed");

        emit PurchaseSettled(purchaseId, aceTransferRef, purchase.usdcAmount, treasury);
    }

    function refundPurchase(uint256 purchaseId) external override nonReentrant {
        Purchase storage purchase = _requirePendingPurchase(purchaseId);
        if (msg.sender != purchase.buyer) revert InvalidPurchase();

        uint256 deadline = uint256(purchase.createdAt) + settlementTimeoutSeconds;
        if (block.timestamp < deadline) revert RefundNotAvailableYet();

        _applyRefundAccounting(purchase);
        purchase.status = PurchaseStatus.REFUNDED;
        bool ok = usdc.transfer(purchase.buyer, purchase.usdcAmount);
        require(ok, "USDC refund failed");

        emit PurchaseRefunded(purchaseId, purchase.buyer, purchase.usdcAmount, bytes32("BUYER_TIMEOUT"));
    }

    function refundPurchaseByOracle(uint256 purchaseId, bytes32 reason) external override onlyOracle nonReentrant {
        Purchase storage purchase = _requirePendingPurchase(purchaseId);
        _applyRefundAccounting(purchase);
        purchase.status = PurchaseStatus.REFUNDED;

        bool ok = usdc.transfer(purchase.buyer, purchase.usdcAmount);
        require(ok, "USDC refund failed");

        emit PurchaseRefunded(purchaseId, purchase.buyer, purchase.usdcAmount, reason);
    }

    function _requireRound(uint256 roundId) internal view returns (Round storage round) {
        round = _rounds[roundId];
        if (round.id == 0) revert RoundNotFound();
    }

    function _requirePendingPurchase(uint256 purchaseId) internal view returns (Purchase storage purchase) {
        purchase = _purchases[purchaseId];
        if (purchase.id == 0) revert InvalidPurchase();
        if (purchase.status != PurchaseStatus.PENDING) revert InvalidPurchaseStatus();
    }

    function _applyRefundAccounting(Purchase storage purchase) internal {
        Round storage round = _rounds[purchase.roundId];
        uint256 investorPurchased = roundPurchasedUsdc[purchase.roundId][purchase.buyer];

        if (investorPurchased >= purchase.usdcAmount) {
            roundPurchasedUsdc[purchase.roundId][purchase.buyer] = investorPurchased - purchase.usdcAmount;
        } else {
            roundPurchasedUsdc[purchase.roundId][purchase.buyer] = 0;
        }

        if (round.soldUsdc >= purchase.usdcAmount) {
            round.soldUsdc -= purchase.usdcAmount;
        } else {
            round.soldUsdc = 0;
        }
    }
}
