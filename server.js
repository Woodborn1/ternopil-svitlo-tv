const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DEFAULT_QUEUE = process.env.DEFAULT_QUEUE || "GPV5.1";
const DATA_URL =
  "https://raw.githubusercontent.com/yaroslav2901/OE_OUTAGE_DATA/main/data/Ternopiloblenerho.json";
const POLL_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

let cachedRaw = null;
let previousDaysByQueue = {};
let lastChangeByQueue = {}; // { "GPV5.1": { changedAt: ISO, changedHours: { "1795644000": ["15","16"] } } }
let lastFetchError = null;
let lastFetchedAt = null;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            "User-Agent": "ternopil-svitlo-tv/1.0",
            "Cache-Control": "no-cache",
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error("HTTP " + res.statusCode));
          }
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(body));
            } catch (e) {
              reject(e);
            }
          });
        }
      )
      .on("error", reject);
  });
}

function detectChanges(newJson) {
  const factData = (newJson && newJson.fact && newJson.fact.data) || {};
  const dayKeys = Object.keys(factData);
  const allQueues = new Set();

  for (const dayKey of dayKeys) {
    const dayObj = factData[dayKey] || {};
    for (const q of Object.keys(dayObj)) {
      allQueues.add(q);
    }
  }

  for (const q of allQueues) {
    const prev = previousDaysByQueue[q];
    const curr = {};
    for (const dayKey of dayKeys) {
      if (factData[dayKey] && factData[dayKey][q]) {
        curr[dayKey] = factData[dayKey][q];
      }
    }

    if (prev) {
      const changedHours = {};
      let hasDiff = false;
      for (const dayKey of Object.keys(curr)) {
        const prevDay = prev[dayKey];
        const currDay = curr[dayKey];
        if (!prevDay) {
          // New day (e.g. tomorrow) appeared
          hasDiff = true;
          changedHours[dayKey] = Object.keys(currDay);
          continue;
        }
        const diffHrs = [];
        for (const hr of Object.keys(currDay)) {
          if (prevDay[hr] !== currDay[hr]) {
            diffHrs.push(hr);
          }
        }
        if (diffHrs.length > 0) {
          hasDiff = true;
          changedHours[dayKey] = diffHrs;
        }
      }

      if (hasDiff) {
        lastChangeByQueue[q] = {
          changedAt: new Date().toISOString(),
          sourceUpdate: (newJson.fact && newJson.fact.update) || newJson.lastUpdated,
          changedHours,
        };
        console.log(`[CHANGE DETECTED] ${q} updated at ${lastChangeByQueue[q].changedAt}`);
      }
    }

    previousDaysByQueue[q] = curr;
  }
}

async function refreshData() {
  try {
    const data = await fetchJson(DATA_URL);
    detectChanges(data);
    cachedRaw = data;
    lastFetchError = null;
    lastFetchedAt = new Date().toISOString();
  } catch (err) {
    lastFetchError = err.message;
    console.error("[FETCH ERROR]", err.message);
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const PUBLIC_DIR = path.join(__dirname, "public");

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  // CORS headers for TV app / local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === "/api/schedule") {
    if (!cachedRaw) {
      await refreshData();
    }
    const queue = urlObj.searchParams.get("queue") || DEFAULT_QUEUE;
    if (!cachedRaw) {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(
        JSON.stringify({
          error: "Не вдалося отримати дані від Тернопільобленерго",
          details: lastFetchError,
        })
      );
    }

    const factData = (cachedRaw.fact && cachedRaw.fact.data) || {};
    const dayKeys = Object.keys(factData).sort();
    const availableQueues =
      dayKeys.length > 0 ? Object.keys(factData[dayKeys[0]] || {}).sort() : [DEFAULT_QUEUE];

    const days = dayKeys.map((dayKey) => ({
      timestamp: Number(dayKey),
      hours: (factData[dayKey] && factData[dayKey][queue]) || {},
    }));

    const payload = {
      region: "Тернопільобленерго",
      queue,
      availableQueues,
      todayTimestamp: cachedRaw.fact ? cachedRaw.fact.today : null,
      sourceUpdate: cachedRaw.fact ? cachedRaw.fact.update : null,
      lastUpdatedIso: cachedRaw.lastUpdated || null,
      serverFetchedAt: lastFetchedAt,
      serverNowIso: new Date().toISOString(),
      lastChange: lastChangeByQueue[queue] || null,
      days,
    };

    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(JSON.stringify(payload));
  }

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, hasData: !!cachedRaw, lastFetchedAt }));
  }

  // Static files from public/
  let filePath = path.join(PUBLIC_DIR, pathname === "/" ? "index.html" : pathname);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(content);
  });
});

refreshData();
setInterval(refreshData, POLL_INTERVAL_MS);

server.listen(PORT, () => {
  console.log(`Ternopil Svitlo TV server running on http://localhost:${PORT}`);
});
