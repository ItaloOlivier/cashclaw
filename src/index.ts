import { startAgent } from "./agent.js";

// Prevent unhandled promise rejections from crashing the server process.
// Log them instead so Railway logs capture the cause without killing the app.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason instanceof Error ? reason.stack : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err.stack ?? err.message);
});

async function main() {
  console.log("Starting CashClaw...");

  const server = await startAgent();

  // Open browser (local dev only — skip on Railway/non-desktop environments)
  if (process.platform === "darwin" || process.platform === "win32") {
    const url = "http://localhost:3777";
    const { execFile: execFileCb } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : "start";
    execFileCb(opener, [url], () => {});
  }

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[startup error]", err instanceof Error ? err.stack : err);
  process.exit(1);
});
