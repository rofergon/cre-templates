// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {IPolicyEngine} from "./IPolicyEngine.sol";

interface IExtractor {
  function typeAndVersion() external pure returns (string memory);

  function extract(IPolicyEngine.Payload calldata payload) external view returns (IPolicyEngine.Parameter[] memory);
}
