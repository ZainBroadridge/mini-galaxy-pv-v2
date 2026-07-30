import { z } from 'zod';
import {
  AUTHENTICITY_CLAIM,
  COMMUNICATION_AUDIENCE,
  COMMUNICATION_CATEGORY,
  DISCOVERY_MODE,
  MAX_OPTIONS,
  MAX_PROPOSALS,
  MIN_OPTIONS,
  SNAP_DELIVERY_MODE,
} from '@pv/shared';

const isoDate = z.string().datetime({ offset: true });
const proposalSchema = z.object({
  title: z.string().trim().min(1).max(220),
  description: z.string().trim().max(5000).default(''),
  options: z.array(z.string().trim().min(1).max(180)).min(MIN_OPTIONS).max(MAX_OPTIONS),
  recommendation: z.number().int().min(0).max(MAX_OPTIONS - 1).nullable().optional().default(null),
});

export const createEventSchema = z.object({
  tokenAddress: z.string().min(1),
  title: z.string().trim().min(1).max(180),
  description: z.string().trim().max(8000).default(''),
  recordDateAt: isoDate,
  votingStartAt: isoDate,
  votingEndAt: isoDate,
  tokenToVoteRatio: z.coerce.number().int().positive().max(1_000_000_000),
  authenticityClaim: z.enum(Object.values(AUTHENTICITY_CLAIM)),
  discoveryMode: z.enum(Object.values(DISCOVERY_MODE)),
  snapDeliveryMode: z.enum(Object.values(SNAP_DELIVERY_MODE)),
  proposals: z.array(proposalSchema).min(1).max(MAX_PROPOSALS),
}).superRefine((value, context) => {
  const now = Date.now();
  const record = Date.parse(value.recordDateAt);
  const start = Date.parse(value.votingStartAt);
  const end = Date.parse(value.votingEndAt);

  if (record > now) {
    context.addIssue({ code: 'custom', path: ['recordDateAt'], message: 'Record date cannot be in the future.' });
  }
  if (record > start) {
    context.addIssue({ code: 'custom', path: ['recordDateAt'], message: 'Record date must be at or before voting start.' });
  }
  if (start >= end) {
    context.addIssue({ code: 'custom', path: ['votingEndAt'], message: 'Voting end must be after voting start.' });
  }
  if (end <= now + 5 * 60_000) {
    context.addIssue({ code: 'custom', path: ['votingEndAt'], message: 'Voting must remain open for at least five more minutes.' });
  }
  value.proposals.forEach((proposal, index) => {
    if (proposal.recommendation !== null && proposal.recommendation >= proposal.options.length) {
      context.addIssue({
        code: 'custom',
        path: ['proposals', index, 'recommendation'],
        message: 'Recommendation must refer to an existing option.',
      });
    }
  });
});


export const choicesSchema = z.object({
  choices: z.array(z.number().int().min(0).max(MAX_OPTIONS - 1)).min(1).max(MAX_PROPOSALS),
});

export const submitVoteSchema = choicesSchema.extend({
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export const subscriptionSchema = z.object({
  tokenAddress: z.string().min(1),
  categories: z.array(
    z.enum(Object.values(COMMUNICATION_CATEGORY)),
  ).min(1).max(6),
  enabled: z.boolean().default(true),
});

const communicationDraftBaseSchema = z.object({
  messageId: z.string().uuid().optional(),
  category: z.enum(Object.values(COMMUNICATION_CATEGORY)),
  audience: z.enum(Object.values(COMMUNICATION_AUDIENCE)),
  title: z.string().trim().min(1).max(180),
  body: z.string().trim().min(1).max(12_000),
  actionUrl: z.string().url(),
  publishedAt: isoDate,
  expiresAt: isoDate,
});

const validateCommunicationDates = (value, context) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.publishedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Expiry must be after publication.',
    });
  }

  if (Date.parse(value.expiresAt) <= Date.now()) {
    context.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'Expiry must be in the future.',
    });
  }
};

export const communicationDraftSchema =
  communicationDraftBaseSchema.superRefine(validateCommunicationDates);

export const communicationPublishSchema = z.object({
  message: communicationDraftBaseSchema
    .extend({
      messageId: z.string().uuid(),
    })
    .superRefine(validateCommunicationDates),

  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});
