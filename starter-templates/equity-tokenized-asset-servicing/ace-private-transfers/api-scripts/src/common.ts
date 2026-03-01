import { ethers } from "ethers";

const API_BASE_URL = "https://convergence2026-token-api.cldev.cloud";

const EIP712_DOMAIN = {
    name: "CompliantPrivateTokenDemo",
    version: "0.0.1",
    chainId: 11155111,
    verifyingContract: "0xE588a6c73933BFD66Af9b4A07d48bcE59c0D2d13" as `0x${string}`,
};

export function getWallet(): ethers.Wallet {
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error("Error: PRIVATE_KEY environment variable is not set.");
        process.exit(1);
    }
    return new ethers.Wallet(privateKey);
}

export function currentTimestamp(): number {
    return Math.floor(Date.now() / 1000);
}

export async function signTypedData(
    wallet: ethers.Wallet,
    types: Record<string, ethers.TypedDataField[]>,
    message: Record<string, unknown>
): Promise<string> {
    return wallet.signTypedData(EIP712_DOMAIN, types, message);
}

export async function postApi(
    endpoint: string,
    body: Record<string, unknown>
): Promise<unknown> {
    const url = `${API_BASE_URL}${endpoint}`;
    console.log(`\nPOST ${url}`);
    console.log("Request body:", JSON.stringify(body, null, 2));

    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
        console.error(`\nError (${response.status}):`);
        console.error(JSON.stringify(data, null, 2));
        process.exit(1);
    }

    console.log("\nResponse:");
    console.log(JSON.stringify(data, null, 2));
    return data;
}

export function requiredArg(index: number, name: string): string {
    const value = process.argv[2 + index];
    if (!value) {
        console.error(`Error: Missing required argument <${name}>.`);
        printUsageAndExit();
    }
    return value;
}

export function optionalArg(index: number): string | undefined {
    return process.argv[2 + index];
}

let usageMessage = "";

export function setUsage(msg: string): void {
    usageMessage = msg;
}

function printUsageAndExit(): never {
    if (usageMessage) {
        console.error(`\nUsage: ${usageMessage}`);
    }
    process.exit(1);
}
