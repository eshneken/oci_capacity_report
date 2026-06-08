#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { collectRows, normalizeReportOptions } = require("../lib/report");
const { createSdkClient } = require("../lib/oci-sdk-client");

function parseArgs(argv) {
  const options = {
    families: "E5,E6",
    ocpus: 1,
    memoryGbs: 16
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      options.profile = argv[++index];
    } else if (arg === "--config-file") {
      options.configFile = argv[++index];
    } else if (arg === "--families") {
      options.families = argv[++index];
    } else if (arg === "--regions") {
      options.regions = argv[++index];
    } else if (arg === "--ocpus") {
      options.ocpus = Number(argv[++index]);
    } else if (arg === "--memory-gbs") {
      options.memoryGbs = Number(argv[++index]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return normalizeReportOptions(options);
}

function printHelp() {
  console.log(`Usage: npm run parity:live -- [options]

Compares this branch's OCI SDK report output against the Python script from master.
This command is optional and is not part of npm test.

Options:
  --profile PROFILE
  --config-file PATH
  --families E5,E6
  --regions us-ashburn-1,us-chicago-1
  --ocpus 1
  --memory-gbs 16`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.status}`).trim());
  }

  return result.stdout;
}

function masterPythonScript(tempDir) {
  const source = run("git", ["show", "master:oci_capacity_report.py"]);
  const scriptPath = path.join(tempDir, "oci_capacity_report.py");
  fs.writeFileSync(scriptPath, source, { mode: 0o755 });
  return scriptPath;
}

function pythonArgs(options) {
  const args = [
    "--format",
    "json",
    "--families",
    options.families.join(","),
    "--ocpus",
    String(options.ocpus),
    "--memory-gbs",
    String(options.memoryGbs)
  ];

  if (options.regions) {
    args.push("--regions", options.regions.join(","));
  }
  if (options.profile) {
    args.push("--profile", options.profile);
  }
  if (options.configFile) {
    args.push("--config-file", options.configFile);
  }

  return args;
}

(async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-capacity-parity-"));
  try {
    const options = parseArgs(process.argv.slice(2));
    const scriptPath = masterPythonScript(tempDir);
    const masterRows = JSON.parse(run("python3", [scriptPath, ...pythonArgs(options)]));
    const branchRows = await collectRows(createSdkClient(options), options);

    assert.deepEqual(branchRows, masterRows);
    console.log(`Live parity passed for ${branchRows.length} rows.`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
