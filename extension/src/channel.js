const VERSION = 1;

export class WebbyChannel {
  constructor({baseUrl, extensionId, browserId, onChallenge, onReady, onEvent, replyTimeoutMs = 10_000}) {
    this.baseUrl = baseUrl;
    this.extensionId = extensionId;
    this.browserId = browserId;
    this.onChallenge = onChallenge;
    this.onReady = onReady;
    this.onEvent = onEvent;
    this.replyTimeoutMs = replyTimeoutMs;
    this.ref = 0;
    this.pending = new Map();
  }

  connect() {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // A browser may remain intentionally unpaired, so a failed initial join can
    // precede any caller awaiting readiness. Keep that expected failure handled;
    // callers awaiting the original promise still receive the rejection.
    this.ready.catch(() => {});
    const url = new URL("/browser/websocket", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("vsn", "2.0.0");
    url.searchParams.set("extension_id", this.extensionId);
    if (this.browserId) url.searchParams.set("browser_id", this.browserId);
    this.socket = new WebSocket(url);
    this.socket.onmessage = (event) => this.receive(JSON.parse(event.data));
    this.socket.onopen = () => this.join();
    this.socket.onclose = () => {
      this.rejectPending(new Error("channel_disconnected"));
      this.scheduleReconnect();
    };
  }

  join() {
    const topic = this.browserId ? "browser:auth" : `browser:pairing:${this.extensionId}`;
    this.topic = topic;
    this.sendFrame("phx_join", this.browserId ? {browser_id: this.browserId} : {})
      .then(async (reply) => {
        const challenge = reply;
        if (challenge?.type === "auth.challenge") await this.onChallenge(challenge.payload);
        this.resolveReady();
        this.startHeartbeat();
        this.onReady?.();
      })
      .catch((reason) => {
        this.rejectReady(reason);
        this.socket.close();
      });
  }

  async message(type, payload) {
    await this.ready;
    return this.messageNow(type, payload);
  }

  messageNow(type, payload) {
    return this.sendFrame("message", {
      protocol_version: VERSION,
      type,
      request_id: crypto.randomUUID(),
      browser_id: this.browserId,
      sent_at: new Date().toISOString(),
      payload
    });
  }

  receive([_joinRef, ref, _topic, event, payload]) {
    if (event === "phx_reply" && this.pending.has(ref)) {
      const {resolve, reject, timeout} = this.pending.get(ref);
      this.pending.delete(ref);
      clearTimeout(timeout);
      payload.status === "ok" ? resolve(payload.response) : reject(payload.response);
    } else if (event === "message") {
      this.onEvent?.(payload);
    }
  }

  close() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.socket.onclose = null;
    this.rejectPending(new Error("channel_closed"));
    this.socket.close();
  }

  rejectPending(reason) {
    for (const {reject, timeout} of this.pending.values()) {
      clearTimeout(timeout);
      reject(reason);
    }
    this.pending.clear();
  }

  sendFrame(event, payload) {
    const ref = String(++this.ref);
    if (event === "phx_join") this.joinRef = ref;
    this.socket.send(JSON.stringify([this.joinRef, ref, this.topic, event, payload]));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error("channel_reply_timeout"));
      }, this.replyTimeoutMs);
      this.pending.set(ref, {resolve, reject, timeout});
    });
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.socket.readyState !== WebSocket.OPEN) return;
      const ref = String(++this.ref);
      this.socket.send(JSON.stringify([null, ref, "phoenix", "heartbeat", {}]));
    }, 25_000);
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), 2000);
  }
}
