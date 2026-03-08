// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {IPolicyEngine} from "./IPolicyEngine.sol";

interface IMapper {
  function typeAndVersion() external pure returns (string memory);

  function map(IPolicyEngine.Parameter[] calldata extractedParameters) external view returns (bytes[] memory);
}
