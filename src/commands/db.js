import {
  getConfig,
  getAppConfig,
  pushAppConfig,
  getWorkersSubdomain,
  createD1Database,
  deleteD1Database,
  getD1Database,
  queryD1,
  exportD1,
  importD1,
} from "../lib/cf.js";
import { resolveAppName } from "../lib/link.js";
import { phase, status, success, fatal, hint, fmt, table } from "../lib/output.js";
import { createInterface } from "readline";
import { readFileSync, writeFileSync } from "fs";
import { randomBytes } from "crypto";

export async function dbCreate(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig) {
    fatal(
      `App ${fmt.app(name)} not found.`,
      `Run ${fmt.cmd(`flarepilot deploy ${name} .`)} first.`
    );
  }

  if (appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} already has a database: ${appConfig.dbName}`,
      `Run ${fmt.cmd(`flarepilot db info ${name}`)} to see details.`
    );
  }

  var dbName = `flarepilot-${name}`;

  phase("Creating D1 database");
  if (options.jurisdiction) status(`${dbName} (jurisdiction: ${options.jurisdiction})...`);
  else if (options.location) status(`${dbName} (location: ${options.location})...`);
  else status(`${dbName}...`);
  var result = await createD1Database(config, dbName, {
    locationHint: options.location,
    jurisdiction: options.jurisdiction,
  });

  appConfig.dbId = result.uuid;
  appConfig.dbName = dbName;

  // Auto-provision DB_URL and DB_TOKEN env vars for the container
  if (!appConfig.envKeys) appConfig.envKeys = [];
  if (!appConfig.secretKeys) appConfig.secretKeys = [];
  if (!appConfig.env) appConfig.env = {};

  var subdomain = await getWorkersSubdomain(config);
  var connectionUrl = subdomain
    ? `https://flarepilot-${name}.${subdomain}.workers.dev`
    : null;

  if (connectionUrl) {
    appConfig.env["DB_URL"] = connectionUrl;
    if (!appConfig.envKeys.includes("DB_URL")) appConfig.envKeys.push("DB_URL");
  }

  var dbToken = randomBytes(32).toString("hex");
  appConfig.env["DB_TOKEN"] = "[hidden]";
  appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");
  appConfig.secretKeys.push("DB_TOKEN");
  appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

  var newSecrets = { DB_TOKEN: dbToken };

  status("Updating worker bindings...");
  await pushAppConfig(config, name, appConfig, { newSecrets });

  if (options.json) {
    console.log(JSON.stringify({
      name,
      dbId: appConfig.dbId,
      dbName,
      dbToken,
      connectionUrl,
    }, null, 2));
    return;
  }

  success(`Database ${fmt.app(dbName)} created!`);
  console.log(`  ${fmt.bold("DB ID:")}     ${appConfig.dbId}`);
  console.log(`  ${fmt.bold("DB Name:")}   ${dbName}`);
  if (connectionUrl) {
    console.log(`  ${fmt.bold("DB URL:")}    ${fmt.url(connectionUrl)}`);
  }
  console.log(`  ${fmt.bold("Token:")}     ${dbToken}`);
  hint("Next", `flarepilot db shell ${name}`);
}

export async function dbDestroy(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(`App ${fmt.app(name)} does not have a database.`);
  }

  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`Type "${name}" to confirm database destruction: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Destroying database requires confirmation.`,
        `Run: flarepilot db destroy ${name} --confirm ${name}`
      );
    }
  }

  phase("Destroying D1 database");
  status(`Deleting ${appConfig.dbName}...`);
  await deleteD1Database(config, appConfig.dbId);

  delete appConfig.dbId;
  delete appConfig.dbName;

  // Remove auto-provisioned DB env vars
  if (appConfig.env) {
    delete appConfig.env["DB_URL"];
    delete appConfig.env["DB_TOKEN"];
  }
  if (appConfig.envKeys) appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_URL");
  if (appConfig.secretKeys) appConfig.secretKeys = appConfig.secretKeys.filter((k) => k !== "DB_TOKEN");

  status("Updating worker bindings...");
  await pushAppConfig(config, name, appConfig);

  success(`Database for ${fmt.app(name)} destroyed.`);
}

export async function dbInfo(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  var dbDetails = await getD1Database(config, appConfig.dbId);
  var subdomain = await getWorkersSubdomain(config);
  var connectionUrl = subdomain
    ? `https://flarepilot-${name}.${subdomain}.workers.dev`
    : null;

  if (options.json) {
    console.log(JSON.stringify({
      name,
      dbId: appConfig.dbId,
      dbName: appConfig.dbName,
      connectionUrl,
      size: dbDetails.file_size,
      numTables: dbDetails.num_tables,
      createdAt: dbDetails.created_at,
    }, null, 2));
    return;
  }

  console.log("");
  console.log(`${fmt.bold("Database:")}   ${fmt.app(appConfig.dbName)}`);
  console.log(`${fmt.bold("DB ID:")}      ${appConfig.dbId}`);
  if (dbDetails.file_size != null) {
    var sizeKb = (dbDetails.file_size / 1024).toFixed(1);
    console.log(`${fmt.bold("Size:")}       ${sizeKb} KB`);
  }
  if (dbDetails.num_tables != null) {
    console.log(`${fmt.bold("Tables:")}     ${dbDetails.num_tables}`);
  }
  if (connectionUrl) {
    console.log(`${fmt.bold("DB URL:")}     ${fmt.url(connectionUrl)}`);
  }
  console.log(`${fmt.bold("Token:")}      ${fmt.dim("[hidden]")}`);
  if (dbDetails.created_at) {
    console.log(`${fmt.bold("Created:")}    ${dbDetails.created_at}`);
  }
  console.log("");
}

