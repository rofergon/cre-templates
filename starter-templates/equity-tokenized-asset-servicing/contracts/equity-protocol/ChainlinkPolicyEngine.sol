// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {PolicyEngine} from "./ace-policy/core/PolicyEngine.sol";

/// @notice Hardhat wrapper so the official ACE PolicyEngine can be compiled locally.
contract ChainlinkPolicyEngine is PolicyEngine {}
