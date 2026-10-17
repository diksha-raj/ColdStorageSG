import { expect } from "chai";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import config from "../hardhat.config.ts";

// Every contract pins the exact compiler version Hardhat builds with: no floating pragma (^, >=),
// so the bytecode we test and deploy can only come from that one compiler.
describe("Solidity pragma", function () {
  const compiler = (config.solidity as { version: string }).version;
  const dir = join(import.meta.dirname, "..", "contracts");

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sol"))) {
    it(`${file} pins solidity ${compiler}`, function () {
      const pragma = readFileSync(join(dir, file), "utf8").match(/pragma solidity ([^;]+);/)?.[1];
      expect(pragma).to.equal(compiler);
    });
  }
});
