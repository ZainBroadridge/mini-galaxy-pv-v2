import { Contract } from 'ethers';
import { STANDARD_ERC20_ABI, ZERO_ADDRESS } from '@pv/shared';
import { config } from './config.js';
import { query } from './db.js';
import { HttpError, normalizeAddress } from './errors.js';
import { provider } from './provider.js';

async function optionalCall(contract, method, fallback) {
  try {
    return await contract[method]();
  } catch {
    return fallback;
  }
}

export async function inspectStandardToken(tokenAddress) {
  const address = normalizeAddress(tokenAddress, 'tokenAddress');
  const code = await provider.getCode(address);
  if (code === '0x') {
    throw new HttpError(400, 'The token address has no contract code on Polygon Amoy.', 'TOKEN_NOT_CONTRACT');
  }

  const token = new Contract(address, STANDARD_ERC20_ABI, provider);
  let decimals;
  let totalSupply;
  try {
    const standardReads = await Promise.all([
      token.decimals(),
      token.totalSupply(),
      token.balanceOf(ZERO_ADDRESS),
    ]);
    [decimals, totalSupply] = standardReads;
  } catch {
    throw new HttpError(
      400,
      'The contract does not expose the standard ERC-20 decimals, totalSupply, and balanceOf interface.',
      'UNSUPPORTED_TOKEN',
    );
  }

  const decimalCount = Number(decimals);
  if (!Number.isInteger(decimalCount) || decimalCount < 0 || decimalCount > 36) {
    throw new HttpError(400, 'The ERC-20 decimals value must be between 0 and 36.', 'UNSUPPORTED_DECIMALS');
  }

  const rawName = await optionalCall(token, 'name', 'ERC-20 Token');
  const rawSymbol = await optionalCall(token, 'symbol', 'TOKEN');
  let optionalOwner = null;
  try {
    const ownable = new Contract(address, ['function owner() view returns (address)'], provider);
    optionalOwner = normalizeAddress(await ownable.owner());
  } catch {
    // owner() is optional and not part of ERC-20.
  }

  const result = {
    chainId: config.chainId,
    tokenAddress: address,
    name: String(rawName || 'ERC-20 Token').slice(0, 120),
    symbol: String(rawSymbol || 'TOKEN').slice(0, 40),
    decimals: decimalCount,
    totalSupply: totalSupply.toString(),
    optionalOwner,
  };

  const saved = await query(
    `INSERT INTO tokens (
       chain_id, token_address, name, symbol, decimals, total_supply,
       optional_owner, standard_status, validated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,'VALIDATED',now())
     ON CONFLICT (chain_id, token_address) DO UPDATE SET
       name = EXCLUDED.name,
       symbol = EXCLUDED.symbol,
       decimals = EXCLUDED.decimals,
       total_supply = EXCLUDED.total_supply,
       optional_owner = EXCLUDED.optional_owner,
       standard_status = CASE
         WHEN tokens.standard_status = 'UNSUPPORTED' THEN tokens.standard_status
         ELSE 'VALIDATED'
       END,
       validation_message = CASE
         WHEN tokens.standard_status = 'UNSUPPORTED' THEN tokens.validation_message
         ELSE NULL
       END,
       validated_at = now()
     RETURNING standard_status, validation_message`,
    [
      config.chainId,
      result.tokenAddress,
      result.name,
      result.symbol,
      result.decimals,
      result.totalSupply,
      result.optionalOwner,
    ],
  );

  const standardStatus = saved.rows[0].standard_status;
  const validationMessage = saved.rows[0].validation_message;
  if (standardStatus === 'UNSUPPORTED') {
    throw new HttpError(
      400,
      validationMessage || 'This token was previously found incompatible with Transfer-log snapshots.',
      'UNSUPPORTED_TOKEN_HISTORY',
    );
  }
  return { ...result, standardStatus, validationMessage };
}