export async function dbShell(name) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  var rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: "sql> ",
  });

  process.stderr.write(`Connected to ${fmt.app(appConfig.dbName)}. Type .exit to quit.\n\n`);
  rl.prompt();

  rl.on("line", async (line) => {
    line = line.trim();
    if (!line) {
      rl.prompt();
      return;
    }

    if (line === ".exit" || line === ".quit") {
      rl.close();
      return;
    }

    try {
      var sql;
      if (line === ".tables") {
        sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name";
      } else if (line.startsWith(".schema")) {
        var tableName = line.split(/\s+/)[1];
        if (!tableName) {
          process.stderr.write("Usage: .schema <table>\n");
          rl.prompt();
          return;
        }
        sql = `SELECT sql FROM sqlite_master WHERE name='${tableName}'`;
      } else {
        sql = line;
      }

      var results = await queryD1(config, appConfig.dbId, sql);
      var result = Array.isArray(results) ? results[0] : results;

      if (result && result.results && result.results.length > 0) {
        var cols = Object.keys(result.results[0]);
        var rows = result.results.map((r) => cols.map((c) => String(r[c] ?? "")));
        console.log(table(cols, rows));
      } else if (result && result.meta) {
        process.stderr.write(
          fmt.dim(`OK. ${result.meta.changes || 0} changes, ${result.meta.rows_read || 0} rows read.\n`)
        );
      }
    } catch (e) {
      process.stderr.write(`${fmt.dim("Error:")} ${e.message}\n`);
    }

    rl.prompt();
  });

  rl.on("close", () => {
    process.stderr.write("\n");
  });

  // Keep process alive until rl closes
  await new Promise((resolve) => rl.on("close", resolve));
}

export async function dbQuery(args, options) {
  // Smart arg parsing: [name] <sql>
  var name;
  var sql;
  var joined = args.join(" ");

  // If first arg has no spaces and doesn't start with SQL keyword, treat as app name
  var sqlKeywords = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA|WITH|EXPLAIN|BEGIN|COMMIT|ROLLBACK|REPLACE|VACUUM|REINDEX|ATTACH|DETACH)\b/i;
  if (args.length >= 2 && !args[0].includes(" ") && !sqlKeywords.test(args[0])) {
    name = args[0];
    sql = args.slice(1).join(" ");
  } else {
    sql = joined;
  }

  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  var results = await queryD1(config, appConfig.dbId, sql);
  var result = Array.isArray(results) ? results[0] : results;

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result && result.results && result.results.length > 0) {
    var cols = Object.keys(result.results[0]);
    var rows = result.results.map((r) => cols.map((c) => String(r[c] ?? "")));
    console.log(table(cols, rows));
  } else if (result && result.meta) {
    process.stderr.write(
      fmt.dim(`OK. ${result.meta.changes || 0} changes, ${result.meta.rows_read || 0} rows read.\n`)
    );
  }
}

export async function dbImport(args, options) {
  // Parse args: [name] <filepath>
  var name;
  var filepath;
  if (args.length >= 2) {
    name = args[0];
    filepath = args[1];
  } else if (args.length === 1) {
    filepath = args[0];
  } else {
    fatal("Usage: flarepilot db import [name] <path>");
  }

  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  var sqlContent;
  try {
    sqlContent = readFileSync(filepath, "utf-8");
  } catch (e) {
    fatal(`Could not read file: ${filepath}`, e.message);
  }

  phase("Importing SQL");
  status(`File: ${filepath} (${(sqlContent.length / 1024).toFixed(1)} KB)`);

  // Step 1: Init import
  status("Initializing import...");
  var initRes = await importD1(config, appConfig.dbId, {
    action: "init",
  });
  var initResult = initRes.result || initRes;

  if (!initResult.filename || !initResult.upload_url) {
    fatal("Import init failed — no upload URL returned.");
  }

  // Step 2: Upload to signed URL
  status("Uploading SQL...");
  var uploadRes = await fetch(initResult.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: sqlContent,
  });
  if (!uploadRes.ok) {
    fatal(`Upload failed: ${uploadRes.status} ${await uploadRes.text()}`);
  }

  // Step 3: Ingest
  status("Ingesting...");
  var ingestRes = await importD1(config, appConfig.dbId, {
    action: "ingest",
    filename: initResult.filename,
  });

  // Step 4: Poll until complete
  var polling = true;
  while (polling) {
    await new Promise((r) => setTimeout(r, 2000));
    var pollRes = await importD1(config, appConfig.dbId, {
      action: "poll",
      current_bookmark: (ingestRes.result || ingestRes).at_bookmark,
    });
    var pollResult = pollRes.result || pollRes;
    if (pollResult.status === "complete" || pollResult.type === "done") {
      polling = false;
    } else if (pollResult.status === "error" || pollResult.error) {
      fatal("Import failed.", pollResult.error || "Unknown error during ingest.");
    } else {
      status("Still importing...");
    }
  }

  success(`Imported ${filepath} into ${fmt.app(appConfig.dbName)}`);
}

