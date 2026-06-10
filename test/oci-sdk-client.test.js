const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { expandHome } = require("../lib/oci-sdk-client");

test("expandHome leaves empty and absolute config paths stable", () => {
  assert.equal(expandHome(undefined), undefined);
  assert.equal(expandHome("/tmp/config"), "/tmp/config");
});

test("expandHome resolves user-relative config paths", () => {
  assert.equal(expandHome("~"), os.homedir());
  assert.equal(expandHome("~/.oci/config"), path.join(os.homedir(), ".oci/config"));
});
