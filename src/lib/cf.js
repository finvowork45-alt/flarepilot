import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

var CONFIG_DIR = join(homedir(), ".flarepilot");
var CONFIG_PATH = join(CONFIG_DIR, "config.json");

var CF_API = "https://api.cloudflare.com/client/v4";
var CF_REGISTRY = "registry.cloudflare.com";

export { CF_REGISTRY };

// --- Auth config (~/.flarepilot/config.json is the only local file) ---

export function getConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error("Not authenticated. Run `flarepilot auth` first.");
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

export function tryGetConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return null;
  }
}

export function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// --- CF API base ---

export async function cfApi(method, path, body, apiToken, contentType) {
  if (!apiToken) {
    var config = getConfig();
    apiToken = config.apiToken;
  }

  var headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  } else if (body && typeof body === "object") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }

  var res = await fetch(`${CF_API}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : body,
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF API ${method} ${path}: ${res.status} ${text}`);
  }

  var ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// --- CF GraphQL Analytics API ---

export async function cfGraphQL(config, query, variables) {
  var res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`CF GraphQL: ${res.status} ${text}`);
  }

  var json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`CF GraphQL: ${json.errors.map((e) => e.message).join(", ")}`);
  }
  return json.data;
}

// --- Registry ---

export async function getRegistryCredentials(config) {
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/containers/registries/${CF_REGISTRY}/credentials`,
    { permissions: ["push", "pull"], expiration_minutes: 15 },
    config.apiToken
  );
  return res.result;
}

// --- Worker scripts ---

export async function uploadWorker(config, scriptName, code, metadata) {
  var form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(metadata)], { type: "application/json" })
  );
  form.append(
    "index.js",
    new Blob([code], { type: "application/javascript+module" }),
    "index.js"
  );

  var res = await fetch(
    `${CF_API}/accounts/${config.accountId}/workers/scripts/${scriptName}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${config.apiToken}` },
      body: form,
    }
  );

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Worker upload failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function deleteWorker(config, scriptName) {
  return cfApi(
    "DELETE",
    `/accounts/${config.accountId}/workers/scripts/${scriptName}`,
    null,
    config.apiToken
  );
}

export async function patchWorkerSettings(config, scriptName, settings) {
  var form = new FormData();
  form.append(
    "settings",
    new Blob([JSON.stringify(settings)], { type: "application/json" })
  );

  var res = await fetch(
    `${CF_API}/accounts/${config.accountId}/workers/scripts/${scriptName}/settings`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${config.apiToken}` },
      body: form,
    }
  );

  if (!res.ok) {
    var text = await res.text();
    throw new Error(`Settings update failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function listWorkerScripts(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/scripts`,
    null,
    config.apiToken
  );
  return res.result || [];
}

// --- App config (stored in the deployed worker's FLAREPILOT_APP_CONFIG binding) ---

