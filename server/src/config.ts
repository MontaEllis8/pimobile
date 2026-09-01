import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "8787", 10),
  host: process.env.HOST || "0.0.0.0",
  authToken: process.env.AUTH_TOKEN || "",
};
