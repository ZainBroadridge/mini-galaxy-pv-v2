import { getAddress, keccak256 } from 'ethers';

export const BALLOT_TYPES = Object.freeze({
  Ballot: [
    { name: 'voter', type: 'address' },
    { name: 'choicesHash', type: 'bytes32' },
  ],
});

export function choicesToBytes(choices) {
  if (!Array.isArray(choices) || choices.length === 0 || choices.length > 32) {
    throw new Error('Choices must contain 1-32 option indexes.');
  }
  const bytes = new Uint8Array(choices.length);
  choices.forEach((choice, index) => {
    const value = Number(choice);
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error(`Choice ${index + 1} is not an unsigned byte.`);
    }
    bytes[index] = value;
  });
  return `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function ballotTypedData({ chainId, contractAddress, voter, choices }) {
  const choicesBytes = choicesToBytes(choices);
  return {
    domain: {
      name: 'PV VoteEvent',
      version: '2',
      chainId: Number(chainId),
      verifyingContract: getAddress(contractAddress),
    },
    types: BALLOT_TYPES,
    primaryType: 'Ballot',
    message: {
      voter: getAddress(voter),
      choicesHash: keccak256(choicesBytes),
    },
    choicesBytes,
  };
}
