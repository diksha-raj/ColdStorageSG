// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ParticipantRegistry} from "./ParticipantRegistry.sol";

/// @title ShipmentCustody
/// @notice Who holds each batch and container, when they took it and handed it on, and which of
///         their sensors covered it.
///
/// Batches and containers share one id space ("units"). The route, by stage:
///
///   0 Origin     the supplier creates batches and keeps them in its cold room
///   1 Carrier    Cargo receives each batch straight into its container, seals it, ships it
///   2 Handler    the destination freight handler takes the sealed container
///   3 ColdStore  the cold store takes the container and unloads it; batches go on singly
///   4 Truck      a reefer truck takes a batch to its buyer
///   5 Delivered  the buyer holds it
///
/// Every handover is a two-sided quality check: the sender signs it off (initiateTransfer), the
/// receiver signs it in (acceptTransfer / acceptIntoContainer). The sign-off is the unit's exit
/// time from the sender; the sign-in is its entry time with the receiver. Between the two it's on
/// the dock, unrefrigerated: the handover gap. There is no rejection: problems are recorded, then
/// flagged and ruled on by QA (CertificateRegistry).
///
/// Each custodian registers its own sensor for the stage it holds: the supplier's cold room
/// (stage 0), Cargo's container (stages 1-2: it keeps reading while the handler holds it), the
/// cold store's room (3) and the truck (4). Checks for stages 0, 3 and 4 live on the batch; for
/// stages 1 and 2 on the container.
contract ShipmentCustody {
    enum Kind {
        None,
        Container,
        Batch
    }

    // Order matters: a batch moves through these in turn.
    enum Stage {
        Origin, //    0  supplier
        Carrier, //   1  Cargo (air or sea)
        Handler, //   2  destination freight handler
        ColdStore, // 3  cold store
        Truck, //     4  reefer truck
        Delivered //  5  buyer
    }

    struct Unit {
        Kind kind;
        uint256 containerId; // batch: the container it was received into (0 before); container: own id
        address supplier; // batch: who created it (0 for containers)
        address custodian;
        address pendingTo; // set by initiateTransfer, cleared on sign-in
        Stage stage;
        uint64 createdAt;
        uint64 unloadedAt; // container: when the cold store unloaded it (0 until then)
        bytes11 code; // ISO 6346 container number; a batch carries its container's once loaded
        bytes32 sealNumber; // container: the seal Cargo applied after loading
        // Batch-only fields, fixed by the supplier
        address buyer;
        address inspector;
        int16 thresholdTenthsC; // max allowed temperature, e.g. 40 = 4.0 °C
        uint16 graceMinutes;
    }

    struct Handover {
        address custodian;
        Stage stage;
        uint64 startedAt;
    }

    struct Sensor {
        bytes32 sensorId;
        address device; // the key the sensor signs its readings with
        address owner; // the participant who registered it
        uint64 registeredAt;
    }

    /// What one side of a handover declares. Spot readings, issue reports and notes stay off-chain;
    /// `notesHash` seals them so they can't be edited later.
    struct CheckInput {
        int16 tempTenthsC; // probe temperature, e.g. 31 = 3.1 °C
        bool damaged; // packaging damaged
        bool sealIntact;
        bool issues; // sender: issues during their stage; receiver: "accepted with issues"
        bytes32 notesHash;
    }

    struct Check {
        int16 tempTenthsC;
        bool damaged;
        bool sealIntact;
        bool issues;
        bytes32 notesHash;
        address by;
        uint64 checkedAt; // sender: exit time; receiver: entry time
    }

    struct Checkpoint {
        Check outgoing; // the sender's sign-off
        Check incoming; // the receiver's sign-in; `checkedAt` is 0 until then
    }

    ParticipantRegistry public immutable registry;
    uint256 public nextId = 1;

    mapping(uint256 => Unit) internal units;
    mapping(uint256 => Handover[]) internal history;
    mapping(uint256 => uint256[]) internal batchesOf; // container => batches inside
    mapping(uint256 => mapping(uint8 => Checkpoint)) internal checkpoints; // [unit][stage it closes]
    mapping(uint256 => Check) internal pendingChecks; // sender's sign-off while the handover is pending
    mapping(uint256 => mapping(uint8 => Sensor)) internal sensors; // [unit][stage]
    mapping(bytes32 => address) public sensorOwner;
    mapping(bytes32 => address) public sensorDevice;
    mapping(bytes11 => uint256) public activeContainerByCode; // container number => container until unloaded

    event BatchCreated(
        uint256 indexed batchId,
        address indexed supplier,
        address indexed buyer,
        address inspector,
        int16 thresholdTenthsC,
        uint16 graceMinutes
    );
    event ContainerCreated(uint256 indexed containerId, address indexed carrier, bytes11 code);
    event SensorRegistered(uint256 indexed id, uint8 indexed stage, bytes32 indexed sensorId, address device, address owner);
    event BatchLoaded(uint256 indexed batchId, uint256 indexed containerId);
    event SealRecorded(uint256 indexed containerId, bytes32 sealNumber);
    event TransferInitiated(uint256 indexed id, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed id, address indexed from, address indexed to, Stage stage);
    event ContainerUnloaded(uint256 indexed containerId, uint256[] batchIds);
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

    // ---- Supplier: batches ----------------------------------------------------

    function createBatch(address buyer, address inspector, int16 thresholdTenthsC, uint16 graceMinutes)
        external
        whenSystemActive
        returns (uint256 id)
    {
        require(registry.hasRole(registry.SUPPLIER(), msg.sender), "not a supplier");
        require(registry.hasRole(registry.BUYER(), buyer), "buyer not registered");
        require(registry.hasRole(registry.INSPECTOR(), inspector), "inspector not registered");
        require(thresholdTenthsC >= -400 && thresholdTenthsC <= 600, "temperature limit out of range");

        id = nextId++;
        Unit storage b = units[id];
        b.kind = Kind.Batch;
        b.supplier = msg.sender;
        b.custodian = msg.sender;
        b.stage = Stage.Origin;
        b.createdAt = uint64(block.timestamp);
        b.buyer = buyer;
        b.inspector = inspector;
        b.thresholdTenthsC = thresholdTenthsC;
        b.graceMinutes = graceMinutes;
        _record(id, msg.sender, Stage.Origin);

        emit BatchCreated(id, msg.sender, buyer, inspector, thresholdTenthsC, graceMinutes);
    }

    // ---- Cargo: containers ------------------------------------------------------

    /// @param code The physical container's ISO 6346 number, or 0 to have one generated.
    function createContainer(bytes11 code) external whenSystemActive returns (uint256 id) {
        require(registry.hasRole(registry.CARRIER(), msg.sender), "not a carrier");

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
        c.kind = Kind.Container;
        c.containerId = id;
        c.custodian = msg.sender;
        c.stage = Stage.Carrier;
        c.createdAt = uint64(block.timestamp);
        c.code = code;
        _record(id, msg.sender, Stage.Carrier);

        emit ContainerCreated(id, msg.sender, code);
    }

    /// @notice Cargo records the seal applied after loading. It can be corrected until the
    ///         container is handed on, then it's fixed.
    function recordSeal(uint256 containerId, bytes32 sealNumber) external whenSystemActive {
        Unit storage c = units[containerId];
        require(c.kind == Kind.Container, "no such container");
        require(c.custodian == msg.sender, "not the current custodian");
        require(c.stage == Stage.Carrier && c.pendingTo == address(0), "container already dispatched");
        require(batchesOf[containerId].length > 0, "load a batch first");
        require(sealNumber != bytes32(0), "seal number required");

        c.sealNumber = sealNumber;
        emit SealRecorded(containerId, sealNumber);
    }

    // ---- Sensors ----------------------------------------------------------------

    /// @notice The current custodian registers the sensor covering these units for the stage they
    ///         hold: the supplier's cold room, Cargo's container, the cold store's room or the truck.
    ///         One sensor (a room, a truck) can cover many units.
    function registerSensor(uint256[] calldata ids, bytes32 sensorId, address device) external whenSystemActive {
        require(sensorId != bytes32(0) && device != address(0), "sensor id and device required");
        address owner = sensorOwner[sensorId];
        require(owner == address(0) || owner == msg.sender, "sensor belongs to another participant");
        address bound = sensorDevice[sensorId];
        require(bound == address(0) || bound == device, "sensor is bound to another device");
        sensorOwner[sensorId] = msg.sender;
        sensorDevice[sensorId] = device;

        for (uint256 i = 0; i < ids.length; i++) {
            Unit storage u = units[ids[i]];
            require(u.kind != Kind.None, "no such shipment");
            require(u.custodian == msg.sender, "not the current custodian");
            uint8 stage = _sensorStage(u);
            require(sensors[ids[i]][stage].device == address(0), "sensor already registered for this stage");

            Sensor memory s = Sensor(sensorId, device, msg.sender, uint64(block.timestamp));
            sensors[ids[i]][stage] = s;
            // The container's sensor keeps covering it while the handler holds it.
            if (u.kind == Kind.Container) sensors[ids[i]][uint8(Stage.Handler)] = s;
            emit SensorRegistered(ids[i], stage, sensorId, device, msg.sender);
        }
    }

    // ---- Handovers ------------------------------------------------------------

    /// @notice The current custodian signs the unit off to the next custodian (its exit time).
    ///         Calling again replaces a pending handover and its check.
    function initiateTransfer(uint256 id, address to, CheckInput calldata check) external whenSystemActive {
        Unit storage u = units[id];
        require(u.kind != Kind.None, "no such shipment");
        require(u.custodian == msg.sender, "not the current custodian");
        require(u.stage != Stage.Delivered, "batch already delivered");

        if (u.kind == Kind.Batch) {
            require(u.containerId == 0 || units[u.containerId].unloadedAt != 0, "batch is inside a container");
        } else {
            require(u.unloadedAt == 0, "container already unloaded");
            require(u.stage != Stage.ColdStore, "unload the container; batches leave the cold store singly");
            if (u.stage == Stage.Carrier) require(u.sealNumber != bytes32(0), "record the seal number first");
        }
        require(sensors[id][uint8(u.stage)].device != address(0), "register a sensor first");
        require(_isValidNextCustodian(u, to), "recipient not valid for next leg");

        u.pendingTo = to;
        pendingChecks[id] = _toCheck(check);
        emit TransferInitiated(id, msg.sender, to);
    }

    /// @notice Cargo signs a batch in straight into one of its open containers (the batch's entry).
    function acceptIntoContainer(uint256 batchId, uint256 containerId, CheckInput calldata check) external whenSystemActive {
        Unit storage b = units[batchId];
        require(b.kind == Kind.Batch && b.stage == Stage.Origin, "not a batch at origin");
        require(b.pendingTo != address(0) && b.pendingTo == msg.sender, "no transfer pending for you");
        require(_isValidNextCustodian(b, msg.sender), "recipient not valid for next leg");
        Unit storage c = units[containerId];
        require(
            c.kind == Kind.Container && c.custodian == msg.sender && c.stage == Stage.Carrier && c.pendingTo == address(0),
            "not an open container of yours"
        );
        require(c.sealNumber == bytes32(0), "container already sealed");

        b.containerId = containerId;
        b.code = c.code;
        batchesOf[containerId].push(batchId);
        _signIn(batchId, check);
        emit BatchLoaded(batchId, containerId);
    }

    /// @notice The named recipient signs the unit in (its entry time) and takes custody.
    ///         Problems found here are recorded, not refused: QA rules on them later.
    ///         Signing in a container moves every batch inside it too.
    function acceptTransfer(uint256 id, CheckInput calldata check) external whenSystemActive {
        Unit storage u = units[id];
        require(u.pendingTo != address(0) && u.pendingTo == msg.sender, "no transfer pending for you");
        require(!(u.kind == Kind.Batch && u.stage == Stage.Origin), "receive the batch into a container");
        // Re-check in case the recipient was suspended after the transfer was initiated.
        require(_isValidNextCustodian(u, msg.sender), "recipient not valid for next leg");
        _signIn(id, check);

        if (u.kind == Kind.Container) {
            uint256[] storage inside = batchesOf[id];
            for (uint256 i = 0; i < inside.length; i++) {
                Unit storage b = units[inside[i]];
                b.custodian = msg.sender;
                b.stage = u.stage;
                _record(inside[i], msg.sender, u.stage);
            }
        }
    }

    // ---- Cold store: unloading --------------------------------------------------

    function unloadContainer(uint256 containerId) external whenSystemActive {
        Unit storage c = units[containerId];
        require(c.kind == Kind.Container, "no such container");
        require(c.stage == Stage.ColdStore, "container not at cold store");
        require(c.custodian == msg.sender, "not the current custodian");
        require(c.unloadedAt == 0, "already unloaded");

        c.unloadedAt = uint64(block.timestamp);
        delete activeContainerByCode[c.code]; // the box is empty; its number can be used again
        emit ContainerUnloaded(containerId, batchesOf[containerId]);
    }

    // ---- Container numbers --------------------------------------------------------

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

    /// @notice The handover that closed `stage` on this unit.
    function getCheckpoint(uint256 id, uint8 stage) external view returns (Checkpoint memory) {
        return checkpoints[id][stage];
    }

    /// @notice The sender's sign-off for a handover not yet signed in.
    function getPendingCheck(uint256 id) external view returns (Check memory) {
        return pendingChecks[id];
    }

    /// @notice The unit a batch's stage is recorded on: its container for stages 1-2, else itself.
    function recordedOn(uint256 id, uint8 stage) public view returns (uint256) {
        Unit storage u = units[id];
        require(u.kind != Kind.None, "no such shipment");
        if (u.kind == Kind.Batch && (stage == uint8(Stage.Carrier) || stage == uint8(Stage.Handler))) return u.containerId;
        return id;
    }

    /// @notice The sensor covering this unit's stage (for a batch's stages 1-2, its container's).
    function getSensor(uint256 id, uint8 stage) external view returns (Sensor memory) {
        return sensors[recordedOn(id, stage)][stage];
    }

    /// @notice One batch's stage: who held it, its entry and exit times, and the unit it's recorded
    ///         on. `end` is 0 until the handover closing the stage is signed in. Stage 1 runs until
    ///         the handler signs the container in: the container's sensor reads through that handover.
    function stageWindow(uint256 batchId, uint8 stage)
        external
        view
        returns (address custodian, uint64 start, uint64 end, uint256 unit)
    {
        Unit storage b = units[batchId];
        require(b.kind == Kind.Batch, "not a batch");
        require(stage <= uint8(Stage.Truck), "stage must be 0-4");
        unit = recordedOn(batchId, stage);

        Handover[] storage h = history[batchId];
        for (uint256 i = 0; i < h.length; i++) {
            if (h[i].stage == Stage(stage)) {
                custodian = h[i].custodian;
                break;
            }
        }
        start = stage == 0 ? b.createdAt : _entry(batchId, stage);
        end = _exit(unit, stage);
    }

    /// @notice The window a sensor commits its readings for: per container for stages 1-2, per
    ///         batch otherwise. A container's stage 1 starts when Cargo opens it.
    function sensorWindow(uint256 id, uint8 stage) external view returns (Sensor memory sensor, uint64 start, uint64 end) {
        Unit storage u = units[id];
        require(stage <= uint8(Stage.Truck), "stage must be 0-4");
        require(recordedOn(id, stage) == id, "stage is recorded on the container");
        if (u.kind == Kind.Container) {
            require(stage == uint8(Stage.Carrier) || stage == uint8(Stage.Handler), "containers cover stages 1-2");
            start = stage == uint8(Stage.Carrier) ? u.createdAt : checkpoints[id][uint8(Stage.Carrier)].incoming.checkedAt;
        } else {
            start = stage == 0 ? u.createdAt : _entry(id, stage);
        }
        sensor = sensors[id][stage];
        end = _exit(id, stage);
    }

    /// @notice Whole minutes the batch spent on the dock at the handover closing
    ///         `stage`, from the sender's sign-off to the receiver's sign-in. Always 0 for stage 1
    ///         (the container's sensor keeps reading), and 0 until the handover is signed in.
    function handoverGapMinutes(uint256 batchId, uint8 stage) external view returns (uint256) {
        require(units[batchId].kind == Kind.Batch, "not a batch");
        if (stage == uint8(Stage.Carrier)) return 0;
        Checkpoint storage cp = checkpoints[recordedOn(batchId, stage)][stage];
        if (cp.incoming.checkedAt == 0) return 0;
        return uint256(cp.incoming.checkedAt - cp.outgoing.checkedAt) / 60;
    }

    // ---- Internals ------------------------------------------------------------

    /// The stage a custodian's own sensor covers for this unit, or a revert saying what covers it.
    function _sensorStage(Unit storage u) internal view returns (uint8) {
        if (u.kind == Kind.Container) {
            require(u.stage == Stage.Carrier, "the container's sensor covers this stage");
            return uint8(Stage.Carrier);
        }
        require(u.stage != Stage.Carrier && u.stage != Stage.Handler, "the container's sensor covers this batch");
        require(u.stage != Stage.Delivered, "batch already delivered");
        return uint8(u.stage);
    }

    /// Entry time into a batch's stage: when the receiver signed in the handover before it.
    function _entry(uint256 batchId, uint8 stage) internal view returns (uint64) {
        return checkpoints[recordedOn(batchId, stage - 1)][stage - 1].incoming.checkedAt;
    }

    /// Exit time from a unit's stage: the sender's sign-off, once signed in. A container's stage 1
    /// ends when the handler signs it in, since its sensor keeps reading through the handover.
    function _exit(uint256 unit, uint8 stage) internal view returns (uint64) {
        Checkpoint storage cp = checkpoints[unit][stage];
        if (cp.incoming.checkedAt == 0) return 0;
        return stage == uint8(Stage.Carrier) ? cp.incoming.checkedAt : cp.outgoing.checkedAt;
    }

    function _signIn(uint256 id, CheckInput calldata check) internal {
        Unit storage u = units[id];
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

    function _isValidNextCustodian(Unit storage u, address to) internal view returns (bool) {
        if (u.stage == Stage.Origin) return registry.hasRole(registry.CARRIER(), to);
        if (u.stage == Stage.Carrier) return u.kind == Kind.Container && registry.hasRole(registry.HANDLER(), to);
        if (u.stage == Stage.Handler) return u.kind == Kind.Container && registry.hasRole(registry.COLD_STORE(), to);
        if (u.stage == Stage.ColdStore) return u.kind == Kind.Batch && registry.hasRole(registry.TRUCK(), to);
        if (u.stage == Stage.Truck) return to == u.buyer && registry.hasRole(registry.BUYER(), to);
        return false; // Delivered
    }

    function _toCheck(CheckInput calldata c) internal view returns (Check memory) {
        require(c.tempTenthsC >= -400 && c.tempTenthsC <= 600, "temperature out of range");
        return Check(c.tempTenthsC, c.damaged, c.sealIntact, c.issues, c.notesHash, msg.sender, uint64(block.timestamp));
    }

    function _record(uint256 id, address custodian, Stage stage) internal {
        history[id].push(Handover(custodian, stage, uint64(block.timestamp)));
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
}
