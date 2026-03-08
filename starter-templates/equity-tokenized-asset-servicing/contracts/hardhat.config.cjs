require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config({ path: "../.env" });

const DEFAULT_SEPOLIA_RPC_URL =
  "https://virtual.sepolia.eu.rpc.tenderly.co/6c97cebe-ad20-4014-af71-9037a41fbfd9";
const normalizePrivateKey = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return `0x${trimmed}`;
  throw new Error("CRE_ETH_PRIVATE_KEY must be a 32-byte hex private key");
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    compilers: [
      {
        version: "0.8.20",
      },
    ],
    overrides: {
      "equity-protocol/ace-policy/core/PolicyEngine.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
      "equity-protocol/ChainlinkPolicyEngine.sol": {
        version: "0.8.20",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || DEFAULT_SEPOLIA_RPC_URL,
      accounts: process.env.CRE_ETH_PRIVATE_KEY
        ? [normalizePrivateKey(process.env.CRE_ETH_PRIVATE_KEY)]
        : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  paths: {
    sources: "./equity-protocol",
  },
};
