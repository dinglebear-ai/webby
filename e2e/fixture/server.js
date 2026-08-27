import http from "node:http";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {randomUUID} from "node:crypto";
import {FixtureControl, controlError, parseJson} from "./control.js";

const root = dirname(fileURLToPath(import.meta.url));
const pages = new Map([
  ["/", "pages/index.html"], ["/dynamic", "pages/dynamic.html"], ["/navigation", "pages/navigation.html"]
]);

export async function startFixtureServer({worldId, port = 0, hostname = "127.0.0.1", capabilityTtlMs, now} = {}) {
  if (!worldId || !/^[A-Za-z0-9_-]{8,80}$/.test(worldId)) throw new Error("invalid_world_id");
  let control;
  const server = http.createServer(async (request, response) => {
    try { await route(request, response, control); }
    catch (error) { sendJson(response, error.status ?? 500, {error: error.kind ?? "internal_error"}); }
  });
  server.on("clientError", (_error, socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, hostname, resolve); });
  const address = server.address();
  const host = `${hostname}:${address.port}`;
  const origin = `http://${host}`;
  control = new FixtureControl({worldId, host, origin, capabilityTtlMs, now});
  return {
    origin, capability: control.capability, control,
    async close() { control.disconnect(); await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  };
}

async function route(request, response, control) {
  const url = new URL(request.url, control.origin);
  if (pages.has(url.pathname)) {
    if (request.method !== "GET") throw controlError("method_not_allowed", 405);
    const html = (await readFile(join(root, pages.get(url.pathname)), "utf8"))
      .replace("__DOCUMENT_INSTANCE__", randomUUID());
    response.writeHead(200, {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"});
    return response.end(html);
  }
  if (url.pathname === "/webmcp-fixture.js") {
    if (request.method !== "GET") throw controlError("method_not_allowed", 405);
    const source = await readFile(join(root, "webmcp-fixture.js"), "utf8");
    response.writeHead(200, {"content-type": "text/javascript; charset=utf-8", "cache-control": "no-store"});
    return response.end(source);
  }
  if (url.pathname === "/__fixture/capabilities") {
    if (request.method !== "GET") throw controlError("method_not_allowed", 405);
    return sendJson(response, 200, capabilityProbe());
  }
  if (url.pathname === "/__fixture/wait") {
    if (request.method !== "GET") throw controlError("method_not_allowed", 405);
    if (request.headers.host !== control.host) throw controlError("invalid_host", 421);
    if (request.headers["sec-fetch-site"] !== "same-origin") throw controlError("invalid_page_context", 403);
    control.admitWaitRequest();
    const scenarioId = validPart(url.searchParams.get("scenario_id"));
    const callId = validPart(url.searchParams.get("call_id"));
    const handle = control.handle(`${scenarioId}:${callId}`);
    control.record("page.wait", {scenario_id: scenarioId, call_id: callId,
      request: {method: request.method, path: url.pathname}});
    const wait = control.openWait(handle);
    const cancel = () => wait.cancel("waiter_disconnected");
    request.once("aborted", cancel); response.once("close", cancel);
    try {
      const state = await wait.promise;
      return sendJson(response, 200, {state, scenario_id: scenarioId, call_id: callId});
    } finally {
      request.off("aborted", cancel); response.off("close", cancel);
      wait.cancel("waiter_response_complete");
    }
  }
  if (!url.pathname.startsWith("/__control/")) throw controlError("not_found", 404);
  const json = request.method === "POST";
  const denied = control.authorize(request, {json});
  if (denied) return sendJson(response, denied.status, {error: denied.kind});
  control.begin();
  try {
    if (url.pathname === "/__control/events" && request.method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0);
      return sendJson(response, 200, control.snapshot(Number.isSafeInteger(after) && after >= 0 ? after : 0));
    }
    if (url.pathname !== "/__control/action" || request.method !== "POST") throw controlError("method_not_allowed", 405);
    const body = await readBody(request);
    const input = parseJson(body);
    const deniedNonce = control.acceptNonce(input.nonce);
    if (deniedNonce) return sendJson(response, deniedNonce.status, {error: deniedNonce.kind});
    control.record("control.request", {scenario_id: input.scenario_id ?? null, call_id: input.call_id ?? null,
      request: {method: request.method, path: url.pathname}, action: input.action});
    const result = action(control, input);
    return sendJson(response, 200, {ok: true, ...result});
  } finally { control.end(); }
}

function action(control, input) {
  switch (input.action) {
    case "barrier.create": return {handle: control.createBarrier(`${validPart(input.scenario_id)}:${validPart(input.call_id ?? input.id)}`)};
    case "barrier.release": control.settleBarrier(input.handle, "released"); return {};
    case "barrier.abort": control.settleBarrier(input.handle, "aborted"); return {};
    case "event.record": return {event: control.record(input.type, {handle: input.handle && control.assertHandle(input.handle), value: input.value})};
    default: throw controlError("unknown_action");
  }
}

function validPart(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw controlError("invalid_correlation_id");
  return value;
}

function capabilityProbe() {
  return {
    version: 1,
    status: "requires_browser",
    required: ["document.modelContext", "chrome.scripting.documentIds", "MAIN_world_execution"],
    failure: "fixture_browser_capability_unavailable",
    browser_probe: {
      context_expression: "typeof document.modelContext?.getTools === 'function' && typeof document.modelContext?.executeTool === 'function'",
      document_id_source: "chrome.scripting.executeScript result documentId",
      world: "MAIN"
    }
  };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let rejected = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        if (!rejected) { rejected = true; reject(controlError("body_too_large", 413)); }
      } else if (!rejected) chunks.push(chunk);
    });
    request.on("end", () => { if (!rejected) resolve(Buffer.concat(chunks)); });
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"});
  response.end(JSON.stringify(value));
}
