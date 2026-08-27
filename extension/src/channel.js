const VERSION = 1;

/** @typedef {{resolve: (value: any) => void, reject: (reason?: any) => void, timeout: ReturnType<typeof setTimeout>}} Pending */

export class WebbyChannel {
  /**
   * @param {object} options
   * @param {string} options.baseUrl
   * @param {string} options.extensionId
   * @param {string} [options.browserId]
   * @param {(payload: any) => Promise<void> | void} options.onChallenge
   * @param {() => void} [options.onReady]
   * @param {(payload: any) => Promise<void> | void} [options.onEvent]
   * @param {(error: unknown, payload?: unknown) => void} [options.onError]
   * @param {number} [options.replyTimeoutMs]
   */
  constructor({baseUrl, extensionId, browserId, onChallenge, onReady, onEvent, onError = reportChannelError, replyTimeoutMs = 10_000}) {
    this.baseUrl = baseUrl;
    this.extensionId = extensionId;
    this.browserId = browserId;
    this.onChallenge = onChallenge;
    this.onReady = onReady;
    this.onEvent = onEvent;
    this.onError = onError;
    this.replyTimeoutMs = replyTimeoutMs;
    this.ref = 0;
    /** @type {Map<string, Pending>} */
    this.pending = new Map();
    /** @type {WebSocket} */
    this.socket;
    /** @type {(value?: any) => void} */
    this.resolveReady = () => {};
    /** @type {(reason?: any) => void} */
    this.rejectReady = () => {};
    /** @type {string} */
    this.topic = "";
    /** @type {string | undefined} */
    this.joinRef = undefined;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    this.reconnectTimer = undefined;
    /** @type {ReturnType<typeof setInterval> | undefined} */
    this.heartbeatTimer = undefined;
    /** @type {Promise<void> | undefined} */
    this.ready = undefined;
  }

  connect() {
    this.ready = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    }));
    // A browser may remain intentionally unpaired, so a failed initial join can
    // precede any caller awaiting readiness. Keep that expected failure handled;
    // callers awaiting the original promise still receive the rejection.
    this.ready.catch(() => {});
    const url = new URL("/browser/websocket", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("vsn", "2.0.0");
    url.searchParams.set("extension_id", this.extensionId);
    if (this.browserId) url.searchParams.set("browser_id", this.browserId);
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      let frame;
      try {
        frame = JSON.parse(event.data);
      } catch (error) {
        this.onError(error, {kind: "invalid_json", data: event.data});
        return;
      }
      this.receive(frame);
    };
    socket.onopen = () => {
      if (this.socket === socket) this.join(socket);
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.rejectReady(new Error("channel_disconnected"));
      this.rejectPending(new Error("channel_disconnected"));
      this.scheduleReconnect();
    };
  }

  /** @param {WebSocket} [socket] */
  join(socket = this.socket) {
    const topic = this.browserId ? "browser:auth" : `browser:pairing:${this.extensionId}`;
    this.topic = topic;
    this.sendFrame("phx_join", this.browserId ? {browser_id: this.browserId} : {})
      .then(async (reply) => {
        if (this.socket !== socket) throw new Error("stale_socket");
        const challenge = reply;
        if (challenge?.type === "auth.challenge") await this.onChallenge(challenge.payload);
        if (this.socket !== socket) throw new Error("stale_socket");
        this.resolveReady();
        this.startHeartbeat();
        Promise.resolve(this.onReady?.()).catch((error) => {
          if (this.socket !== socket) return;
          this.onError(error, {kind: "ready_reconciliation_failed"});
          socket.close();
        });
      })
      .catch((reason) => {
        if (this.socket !== socket) return;
        this.rejectReady(reason);
        socket.close();
      });
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   */
  async message(type, payload) {
    await this.ready;
    return this.messageNow(type, payload);
  }

  /**
   * @param {string} type
   * @param {unknown} payload
   */
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

  /** @param {unknown} frame */
  receive(frame) {
    if (!Array.isArray(frame) || frame.length !== 5) {
      this.onError(new Error("malformed_channel_frame"), {kind: "invalid_frame", frame});
      return;
    }
    const [_joinRef, ref, topic, event, payload] = frame;
    if ((ref !== null && typeof ref !== "string") || typeof topic !== "string" || typeof event !== "string") {
      this.onError(new Error("malformed_channel_frame"), {kind: "invalid_frame", frame});
      return;
    }
    if (topic !== this.topic && topic !== "phoenix") {
      this.onError(new Error("unexpected_channel_topic"), {kind: "invalid_frame", topic});
      return;
    }
    const entry = this.pending.get(ref);
    if (event === "phx_reply" && entry) {
      const {resolve, reject, timeout} = entry;
      this.pending.delete(ref);
      clearTimeout(timeout);
      if (!payload || typeof payload !== "object" || !["ok", "error"].includes(payload.status)) {
        reject(new Error("malformed_channel_reply"));
      } else {
        payload.status === "ok" ? resolve(payload.response) : reject(payload.response);
      }
    } else if (event === "message") {
      Promise.resolve(this.onEvent?.(payload)).catch((error) => this.onError(error, payload));
    }
  }

  close() {
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.socket.onclose = null;
    this.rejectPending(new Error("channel_closed"));
    this.socket.close();
  }

  /**
   * @param {Error} reason
   */
  rejectPending(reason) {
    for (const {reject, timeout} of this.pending.values()) {
      clearTimeout(timeout);
      reject(reason);
    }
    this.pending.clear();
  }

  /**
   * @param {string} event
   * @param {unknown} payload
   * @returns {Promise<any>}
   */
  sendFrame(event, payload) {
    if (!this.socket || (typeof this.socket.readyState === "number" && this.socket.readyState !== WebSocket.OPEN)) {
      return Promise.reject(new Error("channel_not_ready"));
    }
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

/**
 * Event handlers run outside the socket frame callback, so a rejected handler
 * must be surfaced explicitly or Chrome silently loses the failure.
 * @param {unknown} error
 * @param {unknown} payload
 */
function reportChannelError(error, payload) {
  const envelope = /** @type {{payload?: {call_id?: unknown}} | undefined} */ (
    payload && typeof payload === "object" ? payload : undefined
  );
  const callId = typeof envelope?.payload?.call_id === "string"
    ? envelope.payload.call_id
    : undefined;
  console.error("Webby channel event failed", {callId, error});
}
