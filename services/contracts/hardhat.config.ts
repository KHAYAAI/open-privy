import { HardhatUserConfig, subtask } from 'hardhat/config';
import { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } from 'hardhat/builtin-tasks/task-names';
import '@nomicfoundation/hardhat-toolbox';
import 'dotenv/config';
import path from 'path';

const SOLC_VERSION = '0.8.24';

// Use the solc npm package (pinned in devDependencies) instead of downloading
// a compiler binary at build time, so compiles work in locked-down CI/sandboxes.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args: { solcVersion: string }, _hre, runSuper) => {
  if (args.solcVersion !== SOLC_VERSION) return runSuper();
  const compilerPath = require.resolve('solc/soljson.js', { paths: [path.join(__dirname, 'node_modules')] });
  return { compilerPath, isSolcJs: true, version: SOLC_VERSION, longVersion: SOLC_VERSION };
});

const config: HardhatUserConfig = {
  solidity: {
    version: SOLC_VERSION,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: process.env.ETHEREUM_RPC_SEPOLIA || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    ethereum: {
      url: process.env.ETHEREUM_RPC_MAINNET || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 1,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 137,
    },
    polygonMumbai: {
      url: process.env.POLYGON_RPC_MUMBAI || '',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 80001,
    },
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      sepolia: process.env.ETHERSCAN_API_KEY || '',
      polygon: process.env.POLYGONSCAN_API_KEY || '',
      polygonMumbai: process.env.POLYGONSCAN_API_KEY || '',
    },
  },
  paths: {
    sources: './src',
    tests: './test',
    artifacts: './artifacts',
  },
};

export default config;
