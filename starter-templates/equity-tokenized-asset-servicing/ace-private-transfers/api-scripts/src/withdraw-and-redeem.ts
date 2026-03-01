import { ethers } from "ethers";
import {
    currentTimestamp,
    signTypedData,
    postApi,
    requiredArg,
    optionalArg,
    setUsage,
} from "./common.js";

setUsage(
    "npx tsx src/withdraw-and-redeem.ts <token> <amount> [recipient]"
);

const VAULT_ADDRESS = "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13";
const DEFAULT_RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";

const EIP712_TYPES = {
    "Withdraw Tokens": [
        { name: "account", type: "address" },
        { name: "token", type: "address" },
        { name: "amount", type: "uint256" },
        { name: "timestamp", type: "uint256" },
    ],
};

const VAULT_ABI = [
    "function withdrawWithTicket(address token, uint256 amount, bytes ticket) external",
];

const ERC20_ABI = [
    "function transfer(address to, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)",
];

function getEmployeeWallet(): ethers.Wallet {
    const privateKey =
        process.env.EMPLOYEE_PRIVATE_KEY ||
        process.env.PRIVATE_KEY_2 ||
        process.env.PRIVATE_KEY;

    if (!privateKey) {
        console.error(
            "Error: set EMPLOYEE_PRIVATE_KEY (or PRIVATE_KEY_2 / PRIVATE_KEY) for the employee account."
        );
        process.exit(1);
    }
    return new ethers.Wallet(privateKey);
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Unexpected API response format.");
    }
    return value as Record<string, unknown>;
}

function readStringField(obj: Record<string, unknown>, field: string): string {
    const value = obj[field];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing or invalid '${field}' in API response.`);
    }
    return value;
}

async function main() {
    const wallet = getEmployeeWallet();
    const account = wallet.address;

    const token = requiredArg(0, "token");
    const amount = requiredArg(1, "amount");
    const recipientRaw = optionalArg(2);
    const recipient = recipientRaw ? ethers.getAddress(recipientRaw) : null;

    const timestamp = currentTimestamp();
    const message = { account, token, amount, timestamp };
    const auth = await signTypedData(wallet, EIP712_TYPES, message);

    console.log(`Employee account: ${account}`);
    console.log(`Token:            ${token}`);
    console.log(`Amount:           ${amount}`);
    console.log(`Timestamp:        ${timestamp}`);

    const withdrawResponseRaw = await postApi("/withdraw", {
        account,
        token,
        amount,
        timestamp,
        auth,
    });
    const withdrawResponse = asRecord(withdrawResponseRaw);
    const ticket = readStringField(withdrawResponse, "ticket");
    const deadline = readStringField(withdrawResponse, "deadline");

    console.log("\nTicket issued.");
    console.log(`Deadline (unix):  ${deadline}`);

    const rpcUrl = process.env.SEPOLIA_RPC_URL || DEFAULT_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = wallet.connect(provider);

    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
    const tokenContract = new ethers.Contract(token, ERC20_ABI, signer);

    const beforeBalance = await tokenContract.balanceOf(account);
    console.log(`Balance before redeem: ${beforeBalance.toString()}`);

    const redeemTx = await vault.withdrawWithTicket(token, amount, ticket);
    console.log(`Redeem tx sent:        ${redeemTx.hash}`);
    await redeemTx.wait();
    console.log("Redeem confirmed on Sepolia.");

    const afterBalance = await tokenContract.balanceOf(account);
    console.log(`Balance after redeem:  ${afterBalance.toString()}`);

    if (recipient && recipient.toLowerCase() !== account.toLowerCase()) {
        const transferTx = await tokenContract.transfer(recipient, amount);
        console.log(`Transfer tx sent:      ${transferTx.hash}`);
        await transferTx.wait();
        console.log(`Transferred ${amount} to ${recipient}.`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

