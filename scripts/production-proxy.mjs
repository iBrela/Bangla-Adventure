/** TCP transport from the host's loopback binding to the internal app. */
import net from "node:net";
import { fileURLToPath } from "node:url";

export async function startProductionProxy({
  listenHost = "0.0.0.0", listenPort = 3000,
  targetHost = "app", targetPort = 3000, shutdownTimeoutMs = 5000,
} = {}) {
  if (typeof listenHost !== "string" || !listenHost ||
      !Number.isInteger(listenPort) || listenPort < 0 || listenPort > 65535 ||
      typeof targetHost !== "string" || !targetHost ||
      !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535 ||
      !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 30000) {
    throw new Error("Invalid production proxy configuration.");
  }
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.createConnection({ host: targetHost, port: targetPort, allowHalfOpen: true });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    }
    // Preserve HTTP bytes and forwarded headers exactly; Nginx remains the HTTP proxy.
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.maxConnections = 128;
  await new Promise((resolve, reject) => {
    const failed = (error) => { server.removeListener("listening", listening); reject(error); };
    const listening = () => { server.removeListener("error", failed); resolve(); };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(listenPort, listenHost);
  });
  let closing;
  const close = () => {
    closing ??= new Promise((resolve) => {
      const timer = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, shutdownTimeoutMs);
      timer.unref();
      server.close(() => { clearTimeout(timer); resolve(); });
    });
    return closing;
  };
  return { server, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startProductionProxy().then(({ server, close }) => {
    let closing = false;
    const finish = () => {
      if (!closing) { closing = true; void close().then(() => process.exit(process.exitCode || 0)); }
    };
    process.once("SIGTERM", finish);
    process.once("SIGINT", finish);
    server.on("error", () => { console.error("production proxy: listener failed."); process.exitCode = 1; finish(); });
    console.log("production proxy: listening on container port 3000.");
  }).catch(() => { console.error("production proxy: could not create the TCP listener."); process.exitCode = 1; });
}
