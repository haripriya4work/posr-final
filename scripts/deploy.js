const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  // 1. Deploy ValidatorRegistry
  const Registry = await ethers.getContractFactory("ValidatorRegistry");
  const registry  = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("ValidatorRegistry deployed to:", registryAddr);

  // 2. Deploy StockExchange
  const Exchange = await ethers.getContractFactory("StockExchange");
  const exchange  = await Exchange.deploy(registryAddr);
  await exchange.waitForDeployment();
  const exchangeAddr = await exchange.getAddress();
  console.log("StockExchange deployed to:", exchangeAddr);

  // 3. Link exchange to registry
  await registry.setExchange(exchangeAddr);
  console.log("Exchange linked to Registry");

  // 4. Set compliance levels for demo validators
  //    Account #8 → CLEAN_RECORD (Iyer)
  //    Account #9 → KYC_DONE (Frank)
  const signers = await ethers.getSigners();
  if (signers[8]) {
    await registry.setComplianceLevel(signers[8].address, 2); // CLEAN_RECORD
    console.log("Compliance set: Account #8 → CLEAN_RECORD");
  }
  if (signers[9]) {
    await registry.setComplianceLevel(signers[9].address, 1); // KYC_DONE
    console.log("Compliance set: Account #9 → KYC_DONE");
  }

  // 5. Save addresses
  const config = {
    validatorRegistry: registryAddr,
    stockExchange:     exchangeAddr,
    network:           "localhost",
    deployedAt:        new Date().toISOString(),
  };

  const frontendSrc    = path.join(__dirname, "../frontend/src/contractAddresses.json");
  const frontendPublic = path.join(__dirname, "../frontend/public/contractAddresses.json");

  fs.mkdirSync(path.dirname(frontendSrc),    { recursive: true });
  fs.mkdirSync(path.dirname(frontendPublic), { recursive: true });

  fs.writeFileSync(frontendSrc,    JSON.stringify(config, null, 2));
  fs.writeFileSync(frontendPublic, JSON.stringify(config, null, 2));
  console.log("Addresses saved to frontend/src and frontend/public");

  console.log("\n✅ Deployment complete!");
  console.log("   Next: cd frontend && npm run dev");
}

main().catch(e => { console.error(e); process.exit(1); });
