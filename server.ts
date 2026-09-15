import express from "express";
import path from "path";
import { createApi } from "./server/api";
import { createFilePollStore } from "./server/poll-store";
import { rateLimitsFromEnv, trustProxyFromEnv } from "./server/rate-limit";
import { cleanupExpiredPolls, formatCleanupReport } from "./server/retention";

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.POLLS_DATA_FILE || path.join(process.cwd(), "data", "polls.json");
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function startServer() {
  const store = createFilePollStore(DATA_FILE);
  const app = createApi(store, { rateLimit: rateLimitsFromEnv() });
  // Off by default: X-Forwarded-For is only believed behind a configured proxy.
  app.set("trust proxy", trustProxyFromEnv(process.env.TRUST_PROXY));

  // Expired polls are already hidden and dropped on writes; this sweep also
  // removes them from disk when nobody writes. Netlify uses a scheduled function.
  const sweep = () =>
    cleanupExpiredPolls(store)
      .then((report) => (report.removed || report.failed || report.remaining) && console.log(formatCleanupReport(report)))
      .catch((err) => console.error("Poll cleanup failed:", err));
  void sweep();
  setInterval(sweep, CLEANUP_INTERVAL_MS).unref();

  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use("/assets", express.static(path.join(distPath, "assets"), {
      maxAge: "1y",
      immutable: true,
      index: false,
    }));
    app.use(express.static(distPath, {
      setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
    }));
    // Poll navigation uses ?poll= on the root. Unknown paths are not SPA routes.
    app.use((_req, res) => res.status(404).send("Not found"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
