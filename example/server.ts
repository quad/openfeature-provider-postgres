import type { EvaluationContext } from "@openfeature/server-sdk";
import { OpenFeature, ProviderEvents } from "@openfeature/server-sdk";
import express, { type Request, type Response } from "express";
import { PostgresProvider } from "../src/index.ts";
import pg from "pg";
import process from "node:process";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ??
    "postgres://localhost:5432/flags",
});

// Run the idempotent migration at boot
const migration = Deno.readTextFileSync(
  new URL("../migration.sql", import.meta.url),
);
await pool.query(migration);

const provider = new PostgresProvider({ pool });
await OpenFeature.setProviderAndWait(provider);

const client = OpenFeature.getClient();

// SSE: push flag updates to connected browsers
const sseClients = new Set<express.Response>();
client.addHandler(ProviderEvents.ConfigurationChanged, () => {
  for (const res of sseClients) {
    res.write("data: changed\n\n");
  }
});

const app = express();

// Evaluate all demo flags for a given user
async function evaluateFlags(targetingKey?: string) {
  const context: EvaluationContext = targetingKey ? { targetingKey } : {};
  const [darkMode, greeting, maxItems, banner, maintenance] = await Promise.all(
    [
      client.getBooleanDetails("dark-mode", false, context),
      client.getStringDetails("greeting", "Hello", context),
      client.getNumberDetails("max-items", 10, context),
      client.getObjectDetails(
        "banner",
        { text: "Welcome", color: "#000" },
        context,
      ),
      client.getBooleanDetails("maintenance", false, context),
    ],
  );
  return { darkMode, greeting, maxItems, banner, maintenance };
}

// JSON API
app.get("/api/flags", async (req: Request, res: Response) => {
  const flags = await evaluateFlags((req.query.user as string) || undefined);
  res.json(flags);
});

// SSE endpoint
app.get("/events", (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  sseClients.add(res);
  req.on("close", () => sseClients.delete(res));
});

// HTML page
app.get("/", async (req: Request, res: Response) => {
  const user = (req.query.user as string) || undefined;
  const flags = await evaluateFlags(user);
  const banner = flags.banner.value as { text: string; color: string };
  const dark = flags.darkMode.value;

  res.type("html").send(/* html */ `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Feature Flags Demo</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, sans-serif;
      padding: 2rem;
      max-width: 48rem;
      margin: 0 auto;
      background: ${dark ? "#1a1a2e" : "#f8fafc"};
      color: ${dark ? "#e2e8f0" : "#1e293b"};
      transition: background 0.3s, color 0.3s;
    }
    h1 { margin-bottom: 0.5rem; }
    .subtitle { color: ${dark ? "#94a3b8" : "#64748b"}; margin-bottom: 2rem; }
    .banner {
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 2rem;
      color: white;
      background: ${banner.color};
    }
    .flag {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      border-radius: 0.5rem;
      margin-bottom: 0.75rem;
      background: ${dark ? "#16213e" : "#fff"};
      border: 1px solid ${dark ? "#2a2a4a" : "#e2e8f0"};
    }
    .flag-key { font-weight: 600; font-family: monospace; }
    .flag-value { font-family: monospace; }
    .flag-meta { font-size: 0.8rem; color: ${dark ? "#94a3b8" : "#64748b"}; }
    .pill {
      display: inline-block;
      padding: 0.15rem 0.5rem;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .pill-static { background: ${dark ? "#1e3a5f" : "#dbeafe"}; color: ${
    dark ? "#93c5fd" : "#2563eb"
  }; }
    .pill-split { background: ${dark ? "#3b1f2b" : "#fce7f3"}; color: ${
    dark ? "#f9a8d4" : "#db2777"
  }; }
    .pill-disabled { background: ${dark ? "#2a2a2a" : "#f1f5f9"}; color: ${
    dark ? "#666" : "#94a3b8"
  }; }
    .user-form { margin-bottom: 2rem; display: flex; gap: 0.5rem; }
    .user-form input {
      padding: 0.5rem; border-radius: 0.375rem; border: 1px solid ${
    dark ? "#2a2a4a" : "#e2e8f0"
  };
      background: ${dark ? "#16213e" : "#fff"}; color: inherit; flex: 1;
    }
    .user-form button {
      padding: 0.5rem 1rem; border-radius: 0.375rem; border: none;
      background: #4f46e5; color: white; cursor: pointer; font-weight: 600;
    }
    .live-dot {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e; margin-right: 0.5rem; animation: pulse 2s infinite;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  </style>
</head>
<body>
  <h1>Feature Flags Demo</h1>
  <p class="subtitle"><span class="live-dot"></span>Live — updates when flags change in Postgres</p>

  <form class="user-form" method="get">
    <input name="user" placeholder="targeting key (e.g. user-123)" value="${
    user ?? ""
  }" />
    <button type="submit">Evaluate</button>
  </form>

  ${
    flags.maintenance.value
      ? '<div class="banner" style="background:#dc2626">Maintenance mode is ON — this flag is disabled, so it returns the default (false). This banner is just for show.</div>'
      : ""
  }

  <div class="banner">${banner.text}</div>

  ${renderFlag("dark-mode", flags.darkMode)}
  ${renderFlag("greeting", flags.greeting)}
  ${renderFlag("max-items", flags.maxItems)}
  ${renderFlag("banner", flags.banner)}
  ${renderFlag("maintenance", flags.maintenance)}

  <script>
    const es = new EventSource("/events");
    es.onmessage = () => location.reload();
  </script>
</body>
</html>`);
});

function renderFlag(
  key: string,
  details: { value: unknown; variant?: string; reason?: string },
) {
  const reason = details.reason ?? "";
  const pillClass = reason === "DISABLED"
    ? "pill-disabled"
    : reason === "SPLIT"
    ? "pill-split"
    : "pill-static";
  const display = typeof details.value === "object"
    ? JSON.stringify(details.value)
    : String(details.value);

  return `<div class="flag">
    <div>
      <div class="flag-key">${key}</div>
      <div class="flag-meta">variant: ${details.variant ?? "—"}</div>
    </div>
    <div style="text-align:right">
      <div class="flag-value">${display}</div>
      <span class="pill ${pillClass}">${reason}</span>
    </div>
  </div>`;
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  console.log(`Try: http://localhost:${port}?user=user-123`);
});
