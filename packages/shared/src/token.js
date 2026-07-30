export function naturalNumber(value, fieldName = 'value') {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${fieldName} must be a natural number.`);
  }
  return number;
}

export function tokenUnitsPerVote(decimals, tokenToVoteRatio) {
  const decimalCount = Number(decimals);
  if (!Number.isInteger(decimalCount) || decimalCount < 0 || decimalCount > 36) {
    throw new Error('Token decimals must be an integer between 0 and 36.');
  }
  return BigInt(naturalNumber(tokenToVoteRatio, 'Token-to-vote ratio'))
    * (10n ** BigInt(decimalCount));
}
