const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const publicDir = path.join(__dirname, "public");
const reportScript = path.join(__dirname, "oci_capacity_report.py");
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

  const args = [
    reportScript,
    "--format",
    "json",
    "--families",
    family,
    "--ocpus",
    String(ocpus),
    "--memory-gbs",
    String(memoryGbs)
  ];

  if (regions.length > 0) {
    args.push("--regions", regions.join(","));
  }

  if (profile) {
    args.push("--profile", profile);
  }

  return { family, ocpus, memoryGbs, regions, args };
}

function spawnReport(req) {
  const options = reportOptions(req);
  const child = spawn("python3", options.args, {
    cwd: __dirname,
    env: process.env
  });

  return { ...options, child };
}

function runRegions(req, res) {
  const args = [reportScript, "--list-regions"];
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const profile = url.searchParams.get("profile");

  if (profile) {
    args.push("--profile", profile);
  }

  const child = spawn("python3", args, {
    cwd: __dirname,
    env: process.env
  });
  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("error", (error) => {
    sendJson(res, 500, { error: error.message });
  });

  child.on("close", (code) => {
    if (res.writableEnded) {
      return;
    }

    if (code !== 0) {
      sendJson(res, 500, { error: stderr.trim() || stdout.trim() || `Region discovery exited with status ${code}` });
      return;
    }

    try {
      sendJson(res, 200, { regions: JSON.parse(stdout) });
    } catch (error) {
      sendJson(res, 500, { error: `Could not parse region discovery JSON: ${error.message}` });
    }
  });
}

function runReport(req, res) {
  const { family, ocpus, memoryGbs, regions, child } = spawnReport(req);


  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  child.on("error", (error) => {
    sendJson(res, 500, { error: error.message });
  });

  child.on("close", (code) => {
    if (res.writableEnded) {
      return;
    }

    if (code !== 0) {
      sendJson(res, 500, {
        error: stderr.trim() || stdout.trim() || `Report exited with status ${code}`
      });
      return;
    }

    try {
      sendJson(res, 200, {
        query: { family, ocpus, memoryGbs, regions },
        progress: stderr
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        rows: JSON.parse(stdout)
      });
    } catch (error) {
      sendJson(res, 500, {
        error: `Could not parse report JSON: ${error.message}`,
        raw: stdout.slice(0, 2000)
      });
    }
  });
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function runReportEvents(req, res) {
  const { family, ocpus, memoryGbs, regions, child } = spawnReport(req);
  let stdout = "";
  let stderr = "";
  let stderrBuffer = "";

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sendEvent(res, "start", { family, ocpus, memoryGbs, regions });

  req.on("close", () => {
    if (!child.killed) {
      child.kill();
    }
  });

  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/\r?\n/);
    stderrBuffer = lines.pop() || "";

    for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
      sendEvent(res, "progress", { message: line });
    }
  });

  child.on("error", (error) => {
    sendEvent(res, "report-error", { error: error.message });
    res.end();
  });

  child.on("close", (code) => {
    if (res.writableEnded) {
      return;
    }

    if (stderrBuffer.trim()) {
      sendEvent(res, "progress", { message: stderrBuffer.trim() });
    }

    if (code !== 0) {
      sendEvent(res, "report-error", {
        error: stderr.trim() || stdout.trim() || `Report exited with status ${code}`
      });
      res.end();
      return;
    }

    try {
      sendEvent(res, "done", {
        query: { family, ocpus, memoryGbs, regions },
        rows: JSON.parse(stdout)
      });
    } catch (error) {
      sendEvent(res, "report-error", {
        error: `Could not parse report JSON: ${error.message}`,
        raw: stdout.slice(0, 2000)
      });
    }

    res.end();
  });
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
