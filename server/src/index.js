import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { AppStore } from "./store.js";

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = parsePort(process.env.PORT, 3001);
const host = process.env.HOST || "0.0.0.0";
const store = new AppStore(
  process.env.DATA_FILE || path.join(serverDirectory, "data", "conversations.json"),
);

try {
  await store.initialize();
} catch (error) {
  console.error(`Could not initialize conversation storage: ${error.message}`);
  process.exit(1);
}

const app = createApp({
  store,
  openRouterConfig: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL,
    baseUrl: process.env.OPENROUTER_BASE_URL,
    appUrl: process.env.APP_URL,
    appName: process.env.APP_NAME || "Local AI Prompt Library",
  },
});

app.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
  if (!process.env.OPENROUTER_API_KEY || !process.env.OPENROUTER_MODEL) {
    console.warn("Set OPENROUTER_API_KEY and OPENROUTER_MODEL before sending messages.");
  }
});

function parsePort(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}
