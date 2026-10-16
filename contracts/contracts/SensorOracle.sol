// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {ShipmentCustody} from "./ShipmentCustody.sol";

/// @title SensorOracle
/// @notice Tamper-evident sensor evidence for each custody leg.
///
/// Two steps per leg:
///   1. The registered sensor device commits the SHA-256 of its raw CSV once the leg has ended.
///      One commit per physical file: legs 1-3 are committed on the container, leg 4 on the batch.
///   2. The oracle replays the CSV it holds and submits a summary per batch (each batch has its
///      own threshold). If the oracle's file hash differs from the sensor's commit, the leg is
///      marked EvidenceMismatch and no LegPass can be issued until a matching file is resubmitted.
///
/// Raw readings stay off-chain; only the hash and summary are recorded here.
contract SensorOracle {
    enum Status {
        None,
        Verified,
        EvidenceMismatch
    }

    struct LegSummary {
        bytes32 fileHash; // SHA-256 of the CSV the oracle replayed
        int16 minTenthsC;
        int16 maxTenthsC;
        uint32 breachMinutes; // longest continuous run above the batch threshold
        uint64 breachStart; // 0 if no reading was above the threshold
        uint64 breachEnd;
        uint64 submittedAt;
        Status status;
    }

    ParticipantRegistry public immutable registry;
    ShipmentCustody public immutable custody;

    mapping(bytes32 => address) public sensorDevice; // sensorId => device wallet
    mapping(uint256 => mapping(uint8 => bytes32)) public committedHash; // [container or batch][leg]
    mapping(uint256 => mapping(uint8 => LegSummary)) internal summaries; // [batch][leg]

    event SensorRegistered(bytes32 indexed sensorId, address indexed device);
    event FileHashCommitted(uint256 indexed shipmentId, uint8 indexed leg, bytes32 indexed sensorId, bytes32 fileHash);
    event LegSummarySubmitted(uint256 indexed batchId, uint8 indexed leg, bytes32 fileHash, Status status);
    event EvidenceMismatch(uint256 indexed batchId, uint8 indexed leg, bytes32 committedHash, bytes32 submittedHash);

    constructor(ParticipantRegistry _registry, ShipmentCustody _custody) {
        registry = _registry;
        custody = _custody;
    }

    modifier whenSystemActive() {
        require(!registry.paused(), "system paused");
        _;
    }

    function registerSensor(bytes32 sensorId, address device) external whenSystemActive {
        require(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), msg.sender), "not admin");
        require(sensorId != bytes32(0) && device != address(0), "sensor id and device required");
        require(sensorDevice[sensorId] == address(0), "sensor already registered");

        sensorDevice[sensorId] = device;
        emit SensorRegistered(sensorId, device);
    }

    /// @notice Called by the sensor device at the end of a leg. `shipmentId` may be a container
    ///         or batch id; the commit is stored on whichever unit the leg is recorded on.
    function commitFileHash(uint256 shipmentId, uint8 leg, bytes32 fileHash) external whenSystemActive {
        (, , uint64 end, bytes32 sensorId, uint256 recordedOn) = custody.legWindow(shipmentId, leg);
        address device = sensorDevice[sensorId];
        require(device != address(0) && device == msg.sender, "not the registered sensor for this leg");
        require(end != 0, "leg not finished");
        require(fileHash != bytes32(0), "empty hash");
        require(committedHash[recordedOn][leg] == bytes32(0), "leg already committed");

        committedHash[recordedOn][leg] = fileHash;
        emit FileHashCommitted(recordedOn, leg, sensorId, fileHash);
    }

    function submitLegSummary(
        uint256 batchId,
        uint8 leg,
        bytes32 fileHash,
        int16 minTenthsC,
        int16 maxTenthsC,
        uint32 breachMinutes,
        uint64 breachStart,
        uint64 breachEnd
    ) external whenSystemActive {
        require(registry.hasRole(registry.ORACLE(), msg.sender), "not a registered oracle");
        require(custody.getUnit(batchId).kind == ShipmentCustody.Kind.Batch, "not a batch");
        require(minTenthsC <= maxTenthsC, "min above max");
        require(breachStart <= breachEnd, "breach ends before it starts");

        (, , , , uint256 recordedOn) = custody.legWindow(batchId, leg);
        bytes32 committed = committedHash[recordedOn][leg];
        require(committed != bytes32(0), "sensor has not committed this leg");

        LegSummary storage s = summaries[batchId][leg];
        // One accepted submission per (batch, leg). A mismatched one may be replaced.
        require(s.status != Status.Verified, "leg already submitted");

        Status status = fileHash == committed ? Status.Verified : Status.EvidenceMismatch;
        summaries[batchId][leg] = LegSummary(
            fileHash, minTenthsC, maxTenthsC, breachMinutes, breachStart, breachEnd, uint64(block.timestamp), status
        );

        emit LegSummarySubmitted(batchId, leg, fileHash, status);
        if (status == Status.EvidenceMismatch) emit EvidenceMismatch(batchId, leg, committed, fileHash);
    }

    /// @notice Anyone holding a CSV can check it against the sensor's on-chain commit.
    function verifyFileHash(uint256 shipmentId, uint8 leg, bytes32 fileHash) external view returns (bool) {
        (, , , , uint256 recordedOn) = custody.legWindow(shipmentId, leg);
        bytes32 committed = committedHash[recordedOn][leg];
        return committed != bytes32(0) && committed == fileHash;
    }

    function getSummary(uint256 batchId, uint8 leg) external view returns (LegSummary memory) {
        return summaries[batchId][leg];
    }
}
