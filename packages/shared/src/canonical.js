import { keccak256, toUtf8Bytes } from 'ethers';
import { EVENT_METADATA_SCHEMA } from './constants.js';
import { MAX_OPTIONS, MAX_PROPOSALS, MIN_OPTIONS } from './proposal-config.js';

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function cleanText(value, maxLength, { required = true } = {}) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (required && text.length === 0) throw new Error('Required text is missing.');
  if (text.length > maxLength) throw new Error(`Text exceeds ${maxLength} characters.`);
  return text;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value));
}

export function canonicalHash(value) {
  return keccak256(toUtf8Bytes(canonicalJson(value)));
}

export function canonicalEventMetadata({ title, description = '', proposals }) {
  if (!Array.isArray(proposals) || proposals.length < 1 || proposals.length > MAX_PROPOSALS) {
    throw new Error(`An event must contain 1-${MAX_PROPOSALS} proposals.`);
  }

  return {
    schema: EVENT_METADATA_SCHEMA,
    title: cleanText(title, 180),
    description: cleanText(description, 8000, { required: false }),
    proposals: proposals.map((proposal, proposalIndex) => {
      const optionTexts = Array.isArray(proposal.options)
        ? proposal.options.map((option) => cleanText(option?.text ?? option, 180))
        : [];
      if (optionTexts.length < MIN_OPTIONS || optionTexts.length > MAX_OPTIONS) {
        throw new Error(`Proposal ${proposalIndex + 1} must have ${MIN_OPTIONS}-${MAX_OPTIONS} options.`);
      }

      const recommendation = proposal.recommendation === null || proposal.recommendation === undefined
        ? null
        : Number(proposal.recommendation);
      if (
        recommendation !== null
        && (!Number.isInteger(recommendation) || recommendation < 0 || recommendation >= optionTexts.length)
      ) {
        throw new Error(`Proposal ${proposalIndex + 1} has an invalid recommendation.`);
      }

      return {
        index: proposalIndex,
        title: cleanText(proposal.title, 220),
        description: cleanText(proposal.description, 5000, { required: false }),
        options: optionTexts.map((text, optionIndex) => ({ index: optionIndex, text })),
        recommendation,
      };
    }),
  };
}

export function hashEventMetadata(input) {
  const metadata = input?.schema === EVENT_METADATA_SCHEMA
    ? normalize(input)
    : canonicalEventMetadata(input);
  return {
    metadata,
    canonicalJson: canonicalJson(metadata),
    hash: canonicalHash(metadata),
  };
}
