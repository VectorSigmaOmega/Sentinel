import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, join, normalize } from "node:path";

const port = Number(process.env.PORT ?? 4173);
// WSL local dev must bind to 0.0.0.0 so the Windows host browser can reach the web app.
const host = process.env.HOST ?? "0.0.0.0";
const root = fileURLToPath(new URL(".", import.meta.url));

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "").replace(/^[/\\]+/, "");

  try {
    const file = await readFile(join(root, safePath));
    res.writeHead(200, {
      "content-type": contentTypes[extname(safePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(file);
  } catch (error) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Not found: ${pathname}`);
  }
});

server.listen(port, host, () => {
  console.log(`Sentinel web listening on http://${host}:${port}`);
});
