// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

interface IPolicyEngine {
  error TargetNotAttached(address target);
  error TargetAlreadyAttached(address target);
  error PolicyEngineUndefined();
  error PolicyRunRejected(address policy, string rejectReason, Payload payload);
  error PolicyMapperError(address policy, bytes errorReason, Payload payload);
  error PolicyRejected(string rejectReason);
  error PolicyRunError(address policy, bytes errorReason, Payload payload);
  error PolicyRunUnauthorizedError(address account);
  error PolicyPostRunError(address policy, bytes errorReason, Payload payload);
  error UnsupportedSelector(bytes4 selector);
  error PolicyActionError(address policy, bytes errorReason);
  error PolicyConfigurationError(address policy, bytes errorReason);
  error PolicyConfigurationVersionError(address policy, uint256 expectedVersion, uint256 actualVersion);
  error ExtractorError(address extractor, bytes errorReason, Payload payload);

  event TargetAttached(address indexed target);
  event TargetDetached(address indexed target);
  event PolicyConfigured(
    address indexed policy, uint256 indexed configVersion, bytes4 indexed configSelector, bytes configData
  );
  event PolicyRunComplete(
    address indexed sender,
    address indexed target,
    bytes4 indexed selector,
    Parameter[] extractedParameters,
    bytes context
  );
  event PolicyAdded(
    address indexed target, bytes4 indexed selector, address policy, uint256 position, bytes32[] policyParameterNames
  );
  event PolicyAddedAt(
    address indexed target,
    bytes4 indexed selector,
    address policy,
    uint256 position,
    bytes32[] policyParameterNames,
    address[] policies
  );
  event PolicyRemoved(address indexed target, bytes4 indexed selector, address policy);
  event ExtractorSet(bytes4 indexed selector, address indexed extractor);
  event PolicyMapperSet(address indexed policy, address indexed mapper);
  event PolicyParametersSet(address indexed policy, bytes[] parameters);
  event DefaultPolicyAllowSet(bool defaultAllow);
  event TargetDefaultPolicyAllowSet(address indexed target, bool defaultAllow);

  enum PolicyResult {
    None,
    Allowed,
    Continue
  }

  struct Payload {
    bytes4 selector;
    address sender;
    bytes data;
    bytes context;
  }

  struct Parameter {
    bytes32 name;
    bytes value;
  }

  function typeAndVersion() external pure returns (string memory);

  function attach() external;

  function detach() external;

  function setExtractor(bytes4 selector, address extractor) external;

  function setExtractors(bytes4[] calldata selectors, address extractor) external;

  function getExtractor(bytes4 selector) external view returns (address);

  function setPolicyMapper(address policy, address mapper) external;

  function getPolicyMapper(address policy) external view returns (address);

  function addPolicy(address target, bytes4 selector, address policy, bytes32[] calldata policyParameterNames) external;

  function addPolicyAt(
    address target,
    bytes4 selector,
    address policy,
    bytes32[] calldata policyParameterNames,
    uint256 position
  ) external;

  function removePolicy(address target, bytes4 selector, address policy) external;

  function getPolicies(address target, bytes4 selector) external view returns (address[] memory);

  function setPolicyConfiguration(
    address policy,
    uint256 configVersion,
    bytes4 configSelector,
    bytes calldata configData
  ) external;

  function getPolicyConfigVersion(address policy) external view returns (uint256);

  function setDefaultPolicyAllow(bool defaultAllow) external;

  function setTargetDefaultPolicyAllow(address target, bool defaultAllow) external;

  function check(Payload calldata payload) external view;

  function run(Payload calldata payload) external;
}
