import express from "express";
import path from "path";
import { createApi } from "./server/api";

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.POLLS_DATA_FILE || path.join(process.cwd(), "data", "polls.json");

async function startServer() {
  const app = createApi(DATA_FILE);

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
