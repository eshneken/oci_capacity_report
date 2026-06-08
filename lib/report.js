const DEFAULT_FAMILIES = ["E5", "E6"];
const DEFAULT_FLEX_OCPUS = 1;
const DEFAULT_FLEX_MEMORY_GBS = 16;

function normalizeReportOptions(options = {}) {
  const ocpus = options.ocpus === undefined ? undefined : Number(options.ocpus);
  const memoryGbs = options.memoryGbs === undefined ? undefined : Number(options.memoryGbs);

  if ((ocpus === undefined) !== (memoryGbs === undefined)) {
    throw new Error("ocpus and memoryGbs must be provided together");
  }
  if (ocpus !== undefined && (!Number.isFinite(ocpus) || ocpus <= 0)) {
    throw new Error("ocpus must be positive");
  }
  if (memoryGbs !== undefined && (!Number.isFinite(memoryGbs) || memoryGbs <= 0)) {
    throw new Error("memoryGbs must be positive");
  }

  return {
    profile: options.profile || process.env.OCI_CLI_PROFILE || process.env.OCI_PROFILE || "DEFAULT",
    configFile: options.configFile || process.env.OCI_CLI_CONFIG_FILE,
    families: normalizeList(options.families || DEFAULT_FAMILIES),
    shapes: options.shapes ? normalizeList(options.shapes) : null,
    regions: options.regions ? normalizeList(options.regions) : null,
    ocpus,
    memoryGbs,
    includeNonReady: Boolean(options.includeNonReady)
  };
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getValue(item, ...names) {
  const defaultIndex = names.indexOf("__default__");
  let defaultValue = "";
  if (defaultIndex >= 0) {
    defaultValue = names[defaultIndex + 1];
    names = names.slice(0, defaultIndex);
  }

  for (const name of names) {
    if (item && typeof item === "object" && item[name] !== undefined && item[name] !== null) {
      return item[name];
    }
  }
  return defaultValue;
}

function dataItems(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.items)) {
    return response.items;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }
  return [];
}

function matchesDefaultShapeFamily(shape, families) {
  const parts = String(shape).split(".");
  if (parts.length !== 4) {
    return false;
  }

  const [shapeType, shapeClass, family, size] = parts;
  return (
    (shapeType === "BM" || shapeType === "VM") &&
    shapeClass === "Standard" &&
    families.includes(family) &&
    (size === "Flex" || /^\d+$/.test(size))
  );
}

function shapeRequest(shape, options) {
  const request = { instanceShape: shape };
  if (String(shape).toLowerCase().endsWith(".flex")) {
    request.instanceShapeConfig = {
      ocpus: options.ocpus ?? DEFAULT_FLEX_OCPUS,
      memoryInGBs: options.memoryGbs ?? DEFAULT_FLEX_MEMORY_GBS
    };
  }
  return request;
}

function normalizeRow(region, availabilityDomain, item) {
  const config = getValue(
    item,
    "instance-shape-config",
    "instanceShapeConfig",
    "__default__",
    {}
  ) || {};

  return {
    region,
    availability_domain: availabilityDomain,
    fault_domain: getValue(item, "fault-domain", "faultDomain", "__default__", "all"),
    shape: getValue(item, "instance-shape", "instanceShape"),
    status: getValue(item, "availability-status", "availabilityStatus"),
    available_count: getValue(item, "available-count", "availableCount"),
    ocpus: getValue(config, "ocpus"),
    memory_gbs: getValue(config, "memory-in-gbs", "memoryInGBs"),
    message: ""
  };
}

function noteRow(region, availabilityDomain = "", message = "") {
  return {
    region,
    availability_domain: availabilityDomain,
    fault_domain: "",
    shape: "",
    status: "INFO",
    available_count: "",
    ocpus: "",
    memory_gbs: "",
    message
  };
}

function errorRow(region, availabilityDomain = "", shape = "", error = "") {
  return {
    region,
    availability_domain: availabilityDomain,
    fault_domain: "",
    shape,
    status: "ERROR",
    available_count: "",
    ocpus: "",
    memory_gbs: "",
    message: summarizeOciError(error)
  };
}

function summarizeOciError(error) {
  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error.replace(/\s+/g, " ").trim();
  }

  const bits = [];
  if (error.statusCode || error.status) {
    bits.push(String(error.statusCode || error.status));
  }
  if (error.serviceCode || error.code) {
    bits.push(error.serviceCode || error.code);
  }
  if (error.message) {
    bits.push(error.message);
  }
  if (bits.length) {
    return bits.join(" - ").replace(/\s+/g, " ").trim();
  }

  return String(error).replace(/\s+/g, " ").trim();
}

