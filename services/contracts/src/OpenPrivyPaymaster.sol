// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@account-abstraction/contracts/core/BasePaymaster.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";
import "@account-abstraction/contracts/core/Helpers.sol";

/**
 * @title OpenPrivyPaymaster
 * @notice EntryPoint v0.7 verifying paymaster: sponsors gas for allow-listed
 *         accounts when the OpenPrivy backend has signed the specific UserOp.
 * @dev paymasterAndData layout (v0.7):
 *      [0:20]   paymaster address
 *      [20:36]  paymasterVerificationGasLimit (uint128)
 *      [36:52]  paymasterPostOpGasLimit (uint128)
 *      [52:116] abi.encode(uint48 validUntil, uint48 validAfter)
 *      [116:]   backend signature over getHash(userOp, validUntil, validAfter)
 */
contract OpenPrivyPaymaster is BasePaymaster {
  using UserOperationLib for PackedUserOperation;

  uint256 private constant VALID_TIMESTAMP_OFFSET = PAYMASTER_DATA_OFFSET;
  uint256 private constant SIGNATURE_OFFSET = VALID_TIMESTAMP_OFFSET + 64;

  address public paymasterSigner;
  mapping(address => bool) public sponsoredAccounts;
  mapping(address => uint256) public gasSponsored;

  event GasSponsored(address indexed account, uint256 actualGasCost);
  event PaymasterSignerUpdated(address indexed newSigner);
  event AccountSponsorship(address indexed account, bool enabled);

  constructor(IEntryPoint _entryPoint, address _signer) BasePaymaster(_entryPoint) {
    require(_signer != address(0), "invalid signer");
    paymasterSigner = _signer;
  }

  function setPaymasterSigner(address _signer) external onlyOwner {
    require(_signer != address(0), "invalid signer");
    paymasterSigner = _signer;
    emit PaymasterSignerUpdated(_signer);
  }

  function setSponsorshipStatus(address account, bool enabled) external onlyOwner {
    sponsoredAccounts[account] = enabled;
    emit AccountSponsorship(account, enabled);
  }

  /// @notice Hash the backend signs. Excludes paymasterAndData's own signature
  /// but binds the paymaster gas limits, chain and this contract.
  function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
    public
    view
    returns (bytes32)
  {
    return
      keccak256(
        abi.encode(
          userOp.getSender(),
          userOp.nonce,
          keccak256(userOp.initCode),
          keccak256(userOp.callData),
          userOp.accountGasLimits,
          uint256(bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET])),
          userOp.preVerificationGas,
          userOp.gasFees,
          block.chainid,
          address(this),
          validUntil,
          validAfter
        )
      );
  }

  function parsePaymasterAndData(bytes calldata paymasterAndData)
    public
    pure
    returns (uint48 validUntil, uint48 validAfter, bytes calldata signature)
  {
    (validUntil, validAfter) = abi.decode(paymasterAndData[VALID_TIMESTAMP_OFFSET:SIGNATURE_OFFSET], (uint48, uint48));
    signature = paymasterAndData[SIGNATURE_OFFSET:];
  }

  function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
    internal
    view
    override
    returns (bytes memory context, uint256 validationData)
  {
    (uint48 validUntil, uint48 validAfter, bytes calldata signature) = parsePaymasterAndData(userOp.paymasterAndData);
    if (!sponsoredAccounts[userOp.sender]) {
      return ("", _packValidationData(true, validUntil, validAfter));
    }
    bytes32 hash = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
    (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
    if (err != ECDSA.RecoverError.NoError || recovered != paymasterSigner) {
      return ("", _packValidationData(true, validUntil, validAfter));
    }
    return (abi.encode(userOp.sender), _packValidationData(false, validUntil, validAfter));
  }

  function _postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) internal override {
    address account = abi.decode(context, (address));
    gasSponsored[account] += actualGasCost;
    emit GasSponsored(account, actualGasCost);
  }
}
