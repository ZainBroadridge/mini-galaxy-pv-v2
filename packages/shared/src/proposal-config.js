export const MAX_PROPOSALS = 32;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

export function packProposalConfig(optionCounts) {
  if (!Array.isArray(optionCounts) || optionCounts.length < 1 || optionCounts.length > MAX_PROPOSALS) {
    throw new Error(`Proposal count must be between 1 and ${MAX_PROPOSALS}.`);
  }

  let packed = BigInt(optionCounts.length);
  optionCounts.forEach((value, index) => {
    const count = Number(value);
    if (!Number.isInteger(count) || count < MIN_OPTIONS || count > MAX_OPTIONS) {
      throw new Error(`Proposal ${index + 1} must contain ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
    }
    packed |= BigInt(count) << BigInt(8 + index * 4);
  });
  return packed;
}

export function unpackProposalConfig(value) {
  const packed = BigInt(value);
  const proposalCount = Number(packed & 0xffn);
  if (proposalCount < 1 || proposalCount > MAX_PROPOSALS) {
    throw new Error('Invalid packed proposal count.');
  }

  const optionCounts = Array.from({ length: proposalCount }, (_, index) =>
    Number((packed >> BigInt(8 + index * 4)) & 0xfn),
  );
  optionCounts.forEach((count, index) => {
    if (count < MIN_OPTIONS || count > MAX_OPTIONS) {
      throw new Error(`Invalid option count for proposal ${index + 1}.`);
    }
  });
  return { proposalCount, optionCounts };
}
