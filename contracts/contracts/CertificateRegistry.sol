// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {SensorOracle} from "./SensorOracle.sol";
import {ShipmentCustody} from "./ShipmentCustody.sol";

/// @title CertificateRegistry
/// @notice Quality outcomes for each batch. Records evidence and decisions only:
///         it never moves money. Disputes are settled between the firms, off-platform.
///
/// A batch passes through five stages, each held by one party with its own sensor and closed by a
/// two-sided handover check:
///   0 Supplier · 1 Cargo · 2 Destination freight handler · 3 Cold store · 4 Reefer truck
///
/// A stage is flagged, permanently, when any of these hold (checked against the batch's own limits):
///   FLAG_SENSOR          the stage's verified sensor readings stay above the limit longer than the grace period
///   FLAG_RECEIPT_TEMP    the receiver's probe temperature at the closing handover is above the limit
///   FLAG_HANDOVER_GAP    the closing handover's time on the dock (sender's sign-off to receiver's
///                        sign-in, unrefrigerated and unmonitored) is longer than the grace period
///   FLAG_CONDITION       damaged packaging, a broken seal, "accepted with issues", or issues the sender reported
///   FLAG_MISSING_DATA    the sensor has no readings for longer than the grace period
///
/// Lifecycle (certifier = the Certificate Service; QA = the batch's assigned inspector):
///   openClaim          certifier, as soon as a stage is flagged (often while the batch is in transit)
///   issueLegPass       certifier, once a stage's closing handover and verified sensor readings are in
///   issueFinalCertificate  certifier, once all five stages have a LegPass
///   submitResolution   QA rules on each flagged stage: upheld / overturned / compensation agreed
///   submitDisposition  QA's final decision on the batch: release for sale or reject
///   acknowledgeReceipt the buyer closes the batch
contract CertificateRegistry {
    enum PassStatus {
        Pass,
        Flagged
    }

    enum Outcome {
        Upheld,
        Overturned,
        CompensationAgreed
    }

    enum CertStatus {
        None,
        Clean, // every stage passed
        Flagged, // at least one flagged stage has no QA ruling yet
        Resolved // QA has ruled on every flagged stage
    }

    enum Disposition {
        None,
        Released, // fit for sale
        Rejected // not to be sold
    }

    uint8 public constant FLAG_SENSOR = 1;
    uint8 public constant FLAG_RECEIPT_TEMP = 2;
    uint8 public constant FLAG_HANDOVER_GAP = 4;
    uint8 public constant FLAG_CONDITION = 8;
    uint8 public constant FLAG_MISSING_DATA = 16;

    uint8 public constant LAST_STAGE = 4; // stages 0..4
    uint256 public constant MAX_NOTE_BYTES = 1000;

    struct LegPass {
        uint256 shipmentId; // the batch's container
        uint256 batchId;
        uint8 leg; // stage 0..4
        address custodian;
        uint8 flags;
        PassStatus status;
        int16 receiptTenthsC; // receiver's probe temperature at the closing handover
        uint32 gapMinutes; // time on the dock at the closing handover, unrefrigerated
        bytes32 fileHash; // the stage's sensor readings
        int16 maxTenthsC; // sensor peak
        uint32 breachMinutes; // longest sensor excursion above the limit
        uint32 missingMinutes; // minutes with no sensor readings
        uint64 issuedAt;
    }

    struct Claim {
        uint256 batchId;
        uint8 leg;
        uint64 breachStart; // from the sensor log, if verified when the claim opened
        uint64 breachEnd;
        address provisionalCustodian; // who held the batch on the flagged stage
        uint64 openedAt;
        uint256 resolutionId; // 0 until QA rules
    }

    struct Resolution {
        uint256 claimId;
        address inspector;
        Outcome outcome;
        string note;
        uint64 signedAt;
    }

    struct FinalCertificate {
        CertStatus status;
        uint256[] legPassIds;
        uint256[] resolutionIds;
        uint64 issuedAt;
    }

    struct QaDecision {
        Disposition disposition;
        address inspector;
        string note;
        uint64 decidedAt;
    }

    struct Acknowledgement {
        address buyer;
        uint64 acknowledgedAt;
    }

    ParticipantRegistry public immutable registry;
    ShipmentCustody public immutable custody;
    SensorOracle public immutable sensorOracle;

    // Ids start at 1 so that 0 means "none".
    uint256 public legPassCount;
    uint256 public claimCount;
    uint256 public resolutionCount;
    mapping(uint256 => LegPass) internal legPasses;
    mapping(uint256 => Claim) internal claims;
    mapping(uint256 => Resolution) internal resolutions;

    mapping(uint256 => mapping(uint8 => uint256)) public legPassOf; // [batch][stage] => legPassId
    mapping(uint256 => mapping(uint8 => uint256)) public claimOf; // [batch][stage] => claimId
    mapping(uint256 => uint256[]) internal claimsOfBatch;
    mapping(uint256 => uint256) public openClaimCount; // batch => claims without a ruling
    mapping(uint256 => FinalCertificate) internal certificates;
    mapping(uint256 => QaDecision) internal decisions;
    mapping(uint256 => Acknowledgement) public acknowledgements;

    event ClaimOpened(uint256 indexed claimId, uint256 indexed batchId, uint8 leg, address indexed provisionalCustodian, uint8 flags);
    event LegPassIssued(uint256 indexed legPassId, uint256 indexed batchId, uint8 indexed leg, PassStatus status, uint8 flags);
    event ResolutionSubmitted(uint256 indexed resolutionId, uint256 indexed claimId, address indexed inspector, Outcome outcome);
    event FinalCertificateIssued(uint256 indexed batchId, CertStatus status);
    event CertificateStatusChanged(uint256 indexed batchId, CertStatus status);
    event DispositionSubmitted(uint256 indexed batchId, address indexed inspector, Disposition disposition);
    event ReceiptAcknowledged(uint256 indexed batchId, address indexed buyer);

    constructor(ParticipantRegistry _registry, ShipmentCustody _custody, SensorOracle _sensorOracle) {
        registry = _registry;
        custody = _custody;
        sensorOracle = _sensorOracle;
    }

    modifier whenSystemActive() {
        require(!registry.paused(), "system paused");
        _;
    }

    modifier onlyCertifier() {
        require(registry.hasRole(registry.CERTIFIER(), msg.sender), "not the certifier");
        _;
    }

    // ---- Evaluating a stage -----------------------------------------------------------

    /// @notice The handover that closed `leg` for this batch (stages 1-2 live on its container).
    function checkpointFor(uint256 batchId, uint8 leg) public view returns (ShipmentCustody.Checkpoint memory) {
        return custody.getCheckpoint(custody.recordedOn(batchId, leg), leg);
    }

    /// @notice Who held the batch during a stage.
    function custodianOf(uint256 batchId, uint8 leg) public view returns (address custodian) {
        (custodian,,,) = custody.stageWindow(batchId, leg);
    }

    /// @notice Live flags for a stage, from whatever evidence exists so far.
    /// @return flags bitmask of FLAG_* reasons
    /// @return checkpointDone the handover closing this stage has been accepted
    /// @return sensorDone the stage's sensor readings are Verified
    function stageFlags(uint256 batchId, uint8 leg)
        public
        view
        returns (uint8 flags, bool checkpointDone, bool sensorDone)
    {
        require(leg <= LAST_STAGE, "stage must be 0-4");
        ShipmentCustody.Unit memory batch = custody.getUnit(batchId);
        require(batch.kind == ShipmentCustody.Kind.Batch, "not a batch");

        ShipmentCustody.Checkpoint memory cp = checkpointFor(batchId, leg);
        checkpointDone = cp.incoming.checkedAt != 0;
        if (checkpointDone) {
            if (cp.incoming.tempTenthsC > batch.thresholdTenthsC) flags |= FLAG_RECEIPT_TEMP;
            if (custody.handoverGapMinutes(batchId, leg) > batch.graceMinutes) flags |= FLAG_HANDOVER_GAP;
            if (cp.incoming.damaged || !cp.incoming.sealIntact || cp.incoming.issues || cp.outgoing.issues) {
                flags |= FLAG_CONDITION;
            }
        }

        SensorOracle.LegSummary memory s = sensorOracle.getSummary(batchId, leg);
        sensorDone = s.status == SensorOracle.Status.Verified;
        if (sensorDone && s.breachMinutes > batch.graceMinutes) flags |= FLAG_SENSOR;
        if (sensorDone && s.missingMinutes > batch.graceMinutes) flags |= FLAG_MISSING_DATA;
    }

    // ---- Claims (opened as soon as a stage is flagged) ------------------------------------

    function openClaim(uint256 batchId, uint8 leg) external whenSystemActive onlyCertifier returns (uint256 id) {
        require(claimOf[batchId][leg] == 0, "claim already open");
        (uint8 flags,,) = stageFlags(batchId, leg);
        require(flags != 0, "stage not flagged");

        Claim storage c = claims[id = ++claimCount];
        c.batchId = batchId;
        c.leg = leg;
        c.provisionalCustodian = custodianOf(batchId, leg);
        c.openedAt = uint64(block.timestamp);
        SensorOracle.LegSummary memory s = sensorOracle.getSummary(batchId, leg);
        if (s.status == SensorOracle.Status.Verified) (c.breachStart, c.breachEnd) = (s.breachStart, s.breachEnd);
        claimOf[batchId][leg] = id;
        claimsOfBatch[batchId].push(id);
        openClaimCount[batchId]++;
        emit ClaimOpened(id, batchId, leg, c.provisionalCustodian, flags);
    }

    // ---- Leg passes (the stage's final, immutable verdict) ---------------------------------

    function issueLegPass(uint256 batchId, uint8 leg) external whenSystemActive onlyCertifier returns (uint256 id) {
        require(legPassOf[batchId][leg] == 0, "leg pass already issued");
        (uint8 flags, bool checkpointDone, bool sensorDone) = stageFlags(batchId, leg);
        require(checkpointDone, "handover checkpoint missing");
        require(sensorDone, "evidence not verified");

        ShipmentCustody.Checkpoint memory cp = checkpointFor(batchId, leg);
        LegPass storage lp = legPasses[id = ++legPassCount];
        lp.shipmentId = custody.getUnit(batchId).containerId;
        lp.batchId = batchId;
        lp.leg = leg;
        lp.custodian = custodianOf(batchId, leg);
        lp.flags = flags;
        lp.status = flags == 0 ? PassStatus.Pass : PassStatus.Flagged;
        lp.receiptTenthsC = cp.incoming.tempTenthsC;
        lp.gapMinutes = uint32(custody.handoverGapMinutes(batchId, leg));
        SensorOracle.LegSummary memory s = sensorOracle.getSummary(batchId, leg);
        (lp.fileHash, lp.maxTenthsC, lp.breachMinutes, lp.missingMinutes) = (s.fileHash, s.maxTenthsC, s.breachMinutes, s.missingMinutes);
        lp.issuedAt = uint64(block.timestamp);
        legPassOf[batchId][leg] = id;
        emit LegPassIssued(id, batchId, leg, lp.status, flags);
    }

    // ---- Final certificate -------------------------------------------------------------

    function issueFinalCertificate(uint256 batchId) external whenSystemActive onlyCertifier {
        FinalCertificate storage cert = certificates[batchId];
        require(cert.status == CertStatus.None, "certificate already issued");

        bool anyFlagged;
        for (uint8 leg = 0; leg <= LAST_STAGE; leg++) {
            uint256 lpId = legPassOf[batchId][leg];
            require(lpId != 0, "not every stage has reported");
            if (legPasses[lpId].status == PassStatus.Flagged) {
                require(claimOf[batchId][leg] != 0, "open a claim for every flagged stage first");
                anyFlagged = true;
            }
            cert.legPassIds.push(lpId);
        }

        uint256[] storage batchClaims = claimsOfBatch[batchId];
        for (uint256 i = 0; i < batchClaims.length; i++) {
            uint256 resolutionId = claims[batchClaims[i]].resolutionId;
            if (resolutionId != 0) cert.resolutionIds.push(resolutionId);
        }

        if (!anyFlagged) cert.status = CertStatus.Clean;
        else cert.status = openClaimCount[batchId] == 0 ? CertStatus.Resolved : CertStatus.Flagged;
        cert.issuedAt = uint64(block.timestamp);
        emit FinalCertificateIssued(batchId, cert.status);
    }

    // ---- QA: rulings on flagged stages ---------------------------------------------------

    function submitResolution(uint256 claimId, Outcome outcome, string calldata note)
        external
        whenSystemActive
        returns (uint256 id)
    {
        Claim storage claim = claims[claimId];
        require(claim.openedAt != 0, "no such claim");
        _requireInspector(claim.batchId);
        require(claim.resolutionId == 0, "claim already resolved");
        _requireNote(note);

        id = ++resolutionCount;
        resolutions[id] = Resolution(claimId, msg.sender, outcome, note, uint64(block.timestamp));
        claim.resolutionId = id;
        openClaimCount[claim.batchId]--;
        emit ResolutionSubmitted(id, claimId, msg.sender, outcome);

        FinalCertificate storage cert = certificates[claim.batchId];
        if (cert.status != CertStatus.None) {
            cert.resolutionIds.push(id);
            if (openClaimCount[claim.batchId] == 0 && cert.status == CertStatus.Flagged) {
                cert.status = CertStatus.Resolved;
                emit CertificateStatusChanged(claim.batchId, CertStatus.Resolved);
            }
        }
    }

    // ---- QA: final decision on the batch -------------------------------------------------

    function submitDisposition(uint256 batchId, Disposition disposition, string calldata note) external whenSystemActive {
        _requireInspector(batchId);
        require(certificates[batchId].status != CertStatus.None, "no final certificate yet");
        require(openClaimCount[batchId] == 0, "rule on every flagged stage first");
        require(decisions[batchId].disposition == Disposition.None, "already decided");
        require(disposition != Disposition.None, "choose release or reject");
        _requireNote(note);

        decisions[batchId] = QaDecision(disposition, msg.sender, note, uint64(block.timestamp));
        emit DispositionSubmitted(batchId, msg.sender, disposition);
    }

    // ---- Buyer closes the batch ------------------------------------------------------------

    function acknowledgeReceipt(uint256 batchId) external whenSystemActive {
        ShipmentCustody.Unit memory batch = custody.getUnit(batchId);
        require(msg.sender == batch.buyer && registry.hasRole(registry.BUYER(), msg.sender), "not the batch's buyer");
        require(decisions[batchId].disposition != Disposition.None, "awaiting QA decision");
        require(acknowledgements[batchId].acknowledgedAt == 0, "already acknowledged");

        acknowledgements[batchId] = Acknowledgement(msg.sender, uint64(block.timestamp));
        emit ReceiptAcknowledged(batchId, msg.sender);
    }

    // ---- Views -----------------------------------------------------------------------------

    function getLegPass(uint256 id) external view returns (LegPass memory) {
        return legPasses[id];
    }

    function getClaim(uint256 id) external view returns (Claim memory) {
        return claims[id];
    }

    function getResolution(uint256 id) external view returns (Resolution memory) {
        return resolutions[id];
    }

    function getCertificate(uint256 batchId) external view returns (FinalCertificate memory) {
        return certificates[batchId];
    }

    function getDecision(uint256 batchId) external view returns (QaDecision memory) {
        return decisions[batchId];
    }

    function getClaimsOfBatch(uint256 batchId) external view returns (uint256[] memory) {
        return claimsOfBatch[batchId];
    }

    // ---- Internals ---------------------------------------------------------------------------

    function _requireInspector(uint256 batchId) internal view {
        ShipmentCustody.Unit memory batch = custody.getUnit(batchId);
        require(
            msg.sender == batch.inspector && registry.hasRole(registry.INSPECTOR(), msg.sender),
            "not the assigned inspector"
        );
    }

    function _requireNote(string calldata note) internal pure {
        require(bytes(note).length > 0 && bytes(note).length <= MAX_NOTE_BYTES, "note must be 1-1000 bytes");
    }
}
