import { AbiCoder, concat, getAddress, keccak256 } from 'ethers';

const coder = AbiCoder.defaultAbiCoder();

export function snapshotLeaf(walletAddress, rawBalance) {
  const inner = keccak256(
    coder.encode(['address', 'uint256'], [getAddress(walletAddress), BigInt(rawBalance)]),
  );
  return keccak256(concat([inner]));
}

export function hashPair(left, right) {
  const [first, second] = BigInt(left) <= BigInt(right) ? [left, right] : [right, left];
  return keccak256(concat([first, second]));
}

export function buildSnapshotTree(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Cannot build a snapshot without positive-balance holders.');
  }

  const normalized = entries
    .map((entry) => ({
      walletAddress: getAddress(entry.walletAddress).toLowerCase(),
      rawBalance: BigInt(entry.rawBalance).toString(),
      votingPower: BigInt(entry.votingPower ?? 0).toString(),
    }))
    .sort((a, b) => a.walletAddress.localeCompare(b.walletAddress));

  const leaves = normalized.map((entry) => snapshotLeaf(entry.walletAddress, entry.rawBalance));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let index = 0; index < current.length; index += 2) {
      next.push(hashPair(current[index], current[index + 1] ?? current[index]));
    }
    levels.push(next);
  }

  const treeEntries = normalized.map((entry, leafIndex) => {
    const proof = [];
    let index = leafIndex;
    for (let levelIndex = 0; levelIndex < levels.length - 1; levelIndex += 1) {
      const level = levels[levelIndex];
      proof.push(level[index ^ 1] ?? level[index]);
      index = Math.floor(index / 2);
    }
    return {
      ...entry,
      leafIndex,
      leafHash: leaves[leafIndex],
      merkleProof: proof,
    };
  });

  return { root: levels.at(-1)[0], entries: treeEntries, levels };
}

export function verifySnapshotProof({ walletAddress, rawBalance, proof, root }) {
  let computed = snapshotLeaf(walletAddress, rawBalance);
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === String(root).toLowerCase();
}
