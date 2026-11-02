// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/utils/Create2.sol";
import "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import "./SimpleAccount.sol";

/**
 * @title SimpleAccountFactory
 * @notice Deterministic (CREATE2) factory for SimpleAccount proxies. Used as the
 *         `factory` in a UserOp's initCode so an account deploys on its first op.
 */
contract SimpleAccountFactory {
  SimpleAccount public immutable accountImplementation;

  event AccountCreated(address indexed account, address indexed owner, uint256 salt);

  constructor(IEntryPoint _entryPoint) {
    accountImplementation = new SimpleAccount(_entryPoint);
  }

  /// @notice Returns the account address even if it already exists, so the
  /// EntryPoint's initCode handling and repeat calls are both safe.
  function createAccount(address owner, uint256 salt) public returns (SimpleAccount ret) {
    address addr = getAccountAddress(owner, salt);
    if (addr.code.length > 0) {
      return SimpleAccount(payable(addr));
    }
    ret = SimpleAccount(
      payable(
        new ERC1967Proxy{salt: bytes32(salt)}(
          address(accountImplementation),
          abi.encodeCall(SimpleAccount.initialize, (owner))
        )
      )
    );
    emit AccountCreated(address(ret), owner, salt);
  }

  function getAccountAddress(address owner, uint256 salt) public view returns (address) {
    return
      Create2.computeAddress(
        bytes32(salt),
        keccak256(
          abi.encodePacked(
            type(ERC1967Proxy).creationCode,
            abi.encode(address(accountImplementation), abi.encodeCall(SimpleAccount.initialize, (owner)))
          )
        )
      );
  }
}
