const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ValidatorRegistry + StockExchange", function () {
  it("deploys, links exchange, allows registration and selection", async function () {
    const [owner, validator] = await ethers.getSigners();

    const Registry = await ethers.getContractFactory("ValidatorRegistry");
    const registry = await Registry.deploy();
    await registry.deployed();

    const Exchange = await ethers.getContractFactory("StockExchange");
    const exchange = await Exchange.deploy(registry.address);
    await exchange.deployed();

    // link exchange to registry (owner)
    await registry.setExchange(exchange.address);

    // validator registers with >= 1 ETH
    await expect(
      registry.connect(validator).registerValidator({ value: ethers.parseEther("1") })
    ).to.be.not.reverted;

    const all = await registry.getAllValidators();
    expect(all.length).to.equal(1);
    expect(all[0]).to.equal(validator.address);

    // select validator (should return a non-zero address)
    const sel = await registry.selectValidator();
    expect(sel).to.be.a("string");
    expect(sel).to.not.equal(ethers.ZeroAddress);
    const current = await registry.currentValidator();
    expect(current).to.equal(sel);
  });
});
