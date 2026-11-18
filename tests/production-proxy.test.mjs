import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { once } from "node:events";
import { startProductionProxy } from "../scripts/production-proxy.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

test("production proxy rejects invalid configuration", async () => {
  for (const options of [{ listenPort: -1 }, { listenPort: 65536 }, { targetPort: 0 },
    { targetHost: "" }, { listenHost: null }, { shutdownTimeoutMs: 0 }]) {
    await assert.rejects(startProductionProxy(options), /Invalid production proxy configuration/);
  }
});

test("real TCP transport preserves request bytes, forwarded headers and response", { timeout: 5000 }, async (t) => {
  let seen = "";
  const upstream = net.createServer((connection) => {
    connection.on("data", (chunk) => {
      seen += chunk.toString();
      if (seen.endsWith("hello")) connection.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
    });
  });
  const targetPort = await listen(upstream);
  const proxy = await startProductionProxy({ listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort });
  t.after(async () => { await proxy.close(); await new Promise((resolve) => upstream.close(resolve)); });
  const client = net.createConnection(proxy.server.address().port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  let received = "";
  client.on("data", (chunk) => { received += chunk.toString(); });
  const ended = once(client, "end");
  const request = "POST /api/example HTTP/1.1\r\nHost: banglaadventure.com\r\nOrigin: https://banglaadventure.com\r\nX-Forwarded-Proto: https\r\nX-Forwarded-For: 192.0.2.10\r\nContent-Length: 5\r\n\r\nhello";
  client.write(request);
  await ended;
  assert.equal(seen, request);
  assert.equal(received, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK");
});

test("unreachable upstream closes the client without crashing the listener", { timeout: 5000 }, async (t) => {
  const unused = net.createServer();
  const targetPort = await listen(unused);
  await new Promise((resolve) => unused.close(resolve));
  const proxy = await startProductionProxy({ listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort });
  t.after(() => proxy.close());
  const client = net.createConnection(proxy.server.address().port, "127.0.0.1");
  client.on("error", () => {});
  await once(client, "close");
  assert.ok(proxy.server.listening);
});

test("shutdown stops accepting and bounds active connections; repeated close is safe", { timeout: 5000 }, async (t) => {
  const upstreamClients = new Set();
  const upstream = net.createServer((socket) => {
    upstreamClients.add(socket);
    socket.once("close", () => upstreamClients.delete(socket));
  });
  const targetPort = await listen(upstream);
  const proxy = await startProductionProxy({ listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort, shutdownTimeoutMs: 30 });
  t.after(async () => {
    await proxy.close();
    for (const socket of upstreamClients) socket.destroy();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const client = net.createConnection(proxy.server.address().port, "127.0.0.1");
  t.after(() => client.destroy());
  await once(client, "connect");
  const clientClosed = once(client, "close");
  const closed = proxy.close();
  assert.equal(proxy.server.listening, false);
  assert.equal(proxy.close(), closed);
  await closed;
  await clientClosed;
  await proxy.close();
});
