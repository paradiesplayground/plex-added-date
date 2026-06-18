const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { URL } = require("node:url");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3737);
const PUBLIC_DIR = path.join(__dirname, "public");

const PLEX_DB_FILE = "com.plexapp.plugins.library.db";
const MEDIA_TYPES = {
  movie: { label: "movies", metadataType: 1 },
  show: { label: "TV shows", metadataType: 2 },
};
const FIELD_SEPARATOR = "\x1f";

const PLEX_DB_PATH = process.env.PLEX_DB_PATH || "/plex-db";
const PLEX_CONTAINER_NAME = process.env.PLEX_CONTAINER_NAME || "binhex-plexpass";
const PLEX_SQLITE_IN_CONTAINER = process.env.PLEX_SQLITE_IN_CONTAINER || "/usr/lib/plexmediaserver/Plex SQLite";
const PLEX_CONFIG_PATH_HOST = process.env.PLEX_CONFIG_PATH_HOST || "/mnt/user/appdata/binhex-plexpass";
const PLEX_DB_RELATIVE_PATH = process.env.PLEX_DB_RELATIVE_PATH || "Plex Media Server/Plug-in Support/Databases/com.plexapp.plugins.library.db";
const BACKUP_DIR = process.env.BACKUP_DIR || "/backups";
const LOG_FILE = process.env.LOG_FILE || "/logs/actions.log";

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function resolveDatabasePath(dbPath = PLEX_DB_PATH) {
  const resolved = path.resolve(String(dbPath || PLEX_DB_PATH).trim().replace(/^"|"$/g, ""));

  if (!fs.existsSync(resolved)) {
    throw new Error(`Database path was not found: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const nestedDbPath = path.join(resolved, PLEX_DB_FILE);
    if (fs.existsSync(nestedDbPath) && fs.statSync(nestedDbPath).isFile()) {
      return nestedDbPath;
    }
    throw new Error(`Database folder does not contain ${PLEX_DB_FILE}: ${resolved}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Database path is not a file: ${resolved}`);
  }

  return resolved;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error("Choose an added-at date.");
  }

  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric <= 0) {
      throw new Error(`Invalid Unix timestamp: ${raw}`);
    }
    return numeric;
  }

  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`Could not parse date: ${raw}`);
  }
  return Math.floor(parsed / 1000);
}

function parseIdRows(text, fallbackTimestamp) {
  const rows = [];
  const seen = new Set();
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  for (const line of lines) {
    const parts = line.split(/[,\t|]/).map((part) => part.trim()).filter(Boolean);
    const idText = parts[0];

    if (!/^\d+$/.test(idText)) {
      throw new Error(`Invalid Plex ID in line: ${line}`);
    }

    const id = Number(idText);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(`Invalid Plex ID in line: ${line}`);
    }

    if (seen.has(id)) {
      throw new Error(`Duplicate Plex ID: ${id}`);
    }
    seen.add(id);

    rows.push({
      id,
      addedAt: parts.length > 1 ? parseTimestamp(parts.slice(1).join(" ")) : fallbackTimestamp,
    });
  }

  if (rows.length === 0) {
    throw new Error("Enter or select at least one Plex metadata ID.");
  }

  return rows;
}

function mediaTypeConfig(mediaType) {
  const key = String(mediaType || "movie").toLowerCase();
  if (!MEDIA_TYPES[key]) {
    throw new Error(`Unsupported media type: ${mediaType}`);
  }
  return { key, ...MEDIA_TYPES[key] };
}

function sqlInt(value) {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric)) {
    throw new Error(`Invalid integer for SQL: ${value}`);
  }
  return String(numeric);
}

function cleanSqlField(field) {
  return `replace(replace(ifnull(${field}, ''), char(10), ' '), char(13), ' ')`;
}

function rowSelectSql(whereClause, orderClause = "") {
  return `
    SELECT id
      || char(31) || ${cleanSqlField("title")}
      || char(31) || ifnull(metadata_type, '')
      || char(31) || ${cleanSqlField("guid")}
      || char(31) || ifnull(library_section_id, '')
      || char(31) || ifnull(added_at, '')
    FROM metadata_items
    ${whereClause}
    ${orderClause};
  `;
}

function runDocker(args, description, options = {}) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    input: options.input,
  });

  if (result.error) {
    throw new Error(`Could not ${description}: ${result.error.message}`);
  }

  const stderr = String(result.stderr || "").trim();
  if (result.status !== 0) {
    throw new Error(stderr || `Could not ${description}. Docker exited with code ${result.status}`);
  }

  return String(result.stdout || "");
}

function plexImage() {
  return runDocker(["inspect", "-f", "{{.Config.Image}}", PLEX_CONTAINER_NAME], "inspect Plex container").trim();
}

function plexContainerStatus() {
  return runDocker(["inspect", "-f", "{{.State.Status}}", PLEX_CONTAINER_NAME], "inspect Plex container").trim();
}

function stopPlexContainerIfRunning() {
  const status = plexContainerStatus();
  if (status !== "running") {
    return { stopped: false, previousStatus: status };
  }
  runDocker(["stop", PLEX_CONTAINER_NAME], "stop Plex container");
  return { stopped: true, previousStatus: status };
}

function startPlexContainer() {
  runDocker(["start", PLEX_CONTAINER_NAME], "start Plex container");
}

function runPlexSqlite(sql, write = false) {
  const input = [
    ".timeout 5000",
    ".headers off",
    ".mode list",
    `.separator "${FIELD_SEPARATOR}"`,
    sql,
    "",
  ].join("\n");

  const output = runDocker(
    [
      "run",
      "--rm",
      "-i",
      "--entrypoint",
      PLEX_SQLITE_IN_CONTAINER,
      "-v",
      `${PLEX_CONFIG_PATH_HOST}:/config`,
      plexImage(),
      `/config/${PLEX_DB_RELATIVE_PATH}`,
    ],
    "run Plex SQLite",
    { input }
  );

  if (write) {
    return [];
  }

  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function parsePlexRows(lines) {
  return lines.map((line) => {
    const parts = line.split(FIELD_SEPARATOR);
    return {
      id: Number(parts[0]),
      title: parts[1] || "",
      metadataType: parts[2] ? Number(parts[2]) : "",
      guid: parts[3] || "",
      librarySectionId: parts[4] ? Number(parts[4]) : "",
      addedAt: parts[5] ? Number(parts[5]) : null,
    };
  });
}

function formatIso(timestamp) {
  return new Date(timestamp * 1000).toISOString();
}

function toPreviewRow(row, newAddedAt = row.addedAt) {
  return {
    id: row.id,
    status: "found",
    title: row.title || "",
    type: row.metadataType,
    librarySectionId: row.librarySectionId || "",
    currentAddedAt: row.addedAt || null,
    currentAddedAtIso: row.addedAt ? formatIso(row.addedAt) : "",
    newAddedAt,
    newAddedAtIso: newAddedAt ? formatIso(newAddedAt) : "",
    guid: row.guid || "",
  };
}

function recentItems(mediaType, days = 7) {
  const media = mediaTypeConfig(mediaType);
  const numericDays = Number(days);
  if (!Number.isFinite(numericDays) || numericDays <= 0 || numericDays > 3650) {
    throw new Error("Recent-days value must be between 1 and 3650.");
  }

  const cutoff = Math.floor(Date.now() / 1000) - Math.floor(numericDays * 86400);
  const lines = runPlexSqlite(
    rowSelectSql(
      `WHERE metadata_type = ${sqlInt(media.metadataType)} AND added_at >= ${sqlInt(cutoff)}`,
      "ORDER BY added_at DESC, id DESC"
    )
  );

  return parsePlexRows(lines).map((row) => toPreviewRow(row));
}

function buildPreview(mediaType, rows) {
  const media = mediaTypeConfig(mediaType);
  const found = new Map();
  const idList = rows.map((row) => sqlInt(row.id)).join(",");
  const lines = runPlexSqlite(rowSelectSql(`WHERE metadata_type = ${sqlInt(media.metadataType)} AND id IN (${idList})`));

  for (const item of parsePlexRows(lines)) {
    found.set(item.id, item);
  }

  return rows.map((row) => {
    const item = found.get(row.id);
    if (!item) {
      return {
        id: row.id,
        status: "missing",
        title: "",
        type: "",
        librarySectionId: "",
        currentAddedAt: null,
        currentAddedAtIso: "",
        newAddedAt: row.addedAt,
        newAddedAtIso: formatIso(row.addedAt),
        guid: "",
      };
    }
    return toPreviewRow(item, row.addedAt);
  });
}

function createBackup(dbPath) {
  const dir = fs.existsSync(BACKUP_DIR) ? BACKUP_DIR : path.dirname(dbPath);
  const ext = path.extname(dbPath);
  const base = path.basename(dbPath, ext);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const backupPath = path.join(dir, `${base}.backup-${stamp}${ext || ".db"}`);

  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(dbPath, backupPath, fs.constants.COPYFILE_EXCL);
  return backupPath;
}

function appendActionLog(entry) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...entry,
  })}\n`);
  return LOG_FILE;
}

function applyDatabaseUpdates(mediaType, rows) {
  const media = mediaTypeConfig(mediaType);
  const updates = rows
    .map((row) => `UPDATE metadata_items SET added_at = ${sqlInt(row.addedAt)} WHERE metadata_type = ${sqlInt(media.metadataType)} AND id = ${sqlInt(row.id)};`)
    .join("\n");

  runPlexSqlite(`BEGIN IMMEDIATE;\n${updates}\nCOMMIT;`, true);
}

function applyUpdates(dbPath, mediaType, rows, makeBackup, managePlex = false) {
  const media = mediaTypeConfig(mediaType);
  let plexWasStopped = false;

  try {
    if (managePlex) {
      plexWasStopped = stopPlexContainerIfRunning().stopped;
    }

    const preview = buildPreview(media.key, rows);
    const missing = preview.filter((row) => row.status === "missing");
    if (missing.length > 0) {
      throw new Error(`Cannot update missing ${media.label} IDs: ${missing.map((row) => row.id).join(", ")}`);
    }

    const backupPath = makeBackup ? createBackup(dbPath) : "";
    applyDatabaseUpdates(media.key, rows);

    const result = {
      backupPath,
      plexStopped: plexWasStopped,
      plexRestarted: plexWasStopped,
      mediaType: media.key,
      mediaLabel: media.label,
      updated: rows.length,
      changes: preview.map((row) => ({
        id: row.id,
        title: row.title,
        oldAddedAt: row.currentAddedAt,
        oldAddedAtIso: row.currentAddedAtIso,
        newAddedAt: row.newAddedAt,
        newAddedAtIso: row.newAddedAtIso,
      })),
      rows: buildPreview(media.key, rows),
    };

    const logPath = appendActionLog({
      action: "apply",
      status: "success",
      mediaType: media.key,
      mediaLabel: media.label,
      dbPath,
      backupPath,
      plexStopped: result.plexStopped,
      plexRestarted: result.plexRestarted,
      updated: result.updated,
      changes: result.changes,
    });

    return { ...result, logPath };
  } catch (error) {
    const logPath = appendActionLog({
      action: "apply",
      status: "error",
      mediaType: media.key,
      mediaLabel: media.label,
      dbPath,
      plexStopped: plexWasStopped,
      plexRestarted: false,
      requestedIds: rows.map((row) => row.id),
      error: error.message || String(error),
    });
    error.logPath = logPath;
    throw error;
  } finally {
    if (plexWasStopped) {
      startPlexContainer();
    }
  }
}

function parsePayload(payload) {
  const dbPath = resolveDatabasePath(payload.dbPath || PLEX_DB_PATH);
  const media = mediaTypeConfig(payload.mediaType);
  const defaultTimestamp = parseTimestamp(payload.defaultDate);
  const rows = parseIdRows(payload.ids, defaultTimestamp);
  return { dbPath, mediaType: media.key, rows };
}

async function handleApi(req, res, pathname) {
  try {
    const payload = JSON.parse(await readBody(req) || "{}");

    if (pathname === "/api/config") {
      sendJson(res, 200, {
        defaultDbPath: resolveDatabasePath(PLEX_DB_PATH),
        plexContainerName: PLEX_CONTAINER_NAME,
        backupDir: BACKUP_DIR,
        logFile: LOG_FILE,
        mediaTypes: Object.entries(MEDIA_TYPES).map(([value, media]) => ({
          value,
          label: media.label,
        })),
      });
      return;
    }

    if (pathname === "/api/recent") {
      sendJson(res, 200, {
        dbPath: resolveDatabasePath(payload.dbPath || PLEX_DB_PATH),
        rows: recentItems(payload.mediaType, payload.days || 7),
      });
      return;
    }

    const { dbPath, mediaType, rows } = parsePayload(payload);

    if (pathname === "/api/preview") {
      sendJson(res, 200, { dbPath, rows: buildPreview(mediaType, rows) });
      return;
    }

    if (pathname === "/api/apply") {
      sendJson(res, 200, applyUpdates(dbPath, mediaType, rows, payload.backup !== false, payload.managePlex === true));
      return;
    }

    sendJson(res, 404, { error: "Unknown API route." });
  } catch (error) {
    sendJson(res, 400, { error: error.message || String(error), logPath: error.logPath || "" });
  }
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const type = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
  }[ext] || "application/octet-stream";

  res.writeHead(200, { "content-type": type });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res, decodeURIComponent(url.pathname));
    return;
  }

  sendText(res, 405, "Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`Plex Added Date is running at http://${HOST}:${PORT}`);
});
