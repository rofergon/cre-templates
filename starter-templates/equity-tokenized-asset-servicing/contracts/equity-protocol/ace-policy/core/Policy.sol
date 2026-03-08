// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.20;

import {IPolicy} from "../interfaces/IPolicy.sol";
import {IPolicyEngine} from "../interfaces/IPolicyEngine.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC165Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/introspection/ERC165Upgradeable.sol";

abstract contract Policy is Initializable, OwnableUpgradeable, ERC165Upgradeable, IPolicy {
  error Unauthorized();
  error InvalidParameters(string reason);

  struct PolicyStorage {
    address policyEngine;
  }

  bytes32 private constant PolicyStorageLocation = 0x88b18ed68be9f5af7a0aa0e9a55256b17a6bcc168c9c257d2c5556789ebee900;

  function _getPolicyStorage() private pure returns (PolicyStorage storage $) {
    assembly {
      $.slot := PolicyStorageLocation
    }
  }

  constructor() {
    _disableInitializers();
  }

  modifier onlyPolicyEngine() {
    if (msg.sender != _getPolicyStorage().policyEngine) {
      revert Unauthorized();
    }
    _;
  }

  function initialize(
    address policyEngine,
    address initialOwner,
    bytes calldata configParams
  ) public virtual initializer {
    __Policy_init(policyEngine, initialOwner);
    configure(configParams);
  }

  function configure(bytes calldata parameters) internal virtual onlyInitializing {}

  function __Policy_init(address policyEngine, address initialOwner) internal onlyInitializing {
    __Policy_init_unchained(policyEngine);
    __Ownable_init();
    transferOwnership(initialOwner);
    __ERC165_init();
  }

  function __Policy_init_unchained(address policyEngine) internal onlyInitializing {
    _getPolicyStorage().policyEngine = policyEngine;
  }

  function onInstall(bytes4) public virtual override onlyPolicyEngine {}

  function onUninstall(bytes4) public virtual override onlyPolicyEngine {}

  function run(
    address caller,
    address subject,
    bytes4 selector,
    bytes[] calldata parameters,
    bytes calldata context
  ) public view virtual override returns (IPolicyEngine.PolicyResult);

  function postRun(
    address,
    address,
    bytes4,
    bytes[] calldata,
    bytes calldata
  ) public virtual override onlyPolicyEngine {}

  function supportsInterface(bytes4 interfaceId)
    public
    view
    virtual
    override(ERC165Upgradeable, IERC165)
    returns (bool)
  {
    return interfaceId == type(IPolicy).interfaceId || super.supportsInterface(interfaceId);
  }
}
