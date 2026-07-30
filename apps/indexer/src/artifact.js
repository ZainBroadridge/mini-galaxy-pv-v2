import { readFile } from 'node:fs/promises';

const artifactUrl = new URL('../../../packages/contracts/generated/VoteEvent.json', import.meta.url);
let cached;

export async function loadVoteEventArtifact() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(artifactUrl, 'utf8'));
  } catch (error) {
    throw new Error(`VoteEvent artifact is missing. Run npm run compile. ${error.message}`);
  }
  if (!Array.isArray(cached.abi) || !cached.bytecode || cached.bytecode === '0x') {
    throw new Error('Generated VoteEvent artifact is invalid.');
  }
  return cached;
}
