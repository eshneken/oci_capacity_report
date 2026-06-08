const os = require("node:os");
const path = require("node:path");
const common = require("oci-common");
const core = require("oci-core");
const identity = require("oci-identity");

function expandHome(filePath) {
  if (!filePath) {
    return undefined;
  }
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function createProvider(options = {}) {
  return new common.ConfigFileAuthenticationDetailsProvider(
    expandHome(options.configFile || process.env.OCI_CLI_CONFIG_FILE),
    options.profile || process.env.OCI_CLI_PROFILE || process.env.OCI_PROFILE || "DEFAULT"
  );
}

function createSdkClient(options = {}) {
  if (process.env.OCI_CAPACITY_CLIENT_FACTORY) {
    const factory = require(path.resolve(process.env.OCI_CAPACITY_CLIENT_FACTORY));
    return factory.createClient(options);
  }

  const provider = createProvider(options);
  const identityClient = new identity.IdentityClient({ authenticationDetailsProvider: provider });
  const computeClient = new core.ComputeClient({ authenticationDetailsProvider: provider });

  async function getAllPages(fn, request) {
    const items = [];
    let page;
    do {
      const response = await fn({ ...request, page });
      items.push(...(response.items || []));
      page = response.opcNextPage;
    } while (page);
    return { items };
  }

  return {
    async getTenancyId() {
      return provider.getTenantId();
    },

    async listRegionSubscriptions(request) {
      return identityClient.listRegionSubscriptions(request);
    },

    async listAvailabilityDomains(request) {
      identityClient.regionId = request.region;
      return getAllPages((pageRequest) => identityClient.listAvailabilityDomains(pageRequest), {
        compartmentId: request.compartmentId
      });
    },

    async listShapes(request) {
      computeClient.regionId = request.region;
      return getAllPages((pageRequest) => computeClient.listShapes(pageRequest), {
        compartmentId: request.compartmentId,
        availabilityDomain: request.availabilityDomain
      });
    },

    async createComputeCapacityReport(request) {
      computeClient.regionId = request.region;
      return computeClient.createComputeCapacityReport({
        createComputeCapacityReportDetails: request.createComputeCapacityReportDetails
      });
    }
  };
}

module.exports = {
  createProvider,
  createSdkClient,
  expandHome
};
