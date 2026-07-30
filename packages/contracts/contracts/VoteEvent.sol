// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title VoteEvent
/// @notice One immutable proxy-voting event for one standard ERC-20 token.
/// @dev Eligibility is an off-chain record-date snapshot committed as a Merkle
///      root. Anyone may submit a valid signed ballot, so a Render relayer can
///      pay gas without being stored as a privileged contract address.
contract VoteEvent is EIP712 {
    error InvalidConfiguration();
    error VotingNotOpen();
    error AlreadyVoted();
    error InvalidChoices();
    error InvalidSnapshotProof();
    error InvalidSignature();
    error ZeroVotingPower();
    error InvalidProposal();
    error InvalidOption();

    bytes32 private constant BALLOT_TYPEHASH =
        keccak256("Ballot(address voter,bytes32 choicesHash)");

    address public immutable creator;
    address public immutable tokenAddress;
    uint64 public immutable snapshotBlock;
    bytes32 public immutable snapshotRoot;
    uint64 public immutable votingStart;
    uint64 public immutable votingEnd;

    /// @notice Raw token units required for one vote. For an 18-decimal token
    ///         and creator ratio X, voteUnit = X * 10**18.
    uint256 public immutable voteUnit;

    /// @notice Hash of the canonical off-chain event/proposal JSON in Neon.
    bytes32 public immutable metadataHash;

    /// @dev Bits 0..7 store proposal count. Four bits per proposal then store
    ///      option count. This avoids a dynamic array in contract storage.
    uint256 public immutable proposalConfig;

    mapping(address voter => bool voted) public hasVoted;
    mapping(uint256 proposalOptionKey => uint256 votingPower) private _tallies;

    event VoteCast(address indexed voter, uint256 votingPower, bytes choices);

    constructor(
        address creator_,
        address tokenAddress_,
        uint64 snapshotBlock_,
        bytes32 snapshotRoot_,
        uint64 votingStart_,
        uint64 votingEnd_,
        uint256 voteUnit_,
        bytes32 metadataHash_,
        uint256 proposalConfig_
    ) EIP712("PV VoteEvent", "2") {
        if (
            creator_ == address(0) ||
            tokenAddress_ == address(0) ||
            snapshotRoot_ == bytes32(0) ||
            metadataHash_ == bytes32(0) ||
            snapshotBlock_ >= block.number ||
            votingStart_ >= votingEnd_ ||
            votingEnd_ <= block.timestamp ||
            voteUnit_ == 0 ||
            !_validProposalConfig(proposalConfig_)
        ) revert InvalidConfiguration();

        creator = creator_;
        tokenAddress = tokenAddress_;
        snapshotBlock = snapshotBlock_;
        snapshotRoot = snapshotRoot_;
        votingStart = votingStart_;
        votingEnd = votingEnd_;
        voteUnit = voteUnit_;
        metadataHash = metadataHash_;
        proposalConfig = proposalConfig_;
    }

    /// @notice Submit a holder's one final ballot. The caller may be the voter,
    ///         the platform relayer, or any other address.
    function castVote(
        address voter,
        uint256 snapshotBalance,
        bytes32[] calldata proof,
        bytes calldata choices,
        bytes calldata signature
    ) external {
        if (block.timestamp < votingStart || block.timestamp > votingEnd) {
            revert VotingNotOpen();
        }
        if (hasVoted[voter]) revert AlreadyVoted();

        uint256 count = proposalCount();
        if (choices.length != count) revert InvalidChoices();

        // Double-hashed leaf matches OpenZeppelin's standard Merkle-tree format.
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(voter, snapshotBalance))));
        if (!MerkleProof.verifyCalldata(proof, snapshotRoot, leaf)) {
            revert InvalidSnapshotProof();
        }

        bytes32 structHash = keccak256(
            abi.encode(BALLOT_TYPEHASH, voter, keccak256(choices))
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != voter) {
            revert InvalidSignature();
        }

        uint256 votingPower = snapshotBalance / voteUnit;
        if (votingPower == 0) revert ZeroVotingPower();

        hasVoted[voter] = true;
        for (uint256 proposalIndex; proposalIndex < count; ) {
            uint8 selectedOption = uint8(choices[proposalIndex]);
            if (selectedOption >= _optionCountUnchecked(proposalIndex)) {
                revert InvalidOption();
            }
            _tallies[_tallyKey(proposalIndex, selectedOption)] += votingPower;
            unchecked {
                ++proposalIndex;
            }
        }

        emit VoteCast(voter, votingPower, choices);
    }

    function proposalCount() public view returns (uint8) {
        return uint8(proposalConfig);
    }

    function optionCount(uint256 proposalIndex) public view returns (uint8) {
        if (proposalIndex >= proposalCount()) revert InvalidProposal();
        return _optionCountUnchecked(proposalIndex);
    }

    function getProposalTallies(uint256 proposalIndex)
        external
        view
        returns (uint256[] memory values)
    {
        if (proposalIndex >= proposalCount()) revert InvalidProposal();
        uint256 count = _optionCountUnchecked(proposalIndex);
        values = new uint256[](count);
        for (uint256 optionIndex; optionIndex < count; ) {
            values[optionIndex] = _tallies[_tallyKey(proposalIndex, uint8(optionIndex))];
            unchecked {
                ++optionIndex;
            }
        }
    }

    function _optionCountUnchecked(uint256 proposalIndex) private view returns (uint8) {
        return uint8((proposalConfig >> (8 + proposalIndex * 4)) & 0x0f);
    }

    function _tallyKey(uint256 proposalIndex, uint8 optionIndex)
        private
        pure
        returns (uint256)
    {
        return (proposalIndex << 8) | uint256(optionIndex);
    }

    function _validProposalConfig(uint256 config) private pure returns (bool) {
        uint256 count = uint8(config);
        if (count == 0 || count > 32) return false;
        for (uint256 index; index < count; ) {
            uint256 options = (config >> (8 + index * 4)) & 0x0f;
            if (options < 2 || options > 4) return false;
            unchecked {
                ++index;
            }
        }
        return (config >> (8 + count * 4)) == 0;
    }
}
