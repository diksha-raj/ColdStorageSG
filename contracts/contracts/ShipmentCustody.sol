// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";

/// @title ShipmentCustody
/// @notice Who holds a container or batch, and since when.
///
/// Containers and batches share one id space ("units"), so initiateTransfer / acceptTransfer
/// work on either. The fixed route is:
///
///   Container: Origin (supplier) -> Carrier -> Handler -> ColdStore -> split into batches
///   Batch:     (in container) ... ColdStore -> Truck -> Delivered (buyer)
///
/// The stage number doubles as the sensor leg number: 1 Carrier, 2 Handler, 3 ColdStore, 4 Truck.
/// Legs 1-3 are recorded on the container; leg 4 on each batch.
///
/// Every handover is also a two-sided quality checkpoint: the sender signs an outgoing check
/// (temperature at dispatch, minutes without refrigeration, condition) in initiateTransfer, and
/// the receiver signs an incoming check in acceptTransfer. The checkpoint is stored against the
/// stage it closes: stage 0 (origin dispatch) and legs 1-2 on the container; legs 3-4 on each batch.
/// There is no rejection: a receiver records what they found, and failures are flagged and ruled
/// on by QA (see CertificateRegistry).
contract ShipmentCustody {
    enum Kind {
        None,
        Container,
        Batch
    }

    // Order matters: stage N == leg N for legs 1-4.
    enum Stage {
        Origin, //    0  the supplier dispatches from origin
        Carrier, //   1
        Handler, //   2
        ColdStore, // 3
        Truck, //     4
        Delivered //  5  buyer holds it; no further legs
    }

    struct Unit {
        Kind kind;
        uint256 containerId; // a batch's parent; a container's own id
        address supplier;
        address custodian;
        address pendingTo; // set by initiateTransfer, cleared by acceptTransfer
        Stage stage;
        uint64 splitAt; // containers only; 0 until split at the cold store
        bytes32 sensorId; // container sensor covers legs 1-3; batch sensor covers leg 4
        bytes11 code; // ISO 6346 container number, e.g. "CCSU4831207"; a batch carries its container's
        bytes32 sealNumber; // containers only: the seal the supplier applied before dispatch
        // Batch-only fields
        address buyer;
        address inspector;
        int16 thresholdTenthsC; // e.g. 40 = 4.0 °C
        uint16 graceMinutes;
    }

    struct Handover {
        address custodian;
        Stage stage;
        uint64 startedAt; // block timestamp when custody began
    }

    /// What one side of a handover declares. Readings, issue reports and notes stay off-chain;
    /// `notesHash` seals them so they can't be edited later.
    struct CheckInput {
        int16 tempTenthsC; // probe temperature, e.g. 31 = 3.1 °C
        uint32 unrefrigeratedMinutes; // sender: during their custody; receiver: waiting at the handover
        bool damaged; // packaging damaged
        bool sealIntact;
        bool issues; // sender: issues reported during the leg; receiver: "accepted with issues"
        bytes32 notesHash;
    }

    struct Check {
        int16 tempTenthsC;
        uint32 unrefrigeratedMinutes;
        bool damaged;
        bool sealIntact;
        bool issues;
        bytes32 notesHash;
        address by;
        uint64 checkedAt;
    }

    struct Checkpoint {
        Check outgoing; // by the sender
        Check incoming; // by the receiver; `checkedAt` is 0 until the handover is accepted
    }

    ParticipantRegistry public immutable registry;
    uint256 public nextId = 1;

    mapping(uint256 => Unit) internal units;
    mapping(uint256 => Handover[]) internal history;
    mapping(uint256 => uint256[]) internal batchesOf;
    mapping(uint256 => mapping(uint8 => Checkpoint)) internal checkpoints; // [unit][stage it closes]
    mapping(uint256 => Check) internal pendingChecks; // sender's outgoing check while a transfer is pending
    mapping(bytes11 => uint256) public activeContainerByCode; // container number => container until it's split

    event ContainerCreated(uint256 indexed containerId, address indexed supplier, bytes32 sensorId, bytes11 code);
    event SealRecorded(uint256 indexed containerId, bytes32 sealNumber);
    event BatchAdded(
        uint256 indexed batchId, uint256 indexed containerId, address indexed buyer, address inspector, bytes32 sensorId
    );
    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed id, address indexed from, address indexed to, Stage stage);
    event ContainerSplit(uint256 indexed containerId, uint256[] batchIds);
    event CheckpointRecorded(
        uint256 indexed id, uint8 indexed stage, int16 dispatchTenthsC, int16 receiptTenthsC, bool receivedWithIssues
    );

    constructor(ParticipantRegistry _registry) {
        registry = _registry;
    }

    modifier whenSystemActive() {
        require(!registry.paused(), "system paused");
        _;
    }

    // ---- Setup (supplier) ---------------------------------------------------

    /// @param code The physical container's ISO 6346 number, or 0 to have one generated.
    function createContainer(bytes32 sensorId, bytes11 code) external whenSystemActive returns (uint256 id) {
        require(registry.hasRole(registry.SUPPLIER(), msg.sender), "not a supplier");
        require(sensorId != bytes32(0), "sensor required");

        id = nextId++;
        if (code == bytes11(0)) {
            code = containerCode(id);
        } else {
            require(isValidContainerCode(code), "invalid container number");
            require(bytes3(code) != bytes3("CCS"), "owner code CCS is reserved for generated numbers");
        }
        // Real containers are reused, so a number is only blocked while it's on an active shipment.
        require(activeContainerByCode[code] == 0, "container number already in use");
        activeContainerByCode[code] = id;

        Unit storage c = units[id];
        c.code = code;
        c.kind = Kind.Container;
        c.containerId = id;
        c.supplier = msg.sender;
        c.custodian = msg.sender;
        c.stage = Stage.Origin;
        c.sensorId = sensorId;
        _record(id, msg.sender, Stage.Origin);

        emit ContainerCreated(id, msg.sender, sensorId, c.code);
    }

    /// @notice The supplier records the number of the seal applied after loading. It can be
    ///         corrected until the container is handed to the carrier, then it's fixed.
    function recordSeal(uint256 containerId, bytes32 sealNumber) external whenSystemActive {
        Unit storage c = units[containerId];
        require(c.kind == Kind.Container, "no such container");
        require(c.supplier == msg.sender, "not this container's supplier");
        require(c.stage == Stage.Origin && c.pendingTo == address(0), "container already dispatched");
        require(sealNumber != bytes32(0), "seal number required");

        c.sealNumber = sealNumber;
        emit SealRecorded(containerId, sealNumber);
    }

    /// @notice A container number in ISO 6346 form: owner code "CCS", category "U", a six-digit
    ///         serial and the standard check digit. The serial is the id passed through a fixed
    ///         permutation of 0..999999 (7919 is coprime with 10^6), so numbers are unique but not
    ///         sequential.
    function containerCode(uint256 id) public pure returns (bytes11) {
        require(id < 1_000_000, "container numbers exhausted");
        uint256 serial = (id * 7919 + 104729) % 1_000_000;
        bytes memory out = new bytes(11);
        (out[0], out[1], out[2], out[3]) = (bytes1("C"), bytes1("C"), bytes1("S"), bytes1("U"));
        for (uint256 i = 0; i < 6; i++) {
            out[4 + i] = bytes1(uint8(48 + ((serial / 10 ** (5 - i)) % 10)));
        }
        out[10] = bytes1(uint8(48 + _checkDigit(bytes11(out))));
        return bytes11(out);
    }

    /// @notice A freight container number: three-letter owner code, category "U", six digits and
    ///         the correct ISO 6346 check digit.
    function isValidContainerCode(bytes11 code) public pure returns (bool) {
        for (uint256 i = 0; i < 11; i++) {
            bytes1 ch = code[i];
            bool ok = i < 3 ? (ch >= "A" && ch <= "Z") : i == 3 ? ch == "U" : (ch >= "0" && ch <= "9");
            if (!ok) return false;
        }
        return uint8(code[10]) - 48 == _checkDigit(code);
    }

    /// @dev ISO 6346: letters are worth 10-38 skipping multiples of 11, digits their value; the
    ///      first ten characters are weighted 2^0..2^9, and the check digit is (sum mod 11) mod 10.
    function _checkDigit(bytes11 code) internal pure returns (uint8) {
        uint256 sum = 0;
        for (uint256 i = 0; i < 10; i++) {
            uint256 ch = uint8(code[i]);
            uint256 value;
            if (ch >= 65) {
                value = ch - 65 + 10;
                if (value >= 11) value++;
                if (value >= 22) value++;
                if (value >= 33) value++;
            } else {
                value = ch - 48;
            }
            sum += value << i;
        }
        return uint8((sum % 11) % 10);
    }

    function addBatch(
        uint256 containerId,
        address buyer,
        address inspector,
        int16 thresholdTenthsC,
        uint16 graceMinutes,
        bytes32 sensorId
    ) external whenSystemActive returns (uint256 id) {
        Unit storage c = units[containerId];
        require(c.kind == Kind.Container, "no such container");
        require(c.supplier == msg.sender, "not this container's supplier");
        require(c.stage == Stage.Origin, "container already dispatched");
        require(registry.hasRole(registry.BUYER(), buyer), "buyer not registered");
        require(registry.hasRole(registry.INSPECTOR(), inspector), "inspector not registered");
        require(sensorId != bytes32(0), "sensor required");

        id = nextId++;
        Unit storage b = units[id];
        b.kind = Kind.Batch;
        b.containerId = containerId;
        b.code = c.code;
        b.supplier = msg.sender;
        b.stage = Stage.Origin;
        b.sensorId = sensorId;
        b.buyer = buyer;
        b.inspector = inspector;
        b.thresholdTenthsC = thresholdTenthsC;
        b.graceMinutes = graceMinutes;
        batchesOf[containerId].push(id);

        emit BatchAdded(id, containerId, buyer, inspector, sensorId);
    }

    // ---- Two-step handover ----------------------------------------------------

    /// @notice Current custodian names the next custodian and signs their outgoing quality check.
    ///         Calling again replaces a pending transfer (and its check).
    function initiateTransfer(uint256 id, address to, CheckInput calldata check) external whenSystemActive {
        Unit storage u = units[id];
        require(u.kind != Kind.None, "no such shipment");
        require(u.custodian == msg.sender, "not the current custodian");

        if (u.kind == Kind.Container) {
            require(u.splitAt == 0, "container already split");
            require(u.stage != Stage.ColdStore, "split the container first");
            if (u.stage == Stage.Origin) {
                require(batchesOf[id].length > 0, "add a batch first");
                require(u.sealNumber != bytes32(0), "record the seal number first");
            }
        }
        require(_isValidNextCustodian(u, to), "recipient not valid for next leg");

        u.pendingTo = to;
        pendingChecks[id] = _toCheck(check);
        emit TransferInitiated(id, msg.sender, to);
    }

    /// @notice The named recipient takes custody and signs their incoming quality check.
    ///         Problems found here are recorded, not refused: QA rules on them later.
    function acceptTransfer(uint256 id, CheckInput calldata check) external whenSystemActive {
        Unit storage u = units[id];
        require(u.pendingTo != address(0) && u.pendingTo == msg.sender, "no transfer pending for you");
        // Re-check in case the recipient was suspended after the transfer was initiated.
        require(_isValidNextCustodian(u, msg.sender), "recipient not valid for next leg");

        uint8 closing = uint8(u.stage);
        Checkpoint storage cp = checkpoints[id][closing];
        cp.outgoing = pendingChecks[id];
        cp.incoming = _toCheck(check);
        delete pendingChecks[id];

        address from = u.custodian;
        u.custodian = msg.sender;
        u.pendingTo = address(0);
        u.stage = Stage(closing + 1);
        _record(id, msg.sender, u.stage);

        emit TransferAccepted(id, from, msg.sender, u.stage);
        emit CheckpointRecorded(id, closing, cp.outgoing.tempTenthsC, check.tempTenthsC, check.issues);
    }

    // ---- Cold-store split -----------------------------------------------------

    function splitContainer(uint256 containerId) external whenSystemActive {
        Unit storage c = units[containerId];
        require(c.kind == Kind.Container, "no such container");
        require(c.stage == Stage.ColdStore, "container not at cold store");
        require(c.custodian == msg.sender, "not the current custodian");
        require(c.splitAt == 0, "already split");

        c.splitAt = uint64(block.timestamp);
        delete activeContainerByCode[c.code]; // the box has been unloaded; its number can be used again
        uint256[] memory ids = batchesOf[containerId];
        for (uint256 i = 0; i < ids.length; i++) {
            Unit storage b = units[ids[i]];
            b.custodian = msg.sender;
            b.stage = Stage.ColdStore;
            _record(ids[i], msg.sender, Stage.ColdStore);
        }
        emit ContainerSplit(containerId, ids);
    }

    // ---- Views ----------------------------------------------------------------

    function getUnit(uint256 id) external view returns (Unit memory) {
        return units[id];
    }

    function getHistory(uint256 id) external view returns (Handover[] memory) {
        return history[id];
    }

    function getBatches(uint256 containerId) external view returns (uint256[] memory) {
        return batchesOf[containerId];
    }

    /// @notice The checkpoint at the handover that closed `stage` on this unit (0 = origin dispatch).
    function getCheckpoint(uint256 id, uint8 stage) external view returns (Checkpoint memory) {
        return checkpoints[id][stage];
    }

    /// @notice The sender's outgoing check for a transfer that hasn't been accepted yet.
    function getPendingCheck(uint256 id) external view returns (Check memory) {
        return pendingChecks[id];
    }

    /// @notice Who held this batch (or container) at `timestamp`, and on which leg.
    ///         Returns address(0) if the timestamp is before the shipment existed.
    function getCustodianAt(uint256 id, uint256 timestamp) public view returns (address custodian, Stage stage) {
        Unit storage u = units[id];
        require(u.kind != Kind.None, "no such shipment");

        // A batch's own history starts at the split; before that it travelled inside its container.
        Handover[] storage own = history[id];
        if (own.length > 0 && timestamp >= own[0].startedAt) return _latestAt(own, timestamp);
        if (u.kind == Kind.Batch) return _latestAt(history[u.containerId], timestamp);
        return (address(0), Stage.Origin);
    }

    /// @notice The custody window for one sensor leg (1-4) of a shipment. `end` is 0 while
    ///         the leg is still in progress. Legs 1-3 are read from the container even when
    ///         a batch id is passed; leg 4 needs a batch id.
    function legWindow(uint256 id, uint8 leg)
        external
        view
        returns (address custodian, uint64 start, uint64 end, bytes32 sensorId, uint256 recordedOn)
    {
        require(leg >= 1 && leg <= 4, "leg must be 1-4");
        Unit storage u = units[id];
        require(u.kind != Kind.None, "no such shipment");
        require(leg <= 3 || u.kind == Kind.Batch, "leg 4 is per batch");

        recordedOn = leg <= 3 ? u.containerId : id;
        sensorId = units[recordedOn].sensorId;
        Handover[] storage h = history[recordedOn];
        for (uint256 i = 0; i < h.length; i++) {
            if (h[i].stage == Stage(leg)) {
                custodian = h[i].custodian;
                start = h[i].startedAt;
                if (i + 1 < h.length) end = h[i + 1].startedAt;
                break;
            }
        }
        // Leg 3 (container at the cold store) ends when the container is split.
        if (leg == 3) end = units[recordedOn].splitAt;
    }

    // ---- Internals ------------------------------------------------------------

    function _isValidNextCustodian(Unit storage u, address to) internal view returns (bool) {
        if (u.stage == Stage.Origin) return registry.hasRole(registry.CARRIER(), to);
        if (u.stage == Stage.Carrier) return registry.hasRole(registry.HANDLER(), to);
        if (u.stage == Stage.Handler) return registry.hasRole(registry.COLD_STORE(), to);
        if (u.stage == Stage.ColdStore) return u.kind == Kind.Batch && registry.hasRole(registry.TRUCK(), to);
        if (u.stage == Stage.Truck) return to == u.buyer && registry.hasRole(registry.BUYER(), to);
        return false; // Delivered
    }

    function _toCheck(CheckInput calldata c) internal view returns (Check memory) {
        require(c.tempTenthsC >= -400 && c.tempTenthsC <= 600, "temperature out of range");
        require(c.unrefrigeratedMinutes <= 10080, "unrefrigerated minutes out of range");
        return Check(
            c.tempTenthsC,
            c.unrefrigeratedMinutes,
            c.damaged,
            c.sealIntact,
            c.issues,
            c.notesHash,
            msg.sender,
            uint64(block.timestamp)
        );
    }

    function _record(uint256 id, address custodian, Stage stage) internal {
        history[id].push(Handover(custodian, stage, uint64(block.timestamp)));
    }

    function _latestAt(Handover[] storage h, uint256 timestamp) internal view returns (address, Stage) {
        for (uint256 i = h.length; i > 0; i--) {
            if (h[i - 1].startedAt <= timestamp) return (h[i - 1].custodian, h[i - 1].stage);
        }
        return (address(0), Stage.Origin);
    }
}
