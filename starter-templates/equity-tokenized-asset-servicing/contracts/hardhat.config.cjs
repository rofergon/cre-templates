require("@nomicfoundation/hardhat-ethers");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config({ path: "../.env" });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",
  networks: {
    sepolia: {
      url: "https://sepolia.gateway.tenderly.co/3Gg3yWf8Ftc5qKVcpRZYuI",
      accounts: process.env.CRE_ETH_PRIVATE_KEY ? [process.env.CRE_ETH_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./equity-protocol",
  },
};
