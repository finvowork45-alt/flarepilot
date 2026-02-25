import { Container } from "@cloudflare/containers";

export class AppContainer extends Container {
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    var appConfig = JSON.parse(env.FLAREPILOT_APP_CONFIG);
    this.defaultPort = appConfig.port || 8080;
    this.sleepAfter = appConfig.sleepAfter || "30s";

    // Read env vars from native bindings (new format)
    var envVars = {};
    var allKeys = [...(appConfig.envKeys || []), ...(appConfig.secretKeys || [])];
    if (allKeys.length > 0) {
      for (var key of allKeys) {
        if (env[key] !== undefined) envVars[key] = env[key];
      }
    }
    // Backward compat: merge appConfig.env for old-format configs or plain values
    if (appConfig.env) {
      for (var key of Object.keys(appConfig.env)) {
        if (envVars[key] === undefined) envVars[key] = appConfig.env[key];
      }
    }
    this.envVars = envVars;
  }
}

export default {
  async fetch(request, env) {
    var appConfig = JSON.parse(env.FLAREPILOT_APP_CONFIG);

    // Hrana protocol handler — only active when D1 binding exists
    if (env.DB) {
      var url = new URL(request.url);
      var path = url.pathname.replace(/\/+/g, "/").replace(/\/$/, "");
      if (request.method === "POST" && path === "/v2/pipeline") {
        return handleHranaPipeline(request, env, appConfig);
      }
      if (request.method === "GET" && (path === "/v2" || path === "/v3")) {
        return new Response("ok");
      }
    }

    var regions = appConfig.regions;
    var instances = appConfig.instances || 2;

    // Geo-aware routing: use Cloudflare's request.cf to pick closest region
    var cf = request.cf || {};
    var region = pickRegion(regions, cf);

    var binding = env.APP_CONTAINER;

    // Route to a random instance in the selected region
    var idx = Math.floor(Math.random() * instances);
    var objectId = binding.idFromName(region + "-" + idx);
    var container = binding.get(objectId, { locationHint: region });

    var response = await container.fetch(request);

    // Also set on response for external observability (curl -I, devtools)
    var headers = new Headers(response.headers);
    headers.set("X-Flarepilot-Region", region);

    return response;
  },
};


// Country → preferred location hints (ordered by proximity)
// Uses request.cf.country (ISO 3166-1 alpha-2)
var COUNTRY_PREFERENCES = {
  // Eastern Europe → eeur first
  PL: ["eeur", "weur"], CZ: ["eeur", "weur"], SK: ["eeur", "weur"],
  HU: ["eeur", "weur"], RO: ["eeur", "weur"], BG: ["eeur", "weur"],
  UA: ["eeur", "weur"], LT: ["eeur", "weur"], LV: ["eeur", "weur"],
  EE: ["eeur", "weur"], HR: ["eeur", "weur"], SI: ["eeur", "weur"],
  RS: ["eeur", "weur"], BA: ["eeur", "weur"], MK: ["eeur", "weur"],
  AL: ["eeur", "weur"], ME: ["eeur", "weur"], MD: ["eeur", "weur"],
  BY: ["eeur", "weur"], FI: ["eeur", "weur"], GR: ["eeur", "weur", "me"],
  // Turkey — between eeur and me
  TR: ["eeur", "me", "weur"],
  // Middle East (CF puts these in AS continent)
  AE: ["me", "eeur", "apac"], SA: ["me", "afr", "eeur"],
  QA: ["me", "eeur", "apac"], BH: ["me", "eeur", "apac"],
  KW: ["me", "eeur"], OM: ["me", "apac"], IL: ["me", "eeur"],
  JO: ["me", "eeur"], LB: ["me", "eeur"], IQ: ["me", "eeur"],
  IR: ["me", "apac", "eeur"], YE: ["me", "afr"],
  // South Asia → apac, but me as second choice
  IN: ["apac", "me"], PK: ["apac", "me"], BD: ["apac", "me"],
  LK: ["apac", "me"],
  // North Africa — closer to Europe/ME than sub-Saharan Africa
  EG: ["me", "eeur", "afr"], LY: ["afr", "me", "weur"],
  TN: ["afr", "weur", "me"], DZ: ["afr", "weur"],
  MA: ["afr", "weur"],
  // Mexico / Central America → wnam
  MX: ["wnam", "enam", "sam"],
  // Australia / NZ → explicit oc
  AU: ["oc", "apac"], NZ: ["oc", "apac"],
};

// Fallback: continent → preferred location hints
var CONTINENT_PREFERENCES = {
  NA: ["enam", "wnam", "sam"],
  SA: ["sam", "enam", "wnam"],
  EU: ["weur", "eeur"],
  AS: ["apac", "me", "eeur"],
  OC: ["oc", "apac"],
  AF: ["afr", "me", "weur"],
  AN: ["oc", "sam", "apac"],
};

