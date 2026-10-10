import { createRequestHandler } from "@react-router/express";
import express from "express";
import { createProxyMiddleware } from "http-proxy-middleware";

const PORT = Number(process.env.PORT) || 8080;
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";

const app = express();
app.disable("x-powered-by");

// pathFilter keeps the /api prefix, which the backend routes expect.
app.use(
  createProxyMiddleware({
    target: BACKEND_URL,
    changeOrigin: true,
    pathFilter: "/api",
  }),
);

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));

app.use(
  createRequestHandler({
    build: () => import("./build/server/index.js"),
  }),
);

app.listen(PORT, () => console.log(`Listening on :${PORT}, proxying /api to ${BACKEND_URL}`));
