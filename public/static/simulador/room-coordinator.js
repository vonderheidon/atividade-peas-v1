// @ts-check
(function registerRoomCoordinator() {
'use strict';

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {{
 * identity_id: string,
 * identity_generation: number,
 * operation_id: string,
 * payload_hash: string,
 * base_revision: number,
 * new_revision: number,
 * operation: string,
 * status?: string,
 * attempts?: number,
 * response?: unknown,
 * enqueued_at?: number,
 * payload?: unknown,
 * path?: string,
 * }} OperationRecord */
/** @typedef {{ identity_id: string, identity_generation: number, revision: number, [key: string]: unknown }} RoomSnapshot */
/** @typedef {{
 * getRoom: (identityId: string, identityGeneration?: number) => Promise<RoomSnapshot | null>,
 * getLease: (identityId: string) => Promise<JsonRecord | null>,
 * claimLease: (identityId: string, generation: number, ownerId: string, now: number, ttlMs: number) => Promise<{ acquired: boolean, lease: JsonRecord | null }>,
 * releaseLease: (identityId: string, generation: number, ownerId: string, epoch: number, now: number) => Promise<boolean>,
 * getOperation: (identityId: string, operationId: string) => Promise<OperationRecord | null>,
 * getOperationsByStatus: (status: string) => Promise<OperationRecord[]>,
 * putOperation: (operation: OperationRecord) => Promise<void>,
 * commitOperation: (input: JsonRecord) => Promise<{ status: string, snapshot?: RoomSnapshot, operation?: OperationRecord, error?: Error }>,
 * }} RoomStoreLike */
/** @typedef {{ postMessage: (message: JsonRecord) => void, close?: () => void, onmessage?: ((event: { data: unknown }) => void) | null, addEventListener?: (type: string, listener: (event: { data: unknown }) => void) => void, removeEventListener?: (type: string, listener: (event: { data: unknown }) => void) => void }} RoomChannel */
/** @typedef {{ record: OperationRecord, payload?: unknown, path?: string }} EnqueueInput */
/** @typedef {{ operation: OperationRecord, payload: unknown, path: string, resolvers: Array<{ resolve: (value: unknown) => void, reject: (error: Error) => void }>, retryTimer: number | null, order: number }} QueueEntry */
/** @typedef {(operation: OperationRecord, payload: unknown, snapshot: RoomSnapshot) => Promise<{ operation: OperationRecord, payload: unknown }> | { operation: OperationRecord, payload: unknown }} RebaseOperation */

const LEASE_TTL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_RETRY_DELAY_MS = 1000;
const TIMEOUT_RESULT = Symbol('timeout');

/** Error raised when a coordinator input or persisted operation is inconsistent. */
class RoomCoordinatorError extends Error {
  /** @type {unknown} */
  response;

  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'room_coordinator_error') {
    super(message);
    this.name = 'RoomCoordinatorError';
    this.code = code;
  }
}

/** @param {unknown} value @returns {value is JsonRecord} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} response @returns {number | null} */
function responseRevision(response) {
  if (!isRecord(response)) return null;
  if (isNonNegativeInteger(response.new_revision)) return response.new_revision;
  if (isNonNegativeInteger(response.revision)) return response.revision;
  if (isRecord(response.snapshot) && isNonNegativeInteger(response.snapshot.revision)) {
    return response.snapshot.revision;
  }
  return null;
}

/**
 * Coordinates one identity's BroadcastChannel, lease, and FIFO operation queue.
 * @example const coordinator = new RoomCoordinator({ roomStore, identityId, identityGeneration, BroadcastChannel });
 */
class RoomCoordinator {
  /** @type {RoomStoreLike} */
  roomStore;
  /** @type {string} */
  identityId;
  /** @type {number} */
  identityGeneration;
  /** @type {string} */
  tabId;
  /** @type {() => number} */
  now;
  /** @type {(callback: () => void, delay: number) => number} */
  setTimeout;
  /** @type {(handle: number) => void} */
  clearTimeout;
  /** @type {(callback: () => void, delay: number) => number} */
  setInterval;
  /** @type {(handle: number) => void} */
  clearInterval;
  /** @type {(operation: OperationRecord, payload: unknown, path: string) => Promise<unknown> | unknown} */
  sendRequest;
  /** @type {(response: unknown, operation: OperationRecord, current: RoomSnapshot) => RoomSnapshot | null} */
  snapshotFromResponse;
  /** @type {RebaseOperation | null} */
  rebaseOperation;
  /** @type {(event: JsonRecord) => void} */
  onState;
  /** @type {number} */
  requestTimeoutMs;
  /** @type {number} */
  retryDelayMs;
  /** @type {RoomChannel | null} */
  channel = null;
  /** @type {RoomSnapshot | null} */
  snapshot = null;
  /** @type {JsonRecord | null} */
  lease = null;
  /** @type {Map<string, QueueEntry[]>} */
  queues = new Map();
  /** @type {Map<string, QueueEntry>} */
  pending = new Map();
  /** @type {Map<string, Set<string>>} */
  aliases = new Map();
  /** @type {QueueEntry | null} */
  inFlight = null;
  /** @type {number | null} */
  heartbeatTimer = null;
  /** @type {boolean} */
  started = false;
  /** @type {boolean} */
  disposed = false;
  /** @type {Promise<void> | null} */
  heartbeatPromise = null;
  /** @type {Promise<void> | null} */
  drainPromise = null;
  /** @type {Promise<void>} */
  messageQueue = Promise.resolve();
  /** @type {number} */
  nextOrder = 0;
  /** @type {(event: { data: unknown }) => void} */
  messageListener;

  /**
   * @param {{ roomStore: RoomStoreLike, identityId: string, identityGeneration: number,
   *   BroadcastChannel?: new (name: string) => RoomChannel, channelFactory?: (name: string) => RoomChannel,
   *   tabId?: string, now?: () => number, setTimeout?: (callback: () => void, delay: number) => number,
   *   clearTimeout?: (handle: number) => void, setInterval?: (callback: () => void, delay: number) => number,
   *   clearInterval?: (handle: number) => void,
   *   sendRequest?: (operation: OperationRecord, payload: unknown, path: string) => Promise<unknown> | unknown,
   *   snapshotFromResponse?: (response: unknown, operation: OperationRecord, current: RoomSnapshot) => RoomSnapshot | null,
   *   rebaseOperation?: RebaseOperation,
   *   onState?: (event: JsonRecord) => void, requestTimeoutMs?: number, retryDelayMs?: number }} options
   * @throws {TypeError} when required identity, persistence, or channel dependencies are missing.
   */
  constructor(options) {
    if (!options || !options.roomStore
      || typeof options.identityId !== 'string' || options.identityId.length === 0
      || !isNonNegativeInteger(options.identityGeneration)) {
      throw new TypeError('RoomCoordinator requires a store, identity_id, and identity_generation.');
    }
    this.roomStore = options.roomStore;
    this.identityId = options.identityId;
    this.identityGeneration = options.identityGeneration;
    const root = /** @type {typeof globalThis & { BroadcastChannel?: new (name: string) => RoomChannel }} */ (globalThis);
    const Channel = options.BroadcastChannel ?? root.BroadcastChannel;
    if (!options.channelFactory && !Channel) {
      throw new TypeError('RoomCoordinator requires an injected BroadcastChannel.');
    }
    if (typeof options.now !== 'function' && typeof Date.now !== 'function') {
      throw new TypeError('RoomCoordinator requires a clock.');
    }
    this.now = options.now ?? Date.now;
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.setInterval = options.setInterval ?? globalThis.setInterval.bind(globalThis);
    this.clearInterval = options.clearInterval ?? globalThis.clearInterval.bind(globalThis);
    this.sendRequest = options.sendRequest ?? (() => {
      throw new RoomCoordinatorError('No request transport was configured.', 'transport_unavailable');
    });
    this.snapshotFromResponse = options.snapshotFromResponse
      ?? ((response) => isRecord(response) && isRecord(response.snapshot)
        ? /** @type {RoomSnapshot} */ (response.snapshot) : null);
    this.rebaseOperation = options.rebaseOperation ?? null;
    this.onState = options.onState ?? (() => {});
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs <= 0
      || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 0) {
      throw new TypeError('Coordinator timeout values must be valid millisecond durations.');
    }
    this.tabId = options.tabId ?? this.#createTabId();
    if (this.tabId.length === 0) throw new TypeError('tabId must be a non-empty string.');
    this.messageListener = (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.#handleMessage(event.data))
        .catch((error) => this.#emit({ type: 'error', error: this.#errorMessage(error) }));
    };
    this.channelFactory = options.channelFactory ?? ((name) => new /** @type {new (name: string) => RoomChannel} */ (Channel)(name));
    this.queues.set(this.identityId, []);
  }

  /** @type {(name: string) => RoomChannel} */
  channelFactory;

  /** @returns {string} */
  #createTabId() {
    const cryptoRef = globalThis.crypto;
    if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
    if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
      throw new RoomCoordinatorError('Secure randomness is required for tab_id.', 'crypto_unavailable');
    }
    const bytes = new Uint8Array(16);
    cryptoRef.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Opens the identity channel, announces the local snapshot, recovers pending work, and starts heartbeats.
   * @returns {Promise<this>}
   * @throws {RoomCoordinatorError | Error} when the stored room cannot be loaded.
   */
  async start() {
    if (this.started) return this;
    if (this.disposed) throw new RoomCoordinatorError('A disposed coordinator cannot be restarted.', 'disposed');
    let snapshot;
    try {
      snapshot = await this.roomStore.getRoom(this.identityId, this.identityGeneration);
    } catch (error) {
      if (isRecord(error) && error.code === 'identity_mismatch') {
        this.#emit({ type: 'identity_mismatch', reason: 'stored_generation', error: this.#errorMessage(error) });
      }
      throw error;
    }
    if (!snapshot) throw new RoomCoordinatorError('No snapshot exists for the coordinator identity.', 'room_not_found');
    this.snapshot = snapshot;
    this.lease = await this.roomStore.getLease(this.identityId);
    this.channel = this.channelFactory(`peas-room:${this.identityId}`);
    if (typeof this.channel.addEventListener === 'function') {
      this.channel.addEventListener('message', this.messageListener);
    } else {
      this.channel.onmessage = this.messageListener;
    }
    this.started = true;
    this.#announce();
    await this.#recoverOperations();
    await this.#heartbeat();
    this.heartbeatTimer = this.setInterval(() => {
      void this.#heartbeat().catch((error) => this.#emit({ type: 'error', error: this.#errorMessage(error) }));
    }, HEARTBEAT_INTERVAL_MS);
    void this.#drain();
    return this;
  }

  /**
   * Adds an operation to this identity's FIFO queue. The operation record is persisted before announcement.
   * @param {EnqueueInput} input
   * @returns {Promise<unknown>} resolves after the accepted response and snapshot are persisted.
   * @throws {RoomCoordinatorError} when the operation does not match this identity or duplicates an ID with a different hash.
   */
  async enqueue(input) {
    if (!this.started || this.disposed) throw new RoomCoordinatorError('Coordinator is not active.', 'not_started');
    const record = input?.record;
    if (!isRecord(record)
      || record.identity_id !== this.identityId
      || record.identity_generation !== this.identityGeneration
      || typeof record.operation_id !== 'string'
      || typeof record.payload_hash !== 'string'
      || typeof record.operation !== 'string'
      || !isNonNegativeInteger(record.base_revision)
      || record.new_revision !== record.base_revision + 1) {
      throw new RoomCoordinatorError('Operation record does not match the coordinator identity or revision contract.', 'invalid_operation');
    }
    const operation = /** @type {OperationRecord} */ ({
      ...record,
      status: record.status ?? 'pending',
      attempts: record.attempts ?? 0,
      payload: input.payload ?? record.payload,
      path: input.path ?? record.path ?? '',
      enqueued_at: isNonNegativeInteger(record.enqueued_at) ? record.enqueued_at : this.now(),
    });
    const existing = this.pending.get(operation.operation_id)
      ?? this.#findQueued(operation.operation_id);
    if (existing) {
      this.#assertSameOperation(existing.operation, operation);
      return new Promise((resolve, reject) => {
        existing.resolvers.push({ resolve, reject });
      });
    }
    const equivalent = this.#findEquivalent(operation);
    if (equivalent) {
      return new Promise((resolve, reject) => {
        equivalent.resolvers.push({ resolve, reject });
      });
    }

    const entry = this.#createEntry(operation, input.payload ?? operation.payload, input.path ?? operation.path ?? '');
    this.pending.set(operation.operation_id, entry);
    const result = new Promise((resolve, reject) => entry.resolvers.push({ resolve, reject }));
    let stored;
    try {
      stored = await this.roomStore.getOperation(this.identityId, operation.operation_id);
      if (stored) {
        this.#assertSameOperation(stored, operation);
        if (stored.status === 'persisted') {
          const current = await this.roomStore.getRoom(this.identityId, this.identityGeneration);
          if (current) this.#adoptSnapshot(current);
          this.pending.delete(operation.operation_id);
          for (const resolver of entry.resolvers) resolver.resolve(stored.response);
          return result;
        }
        entry.operation = stored;
        entry.payload = input.payload ?? stored.payload;
        entry.path = input.path ?? stored.path ?? '';
      } else {
        await this.roomStore.putOperation(entry.operation);
      }
    } catch (error) {
      this.pending.delete(operation.operation_id);
      for (const resolver of entry.resolvers) resolver.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
      entry.resolvers.length = 0;
      throw error;
    }
    this.#addToQueue(entry);
    if (this.#isLeader()) {
      void this.#drain();
    } else {
      this.#post({ type: 'enqueue', operation, payload: entry.payload, path: entry.path });
    }
    return result;
  }

  /**
   * Retries the same operation ID and payload hash after timeout or unknown status.
   * @param {string} operationId
   * @returns {Promise<boolean>} whether a retry was scheduled or started.
   */
  async retry(operationId) {
    const entry = this.pending.get(operationId) ?? this.#findQueued(operationId);
    if (!entry || this.disposed) return false;
    if (entry.retryTimer !== null) {
      this.clearTimeout(entry.retryTimer);
      entry.retryTimer = null;
    }
    if (!this.#isLeader()) {
      this.#post({ type: 'retry', operation_id: operationId });
      return true;
    }
    if (this.inFlight && this.inFlight !== entry) return false;
    this.#launchEntry(entry);
    return true;
  }

  /**
   * Stops heartbeats and expires this tab's lease without cancelling a request already sent.
   * @returns {Promise<void>}
   */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer !== null) {
      this.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const queue of this.queues.values()) {
      for (const entry of queue) {
        if (entry.retryTimer !== null) {
          this.clearTimeout(entry.retryTimer);
          entry.retryTimer = null;
        }
      }
    }
    const lease = this.lease;
    if (lease && lease.owner_id === this.tabId && isNonNegativeInteger(lease.epoch)) {
      await this.roomStore.releaseLease(
        this.identityId,
        this.identityGeneration,
        this.tabId,
        lease.epoch,
        this.now(),
      );
      const released = { ...lease, heartbeat_at: this.now(), expires_at: this.now(), released: true };
      this.lease = released;
      this.#post({ type: 'lease', lease: released });
    }
    if (this.channel) {
      if (typeof this.channel.removeEventListener === 'function') {
        this.channel.removeEventListener('message', this.messageListener);
      } else {
        this.channel.onmessage = null;
      }
      this.channel.close?.();
      this.channel = null;
    }
  }

  /** @returns {boolean} */
  get isCoordinator() {
    return this.#isLeader();
  }

  /** @returns {RoomSnapshot | null} */
  get currentSnapshot() {
    return this.snapshot;
  }

  /** @returns {JsonRecord | null} */
  get currentLease() {
    return this.lease;
  }

  /** @param {OperationRecord} left @param {OperationRecord} right */
  #assertSameOperation(left, right) {
    if (left.payload_hash !== right.payload_hash || left.operation !== right.operation
      || left.identity_id !== right.identity_id
      || left.identity_generation !== right.identity_generation
      || left.base_revision !== right.base_revision
      || left.new_revision !== right.new_revision) {
      throw new RoomCoordinatorError('An operation_id cannot be reused with a different identity, operation, or payload hash.', 'operation_conflict');
    }
  }

  /** @param {OperationRecord} operation @param {unknown} payload @param {string} path @returns {QueueEntry} */
  #createEntry(operation, payload, path) {
    return { operation, payload, path, resolvers: [], retryTimer: null, order: this.nextOrder++ };
  }

  /** @param {QueueEntry} entry */
  #addToQueue(entry) {
    const queue = this.queues.get(this.identityId) ?? [];
    if (queue.some((queued) => queued.operation.operation_id === entry.operation.operation_id)) return;
    queue.push(entry);
    queue.sort((left, right) => left.order - right.order);
    this.queues.set(this.identityId, queue);
  }

  /** @param {string} operationId @returns {QueueEntry | null} */
  #findQueued(operationId) {
    const queued = this.queues.get(this.identityId)?.find((entry) => entry.operation.operation_id === operationId);
    if (queued) return queued;
    const active = this.inFlight?.operation.operation_id === operationId ? this.inFlight : null;
    return active;
  }

  /** @param {OperationRecord} operation @returns {QueueEntry | null} */
  #findEquivalent(operation) {
    const candidates = [
      ...(this.queues.get(this.identityId) ?? []),
      ...this.pending.values(),
      ...(this.inFlight ? [this.inFlight] : []),
    ];
    return candidates.find((entry) => entry.operation.operation_id !== operation.operation_id
      && entry.operation.identity_id === operation.identity_id
      && entry.operation.identity_generation === operation.identity_generation
      && entry.operation.base_revision === operation.base_revision
      && entry.operation.operation === operation.operation
      && (entry.operation.payload_hash === operation.payload_hash
        || this.#sameIntent(entry, operation))) ?? null;
  }

  /** @param {QueueEntry} entry @param {OperationRecord} operation @returns {boolean} */
  #sameIntent(entry, operation) {
    return this.#sameIntentPayload(entry.payload, operation.payload);
  }

  /** @param {unknown} leftValue @param {unknown} rightValue @returns {boolean} */
  #sameIntentPayload(leftValue, rightValue) {
    if (!isRecord(leftValue) || !isRecord(rightValue)) return false;
    const left = { ...leftValue };
    const right = { ...rightValue };
    delete left.operation_id;
    delete right.operation_id;
    delete left.payload_hash;
    delete right.payload_hash;
    return JSON.stringify(left) === JSON.stringify(right);
  }

  /** @returns {boolean} */
  #isLeader() {
    return this.lease?.owner_id === this.tabId
      && this.lease.released !== true
      && typeof this.lease.expires_at === 'number'
      && this.lease.expires_at > this.now();
  }

  /** @param {JsonRecord} message */
  #post(message) {
    if (!this.channel) return;
    this.channel.postMessage({
      ...message,
      identity_id: this.identityId,
      identity_generation: this.identityGeneration,
      tab_id: this.tabId,
    });
  }

  #announce() {
    this.#post({ type: 'announce', revision: this.snapshot?.revision ?? 0 });
  }

  /** @param {JsonRecord} event */
  #emit(event) {
    try {
      this.onState({
        ...event,
        identity_id: this.identityId,
        identity_generation: this.identityGeneration,
        tab_id: this.tabId,
      });
    } catch {}
  }

  /** @param {unknown} error @returns {string} */
  #errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  /** @returns {Promise<void>} */
  async #heartbeat() {
    if (!this.started || this.disposed || this.heartbeatPromise) return this.heartbeatPromise ?? undefined;
    this.heartbeatPromise = this.#heartbeatOnce();
    try {
      await this.heartbeatPromise;
    } finally {
      this.heartbeatPromise = null;
    }
  }

  async #heartbeatOnce() {
    const now = this.now();
    const persistent = await this.roomStore.getLease(this.identityId);
    if (persistent && persistent.identity_generation !== this.identityGeneration) {
      this.#emit({ type: 'identity_mismatch', reason: 'lease_generation', lease: persistent });
      return;
    }
    const current = isRecord(persistent) ? persistent : this.lease;
    const owner = current?.owner_id ?? current?.tab_id;
    const expiresAt = typeof current?.expires_at === 'number' ? current.expires_at : now - LEASE_TTL_MS;
    const active = typeof expiresAt === 'number' && expiresAt > now && current?.released !== true;
    const heartbeatAt = typeof current?.heartbeat_at === 'number'
      ? current.heartbeat_at
      : typeof expiresAt === 'number' ? expiresAt - LEASE_TTL_MS : now;
    const missedPulses = Math.floor(Math.max(0, now - heartbeatAt) / HEARTBEAT_INTERVAL_MS);
    const mayAcquire = !active && (!current || (now >= expiresAt && missedPulses >= 2));

    if (active && owner !== this.tabId) {
      this.lease = current;
    } else if (mayAcquire || (active && owner === this.tabId)) {
      const claim = await this.roomStore.claimLease(
        this.identityId,
        this.identityGeneration,
        this.tabId,
        now,
        LEASE_TTL_MS,
      );
      this.lease = claim.lease;
      if (claim.acquired && claim.lease) {
        this.#post({ type: 'lease', lease: claim.lease });
        this.#emit({ type: owner === this.tabId ? 'lease_renewed' : 'lease_acquired', lease: claim.lease });
        if (owner !== this.tabId) await this.#recoverOperations();
      }
    } else {
      this.lease = current ?? null;
    }

    this.#announce();
    if (this.#isLeader()) void this.#drain();
  }

  /** @returns {Promise<void>} */
  async #recoverOperations() {
    const statuses = ['pending', 'sent', 'accepted', 'retryable', 'timeout', 'unknown'];
    const records = (await Promise.all(statuses.map((status) => this.roomStore.getOperationsByStatus(status))))
      .flat()
      .filter((record) => record.identity_id === this.identityId
        && record.identity_generation === this.identityGeneration)
      .sort((left, right) => left.base_revision - right.base_revision
        || (left.enqueued_at ?? 0) - (right.enqueued_at ?? 0)
        || left.operation_id.localeCompare(right.operation_id));
    for (const stored of records) {
      const operation = stored.status === 'sent' ? { ...stored, status: 'unknown' } : stored;
      if (operation !== stored) await this.roomStore.putOperation(operation);
      const entry = this.#createEntry(operation, operation.payload, operation.path ?? '');
      this.#addToQueue(entry);
    }
  }

  /** @param {unknown} value */
  async #handleMessage(value) {
    if (!isRecord(value)) return;
    if (value.identity_id !== this.identityId || value.identity_generation !== this.identityGeneration) {
      this.#emit({ type: 'identity_mismatch', reason: 'channel_identity', message: value });
      return;
    }
    if (value.tab_id === this.tabId) return;
    if (value.type === 'announce') {
      if (isNonNegativeInteger(value.revision) && value.revision > (this.snapshot?.revision ?? -1)) {
        await this.#refreshSnapshot();
      }
      const lease = await this.roomStore.getLease(this.identityId);
      if (lease && lease.owner_id === value.tab_id && lease.epoch === this.lease?.epoch) {
        this.lease = lease;
      }
      return;
    }
    if (value.type === 'lease' && isRecord(value.lease)) {
      if (value.lease.identity_generation !== this.identityGeneration) {
        this.#emit({ type: 'identity_mismatch', reason: 'lease_message', lease: value.lease });
        return;
      }
      if (!this.lease || !isNonNegativeInteger(this.lease.epoch)
        || (isNonNegativeInteger(value.lease.epoch) && value.lease.epoch >= this.lease.epoch)) {
        this.lease = value.lease;
      }
      return;
    }
    if (value.type === 'enqueue' && this.#isLeader() && isRecord(value.operation)) {
      await this.#acceptRemoteOperation(
        /** @type {OperationRecord} */ (value.operation),
        value.payload,
        typeof value.path === 'string' ? value.path : '',
      );
      return;
    }
    if (value.type === 'coalesced') {
      await this.#receiveCoalesced(value);
      return;
    }
    if (value.type === 'retry' && this.#isLeader() && typeof value.operation_id === 'string') {
      await this.retry(value.operation_id);
      return;
    }
    if (value.type === 'committed') {
      await this.#receiveCommitted(value);
      return;
    }
    if (value.type === 'operation_status') {
      if (value.status === 'failed' && typeof value.operation_id === 'string') {
        const entry = this.pending.get(value.operation_id) ?? this.#findQueued(value.operation_id);
        if (entry) {
          const error = new RoomCoordinatorError(
            isRecord(value.response) && typeof value.response.message === 'string'
              ? value.response.message
              : 'The transition was rejected in another tab.',
            isRecord(value.response) && typeof value.response.code === 'string'
              ? value.response.code
              : 'transition_rejected',
          );
          error.response = value.response;
          this.#rejectEntry(entry, error);
        }
      }
      this.#emit({ type: 'operation_status', operation_id: value.operation_id, status: value.status });
    }
  }

  /** @param {OperationRecord} operation @param {unknown} payload @param {string} path */
  async #acceptRemoteOperation(operation, payload, path) {
    if (operation.identity_id !== this.identityId
      || operation.identity_generation !== this.identityGeneration) {
      this.#emit({ type: 'identity_mismatch', reason: 'queued_operation', operation });
      return;
    }
    let entry = this.#findQueued(operation.operation_id);
    if (entry) this.#assertSameOperation(entry.operation, operation);
    else {
      entry = this.#createEntry(operation, payload ?? operation.payload, path || operation.path || '');
      this.#addToQueue(entry);
    }
    const stored = await this.roomStore.getOperation(this.identityId, operation.operation_id);
    if (stored) this.#assertSameOperation(stored, operation);
    if (stored?.status === 'persisted') {
      this.#adoptSnapshot(await this.roomStore.getRoom(this.identityId, this.identityGeneration)
        ?? this.snapshot);
      const queue = this.queues.get(this.identityId) ?? [];
      const position = queue.findIndex((queued) => queued.operation.operation_id === operation.operation_id);
      if (position >= 0) queue.splice(position, 1);
      this.#post({
        type: 'committed',
        operation_id: operation.operation_id,
        revision: stored.new_revision,
      });
      return;
    }
    if (stored) {
      entry.operation = stored;
      entry.payload = payload ?? stored.payload;
      entry.path = path || stored.path || '';
    }
    let equivalent = this.#findEquivalent(operation);
    let equivalentIsPersisted = false;
    if (!equivalent) {
      const persisted = await this.roomStore.getOperationsByStatus('persisted');
      const prior = persisted.find((candidate) => candidate.identity_id === this.identityId
        && candidate.identity_generation === this.identityGeneration
        && candidate.operation_id !== operation.operation_id
        && candidate.base_revision === operation.base_revision
        && candidate.operation === operation.operation
        && (candidate.payload_hash === operation.payload_hash
          || this.#sameIntentPayload(candidate.payload, payload ?? operation.payload)));
      if (prior) {
        equivalent = this.#createEntry(prior, prior.payload, prior.path ?? '');
        equivalentIsPersisted = true;
      }
    }
    if (equivalent) {
      await this.roomStore.putOperation({
        ...operation,
        status: 'failed',
        response: { status: 'coalesced', canonical_operation_id: equivalent.operation.operation_id },
      });
      if (!equivalentIsPersisted) {
        const aliasIds = this.aliases.get(equivalent.operation.operation_id) ?? new Set();
        aliasIds.add(operation.operation_id);
        this.aliases.set(equivalent.operation.operation_id, aliasIds);
      }
      const queue = this.queues.get(this.identityId) ?? [];
      const position = queue.findIndex((queued) => queued.operation.operation_id === operation.operation_id);
      if (position >= 0) queue.splice(position, 1);
      this.#post({
        type: 'coalesced',
        operation_id: operation.operation_id,
        canonical_operation_id: equivalent.operation.operation_id,
      });
      return;
    }
    this.#post({ type: 'operation_status', operation_id: operation.operation_id, status: 'pending' });
    void this.#drain();
  }

  /** @param {JsonRecord} message */
  async #receiveCoalesced(message) {
    if (typeof message.operation_id !== 'string'
      || typeof message.canonical_operation_id !== 'string') return;
    const aliasId = message.operation_id;
    const canonicalId = message.canonical_operation_id;
    const aliasIds = this.aliases.get(canonicalId) ?? new Set();
    aliasIds.add(aliasId);
    this.aliases.set(canonicalId, aliasIds);
    const entry = this.pending.get(aliasId) ?? this.#findQueued(aliasId);
    if (entry) {
      const queue = this.queues.get(this.identityId) ?? [];
      const position = queue.findIndex((queued) => queued.operation.operation_id === aliasId);
      if (position >= 0) queue.splice(position, 1);
      await this.roomStore.putOperation({
        ...entry.operation,
        status: 'failed',
        response: { status: 'coalesced', canonical_operation_id: canonicalId },
      });
    }
    const canonical = await this.roomStore.getOperation(this.identityId, canonicalId);
    if (canonical?.status === 'persisted' && entry) this.#resolveAlias(aliasId, canonical.response);
  }

  /** @param {string} aliasId @param {unknown} response */
  #resolveAlias(aliasId, response) {
    const entry = this.pending.get(aliasId) ?? this.#findQueued(aliasId);
    if (!entry) return;
    const queue = this.queues.get(this.identityId) ?? [];
    const position = queue.findIndex((queued) => queued.operation.operation_id === aliasId);
    if (position >= 0) queue.splice(position, 1);
    this.pending.delete(aliasId);
    for (const resolver of entry.resolvers) resolver.resolve(response);
    entry.resolvers.length = 0;
  }

  async #drain() {
    if (this.drainPromise || !this.#isLeader() || this.disposed) return this.drainPromise ?? undefined;
    this.drainPromise = this.#drainQueue();
    try {
      await this.drainPromise;
    } catch (error) {
      this.#emit({ type: 'error', error: this.#errorMessage(error) });
      if (this.inFlight) {
        try {
          await this.#markUnknown(this.inFlight, 'unknown');
          this.#scheduleRetry(this.inFlight);
        } catch (storageError) {
          this.#emit({ type: 'error', error: this.#errorMessage(storageError) });
        }
      }
    } finally {
      this.drainPromise = null;
      if (this.#isLeader() && !this.inFlight
        && (this.queues.get(this.identityId)?.length ?? 0) > 0) {
        queueMicrotask(() => { void this.#drain(); });
      }
    }
  }

  async #drainQueue() {
    if (this.inFlight || !this.#isLeader() || this.disposed) return;
    const queue = this.queues.get(this.identityId) ?? [];
    const entry = queue[0];
    if (!entry) return;
    this.inFlight = entry;
    await this.#refreshSnapshot();
    const record = await this.roomStore.getOperation(this.identityId, entry.operation.operation_id);
    if (record?.status === 'persisted') {
      await this.#finishPersisted(entry, record);
      return;
    }
    if (record) entry.operation = record;
    if (entry.operation.status === 'pending'
      && (entry.operation.attempts ?? 0) === 0
      && this.snapshot
      && entry.operation.base_revision !== this.snapshot.revision
      && this.rebaseOperation) {
      const rebased = await this.rebaseOperation(entry.operation, entry.payload, this.snapshot);
      if (rebased.operation.operation_id !== entry.operation.operation_id
        || rebased.operation.identity_id !== this.identityId
        || rebased.operation.identity_generation !== this.identityGeneration
        || rebased.operation.operation !== entry.operation.operation
        || rebased.operation.base_revision !== this.snapshot.revision
        || rebased.operation.new_revision !== this.snapshot.revision + 1) {
        throw new RoomCoordinatorError('A rebased operation does not match the current queue head.', 'invalid_rebase');
      }
      await this.roomStore.putOperation({ ...rebased.operation, status: 'pending', attempts: 0 });
      entry.operation = { ...rebased.operation, status: 'pending', attempts: 0 };
      entry.payload = rebased.payload;
      entry.path = typeof entry.operation.path === 'string' ? entry.operation.path : entry.path;
    }
    if (entry.operation.status === 'accepted' && entry.operation.response) {
      await this.#commitAccepted(entry, entry.operation.response);
      return;
    }
    await this.#runEntry(entry);
  }

  /** @param {QueueEntry} entry */
  async #runEntry(entry) {
    if (this.disposed || !this.#isLeader() || (this.inFlight && this.inFlight !== entry)) return;
    this.inFlight = entry;
    const stored = await this.roomStore.getOperation(this.identityId, entry.operation.operation_id);
    if (stored?.status === 'persisted') {
      await this.#finishPersisted(entry, stored);
      return;
    }
    if (stored) entry.operation = stored;
    if (entry.operation.status === 'accepted' && entry.operation.response) {
      await this.#commitAccepted(entry, entry.operation.response);
      return;
    }
    const sent = {
      ...entry.operation,
      status: 'sent',
      attempts: (entry.operation.attempts ?? 0) + 1,
      response: null,
    };
    await this.roomStore.putOperation(sent);
    entry.operation = sent;
    this.#post({ type: 'operation_status', operation_id: sent.operation_id, status: 'sent', attempts: sent.attempts });
    this.#emit({ type: 'operation_status', operation_id: sent.operation_id, status: 'sent', attempts: sent.attempts });

    let timeoutHandle = null;
    /** @type {Promise<{ kind: 'response', response: unknown } | { kind: 'error', error: unknown } | { kind: 'timeout' }>} */
    const request = Promise.resolve().then(() => this.sendRequest(sent, entry.payload, entry.path))
      .then((response) => ({ kind: 'response', response }), (error) => ({ kind: 'error', error }));
    const timeout = new Promise((resolve) => {
      timeoutHandle = this.setTimeout(() => resolve({ kind: 'timeout' }), this.requestTimeoutMs);
    });
    const outcome = await Promise.race([request, timeout]);
    if (timeoutHandle !== null) this.clearTimeout(timeoutHandle);
    if (outcome.kind === 'timeout') {
      await this.#markUnknown(entry, 'timeout');
      this.#scheduleRetry(entry);
      return;
    }
    if (outcome.kind === 'error') {
      this.#emit({ type: 'operation_error', operation_id: sent.operation_id, error: this.#errorMessage(outcome.error) });
      await this.#markUnknown(entry, 'unknown');
      this.#scheduleRetry(entry);
      return;
    }
    await this.#handleResponse(entry, outcome.response);
  }

  /** @param {QueueEntry} entry @param {unknown} response */
  async #handleResponse(entry, response) {
    const operation = entry.operation;
    await this.#refreshSnapshot();
    const persisted = await this.roomStore.getOperation(this.identityId, operation.operation_id);
    if (persisted?.status === 'persisted') {
      await this.#finishPersisted(entry, persisted);
      return;
    }
    if (isRecord(response) && response.status === 'unknown') {
      await this.#markUnknown(entry, 'unknown', response);
      this.#scheduleRetry(entry);
      return;
    }
    if (isRecord(response) && response.status === 'error') {
      const message = typeof response.message === 'string'
        ? response.message
        : 'The transition was rejected.';
      const error = new RoomCoordinatorError(
        message,
        typeof response.code === 'string' ? response.code : 'transition_rejected',
      );
      error.response = response;
      const failed = { ...entry.operation, status: 'failed', response };
      await this.roomStore.putOperation(failed);
      entry.operation = failed;
      this.#post({
        type: 'operation_status',
        operation_id: failed.operation_id,
        status: 'failed',
        response,
      });
      this.#rejectEntry(entry, error);
      return;
    }
    if (isRecord(response)
      && ((Object.hasOwn(response, 'identity_id') && response.identity_id !== this.identityId)
        || (Object.hasOwn(response, 'identity_generation')
          && response.identity_generation !== this.identityGeneration))) {
      this.#emit({ type: 'identity_mismatch', operation_id: operation.operation_id, response });
      await this.#markUnknown(entry, 'unknown', response);
      return;
    }
    const revision = responseRevision(response);
    if (revision !== null && revision < (this.snapshot?.revision ?? 0)) {
      this.#emit({ type: 'stale', operation_id: operation.operation_id, response_revision: revision });
      await this.#refreshSnapshot();
      const latest = await this.roomStore.getOperation(this.identityId, operation.operation_id);
      if (latest?.status === 'persisted') {
        await this.#finishPersisted(entry, latest);
        return;
      }
      await this.#markUnknown(entry, 'unknown', response);
      this.#scheduleRetry(entry);
      return;
    }
    if (!this.#isCompatibleResponse(response, operation)) {
      this.#emit({ type: 'stale', operation_id: operation.operation_id, reason: 'incompatible_response' });
      await this.#markUnknown(entry, 'unknown', response);
      this.#scheduleRetry(entry);
      return;
    }
    await this.#commitAccepted(entry, response);
  }

  /** @param {unknown} response @param {OperationRecord} operation @returns {boolean} */
  #isCompatibleResponse(response, operation) {
    return isRecord(response)
      && response.status === 'success'
      && response.identity_id === this.identityId
      && response.identity_generation === this.identityGeneration
      && response.operation_id === operation.operation_id
      && response.payload_hash === operation.payload_hash
      && response.operation === operation.operation
      && response.base_revision === operation.base_revision
      && response.new_revision === operation.new_revision;
  }

  /** @param {QueueEntry} entry @param {unknown} response */
  async #commitAccepted(entry, response) {
    const current = this.snapshot;
    if (!current) throw new RoomCoordinatorError('The coordinator has no confirmed snapshot.', 'room_not_loaded');
    const snapshot = this.snapshotFromResponse(response, entry.operation, current);
    if (!snapshot
      || snapshot.identity_id !== this.identityId
      || snapshot.identity_generation !== this.identityGeneration
      || snapshot.revision !== entry.operation.new_revision) {
      this.#emit({ type: 'stale', operation_id: entry.operation.operation_id, reason: 'invalid_snapshot' });
      await this.#markUnknown(entry, 'unknown', response);
      this.#scheduleRetry(entry);
      return;
    }
    const accepted = { ...entry.operation, status: 'accepted', response };
    await this.roomStore.putOperation(accepted);
    entry.operation = accepted;
    const currentLease = await this.roomStore.getLease(this.identityId);
    const commit = await this.roomStore.commitOperation({
      operation: accepted,
      response,
      snapshot,
      lease: currentLease,
      preserve_lease: true,
    });
    if (commit.status === 'committed' && commit.snapshot && commit.operation) {
      this.#adoptSnapshot(commit.snapshot);
      this.#post({
        type: 'committed',
        operation_id: commit.operation.operation_id,
        revision: commit.snapshot.revision,
        alias_operation_ids: [...(this.aliases.get(commit.operation.operation_id) ?? [])],
      });
      this.aliases.delete(commit.operation.operation_id);
      this.#emit({ type: 'committed', operation: commit.operation, snapshot: commit.snapshot });
      await this.#finishPersisted(entry, commit.operation);
      return;
    }
    if (commit.status === 'retryable') {
      await this.#markUnknown(entry, 'retryable', response);
      this.#scheduleRetry(entry);
      return;
    }
    const error = commit.error ?? new RoomCoordinatorError('The operation response could not be committed.', 'commit_failed');
    this.#emit({ type: 'operation_error', operation_id: entry.operation.operation_id, error: error.message });
    this.#rejectEntry(entry, error);
  }

  /** @param {QueueEntry} entry @param {string} status @param {unknown} [response] */
  async #markUnknown(entry, status, response = entry.operation.response) {
    const stored = await this.roomStore.getOperation(this.identityId, entry.operation.operation_id);
    if (stored?.status === 'persisted') {
      await this.#finishPersisted(entry, stored);
      return;
    }
    const blocked = { ...entry.operation, status, response: response ?? null };
    await this.roomStore.putOperation(blocked);
    entry.operation = blocked;
    this.#post({ type: 'operation_status', operation_id: blocked.operation_id, status });
    this.#emit({ type: 'operation_status', operation_id: blocked.operation_id, status });
  }

  /** @param {QueueEntry} entry */
  #scheduleRetry(entry) {
    if (this.disposed || entry.retryTimer !== null) return;
    entry.retryTimer = this.setTimeout(() => {
      entry.retryTimer = null;
      if (this.#isLeader()) this.#launchEntry(entry);
    }, this.retryDelayMs);
  }

  /** @param {QueueEntry} entry */
  #launchEntry(entry) {
    void this.#runEntry(entry).catch(async (error) => {
      this.#emit({ type: 'error', error: this.#errorMessage(error) });
      try {
        await this.#markUnknown(entry, 'unknown');
        this.#scheduleRetry(entry);
      } catch (storageError) {
        this.#emit({ type: 'error', error: this.#errorMessage(storageError) });
      }
    });
  }

  /** @param {QueueEntry} entry @param {OperationRecord} record */
  async #finishPersisted(entry, record) {
    entry.operation = record;
    const snapshot = await this.roomStore.getRoom(this.identityId, this.identityGeneration);
    if (snapshot) this.#adoptSnapshot(snapshot);
    const queue = this.queues.get(this.identityId) ?? [];
    const index = queue.findIndex((candidate) => candidate.operation.operation_id === record.operation_id);
    if (index >= 0) queue.splice(index, 1);
    this.pending.delete(record.operation_id);
    if (entry.retryTimer !== null) this.clearTimeout(entry.retryTimer);
    for (const resolver of entry.resolvers) resolver.resolve(record.response);
    entry.resolvers.length = 0;
    this.inFlight = null;
    if (this.#isLeader()) void this.#drain();
  }

  /** @param {unknown} message */
  async #receiveCommitted(message) {
    if (!isRecord(message)
      || message.identity_id !== this.identityId
      || message.identity_generation !== this.identityGeneration) {
      this.#emit({ type: 'identity_mismatch', reason: 'commit_message', message });
      return;
    }
    if (!isNonNegativeInteger(message.revision)) return;
    const currentRevision = this.snapshot?.revision ?? 0;
    const record = typeof message.operation_id === 'string'
      ? await this.roomStore.getOperation(this.identityId, message.operation_id) : null;
    const entry = typeof message.operation_id === 'string'
      ? this.pending.get(message.operation_id) ?? this.#findQueued(message.operation_id)
      : null;
    const aliasIds = new Set(this.aliases.get(String(message.operation_id)) ?? []);
    if (Array.isArray(message.alias_operation_ids)) {
      for (const aliasId of message.alias_operation_ids) {
        if (typeof aliasId === 'string') aliasIds.add(aliasId);
      }
    }
    const resolveAliases = () => {
      if (record?.status !== 'persisted') return;
      for (const aliasId of aliasIds) this.#resolveAlias(aliasId, record?.response);
      this.aliases.delete(String(message.operation_id));
    };
    if (message.revision < currentRevision) {
      this.#emit({ type: 'stale', operation_id: message.operation_id, response_revision: message.revision });
      await this.#refreshSnapshot();
      if (record?.status === 'persisted' && entry) await this.#finishPersisted(entry, record);
      resolveAliases();
      return;
    }
    await this.#refreshSnapshot();
    if (record?.status === 'persisted' && entry) await this.#finishPersisted(entry, record);
    resolveAliases();
    this.#emit({ type: 'committed', operation_id: message.operation_id, revision: message.revision, snapshot: this.snapshot });
  }

  /** @returns {Promise<void>} */
  async #refreshSnapshot() {
    const latest = await this.roomStore.getRoom(this.identityId, this.identityGeneration);
    if (latest) this.#adoptSnapshot(latest);
  }

  /** @param {RoomSnapshot} snapshot */
  #adoptSnapshot(snapshot) {
    if (snapshot.identity_id !== this.identityId
      || snapshot.identity_generation !== this.identityGeneration) {
      this.#emit({ type: 'identity_mismatch', reason: 'snapshot_generation', snapshot });
      return;
    }
    if (!this.snapshot || snapshot.revision >= this.snapshot.revision) this.snapshot = snapshot;
  }

  /** @param {QueueEntry} entry @param {Error} error */
  #rejectEntry(entry, error) {
    const queue = this.queues.get(this.identityId) ?? [];
    const index = queue.findIndex((candidate) => candidate.operation.operation_id === entry.operation.operation_id);
    if (index >= 0) queue.splice(index, 1);
    this.pending.delete(entry.operation.operation_id);
    for (const resolver of entry.resolvers) resolver.reject(error);
    entry.resolvers.length = 0;
    if (this.inFlight === entry) this.inFlight = null;
    if (this.#isLeader()) void this.#drain();
  }
}

/** @param {ConstructorParameters<typeof RoomCoordinator>[0]} options @returns {RoomCoordinator} */
function createRoomCoordinator(options) {
  return new RoomCoordinator(options);
}

const exported = Object.freeze({
  HEARTBEAT_INTERVAL_MS,
  LEASE_TTL_MS,
  RoomCoordinator,
  RoomCoordinatorError,
  createRoomCoordinator,
});

if (typeof globalThis === 'object') {
  const root = /** @type {{ PEAS?: Record<string, unknown> }} */ (/** @type {unknown} */ (globalThis));
  root.PEAS = isRecord(root.PEAS) ? root.PEAS : {};
  root.PEAS.roomCoordinator = exported;
}
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