async function discoverRegions(client, tenancyId, options) {
  const response = await client.listRegionSubscriptions({ tenancyId });
  const regions = [];

  for (const subscription of dataItems(response)) {
    const status = getValue(subscription, "status");
    const regionName = getValue(subscription, "region-name", "regionName");
    if (regionName && (options.includeNonReady || status === "READY")) {
      regions.push(regionName);
    }
  }

  return [...new Set(regions)].sort();
}

async function listAvailabilityDomains(client, tenancyId, region) {
  const response = await client.listAvailabilityDomains({ compartmentId: tenancyId, region });
  return dataItems(response)
    .map((availabilityDomain) => getValue(availabilityDomain, "name"))
    .filter(Boolean)
    .sort();
}

async function listMatchingShapes(client, tenancyId, region, availabilityDomain, options) {
  if (options.shapes) {
    return options.shapes;
  }

  const response = await client.listShapes({
    compartmentId: tenancyId,
    availabilityDomain,
    region
  });

  const shapes = [];
  for (const shape of dataItems(response)) {
    const name = getValue(shape, "shape", "name");
    if (name && matchesDefaultShapeFamily(name, options.families)) {
      shapes.push(name);
    }
  }

  return [...new Set(shapes)].sort();
}

async function capacityReport(client, tenancyId, region, availabilityDomain, shapes, options) {
  const response = await client.createComputeCapacityReport({
    region,
    createComputeCapacityReportDetails: {
      availabilityDomain,
      compartmentId: tenancyId,
      shapeAvailabilities: shapes.map((shape) => shapeRequest(shape, options))
    }
  });

  return (
    response?.computeCapacityReport?.shapeAvailabilities ||
    response?.data?.["shape-availabilities"] ||
    response?.data?.shapeAvailabilities ||
    []
  );
}

async function collectRows(client, rawOptions = {}, hooks = {}) {
  const options = normalizeReportOptions(rawOptions);
  const tenancyId = await client.getTenancyId();
  const rows = [];
  const subscribedRegions = await discoverRegions(client, tenancyId, options);

  let regions;
  if (options.regions) {
    const requestedRegions = new Set(options.regions);
    regions = subscribedRegions.filter((region) => requestedRegions.has(region));
    const missingRegions = [...requestedRegions]
      .filter((region) => !subscribedRegions.includes(region))
      .sort();
    for (const region of missingRegions) {
      rows.push(errorRow(region, "", "", "Tenancy is not subscribed to this region"));
    }
  } else {
    regions = subscribedRegions;
  }

  for (const region of regions) {
    hooks.onProgress?.(`Checking ${region}...`);
    let availabilityDomains;
    try {
      availabilityDomains = await listAvailabilityDomains(client, tenancyId, region);
    } catch (error) {
      rows.push(errorRow(region, "", "", error));
      continue;
    }

    if (!availabilityDomains.length) {
      rows.push(noteRow(region, "", "No availability domains found"));
      continue;
    }

    for (const availabilityDomain of availabilityDomains) {
      let shapes;
      try {
        shapes = await listMatchingShapes(client, tenancyId, region, availabilityDomain, options);
      } catch (error) {
        rows.push(errorRow(region, availabilityDomain, "", error));
        continue;
      }

      if (!shapes.length) {
        rows.push(
          noteRow(
            region,
            availabilityDomain,
            `No ${options.families.join("/")} shapes found in this availability domain`
          )
        );
        continue;
      }

      for (const shape of shapes) {
        try {
          const reportItems = await capacityReport(client, tenancyId, region, availabilityDomain, [shape], options);
          rows.push(...reportItems.map((item) => normalizeRow(region, availabilityDomain, item)));
        } catch (error) {
          rows.push(errorRow(region, availabilityDomain, shape, error));
        }
      }
    }
  }

  return rows;
}

module.exports = {
  DEFAULT_FAMILIES,
  DEFAULT_FLEX_OCPUS,
  DEFAULT_FLEX_MEMORY_GBS,
  capacityReport,
  collectRows,
  discoverRegions,
  errorRow,
  listAvailabilityDomains,
  listMatchingShapes,
  matchesDefaultShapeFamily,
  normalizeReportOptions,
  normalizeRow,
  noteRow,
  shapeRequest,
  summarizeOciError
};
