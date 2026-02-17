require("@nomicfoundation/hardhat-ethers");
require("hardhat-gas-reporter");
require("solidity-coverage");
require("dotenv").config({ path: "../.env" });

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.20",
  networks: {
    baseSepolia: {
      url: "https://base-sepolia.gateway.tenderly.co/3qeYD3iE02OOzPOCANms01",
      accounts: process.env.CRE_ETH_PRIVATE_KEY ? [process.env.CRE_ETH_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./equity-protocol",
  },
};