export async function getAppConfig(config, name) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/scripts/flarepilot-${name}/settings`,
    null,
    config.apiToken
  );
  var bindings = res.result?.bindings || [];
  var binding = bindings.find((b) => b.name === "FLAREPILOT_APP_CONFIG");
  if (!binding) return null;
  var appConfig = JSON.parse(binding.text);

  // Migration: old format has env object with values but no envKeys/secretKeys
  if (appConfig.env && !appConfig.envKeys) {
    appConfig.envKeys = Object.keys(appConfig.env);
    appConfig.secretKeys = [];
    return appConfig;
  }

  // New format: reconstruct env from native bindings
  if (!appConfig.env) appConfig.env = {};
  for (var key of (appConfig.envKeys || [])) {
    var b = bindings.find((x) => x.name === key && x.type === "plain_text");
    if (b) appConfig.env[key] = b.text;
  }
  for (var key of (appConfig.secretKeys || [])) {
    appConfig.env[key] = "[hidden]";
  }

  return appConfig;
}

export async function pushAppConfig(config, name, appConfig, { newSecrets } = {}) {
  var { getWorkerBundle } = await import("./bundle.js");
  var code = getWorkerBundle();
  var metadata = buildWorkerMetadata(appConfig, { firstDeploy: false, newSecrets });
  await uploadWorker(config, `flarepilot-${name}`, code, metadata);
}

// --- Metadata builder (full deploy) ---

export function buildWorkerMetadata(appConfig, { firstDeploy = false, newSecrets } = {}) {
  // Build the JSON blob — store only key lists, not values
  var envKeys = appConfig.envKeys || [];
  var secretKeys = appConfig.secretKeys || [];
  var configJson = Object.assign({}, appConfig);

  // For backward compat with old templates: keep env with plain_text values only
  var backcompatEnv = {};
  for (var key of envKeys) {
    if (appConfig.env && appConfig.env[key] !== undefined) {
      backcompatEnv[key] = appConfig.env[key];
    }
  }
  configJson.env = backcompatEnv;

  var bindings = [
    {
      type: "durable_object_namespace",
      name: "APP_CONTAINER",
      class_name: "AppContainer",
    },
    {
      type: "plain_text",
      name: "FLAREPILOT_APP_CONFIG",
      text: JSON.stringify(configJson),
    },
  ];

  // D1 binding
  if (appConfig.dbId) {
    bindings.push({ type: "d1", name: "DB", id: appConfig.dbId });
  }

  // Emit native plain_text bindings for each envKey
  for (var key of envKeys) {
    if (appConfig.env && appConfig.env[key] !== undefined) {
      bindings.push({ type: "plain_text", name: key, text: appConfig.env[key] });
    }
  }

  // Emit native secret_text bindings only for new/updated secrets
  for (var key of secretKeys) {
    if (newSecrets && newSecrets[key] !== undefined) {
      bindings.push({ type: "secret_text", name: key, text: newSecrets[key] });
    }
  }

  var metadata = {
    main_module: "index.js",
    compatibility_date: "2025-10-08",
    bindings,
    observability: {
      enabled: appConfig.observability !== false,
    },
    containers: [
      {
        class_name: "AppContainer",
      },
    ],
  };

  if (firstDeploy) {
    metadata.migrations = {
      new_tag: "v1",
      new_sqlite_classes: ["AppContainer"],
    };
  } else {
    metadata.migrations = {
      old_tag: "v1",
      new_tag: "v1",
    };
  }

  return metadata;
}

// --- Container applications ---

export async function getDONamespaceId(config, scriptName, className) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/durable_objects/namespaces`,
    null,
    config.apiToken
  );
  var namespaces = res.result || [];
  var ns = namespaces.find(
    (n) => n.script === scriptName && n.class === className
  );
  return ns ? ns.id : null;
}

export async function listContainerApps(config) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/containers/applications`,
    null,
    config.apiToken
  );
  return res.result || [];
}

export async function findContainerApp(config, name) {
  var apps = await listContainerApps(config);
  return apps.find((a) => a.name === name) || null;
}

export async function createContainerApp(config, app) {
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/containers/applications`,
    app,
    config.apiToken
  );
  return res.result;
}

export async function deleteContainerApp(config, appId) {
  return cfApi(
    "DELETE",
    `/accounts/${config.accountId}/containers/applications/${appId}`,
    null,
    config.apiToken
  );
}

export async function modifyContainerApp(config, appId, changes) {
  var res = await cfApi(
    "PATCH",
    `/accounts/${config.accountId}/containers/applications/${appId}`,
    changes,
    config.apiToken
  );
  return res.result;
}

export async function createRollout(config, appId, rollout) {
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/containers/applications/${appId}/rollouts`,
    rollout,
    config.apiToken
  );
  return res.result;
}

// --- Tail/logs ---

export async function createTail(config, scriptName) {
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/workers/scripts/${scriptName}/tails`,
    {},
    config.apiToken
  );
  return res.result;
}

export async function deleteTail(config, scriptName, tailId) {
  return cfApi(
    "DELETE",
    `/accounts/${config.accountId}/workers/scripts/${scriptName}/tails/${tailId}`,
    null,
    config.apiToken
  );
}

// --- Zones ---

export async function listZones(config) {
  var all = [];
  var page = 1;
  while (true) {
    var res = await cfApi(
      "GET",
      `/zones?account.id=${config.accountId}&per_page=50&status=active&page=${page}`,
      null,
      config.apiToken
    );
    var zones = res.result || [];
    all.push(...zones);
    if (zones.length < 50) break;
    page++;
  }
  return all;
}

