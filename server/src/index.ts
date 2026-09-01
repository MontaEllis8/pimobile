import { startServer } from "./server.js";

// Start the WebSocket server (SIGINT/SIGTERM handlers are registered in server.ts)
startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
