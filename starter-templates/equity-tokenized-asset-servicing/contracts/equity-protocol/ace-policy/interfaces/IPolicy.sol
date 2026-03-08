// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {IPolicyEngine} from "./IPolicyEngine.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface IPolicy is IERC165 {
  function typeAndVersion() external pure returns (string memory);

  function onInstall(bytes4 selector) external;

  function onUninstall(bytes4 selector) external;

  function run(
    address caller,
    address subject,
    bytes4 selector,
    bytes[] calldata parameters,
    bytes calldata context
  ) external view returns (IPolicyEngine.PolicyResult);

  function postRun(
    address caller,
    address subject,
    bytes4 selector,
    bytes[] calldata parameters,
    bytes calldata context
  ) external;
}
