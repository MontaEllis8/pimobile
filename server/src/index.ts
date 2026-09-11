import { startServer } from "./server.js";
import { logger } from "./logger.js";

// Start the WebSocket server (SIGINT/SIGTERM handlers are registered in server.ts)
startServer().catch((err) => {
  logger.fatal({ err }, "Failed to start server");
  process.exit(1);
});
