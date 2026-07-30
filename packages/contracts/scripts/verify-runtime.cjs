const hre = require('hardhat');

function decodeArguments(value) {
  try {
    const json = Buffer.from(String(value), 'base64url').toString('utf8');
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) throw new Error('constructor arguments are not an array');
    return parsed;
  } catch (error) {
    throw new Error(`Could not decode constructor arguments: ${error.message}`);
  }
}

async function main() {
  const [, , address, encodedArguments] = process.argv;
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address ?? ''))) {
    throw new Error('A valid deployed contract address is required.');
  }
  if (!encodedArguments) throw new Error('Encoded constructor arguments are required.');

  await hre.run('verify:verify', {
    address,
    constructorArguments: decodeArguments(encodedArguments),
  });
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exitCode = 1;
});
