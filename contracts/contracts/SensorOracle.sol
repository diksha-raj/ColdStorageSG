// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";
import {ShipmentCustody} from "./ShipmentCustody.sol";

/// @title SensorOracle
/// @notice Tamper-evident sensor readings for every stage a batch passes through.
///
/// Each custodian's sensor is registered in ShipmentCustody against the stage it covers. Two steps
/// per stage window:
///   1. Once the window has closed, the sensor itself (its device key, via the sensor gateway)
///      commits the SHA-256 of its readings for that window. Stages 1-2 are committed once per
///      container; the others per batch.
///   2. The oracle fetches those readings, summarises them for each batch against the batch's own
///      limit (each batch's own entry and exit inside a container window), and submits the summary
///      with the hash of the readings it used. If that hash differs from the sensor's commit, the
///      readings were altered after the sensor reported: the stage is marked EvidenceMismatch and
///      no LegPass can be issued until the genuine readings are submitted.
///
/// Raw readings stay off-chain; only hashes and summaries are recorded here.
contract SensorOracle {
    enum Status {
        None,
        Verified,
        EvidenceMismatch
    }

    struct LegSummary {
        bytes32 fileHash; // SHA-256 of the readings the oracle summarised
        int16 minTenthsC;
        int16 maxTenthsC;
        uint32 breachMinutes; // longest continuous run above the batch's limit, in minutes
        uint32 missingMinutes; // minutes of the batch's window with no readings
        uint64 breachStart; // 0 if no reading was above the limit
        uint64 breachEnd;
        uint64 submittedAt;
        Status status;
    }

    ParticipantRegistry public immutable registry;
    ShipmentCustody public immutable custody;

    mapping(uint256 => mapping(uint8 => bytes32)) public committedHash; // [container or batch][stage]
    mapping(uint256 => mapping(uint8 => LegSummary)) internal summaries; // [batch][stage]

    event FileHashCommitted(uint256 indexed shipmentId, uint8 indexed stage, bytes32 indexed sensorId, bytes32 fileHash);
    event LegSummarySubmitted(uint256 indexed batchId, uint8 indexed stage, bytes32 fileHash, Status status);
    event EvidenceMismatch(uint256 indexed batchId, uint8 indexed stage, bytes32 committedHash, bytes32 submittedHash);

    constructor(ParticipantRegistry _registry, ShipmentCustody _custody) {
        registry = _registry;
        custody = _custody;
    }

    modifier whenSystemActive() {
        require(!registry.paused(), "system paused");
        _;
    }

    /// @notice Called by the sensor's device key once its window on `shipmentId` (a container for
    ///         stages 1-2, a batch otherwise) has closed.
    function commitFileHash(uint256 shipmentId, uint8 stage, bytes32 fileHash) external whenSystemActive {
        (ShipmentCustody.Sensor memory sensor,, uint64 end) = custody.sensorWindow(shipmentId, stage);
        require(sensor.device != address(0) && sensor.device == msg.sender, "not the registered sensor for this stage");
        require(end != 0, "stage not finished");
        require(fileHash != bytes32(0), "empty hash");
        require(committedHash[shipmentId][stage] == bytes32(0), "stage already committed");

        committedHash[shipmentId][stage] = fileHash;
        emit FileHashCommitted(shipmentId, stage, sensor.sensorId, fileHash);
    }

    function submitLegSummary(
        uint256 batchId,
        uint8 stage,
        bytes32 fileHash,
        int16 minTenthsC,
        int16 maxTenthsC,
        uint32 breachMinutes,
        uint32 missingMinutes,
        uint64 breachStart,
        uint64 breachEnd
    ) external whenSystemActive {
        require(registry.hasRole(registry.ORACLE(), msg.sender), "not a registered oracle");
        require(custody.getUnit(batchId).kind == ShipmentCustody.Kind.Batch, "not a batch");
        require(minTenthsC <= maxTenthsC, "min above max");
        require(breachStart <= breachEnd, "breach ends before it starts");

        bytes32 committed = committedHash[custody.recordedOn(batchId, stage)][stage];
        require(committed != bytes32(0), "sensor has not committed this stage");

        LegSummary storage s = summaries[batchId][stage];
        // One accepted submission per (batch, stage). A mismatched one may be replaced.
        require(s.status != Status.Verified, "stage already submitted");

        Status status = fileHash == committed ? Status.Verified : Status.EvidenceMismatch;
        s.fileHash = fileHash;
        s.minTenthsC = minTenthsC;
        s.maxTenthsC = maxTenthsC;
        s.breachMinutes = breachMinutes;
        s.missingMinutes = missingMinutes;
        s.breachStart = breachStart;
        s.breachEnd = breachEnd;
        s.submittedAt = uint64(block.timestamp);
        s.status = status;

        emit LegSummarySubmitted(batchId, stage, fileHash, status);
        if (status == Status.EvidenceMismatch) emit EvidenceMismatch(batchId, stage, committed, fileHash);
    }

    /// @notice Anyone holding a readings file can check it against the sensor's commit.
    function verifyFileHash(uint256 shipmentId, uint8 stage, bytes32 fileHash) external view returns (bool) {
        bytes32 committed = committedHash[custody.recordedOn(shipmentId, stage)][stage];
        return committed != bytes32(0) && committed == fileHash;
    }

    function getSummary(uint256 batchId, uint8 stage) external view returns (LegSummary memory) {
        return summaries[batchId][stage];
    }
}
