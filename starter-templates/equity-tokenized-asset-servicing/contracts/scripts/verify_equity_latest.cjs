const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const CHAINLINK_FORWARDER_ADDRESS = "0x82300bd7c3958625581cc2f77bc6464dcecdf3e5";
const ACE_VAULT_ADDRESS = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";
const DEPLOYMENT_PATH = path.resolve(__dirname, "../deployments", `equity-latest.${hre.network.name}.json`);
const PRIVATE_ROUNDS_SETTLEMENT_TIMEOUT_SECONDS = Number(
  process.env.PRIVATE_ROUNDS_SETTLEMENT_TIMEOUT_SECONDS || "3600",
);

async function verifyContract(address, constructorArguments, contract) {
  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments,
      ...(contract ? { contract } : {}),
    });
    console.log(`Verified: ${address}`);
  } catch (error) {
    const message = error?.message || String(error);
    if (
      message.includes("Already Verified") ||
      message.includes("Reason: Already Verified") ||
      message.includes("already verified")
    ) {
      console.log(`Already verified: ${address}`);
      return;
    }
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(DEPLOYMENT_PATH)) {
    throw new Error(`Deployment summary not found: ${DEPLOYMENT_PATH}`);
  }

  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const contracts = deployment.contracts || {};

  await verifyContract(
    contracts.identityRegistryAddress,
    [],
    "equity-protocol/IdentityRegistry.sol:IdentityRegistry",
  );
  await verifyContract(
    contracts.complianceAddress,
    [contracts.identityRegistryAddress],
    "equity-protocol/ComplianceV2.sol:ComplianceV2",
  );
  await verifyContract(
    contracts.tokenAddress,
    ["EquityToken", "EQT", contracts.identityRegistryAddress, contracts.complianceAddress],
    "equity-protocol/Token.sol:Token",
  );
  await verifyContract(
    contracts.privateEquityAddress,
    [ACE_VAULT_ADDRESS, contracts.tokenAddress],
    "equity-protocol/PrivateEmployeeEquity.sol:PrivateEmployeeEquity",
  );
  await verifyContract(
    contracts.usdcAddress,
    [],
    "equity-protocol/MockUSDC.sol:MockUSDC",
  );
  await verifyContract(
    contracts.privateRoundsMarketAddress,
    [
      contracts.usdcAddress,
      contracts.complianceAddress,
      contracts.identityRegistryAddress,
      contracts.treasuryAddress,
      PRIVATE_ROUNDS_SETTLEMENT_TIMEOUT_SECONDS,
    ],
    "equity-protocol/PrivateRoundsMarket.sol:PrivateRoundsMarket",
  );
  await verifyContract(
    contracts.receiverAddress,
    [
      CHAINLINK_FORWARDER_ADDRESS,
      contracts.identityRegistryAddress,
      contracts.privateEquityAddress,
      contracts.tokenAddress,
      contracts.complianceAddress,
      contracts.privateRoundsMarketAddress,
    ],
    "equity-protocol/EquityWorkflowReceiver.sol:EquityWorkflowReceiver",
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
