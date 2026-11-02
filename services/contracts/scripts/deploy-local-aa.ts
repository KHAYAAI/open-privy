import { ethers } from 'hardhat';
import fs from 'fs';

/**
 * Deploys the canonical EntryPoint v0.7 plus OpenPrivy's factory and paymaster
 * to a local Hardhat node, for the backend's end-to-end AA integration test.
 * Prints shell exports. Uses Hardhat's well-known dev accounts; local only.
 *
 *   npx hardhat node &
 *   npx hardhat run scripts/deploy-local-aa.ts --network localhost
 */
async function main() {
  const [deployer, paymasterSigner] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 31337n) throw new Error('deploy-local-aa is for the local Hardhat chain only');

  const entryPoint = await ethers.deployContract('EntryPoint');
  const factory = await ethers.deployContract('SimpleAccountFactory', [await entryPoint.getAddress()]);
  const paymaster = await ethers.deployContract('OpenPrivyPaymaster', [
    await entryPoint.getAddress(),
    paymasterSigner.address,
  ]);
  await (await paymaster.deposit({ value: ethers.parseEther('10') })).wait();

  const out = {
    ENTRYPOINT_ADDRESS: await entryPoint.getAddress(),
    AA_FACTORY_ADDRESS: await factory.getAddress(),
    AA_PAYMASTER_ADDRESS: await paymaster.getAddress(),
    CHAIN_ID: net.chainId.toString(),
  };
  const lines = Object.entries(out).map(([k, v]) => `export ${k}=${v}`);
  if (process.env.AA_ENV_OUT) fs.writeFileSync(process.env.AA_ENV_OUT, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  console.log(`# deployer ${deployer.address}, paymaster signer ${paymasterSigner.address}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
