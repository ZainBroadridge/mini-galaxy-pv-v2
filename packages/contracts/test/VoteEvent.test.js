const { expect } = require('chai');
const { ethers } = require('hardhat');

const coder = ethers.AbiCoder.defaultAbiCoder();

function leaf(address, balance) {
  const inner = ethers.keccak256(coder.encode(['address', 'uint256'], [address, balance]));
  return ethers.keccak256(ethers.concat([inner]));
}

function pair(a, b) {
  const [first, second] = BigInt(a) <= BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat([first, second]));
}

function treeFor(entries) {
  const leaves = entries.map(([address, balance]) => leaf(address, balance));
  if (leaves.length !== 2) throw new Error('This compact contract test helper expects two leaves.');
  const root = pair(leaves[0], leaves[1]);
  return {
    root,
    proofs: new Map([
      [entries[0][0].toLowerCase(), [leaves[1]]],
      [entries[1][0].toLowerCase(), [leaves[0]]],
    ]),
  };
}

function proposalConfig(optionCounts) {
  let packed = BigInt(optionCounts.length);
  optionCounts.forEach((count, index) => {
    packed |= BigInt(count) << BigInt(8 + index * 4);
  });
  return packed;
}

async function moveTo(timestamp) {
  await ethers.provider.send('evm_setNextBlockTimestamp', [timestamp]);
  await ethers.provider.send('evm_mine');
}

