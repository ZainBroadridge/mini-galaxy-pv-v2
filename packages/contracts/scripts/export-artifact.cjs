const fs = require("node:fs");
const path = require("node:path");

const artifactPath = path.join(
  __dirname,
  "..",
  "artifacts",
  "contracts",
  "VoteEvent.sol",
  "VoteEvent.json"
);
const outputPath = path.join(__dirname, "..", "generated", "VoteEvent.json");

if (!fs.existsSync(artifactPath)) {
  throw new Error(`Hardhat artifact not found: ${artifactPath}`);
}

const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const deployedBytecodeBytes = Math.max(0, (artifact.deployedBytecode.length - 2) / 2);
if (deployedBytecodeBytes > 24_576) {
  throw new Error(`VoteEvent deployed bytecode is ${deployedBytecodeBytes} bytes, above the EVM limit.`);
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  JSON.stringify(
    {
      contractName: artifact.contractName,
      sourceName: artifact.sourceName,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode
    },
    null,
    2
  )
);
console.log(`Exported ${outputPath} (${deployedBytecodeBytes} deployed-bytecode bytes)`);
