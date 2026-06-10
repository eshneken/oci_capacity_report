const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const mockClientFactory = path.join(__dirname, "fixtures", "mock-sdk-factory");

async function withServer(t, options = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-capacity-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      OCI_CAPACITY_CLIENT_FACTORY: mockClientFactory,
      MOCK_OCI_MODE: options.mode || "default"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  t.after(() => {
    if (!child.killed) {
      child.kill();
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitFor(() => stdout.includes(`http://127.0.0.1:${port}`), () => stderr || stdout);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async json(pathname) {
      const response = await fetch(`${this.baseUrl}${pathname}`);
      const body = await response.json();
      return { response, body };
    }
  };
}

async function freePort() {
  const net = require("node:net");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(predicate, details) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for server. ${details()}`);
}

function parseSse(text) {
  return text
    .trim()
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

test("health route returns ok", async (t) => {
  const server = await withServer(t);
  const { response, body } = await server.json("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { status: "ok" });
});

test("regions route returns sorted ready subscriptions", async (t) => {
  const server = await withServer(t);
  const { response, body } = await server.json("/api/regions");

  assert.equal(response.status, 200);
  assert.deepEqual(body, { regions: ["us-ashburn-1", "us-chicago-1"] });
});

test("report route preserves query clamping and normalized rows", async (t) => {
  const server = await withServer(t);
  const { response, body } = await server.json(
    "/api/report?family=E5&ocpus=200&memoryGbs=9999&regions=us-ashburn-1,missing-region,us-chicago-1,us-ashburn-1"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(body.query, {
    family: "E5",
    ocpus: 94,
    memoryGbs: 1049,
    regions: ["us-ashburn-1", "missing-region", "us-chicago-1"]
  });
  assert.deepEqual(body.progress, ["Checking us-ashburn-1...", "Checking us-chicago-1..."]);
  assert.deepEqual(body.rows, [
    {
      region: "missing-region",
      availability_domain: "",
      fault_domain: "",
      shape: "",
      status: "ERROR",
      available_count: "",
      ocpus: "",
      memory_gbs: "",
      message: "Tenancy is not subscribed to this region"
    },
    {
      region: "us-ashburn-1",
      availability_domain: "ASH-AD-1",
      fault_domain: "FAULT-DOMAIN-2",
      shape: "BM.Standard.E5.64",
      status: "OUT_OF_HOST_CAPACITY",
      available_count: 0,
      ocpus: "",
      memory_gbs: "",
      message: ""
    },
    {
      region: "us-ashburn-1",
      availability_domain: "ASH-AD-1",
      fault_domain: "FAULT-DOMAIN-1",
      shape: "VM.Standard.E5.Flex",
      status: "AVAILABLE",
      available_count: 8,
      ocpus: 94,
      memory_gbs: 1049,
      message: ""
    },
    {
      region: "us-ashburn-1",
      availability_domain: "ASH-AD-2",
      fault_domain: "",
      shape: "",
      status: "INFO",
      available_count: "",
      ocpus: "",
      memory_gbs: "",
      message: "No E5 shapes found in this availability domain"
    },
    {
      region: "us-chicago-1",
      availability_domain: "",
      fault_domain: "",
      shape: "",
      status: "ERROR",
      available_count: "",
      ocpus: "",
      memory_gbs: "",
      message: "500 - MockError - Availability domains unavailable"
    }
  ]);
});

test("report route surfaces capacity errors as rows", async (t) => {
  const server = await withServer(t, { mode: "capacity-error" });
  const { response, body } = await server.json(
    "/api/report?family=E6&ocpus=4&memoryGbs=16&regions=us-ashburn-1"
  );

  assert.equal(response.status, 200);
  assert.deepEqual(body.rows.filter((row) => row.status === "ERROR").map((row) => row.message), [
    "500 - MockError - Capacity failed for VM.Standard.E6.Flex"
  ]);
});

test("region discovery failures return API errors", async (t) => {
  const server = await withServer(t, { mode: "subscription-error" });
  const { response, body } = await server.json("/api/regions");

  assert.equal(response.status, 500);
  assert.deepEqual(body, { error: "Error: 500 - MockError - Could not list subscriptions" });
});

test("malformed SDK responses return API errors", async (t) => {
  const server = await withServer(t, { mode: "bad-json" });
  const { response, body } = await server.json("/api/regions");

  assert.equal(response.status, 500);
  assert.equal(body.error, "Error: OCI SDK returned malformed region subscription response");
});

test("report events stream start, progress, and done events", async (t) => {
  const server = await withServer(t);
  const response = await fetch(
    `${server.baseUrl}/api/report/events?family=E5&ocpus=2&memoryGbs=8&regions=us-ashburn-1`
  );
  const text = await response.text();
  const events = parseSse(text);

  assert.equal(response.status, 200);
  assert.deepEqual(events.map((event) => event.event), ["start", "progress", "done"]);
  assert.deepEqual(events[0].data, {
    family: "E5",
    ocpus: 2,
    memoryGbs: 8,
    regions: ["us-ashburn-1"]
  });
  assert.deepEqual(events[1].data, { message: "Checking us-ashburn-1..." });
  assert.equal(events[2].data.query.family, "E5");
  assert.equal(events[2].data.rows.length, 3);
});