describe('VoteEvent', function () {
  async function fixture({
    futureStart = false,
    voterBalance = ethers.parseUnits('100', 18),
    secondBalance = ethers.parseUnits('40', 18),
    voteUnit = ethers.parseUnits('5', 18),
    optionCounts = [3, 2],
  } = {}) {
    const [relayer, creator, voter, secondVoter, tokenAddress, stranger] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock('latest');
    const tree = treeFor([
      [voter.address, voterBalance],
      [secondVoter.address, secondBalance],
    ]);
    const start = latest.timestamp + (futureStart ? 60 : 0);
    const end = start + 3600;
    const factory = await ethers.getContractFactory('VoteEvent', relayer);
    const args = [
      creator.address,
      tokenAddress.address,
      Math.max(0, latest.number - 1),
      tree.root,
      start,
      end,
      voteUnit,
      ethers.keccak256(ethers.toUtf8Bytes('metadata')),
      proposalConfig(optionCounts),
    ];
    const contract = await factory.deploy(...args);
    await contract.waitForDeployment();
    return {
      contract,
      factory,
      args,
      relayer,
      creator,
      voter,
      secondVoter,
      stranger,
      snapshotBalance: voterBalance,
      secondBalance,
      tree,
      start,
      end,
    };
  }

  async function signBallot(contract, signer, choices) {
    const network = await ethers.provider.getNetwork();
    const choicesBytes = ethers.hexlify(Uint8Array.from(choices));
    const signature = await signer.signTypedData(
      {
        name: 'PV VoteEvent',
        version: '2',
        chainId: network.chainId,
        verifyingContract: await contract.getAddress(),
      },
      {
        Ballot: [
          { name: 'voter', type: 'address' },
          { name: 'choicesHash', type: 'bytes32' },
        ],
      },
      { voter: signer.address, choicesHash: ethers.keccak256(choicesBytes) },
    );
    return { choicesBytes, signature };
  }

  async function cast({ contract, caller, voter, balance, proof, choices }) {
    const ballot = await signBallot(contract, voter, choices);
    return contract.connect(caller).castVote(
      voter.address,
      balance,
      proof,
      ballot.choicesBytes,
      ballot.signature,
    );
  }

  it('accepts one relayed weighted ballot and updates on-chain tallies', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [0, 1]);

    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.emit(contract, 'VoteCast').withArgs(voter.address, 20, ballot.choicesBytes);

    expect(await contract.hasVoted(voter.address)).to.equal(true);
    expect(await contract.getProposalTallies(0)).to.deep.equal([20n, 0n, 0n]);
    expect(await contract.getProposalTallies(1)).to.deep.equal([0n, 20n]);
  });

  it('allows any address to relay a valid ballot without contract privilege', async function () {
    const { contract, stranger, voter, snapshotBalance, tree } = await fixture();
    await expect(cast({
      contract,
      caller: stranger,
      voter,
      balance: snapshotBalance,
      proof: tree.proofs.get(voter.address.toLowerCase()),
      choices: [2, 1],
    })).to.emit(contract, 'VoteCast');
  });

  it('aggregates independent weighted ballots', async function () {
    const {
      contract,
      relayer,
      voter,
      secondVoter,
      snapshotBalance,
      secondBalance,
      tree,
    } = await fixture();
    await cast({
      contract,
      caller: relayer,
      voter,
      balance: snapshotBalance,
      proof: tree.proofs.get(voter.address.toLowerCase()),
      choices: [0, 1],
    });
    await cast({
      contract,
      caller: relayer,
      voter: secondVoter,
      balance: secondBalance,
      proof: tree.proofs.get(secondVoter.address.toLowerCase()),
      choices: [1, 1],
    });
    expect(await contract.getProposalTallies(0)).to.deep.equal([20n, 8n, 0n]);
    expect(await contract.getProposalTallies(1)).to.deep.equal([0n, 28n]);
  });

  it('rejects duplicate voting', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [1, 0]);
    const args = [
      voter.address,
      snapshotBalance,
      tree.proofs.get(voter.address.toLowerCase()),
      ballot.choicesBytes,
      ballot.signature,
    ];
    await contract.connect(relayer).castVote(...args);
    await expect(contract.connect(relayer).castVote(...args))
      .to.be.revertedWithCustomError(contract, 'AlreadyVoted');
  });

  it('rejects a false snapshot balance', async function () {
    const { contract, relayer, voter, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [0, 0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        1,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidSnapshotProof');
  });

  it('rejects changing choices after the voter signs', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [0, 1]);
    const alteredChoices = ethers.hexlify(Uint8Array.from([1, 1]));
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        alteredChoices,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidSignature');
  });

  it('rejects a signature from another wallet', async function () {
    const { contract, relayer, voter, secondVoter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, secondVoter, [0, 1]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidSignature');
  });

  it('domain-separates signatures between VoteEvent contracts', async function () {
    const first = await fixture();
    const secondFactory = await ethers.getContractFactory('VoteEvent', first.relayer);
    const second = await secondFactory.deploy(...first.args);
    await second.waitForDeployment();
    const ballot = await signBallot(first.contract, first.voter, [0, 1]);
    await expect(
      second.connect(first.relayer).castVote(
        first.voter.address,
        first.snapshotBalance,
        first.tree.proofs.get(first.voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(second, 'InvalidSignature');
  });

  it('rejects an option outside the proposal configuration', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [3, 0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidOption');
    expect(await contract.hasVoted(voter.address)).to.equal(false);
  });

  it('rejects an incomplete ballot', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture();
    const ballot = await signBallot(contract, voter, [0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'InvalidChoices');
  });

  it('rejects a holder below one complete voting unit', async function () {
    const voterBalance = ethers.parseUnits('1', 18);
    const { contract, relayer, voter, tree } = await fixture({ voterBalance });
    const ballot = await signBallot(contract, voter, [0, 0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        voterBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'ZeroVotingPower');
  });

  it('enforces the voting start time', async function () {
    const { contract, relayer, voter, snapshotBalance, tree } = await fixture({ futureStart: true });
    const ballot = await signBallot(contract, voter, [0, 0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'VotingNotOpen');
  });

  it('enforces the voting end time', async function () {
    const { contract, relayer, voter, snapshotBalance, tree, end } = await fixture();
    await moveTo(end + 1);
    const ballot = await signBallot(contract, voter, [0, 0]);
    await expect(
      contract.connect(relayer).castVote(
        voter.address,
        snapshotBalance,
        tree.proofs.get(voter.address.toLowerCase()),
        ballot.choicesBytes,
        ballot.signature,
      ),
    ).to.be.revertedWithCustomError(contract, 'VotingNotOpen');
  });

  it('validates proposal indexes', async function () {
    const { contract } = await fixture();
    await expect(contract.optionCount(2)).to.be.revertedWithCustomError(contract, 'InvalidProposal');
    await expect(contract.getProposalTallies(2)).to.be.revertedWithCustomError(contract, 'InvalidProposal');
  });

  it('rejects a snapshot block that is not strictly historical', async function () {
    const [relayer, creator, tokenAddress] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock('latest');
    const factory = await ethers.getContractFactory('VoteEvent', relayer);
    await expect(factory.deploy(
      creator.address,
      tokenAddress.address,
      latest.number + 100,
      ethers.keccak256(ethers.toUtf8Bytes('root')),
      latest.timestamp,
      latest.timestamp + 1000,
      1,
      ethers.keccak256(ethers.toUtf8Bytes('metadata')),
      proposalConfig([2]),
    )).to.be.revertedWithCustomError(factory, 'InvalidConfiguration');
  });

  it('rejects a malformed proposal configuration at deployment', async function () {
    const [relayer, creator, tokenAddress] = await ethers.getSigners();
    const latest = await ethers.provider.getBlock('latest');
    const factory = await ethers.getContractFactory('VoteEvent', relayer);
    await expect(factory.deploy(
      creator.address,
      tokenAddress.address,
      Math.max(0, latest.number - 1),
      ethers.keccak256(ethers.toUtf8Bytes('root')),
      latest.timestamp,
      latest.timestamp + 1000,
      1,
      ethers.keccak256(ethers.toUtf8Bytes('metadata')),
      0,
    )).to.be.revertedWithCustomError(factory, 'InvalidConfiguration');
  });
});
