// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import "@account-abstraction/contracts/core/BaseAccount.sol";
import "@account-abstraction/contracts/core/Helpers.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";

/**
 * @title SimpleAccount
 * @notice ERC-4337 smart account for OpenPrivy embedded wallets, targeting EntryPoint v0.7.
 * @dev Nonces are owned by the EntryPoint (NonceManager): BaseAccount.validateUserOp
 *      only checks the signature, and the EntryPoint validates and increments the
 *      nonce itself. Read the next nonce with entryPoint.getNonce(account, 0).
 *      The EntryPoint address is immutable so it lives in the implementation's
 *      bytecode and is visible through every ERC1967 proxy.
 */
contract SimpleAccount is BaseAccount, UUPSUpgradeable, Initializable {
  address public owner;

  IEntryPoint private immutable _entryPoint;

  event SimpleAccountInitialized(IEntryPoint indexed entryPoint, address indexed owner);
  event OwnerUpdated(address indexed previousOwner, address indexed newOwner);

  modifier onlyOwner() {
    _onlyOwner();
    _;
  }

  constructor(IEntryPoint anEntryPoint) {
    _entryPoint = anEntryPoint;
    _disableInitializers();
  }

  function initialize(address anOwner) public virtual initializer {
    require(anOwner != address(0), "invalid owner");
    owner = anOwner;
    emit SimpleAccountInitialized(_entryPoint, anOwner);
  }

  /// @inheritdoc BaseAccount
  function entryPoint() public view virtual override returns (IEntryPoint) {
    return _entryPoint;
  }

  receive() external payable {}

  function execute(address dest, uint256 value, bytes calldata func) external {
    _requireFromEntryPointOrOwner();
    _call(dest, value, func);
  }

  function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func) external {
    _requireFromEntryPointOrOwner();
    require(dest.length == func.length && (value.length == 0 || value.length == func.length), "wrong array lengths");
    for (uint256 i = 0; i < dest.length; i++) {
      _call(dest[i], value.length == 0 ? 0 : value[i], func[i]);
    }
  }

  /// @notice Rotate the signing key (e.g. after social recovery). Callable by the
  /// owner directly or by the account itself via a UserOp.
  function updateOwner(address newOwner) external onlyOwner {
    require(newOwner != address(0), "invalid owner");
    emit OwnerUpdated(owner, newOwner);
    owner = newOwner;
  }

  function getDeposit() public view returns (uint256) {
    return entryPoint().balanceOf(address(this));
  }

  function addDeposit() public payable {
    entryPoint().depositTo{value: msg.value}(address(this));
  }

  function withdrawDepositTo(address payable withdrawAddress, uint256 amount) public onlyOwner {
    entryPoint().withdrawTo(withdrawAddress, amount);
  }

  function getImplementation() external view returns (address) {
    return ERC1967Utils.getImplementation();
  }

  /// @dev Signature is EIP-191 personal_sign over the userOpHash, matching the
  /// backend's UserOpService.signUserOp (ethers Wallet.signMessage).
  function _validateSignature(PackedUserOperation calldata userOp, bytes32 userOpHash)
    internal
    virtual
    override
    returns (uint256 validationData)
  {
    bytes32 hash = MessageHashUtils.toEthSignedMessageHash(userOpHash);
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, userOp.signature);
    if (err != ECDSA.RecoverError.NoError || recovered != owner) {
      return SIG_VALIDATION_FAILED;
    }
    return SIG_VALIDATION_SUCCESS;
  }

  function _onlyOwner() internal view {
    require(msg.sender == owner || msg.sender == address(this), "only owner");
  }

  function _requireFromEntryPointOrOwner() internal view {
    require(msg.sender == address(entryPoint()) || msg.sender == owner, "account: not Owner or EntryPoint");
  }

  function _call(address target, uint256 value, bytes memory data) internal {
    (bool success, bytes memory result) = target.call{value: value}(data);
    if (!success) {
      assembly {
        revert(add(result, 32), mload(result))
      }
    }
  }

  function _authorizeUpgrade(address) internal view override onlyOwner {}
}