/**
 * Pick the closest region from the app's deployed regions.
 * Checks country first (request.cf.country), falls back to continent.
 */
function pickRegion(regions, cf) {
  if (regions.length === 1) return regions[0];
  if (!cf) return regions[0];

  // try country-level match first
  var preferences = COUNTRY_PREFERENCES[cf.country] || CONTINENT_PREFERENCES[cf.continent];
  if (!preferences) return regions[0];

  for (var hint of preferences) {
    if (regions.includes(hint)) return hint;
  }

  return regions[0];
}


// --- Hrana protocol handler (libSQL/sqld HTTP v2) ---

async function handleHranaPipeline(request, env, appConfig) {
  // Auth check — DB_TOKEN is a secret_text binding
  var dbToken = env.DB_TOKEN;
  if (dbToken) {
    var auth = request.headers.get("Authorization") || "";
    var token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== dbToken) {
      return Response.json(hranaError("AUTH_FAILED", "Invalid or missing auth token"), { status: 401 });
    }
  }

  var body;
  try {
    body = await request.json();
  } catch {
    return Response.json(hranaError("REQUEST_INVALID", "Invalid JSON body"), { status: 400 });
  }

  var results = [];
  for (var req of (body.requests || [])) {
    try {
      if (req.type === "execute") {
        var result = await executeStmt(env.DB, req.stmt);
        results.push({ type: "ok", response: { type: "execute", result } });
      } else if (req.type === "batch") {
        var stmts = req.batch.steps.map(function (step) { return step.stmt; });
        var prepared = stmts.map(function (s) { return bindStmt(env.DB, s); });
        var d1Results = await env.DB.batch(prepared);
        var batchResults = d1Results.map(function (d1r) {
          return { type: "ok", response: { type: "execute", result: convertD1Result(d1r) } };
        });
        results.push({ type: "ok", response: { type: "batch", result: { step_results: batchResults, step_errors: batchResults.map(function () { return null; }) } } });
      } else if (req.type === "close") {
        results.push({ type: "ok", response: { type: "close" } });
      } else {
        results.push({ type: "ok", response: { type: "none" } });
      }
    } catch (e) {
      results.push({ type: "error", error: { message: e.message, code: "STMT_ERROR" } });
    }
  }

  return Response.json({ baton: null, base_url: null, results });
}

function hranaValueToJS(v) {
  if (!v || v.type === "null") return null;
  if (v.type === "integer") return Number(v.value);
  if (v.type === "float") return Number(v.value);
  if (v.type === "text") return v.value;
  if (v.type === "blob") {
    var bin = atob(v.base64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  return v.value !== undefined ? v.value : null;
}

function jsValueToHrana(v) {
  if (v === null || v === undefined) return { type: "null" };
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? { type: "integer", value: String(v) }
      : { type: "float", value: v };
  }
  if (typeof v === "string") return { type: "text", value: v };
  if (v instanceof Uint8Array || v instanceof ArrayBuffer) {
    var arr = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
    var s = "";
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return { type: "blob", base64: btoa(s) };
  }
  return { type: "text", value: String(v) };
}

function resolveArgs(stmt) {
  if (stmt.named_args && stmt.named_args.length > 0) {
    var obj = {};
    for (var na of stmt.named_args) {
      obj[na.name] = hranaValueToJS(na.value);
    }
    return obj;
  }
  if (stmt.args && stmt.args.length > 0) {
    return stmt.args.map(hranaValueToJS);
  }
  return [];
}

function bindStmt(db, stmt) {
  var args = resolveArgs(stmt);
  var prepared = db.prepare(stmt.sql);
  return Array.isArray(args) && args.length > 0
    ? prepared.bind(...args)
    : !Array.isArray(args)
      ? prepared.bind(args)
      : prepared;
}

async function executeStmt(db, stmt) {
  var bound = bindStmt(db, stmt);
  var d1Result = await bound.all();
  return convertD1Result(d1Result);
}

function convertD1Result(d1Result) {
  var rows = d1Result.results || [];
  var cols = rows.length > 0
    ? Object.keys(rows[0]).map(function (name) { return { name, decltype: null }; })
    : [];
  var hranaRows = rows.map(function (row) {
    return cols.map(function (col) { return jsValueToHrana(row[col.name]); });
  });
  return {
    cols,
    rows: hranaRows,
    affected_row_count: d1Result.meta?.changes || 0,
    last_insert_rowid: d1Result.meta?.last_row_id != null ? String(d1Result.meta.last_row_id) : null,
  };
}

function hranaError(code, message) {
  return { results: [{ type: "error", error: { message, code } }] };
}