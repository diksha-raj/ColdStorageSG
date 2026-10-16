// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ParticipantRegistry
/// @notice Who is on the platform and what role they hold. Each wallet holds exactly one role.
///         The admin can pause the whole system; the other contracts read `paused()` from here.
///         Organisation names and contact details live off-chain in the Identity Service.
contract ParticipantRegistry is AccessControl, Pausable {
    // Human participants
    bytes32 public constant SUPPLIER = keccak256("SUPPLIER");
    bytes32 public constant CARRIER = keccak256("CARRIER");
    bytes32 public constant HANDLER = keccak256("HANDLER");
    bytes32 public constant COLD_STORE = keccak256("COLD_STORE");
    bytes32 public constant TRUCK = keccak256("TRUCK");
    bytes32 public constant BUYER = keccak256("BUYER");
    bytes32 public constant INSPECTOR = keccak256("INSPECTOR");
    // Service wallets
    bytes32 public constant ORACLE = keccak256("ORACLE");
    bytes32 public constant CERTIFIER = keccak256("CERTIFIER");

    struct Participant {
        bytes32 role;
        bool active;
        uint64 registeredAt;
    }

    mapping(address => Participant) public participants;

    event ParticipantRegistered(address indexed wallet, bytes32 indexed role);
    event ParticipantSuspended(address indexed wallet, bytes32 indexed role);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function registerParticipant(address wallet, bytes32 role) external onlyRole(DEFAULT_ADMIN_ROLE) whenNotPaused {
        require(wallet != address(0), "zero address");
        require(isParticipantRole(role), "unknown role");
        require(participants[wallet].registeredAt == 0, "already registered");

        participants[wallet] = Participant(role, true, uint64(block.timestamp));
        _grantRole(role, wallet);
        emit ParticipantRegistered(wallet, role);
    }

    function suspendParticipant(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Participant storage p = participants[wallet];
        require(p.active, "not active");

        p.active = false;
        _revokeRole(p.role, wallet);
        emit ParticipantSuspended(wallet, p.role);
    }

    /// @notice The wallet's role, or 0x0 if unknown or suspended.
    function roleOf(address wallet) external view returns (bytes32) {
        Participant memory p = participants[wallet];
        return p.active ? p.role : bytes32(0);
    }

    function isParticipantRole(bytes32 role) public pure returns (bool) {
        return role == SUPPLIER || role == CARRIER || role == HANDLER || role == COLD_STORE || role == TRUCK
            || role == BUYER || role == INSPECTOR || role == ORACLE || role == CERTIFIER;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // Roles change only through registerParticipant / suspendParticipant, so the
    // `participants` mapping and AccessControl never drift apart.
    function grantRole(bytes32, address) public pure override {
        revert("use registerParticipant");
    }

    function revokeRole(bytes32, address) public pure override {
        revert("use suspendParticipant");
    }

    function renounceRole(bytes32, address) public pure override {
        revert("ask the admin to suspend");
    }
}
