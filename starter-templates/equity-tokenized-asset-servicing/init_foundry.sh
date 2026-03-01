#!/bin/bash
export PATH="$PATH:~/.foundry/bin"
mkdir -p ace-private-transfers
cd ace-private-transfers
forge init --no-git --force .
forge install foundry-rs/forge-std --no-git
forge install OpenZeppelin/openzeppelin-contracts@v4.9.3 --no-git
forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v4.9.3 --no-git
forge install smartcontractkit/chainlink-ace --no-git
