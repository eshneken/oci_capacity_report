const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { collectRows, discoverRegions, normalizeReportOptions, summarizeOciError } = require("./lib/report");
const { createSdkClient } = require("./lib/oci-sdk-client");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "public");
const shapeLimits = {
  E5: { maxOcpus: 94, maxMemoryGbs: 1049 },
  E6: { maxOcpus: 126, maxMemoryGbs: 1454 }
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon"
};

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), contentTypes[".json"]);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function reportOptions(req) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const family = url.searchParams.get("family") === "E6" ? "E6" : "E5";
  const limits = shapeLimits[family];
  const ocpus = clampNumber(url.searchParams.get("ocpus"), 1, limits.maxOcpus, 1);
  const minMemoryForOcpus = Math.max(1, ocpus);
  const maxMemoryForOcpus = Math.min(limits.maxMemoryGbs, Math.max(1, ocpus * 64));
  const memoryGbs = clampNumber(
    url.searchParams.get("memoryGbs"),
    minMemoryForOcpus,
    maxMemoryForOcpus,
    Math.min(Math.max(16, minMemoryForOcpus), maxMemoryForOcpus)
  );
  const profile = url.searchParams.get("profile");
  const requestedRegions = (url.searchParams.get("regions") || "")
    .split(",")
    .map((region) => region.trim())
    .filter(Boolean);
  const regions = [...new Set(requestedRegions)].slice(0, 6);

  return { family, ocpus, memoryGbs, regions, profile };
}

function routeError(error) {
  return `Error: ${summarizeOciError(error)}`;
}

function reportRequest(options) {
  return normalizeReportOptions({
    profile: options.profile,
    families: [options.family],
    ocpus: options.ocpus,
    memoryGbs: options.memoryGbs,
    regions: options.regions
  });
}

async function runRegions(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const profile = url.searchParams.get("profile");

  try {
    const client = createSdkClient({ profile });
    const options = normalizeReportOptions({ profile });
    const tenancyId = await client.getTenancyId();
    const regions = await discoverRegions(client, tenancyId, options);
    sendJson(res, 200, { regions });
  } catch (error) {
    sendJson(res, 500, { error: routeError(error) });
  }
}

async function runReport(req, res) {
  const options = reportOptions(req);
  const progress = [];

  try {
    const client = createSdkClient({ profile: options.profile });
    const rows = await collectRows(client, reportRequest(options), {
      onProgress(message) {
        progress.push(message);
      }
    });

    sendJson(res, 200, {
      query: {
        family: options.family,
        ocpus: options.ocpus,
        memoryGbs: options.memoryGbs,
        regions: options.regions
      },
      progress,
      rows
    });
  } catch (error) {
    sendJson(res, 500, { error: routeError(error) });
  }
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function runReportEvents(req, res) {
  const options = reportOptions(req);
  let isClosed = false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sendEvent(res, "start", {
    family: options.family,
    ocpus: options.ocpus,
    memoryGbs: options.memoryGbs,
    regions: options.regions
  });

  req.on("close", () => {
    isClosed = true;
  });

  try {
    const client = createSdkClient({ profile: options.profile });
    const rows = await collectRows(client, reportRequest(options), {
      onProgress(message) {
        if (!isClosed) {
          sendEvent(res, "progress", { message });
        }
      }
    });

    if (!isClosed) {
      sendEvent(res, "done", {
        query: {
          family: options.family,
          ocpus: options.ocpus,
          memoryGbs: options.memoryGbs,
          regions: options.regions
        },
        rows
      });
      res.end();
    }
  } catch (error) {
    if (!isClosed) {
      sendEvent(res, "report-error", { error: routeError(error) });
      res.end();
    }
  }
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (urlPath === "/health") {
    send(res, 200, JSON.stringify({ status: "ok" }), contentTypes[".json"]);
    return;
  }

  if (urlPath === "/api/report") {
    runReport(req, res);
    return;
  }

  if (urlPath === "/api/report/events") {
    runReportEvents(req, res);
    return;
  }

  if (urlPath === "/api/regions") {
    runRegions(req, res);
    return;
  }

  if (urlPath.startsWith("/api/")) {
    sendJson(res, 404, {
      error: `API route not found: ${urlPath}. Make sure you started this app with npm start from the project root.`
    });
    return;
  }

  const safePath = urlPath === "/" ? "/index.html" : urlPath;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath);
    send(res, 200, data, contentTypes[ext] || "application/octet-stream");
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use on ${host}. Try: PORT=${port + 1} npm start`);
    process.exit(1);
  }

  throw error;
});

server.listen(port, host, () => {
  console.log(`OCI capacity dashboard running at http://${host}:${port}`);
});
