import { buildServer } from './server.js';

const port = Number(process.env.PORT ?? 8080);
// WSL local dev must bind to 0.0.0.0 so the Windows host browser can reach the API.
const host = process.env.HOST ?? '0.0.0.0';

const server = await buildServer();
await server.listen({ host, port });
