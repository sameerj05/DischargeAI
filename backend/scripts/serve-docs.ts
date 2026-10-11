import { readFileSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";

// Documentation can be inspected before AWS/RDS connectivity is available.
const spec = YAML.parse(readFileSync(join(import.meta.dirname, "..", "openapi.yaml"), "utf8"));
spec.servers = [{ url: process.env.SWAGGER_API_URL || "http://localhost:4000/api" }];
const app = express();
app.disable("x-powered-by");
app.get("/openapi.json", (_req, res) => res.json(spec));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
app.get("/", (_req, res) => res.redirect("/docs/"));
const port = Number(process.env.DOCS_PORT || 4001);
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Swagger: http://localhost:${port}/docs/ (API target: ${spec.servers[0].url})`);
});
process.on("SIGINT", () => server.close());
process.on("SIGTERM", () => server.close());
