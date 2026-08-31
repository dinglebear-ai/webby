import {randomBytes, timingSafeEqual} from "node:crypto";

const LIMITS = Object.freeze({bodyBytes: 64 * 1024, depth: 16, concurrency: 16, history: 2048, barriers: 256,
  rate: 240, waitRate: 240, waits: 128, waitersPerBarrier: 1, waitTimeoutMs: 30_000});

export class FixtureControl {
  constructor({worldId, host, origin, capabilityTtlMs = 15 * 60_000, now = () => Date.now()}) {
    this.worldId = worldId;
    this.host = host;
    this.origin = origin;
    this.capability = randomBytes(32).toString("base64url");
    this.expiresAt = now() + capabilityTtlMs;
    this.now = now;
    this.sequence = 0;
    this.active = 0;
    this.events = [];
    this.barriers = new Map();
    this.nonces = new Set();
    this.rateWindow = [];
    this.waitRateWindow = [];
    this.activeWaits = 0;
  }

  authorize(request, {json = false} = {}) {
    if (request.headers.host !== this.host) return failure(421, "invalid_host");
    if (request.headers.origin !== this.origin) return failure(403, "invalid_origin");
    if (json && request.headers["content-type"] !== "application/json") return failure(415, "invalid_content_type");
    if (this.now() >= this.expiresAt) return failure(401, "expired_capability");
    const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
    const expected = Buffer.from(this.capability);
    const actual = Buffer.from(supplied);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return failure(401, "invalid_capability");
    this.rateWindow = this.rateWindow.filter((at) => at > this.now() - 1000);
    if (this.rateWindow.length >= LIMITS.rate) return failure(429, "rate_limited");
    if (this.active >= LIMITS.concurrency) return failure(429, "too_many_requests");
    this.rateWindow.push(this.now());
    return null;
  }

  begin() { this.active += 1; }
  end() { this.active = Math.max(0, this.active - 1); }

  acceptNonce(nonce) {
    if (typeof nonce !== "string" || nonce.length < 16 || nonce.length > 128) return failure(400, "invalid_nonce");
    if (this.nonces.has(nonce)) return failure(409, "replayed_request");
    this.nonces.add(nonce);
    if (this.nonces.size > LIMITS.history) this.nonces.delete(this.nonces.values().next().value);
    return null;
  }

  handle(localId) {
    if (typeof localId !== "string" || !/^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{1,64}$/.test(localId)) throw controlError("invalid_handle");
    return `${this.worldId}:${localId}`;
  }

  assertHandle(handle) {
    if (typeof handle !== "string" || !handle.startsWith(`${this.worldId}:`)) throw controlError("cross_world_handle");
    return handle;
  }

  createBarrier(localId) {
    const handle = this.handle(localId);
    if (this.barriers.has(handle)) throw controlError("duplicate_handle");
    if (this.barriers.size >= LIMITS.barriers) throw controlError("barrier_capacity");
    this.barriers.set(handle, {state: "pending", waiters: new Set()});
    this.record("barrier.created", correlation(handle));
    return handle;
  }

  openWait(handle, {timeoutMs = LIMITS.waitTimeoutMs} = {}) {
    this.assertHandle(handle);
    const barrier = this.barriers.get(handle);
    if (!barrier || barrier.state !== "pending") throw controlError("unknown_or_stale_handle");
    if (this.activeWaits >= LIMITS.waits) throw controlError("too_many_waits", 429);
    if (barrier.waiters.size >= LIMITS.waitersPerBarrier) throw controlError("barrier_waiter_capacity", 429);
    this.activeWaits += 1;
    let settle;
    const promise = new Promise((resolve, reject) => { settle = {resolve, reject}; });
    const waiter = {finished: false};
    const finish = (outcome, value) => {
      if (waiter.finished) return;
      waiter.finished = true; clearTimeout(waiter.timer); barrier.waiters.delete(waiter);
      this.activeWaits = Math.max(0, this.activeWaits - 1);
      this.record("wait.closed", {...correlation(handle), reason: value});
      outcome === "resolve" ? settle.resolve(value) : settle.reject(controlError(value, value === "waiter_timeout" ? 504 : 499));
    };
    waiter.resolve = (state) => finish("resolve", state);
    waiter.cancel = (reason = "waiter_cancelled") => finish("reject", reason);
    waiter.timer = setTimeout(() => waiter.cancel("waiter_timeout"), timeoutMs);
    barrier.waiters.add(waiter);
    this.record("wait.opened", correlation(handle));
    return {promise, cancel: waiter.cancel};
  }

  admitWaitRequest() {
    this.waitRateWindow = this.waitRateWindow.filter((at) => at > this.now() - 1000);
    if (this.waitRateWindow.length >= LIMITS.waitRate) throw controlError("wait_rate_limited", 429);
    this.waitRateWindow.push(this.now());
  }

  waitBarrier(handle, options) { return this.openWait(handle, options).promise; }

  settleBarrier(handle, state) {
    this.assertHandle(handle);
    const barrier = this.barriers.get(handle);
    if (!barrier) throw controlError("unknown_or_stale_handle");
    if (barrier.state !== "pending") throw controlError("stale_handle");
    barrier.state = state;
    this.barriers.delete(handle);
    this.record(`barrier.${state}`, correlation(handle));
    for (const waiter of [...barrier.waiters]) waiter.resolve(state);
  }

  record(type, detail = {}) {
    const event = {sequence: ++this.sequence, type, ...detail};
    this.events.push(event);
    if (this.events.length > LIMITS.history) this.events.shift();
    return event;
  }

  snapshot(after = 0) {
    return {world_id: this.worldId, latest_sequence: this.sequence, pending_barriers: this.barriers.size,
      events: this.events.filter((event) => event.sequence > after)};
  }

  disconnect() {
    for (const handle of [...this.barriers.keys()]) {
      this.settleBarrier(handle, "aborted");
      this.events[this.events.length - 1].reason = "controller_disconnected";
    }
  }
}

function correlation(handle) {
  const [_world, scenarioId, ...callParts] = handle.split(":");
  return {handle, scenario_id: scenarioId ?? null, call_id: callParts.join(":") || null};
}

export function parseJson(body) {
  if (body.length > LIMITS.bodyBytes) throw controlError("body_too_large", 413);
  const value = JSON.parse(body.toString("utf8"));
  if (jsonDepth(value) > LIMITS.depth) throw controlError("json_too_deep");
  return value;
}

export const fixtureLimits = LIMITS;

function jsonDepth(value, depth = 0) {
  if (!value || typeof value !== "object") return depth;
  return Math.max(depth, ...Object.values(value).map((entry) => jsonDepth(entry, depth + 1)));
}

export function controlError(kind, status = 400) { return Object.assign(new Error(kind), {kind, status}); }
export function failure(status, kind) { return {status, kind}; }