export async function dbExport(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  phase("Exporting database");
  status("Initiating export...");
  var exportRes = await exportD1(config, appConfig.dbId, {
    output_format: "polling",
  });

  // Poll until complete
  var signedUrl = null;
  while (!signedUrl) {
    var exportResult = exportRes.result || exportRes;
    if (exportResult.status === "complete" && exportResult.signed_url) {
      signedUrl = exportResult.signed_url;
    } else if (exportResult.status === "error") {
      fatal("Export failed.", exportResult.error || "Unknown error.");
    } else {
      await new Promise((r) => setTimeout(r, 2000));
      status("Polling...");
      exportRes = await exportD1(config, appConfig.dbId, {
        output_format: "polling",
        current_bookmark: exportResult.at_bookmark,
      });
    }
  }

  // Download
  status("Downloading SQL dump...");
  var dumpRes = await fetch(signedUrl);
  if (!dumpRes.ok) {
    fatal(`Download failed: ${dumpRes.status}`);
  }
  var dump = await dumpRes.text();

  if (options.output) {
    writeFileSync(options.output, dump);
    success(`Exported to ${options.output}`);
  } else {
    process.stdout.write(dump);
  }
}

export async function dbToken(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(
      `App ${fmt.app(name)} does not have a database.`,
      `Run ${fmt.cmd(`flarepilot db create ${name}`)} first.`
    );
  }

  var subdomain = await getWorkersSubdomain(config);
  var connectionUrl = subdomain
    ? `https://flarepilot-${name}.${subdomain}.workers.dev`
    : null;

  if (options.rotate) {
    var dbToken = randomBytes(32).toString("hex");
    if (!appConfig.envKeys) appConfig.envKeys = [];
    if (!appConfig.secretKeys) appConfig.secretKeys = [];
    if (!appConfig.env) appConfig.env = {};

    appConfig.env["DB_TOKEN"] = "[hidden]";
    if (!appConfig.secretKeys.includes("DB_TOKEN")) appConfig.secretKeys.push("DB_TOKEN");
    appConfig.envKeys = appConfig.envKeys.filter((k) => k !== "DB_TOKEN");

    if (connectionUrl) {
      appConfig.env["DB_URL"] = connectionUrl;
      if (!appConfig.envKeys.includes("DB_URL")) appConfig.envKeys.push("DB_URL");
    }

    await pushAppConfig(config, name, appConfig, { newSecrets: { DB_TOKEN: dbToken } });
    success("Token rotated.");
    console.log(`${fmt.bold("Token:")}    ${dbToken}`);
  } else {
    console.log(`${fmt.bold("Token:")}    ${fmt.dim("[hidden] — use --rotate to generate a new token")}`);
  }
  if (connectionUrl) {
    console.log(`${fmt.bold("DB URL:")}   ${fmt.url(connectionUrl)}`);
  }
}

export async function dbReset(name, options) {
  name = resolveAppName(name);
  var config = getConfig();
  var appConfig = await getAppConfig(config, name);

  if (!appConfig || !appConfig.dbId) {
    fatal(`App ${fmt.app(name)} does not have a database.`);
  }

  if (options.confirm !== name) {
    if (process.stdin.isTTY) {
      var rl = createInterface({ input: process.stdin, output: process.stderr });
      var answer = await new Promise((resolve) =>
        rl.question(`Type "${name}" to confirm database reset: `, resolve)
      );
      rl.close();
      if (answer.trim() !== name) {
        fatal("Confirmation did not match. Aborting.");
      }
    } else {
      fatal(
        `Resetting database requires confirmation.`,
        `Run: flarepilot db reset ${name} --confirm ${name}`
      );
    }
  }

  phase("Resetting database");
  status("Listing tables...");

  var results = await queryD1(
    config,
    appConfig.dbId,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  );
  var result = Array.isArray(results) ? results[0] : results;
  var tables = (result && result.results) ? result.results.map((r) => r.name) : [];

  if (tables.length === 0) {
    process.stderr.write("No user tables found.\n");
    return;
  }

  for (var t of tables) {
    status(`Dropping ${t}...`);
    await queryD1(config, appConfig.dbId, `DROP TABLE IF EXISTS "${t}"`);
  }

  success(`Dropped ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
}