export function findZoneForHostname(zones, hostname) {
  // Find the zone whose name is a suffix of the hostname (longest match wins)
  var match = null;
  for (var zone of zones) {
    if (hostname === zone.name || hostname.endsWith("." + zone.name)) {
      if (!match || zone.name.length > match.name.length) {
        match = zone;
      }
    }
  }
  return match;
}

// --- DNS records ---

export async function listDnsRecords(config, zoneId, params) {
  var qs = new URLSearchParams(params || {}).toString();
  var path = `/zones/${zoneId}/dns_records${qs ? "?" + qs : ""}`;
  var res = await cfApi("GET", path, null, config.apiToken);
  return res.result || [];
}

export async function createDnsRecord(config, zoneId, record) {
  return cfApi(
    "POST",
    `/zones/${zoneId}/dns_records`,
    record,
    config.apiToken
  );
}

export async function deleteDnsRecord(config, zoneId, recordId) {
  return cfApi(
    "DELETE",
    `/zones/${zoneId}/dns_records/${recordId}`,
    null,
    config.apiToken
  );
}

// --- Workers custom domains ---

export async function addWorkerDomain(config, scriptName, hostname, zoneId) {
  return cfApi(
    "PUT",
    `/accounts/${config.accountId}/workers/domains`,
    {
      hostname,
      zone_id: zoneId,
      service: scriptName,
      environment: "production",
    },
    config.apiToken
  );
}

export async function removeWorkerDomain(config, hostname) {
  // Find the domain ID by hostname
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/domains`,
    null,
    config.apiToken
  );
  var domains = res.result || [];
  var domain = domains.find((d) => d.hostname === hostname);
  if (!domain) return;

  return cfApi(
    "DELETE",
    `/accounts/${config.accountId}/workers/domains/${domain.id}`,
    null,
    config.apiToken
  );
}

export async function listWorkerDomainsForService(config, scriptName) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/workers/domains`,
    null,
    config.apiToken
  );
  return (res.result || []).filter((d) => d.service === scriptName);
}

// --- Workers subdomain ---

export async function getWorkersSubdomain(config) {
  try {
    var res = await cfApi(
      "GET",
      `/accounts/${config.accountId}/workers/subdomain`,
      null,
      config.apiToken
    );
    return res.result?.subdomain || null;
  } catch {
    return null;
  }
}

export async function enableWorkerSubdomain(config, scriptName) {
  return cfApi(
    "POST",
    `/accounts/${config.accountId}/workers/services/${scriptName}/environments/production/subdomain`,
    { enabled: true },
    config.apiToken
  );
}

export function getAppUrl(subdomain, name) {
  if (!subdomain) return null;
  return `https://flarepilot-${name}.${subdomain}.workers.dev`;
}

// --- D1 databases ---

export async function createD1Database(config, name, { locationHint, jurisdiction } = {}) {
  var body = { name };
  if (jurisdiction) body.jurisdiction = jurisdiction;
  else if (locationHint) body.primary_location_hint = locationHint;
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/d1/database`,
    body,
    config.apiToken
  );
  return res.result;
}

export async function deleteD1Database(config, dbId) {
  return cfApi(
    "DELETE",
    `/accounts/${config.accountId}/d1/database/${dbId}`,
    null,
    config.apiToken
  );
}

export async function getD1Database(config, dbId) {
  var res = await cfApi(
    "GET",
    `/accounts/${config.accountId}/d1/database/${dbId}`,
    null,
    config.apiToken
  );
  return res.result;
}

export async function queryD1(config, dbId, sql, params) {
  var body = { sql };
  if (params) body.params = params;
  var res = await cfApi(
    "POST",
    `/accounts/${config.accountId}/d1/database/${dbId}/query`,
    body,
    config.apiToken
  );
  return res.result;
}

export async function exportD1(config, dbId, body) {
  return cfApi(
    "POST",
    `/accounts/${config.accountId}/d1/database/${dbId}/export`,
    body,
    config.apiToken
  );
}

export async function importD1(config, dbId, body) {
  return cfApi(
    "POST",
    `/accounts/${config.accountId}/d1/database/${dbId}/import`,
    body,
    config.apiToken
  );
}
