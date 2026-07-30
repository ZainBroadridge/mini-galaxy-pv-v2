const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

require('@nomicfoundation/hardhat-toolbox');

const privateKey = process.env.RELAYER_PRIVATE_KEY;
const rpcUrl = process.env.RPC_HTTP_URL || 'https://rpc-amoy.polygon.technology';

module.exports = {
solidity: {
  version: "0.8.25",
  settings: {
    optimizer: {
      enabled: true,
      runs: 200,
    },
    evmVersion: "cancun",
  },
},
  networks: {
    hardhat: {
      chainId: 31337,
    },
    amoy: {
      url: rpcUrl,
      chainId: 80002,
      accounts: privateKey ? [privateKey] : [],
    },
  },
  etherscan: {
    apiKey: process.env.POLYGONSCAN_API_KEY || '',
  },
  paths: {
    sources: './contracts',
    tests: './test',
    cache: './cache',
    artifacts: './artifacts',
  },
};
