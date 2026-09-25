// @ts-check
(function registerRoomStore() {
'use strict';

const DATABASE_NAME = 'peas-room-v1';
const DATABASE_VERSION = 4;
const STORE_NAMES = Object.freeze({
  rooms: 'rooms',
  operations: 'operations',
  leases: 'leases',
  checkpoints: 'checkpoints',
  quarantine: 'quarantine',
  cycle_metrics: 'cycle_metrics',
  trace_events: 'trace_events',
});
const OPERATION_KINDS = Object.freeze([
  'cycle', 'environment', 'manual_command', 'feedback', 'preset', 'pause', 'resume', 'new_run', 'reset', 'checkpoint',
]);
const OPERATION_STATUSES = Object.freeze([
  'pending', 'sent', 'accepted', 'persisted', 'retryable', 'failed', 'timeout', 'unknown',
]);

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {{ revision: number, fisico: JsonRecord, dispositivos: JsonRecord, preferencias: JsonRecord[], decisao: JsonRecord | null, episodio_aberto: JsonRecord | null, execucao: JsonRecord & { pausada: boolean }, metricas: unknown[], resumo: JsonRecord }} RoomComputation */
/** @typedef {{ identity_id: string, identity_generation: number, schema_version: number, revision: number, run_id: string, next_trace_order: number, pruned_before: number, computation: RoomComputation, trace: unknown[], preferences: JsonRecord[], episodes: unknown[], cycle_metrics: unknown[], run_summary: JsonRecord, legacy_preferences: JsonRecord }} RoomSnapshot */
/** @typedef {{ identity_id: string, identity_generation: number, operation_id: string, operation_key: string, payload_hash: string, base_revision: number, new_revision: number, operation: string, status: string, attempts: number, response: unknown }} OperationRecord */
/** @typedef {{ checkpoint_id: string, identity_id: string, identity_generation: number, revision: number, snapshot: RoomSnapshot }} CheckpointRecord */
/** @typedef {{ quarantine_id: string, identity_id: string, identity_generation: number, reason: string, error_code: string, last_valid_snapshot: RoomSnapshot | null, last_valid_checkpoint: CheckpointRecord | null }} QuarantineRecord */

/** Error raised when persisted data does not satisfy its storage contract. */
class RoomStoreError extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = 'room_store_error') {
    super(message);
    this.name = 'RoomStoreError';
    this.code = code;
  }
}

/** Error raised when callers try to combine snapshots from different identities. */
class IdentityMismatchError extends RoomStoreError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'identity_mismatch');
    this.name = 'IdentityMismatchError';
  }
}

/** Error raised when a commit is based on a stale local revision. */
class RevisionConflictError extends RoomStoreError {
  /** @param {string} message */
  constructor(message) {
    super(message, 'stale_revision');
    this.name = 'RevisionConflictError';
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

/** @param {unknown} value @param {string} field @returns {asserts value is string} */
function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoomStoreError(`${field} must be a non-empty string.`, 'invalid_schema');
  }
}

/** @param {unknown} value @param {number} revision @returns {value is RoomComputation} */
function isValidComputation(value, revision) {
  return isRecord(value)
    && isNonNegativeInteger(value.revision)
    && value.revision === revision
    && isRecord(value.fisico)
    && isRecord(value.dispositivos)
    && Array.isArray(value.preferencias)
    && (value.decisao === null || isRecord(value.decisao))
    && (value.episodio_aberto === null || isRecord(value.episodio_aberto))
    && isRecord(value.execucao)
    && typeof value.execucao.pausada === 'boolean'
    && Array.isArray(value.metricas)
    && value.metricas.length <= 1
    && isRecord(value.resumo);
}

/** @param {unknown} value @returns {value is RoomSnapshot} */
function isValidSnapshot(value) {
  return isRecord(value)
    && typeof value.identity_id === 'string'
    && value.identity_id.length > 0
    && value.identity_id.length <= 128
    && isNonNegativeInteger(value.identity_generation)
    && value.schema_version === 1
    && isNonNegativeInteger(value.revision)
    && typeof value.run_id === 'string'
    && value.run_id.length > 0
    && isNonNegativeInteger(value.next_trace_order)
    && value.next_trace_order > 0
    && isNonNegativeInteger(value.pruned_before)
    && isValidComputation(value.computation, value.revision)
    && Array.isArray(value.trace)
    && (!Object.hasOwn(value, 'preferences') || Array.isArray(value.preferences))
    && (!Object.hasOwn(value, 'episodes') || Array.isArray(value.episodes))
    && Array.isArray(value.cycle_metrics)
    && (!Object.hasOwn(value, 'run_summary') || isRecord(value.run_summary))
    && (!Object.hasOwn(value, 'legacy_preferences') || isRecord(value.legacy_preferences));
}

/** @param {RoomSnapshot} snapshot @param {RoomSnapshot} previous @returns {RoomSnapshot} */
function normalizePersistedSnapshot(snapshot, previous) {
  const computation = snapshot.computation;
  return {
    ...snapshot,
    preferences: Array.isArray(snapshot.preferences) ? snapshot.preferences : computation.preferencias,
    episodes: Array.isArray(snapshot.episodes) ? snapshot.episodes : previous.episodes,
    cycle_metrics: Array.isArray(snapshot.cycle_metrics) ? snapshot.cycle_metrics : computation.metricas,
    run_summary: isRecord(snapshot.run_summary) ? snapshot.run_summary : computation.resumo,
    legacy_preferences: {
      ...(isRecord(previous.legacy_preferences) ? previous.legacy_preferences : {}),
      ...(isRecord(snapshot.legacy_preferences) ? snapshot.legacy_preferences : {}),
    },
  };
}

/** @param {unknown} value @returns {Error} */
function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/** @param {unknown} value @returns {boolean} */
function isQuotaError(value) {
  return isRecord(value) && value.name === 'QuotaExceededError';
}

/**
 * Creates an opaque UUID using the runtime's cryptographic random source.
 * @returns {string}
 * @throws {RoomStoreError} when secure randomness is unavailable.
 * @example const identityId = createOpaqueId();
 */
function createOpaqueId() {
  const cryptoRef = globalThis.crypto;
  if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
    throw new RoomStoreError('A cryptographic random source is required.', 'crypto_unavailable');
  }
  const bytes = new Uint8Array(16);
  cryptoRef.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Builds the storage key for one identity's operation.
 * @param {string} identityId
 * @param {string} operationId
 * @returns {string}
 * @throws {RoomStoreError} when an ID is empty or exceeds its contract limit.
 * @example const key = operationKey('identity-1', 'operation-1');
 */
function operationKey(identityId, operationId) {
  requireNonEmptyString(identityId, 'identity_id');
  requireNonEmptyString(operationId, 'operation_id');
  if (identityId.length > 128 || operationId.length > 128) {
    throw new RoomStoreError('Identity and operation IDs must be at most 128 characters.', 'invalid_operation_schema');
  }
  return `${identityId}:${operationId}`;
}

/** @param {string} identityId @param {string} runId */
function historyIdentityRunKey(identityId, runId) {
  return JSON.stringify([identityId, runId]);
}

/** @param {string} identityId @param {string} runId @param {string} itemId */
function historyRecordKey(identityId, runId, itemId) {
  return JSON.stringify([identityId, runId, itemId]);
}

/** @param {RoomSnapshot} snapshot @returns {RoomSnapshot} */
function compactRoomSnapshot(snapshot) {
  return { ...snapshot, cycle_metrics: [], trace: [] };
}

/**
 * Restores per-cycle history around the compact room row.
 * @param {JsonRecord} room
 * @param {unknown[]} metricRecords
 * @param {unknown[]} traceRecords
 * @returns {RoomSnapshot}
 */
function hydrateRoomSnapshot(room, metricRecords, traceRecords) {
  const runId = String(room.run_id);
  const cycleMetrics = metricRecords
    .filter(isRecord)
    .filter((record) => record.run_id === runId && isRecord(record.metric))
    .map((record) => record.metric)
    .filter(isRecord)
    .sort((left, right) => Number(left.numero_ciclo) - Number(right.numero_ciclo));
  const trace = traceRecords
    .filter(isRecord)
    .filter((record) => record.run_id === runId && isRecord(record.event))
    .map((record) => record.event)
    .filter(isRecord)
    .sort((left, right) => Number(left.ordem) - Number(right.ordem));
  return /** @type {RoomSnapshot} */ ({ ...room, cycle_metrics: cycleMetrics, trace });
}

/** @param {string} identityId @param {string} runId @param {JsonRecord} metric */
function cycleMetricRecord(identityId, runId, metric) {
  return {
    record_key: historyRecordKey(identityId, runId, String(metric.cycle_id)),
    identity_id: identityId,
    identity_run_key: historyIdentityRunKey(identityId, runId),
    run_id: runId,
    numero_ciclo: metric.numero_ciclo,
    metric,
  };
}

/** @param {string} identityId @param {string} runId @param {JsonRecord} event */
function traceEventRecord(identityId, runId, event) {
  const itemId = typeof event.event_id === 'string'
    ? event.event_id
    : `legacy-${String(event.ordem)}`;
  return {
    record_key: historyRecordKey(identityId, runId, itemId),
    identity_id: identityId,
    identity_run_key: historyIdentityRunKey(identityId, runId),
    run_id: runId,
    ordem: event.ordem,
    event,
  };
}

/** @param {unknown} event @param {string} identityId @param {string} runId @param {number} index @returns {JsonRecord} */
function migrateTraceEvent(event, identityId, runId, index) {
  if (isRecord(event)
    && typeof event.event_id === 'string'
    && typeof event.operation_id === 'string'
    && typeof event.tipo === 'string') return event;
  const legacy = isRecord(event) ? event : {};
  const order = isNonNegativeInteger(legacy.ordem) ? legacy.ordem : index + 1;
  /** @type {Record<string, string>} */
  const kinds = {
    preset: 'run',
    ciclo: 'cycle',
    feedback: 'feedback',
    correcao: 'manual_command',
    reset: 'reset',
    invalidacao: 'run',
  };
  const legacyKind = typeof legacy.tipo === 'string' ? legacy.tipo : 'run';
  return {
    event_id: `legacy-${order}`,
    run_id: runId,
    ordem: order,
    tipo: kinds[legacyKind] ?? 'run',
    operation_id: `legacy-op-${order}`,
    decisao_id: typeof legacy.decisao_id === 'string' ? legacy.decisao_id : null,
    comando_id: typeof legacy.comando_id === 'string' ? legacy.comando_id : null,
    dados: isRecord(legacy.dados) ? legacy.dados : { legacy_kind: legacyKind },
  };
}

/**
 * Creates a blank revision-zero snapshot for a new identity.
 * @param {string} identityId
 * @param {number} identityGeneration
 * @param {() => string} idFactory
 * @returns {RoomSnapshot & JsonRecord}
 * @throws {RoomStoreError} when the generation is invalid.
 * @example const snapshot = createEmptySnapshot('identity-1', 0, () => 'run-1');
 */
function createEmptySnapshot(identityId, identityGeneration, idFactory) {
  requireNonEmptyString(identityId, 'identity_id');
  if (identityId.length > 128) {
    throw new RoomStoreError('identity_id must be at most 128 characters.', 'invalid_identity');
  }
  if (!isNonNegativeInteger(identityGeneration)) {
    throw new RoomStoreError('identity_generation must be a non-negative integer.', 'invalid_identity');
  }
  const runId = idFactory();
  return {
    identity_id: identityId,
    identity_generation: identityGeneration,
    schema_version: 1,
    revision: 0,
    run_id: runId,
    next_trace_order: 1,
    pruned_before: 0,
    computation: {
      revision: 0,
      fisico: {
        preset_atual: null,
        hora: 12,
        temperatura_externa: 25,
        temperatura_interna: 25,
        umidade: 50,
        luminosidade: 'adequado',
        chuva: 0,
        presenca_interna: 0,
        presenca_externa: 0,
        dormir: 0,
      },
      dispositivos: { janela: 0, ar: 0, ventilador: 0, umidificador: 0, lampada: 0 },
      preferencias: [],
      decisao: null,
      episodio_aberto: null,
      execucao: { pausada: true },
      metricas: [],
      resumo: emptyRunSummary(runId),
    },
    trace: [],
    preferences: [],
    episodes: [],
    cycle_metrics: [],
    run_summary: emptyRunSummary(runId),
    legacy_preferences: {},
  };
}

/** @param {string} runId @returns {JsonRecord} */
function emptyRunSummary(runId) {
  return {
    run_id: runId,
      ciclos: 0,
      custo_energetico_total: 0,
      custo_energetico_medio: null,
      conforto_acumulado: 0,
      conforto_medio: null,
      ciclos_seguros: 0,
      prevencoes: 0,
      incidentes: 0,
      aceitacoes: 0,
      correcoes: 0,
      feedbacks_observados: 0,
      satisfacao_acumulada: 0,
      satisfacao_observada: null,
  };
}

/** @param {IDBDatabase} database @param {string} storeName @param {string | string[]} keyPath */
function ensureObjectStore(database, storeName, keyPath) {
  if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath });
}

/** @param {IDBObjectStore} store @param {string} name @param {string | string[]} keyPath */
function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

/** @param {IDBObjectStore} store @param {(record: JsonRecord) => JsonRecord} migrate */
function migrateRecords(store, migrate) {
  const request = store.getAll();
  request.onsuccess = () => {
    for (const value of /** @type {unknown[]} */ (request.result)) {
      if (isRecord(value)) store.put(migrate(value));
    }
  };
}

/** @param {IDBDatabase} database @param {IDBTransaction} transaction @param {() => string} idFactory */
function migration001(database, transaction, idFactory) {
  ensureObjectStore(database, STORE_NAMES.rooms, 'identity_id');
  ensureObjectStore(database, STORE_NAMES.operations, 'operation_key');
  ensureObjectStore(database, STORE_NAMES.leases, 'identity_id');
  ensureObjectStore(database, STORE_NAMES.checkpoints, 'checkpoint_id');

  const rooms = transaction.objectStore(STORE_NAMES.rooms);
  const operations = transaction.objectStore(STORE_NAMES.operations);
  ensureIndex(rooms, 'by_revision', 'revision');
  ensureIndex(operations, 'by_status', 'status');

  const request = rooms.getAll();
  request.onsuccess = () => {
    if (Array.isArray(request.result) && request.result.length === 0) {
      const identityId = idFactory();
      rooms.put(createEmptySnapshot(identityId, 0, idFactory));
    }
  };
}

/** @param {JsonRecord} room @param {() => string} idFactory @returns {JsonRecord} */
function migrateRoomVersion2(room, idFactory) {
  const migrated = { ...room };
  if (migrated.schema_version !== 1) migrated.schema_version = 1;
  if (!isNonNegativeInteger(migrated.identity_generation)) migrated.identity_generation = 0;
  if (!isNonNegativeInteger(migrated.revision)) migrated.revision = 0;
  if (typeof migrated.run_id !== 'string' || migrated.run_id.length === 0) migrated.run_id = idFactory();
  if (!isNonNegativeInteger(migrated.next_trace_order) || migrated.next_trace_order === 0) {
    migrated.next_trace_order = 1;
  }
  if (!isNonNegativeInteger(migrated.pruned_before)) migrated.pruned_before = 0;
  return migrated;
}

/** @param {unknown} value @returns {JsonRecord | null} */
function preferenceMap(value) {
  return isRecord(value) ? value : null;
}

/** @param {string} key @returns {{ objective: string, strategyId: string } | null} */
function canonicalPreferenceTarget(key) {
  let legacyKey;
  try {
    legacyKey = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(legacyKey) || legacyKey.length !== 8 || typeof legacyKey.at(-1) !== 'string') return null;
  const action = legacyKey.at(-1);
  const targets = {
    ventilar: { objective: 'termico', strategyId: 'ventilacao_assistida' },
    resfriar: { objective: 'termico', strategyId: 'resfriamento' },
    umidificar: { objective: 'umidade', strategyId: 'umidificacao' },
    iluminar: { objective: 'iluminacao', strategyId: 'iluminacao' },
  };
  return Object.hasOwn(targets, action) ? targets[action] : null;
}

/** @param {JsonRecord} room @returns {JsonRecord} */
function migrateLegacyPreferences(room) {
  const migrated = { ...room };
  const computation = isRecord(migrated.computation) ? { ...migrated.computation } : {};
  const canonical = Array.isArray(migrated.preferences)
    ? [...migrated.preferences]
    : Array.isArray(computation.preferencias) ? [...computation.preferencias] : [];
  const existingLegacy = preferenceMap(migrated.legacy_preferences) ?? {};
  const legacyPreferences = { ...existingLegacy };
  const sourceMaps = [...new Set([
    preferenceMap(migrated.preferencias),
    preferenceMap(migrated.preferences),
    preferenceMap(computation.preferencias),
  ].filter((map) => map !== null))];
  const grouped = new Map();

  for (const source of sourceMaps) {
    for (const [key, value] of Object.entries(source)) {
      const target = canonicalPreferenceTarget(key);
      if (!target || typeof value !== 'number' || !Number.isFinite(value)) {
        legacyPreferences[key] = value;
        continue;
      }
      const targetKey = `${target.objective}:${target.strategyId}`;
      const entry = grouped.get(targetKey) ?? { target, value: 0, sourceKeys: [] };
      entry.value += Math.trunc(value);
      entry.sourceKeys.push(key);
      grouped.set(targetKey, entry);
    }
  }

  const originRevision = isNonNegativeInteger(room.revision) ? room.revision : 0;
  for (const { target, value, sourceKeys } of grouped.values()) {
    const preference = {
      objetivo: target.objective,
      strategy_id: target.strategyId,
      valor: Math.max(-3, Math.min(3, value)),
      updated_revision: originRevision,
      contexto_explicativo: { legacy_context_keys: sourceKeys.sort().join(' | ') },
    };
    const existingIndex = canonical.findIndex((item) => isRecord(item)
      && item.objetivo === preference.objetivo
      && item.strategy_id === preference.strategy_id);
    if (existingIndex >= 0) canonical[existingIndex] = preference;
    else canonical.push(preference);
  }

  delete migrated.preferencias;
  migrated.preferences = canonical;
  migrated.legacy_preferences = legacyPreferences;
  const normalizedComputation = /** @type {JsonRecord} */ ({ ...computation, preferencias: canonical });
  normalizedComputation.revision = isNonNegativeInteger(migrated.revision) ? migrated.revision : 0;
  migrated.computation = normalizedComputation;
  return migrated;
}

/** @param {JsonRecord} room @param {() => string} idFactory @returns {JsonRecord} */
function migrateRoomVersion3(room, idFactory) {
  const migrated = migrateLegacyPreferences(room);
  const computation = isRecord(migrated.computation) ? migrated.computation : {};
  const roomRevision = isNonNegativeInteger(migrated.revision) ? migrated.revision : 0;
  migrated.revision = roomRevision;
  migrated.schema_version = 1;
  migrated.identity_generation = isNonNegativeInteger(migrated.identity_generation)
    ? migrated.identity_generation : 0;
  migrated.run_id = typeof migrated.run_id === 'string' && migrated.run_id.length > 0
    ? migrated.run_id : idFactory();
  migrated.next_trace_order = isNonNegativeInteger(migrated.next_trace_order)
    && migrated.next_trace_order > 0 ? migrated.next_trace_order : 1;
  migrated.pruned_before = isNonNegativeInteger(migrated.pruned_before) ? migrated.pruned_before : 0;
  migrated.episodes = Array.isArray(migrated.episodes)
    ? migrated.episodes
    : computation.episodio_aberto ? [computation.episodio_aberto] : [];
  const cycleMetrics = Array.isArray(migrated.cycle_metrics)
    ? migrated.cycle_metrics
    : Array.isArray(computation.metricas) ? computation.metricas : [];
  migrated.cycle_metrics = cycleMetrics;
  const summarySource = isRecord(migrated.run_summary)
    ? migrated.run_summary
    : isRecord(computation.resumo) ? computation.resumo : {};
  const runMetrics = cycleMetrics.filter(
    (metric) => isRecord(metric) && metric.run_id === migrated.run_id,
  );
  const feedbackMetrics = runMetrics.filter(
    (metric) => metric.feedback === 'aceitar' || metric.feedback === 'rejeitar' || metric.feedback === 'corrigir',
  );
  migrated.run_summary = {
    ...emptyRunSummary(String(migrated.run_id)),
    ...summarySource,
    conforto_acumulado: typeof summarySource.conforto_acumulado === 'number'
      ? summarySource.conforto_acumulado
      : runMetrics.reduce((total, metric) => total + (Number(metric.conforto) || 0), 0),
    feedbacks_observados: isNonNegativeInteger(summarySource.feedbacks_observados)
      ? summarySource.feedbacks_observados : feedbackMetrics.length,
    satisfacao_acumulada: typeof summarySource.satisfacao_acumulada === 'number'
      ? summarySource.satisfacao_acumulada
      : feedbackMetrics.filter((metric) => metric.feedback === 'aceitar').length,
  };
  const identityId = typeof migrated.identity_id === 'string' ? migrated.identity_id : idFactory();
  const identityGeneration = isNonNegativeInteger(migrated.identity_generation)
    ? migrated.identity_generation : 0;
  const defaultComputation = createEmptySnapshot(
    identityId,
    identityGeneration,
    () => String(migrated.run_id),
  ).computation;
  const execucao = isRecord(computation.execucao) && typeof computation.execucao.pausada === 'boolean'
    ? { ...defaultComputation.execucao, ...computation.execucao }
    : defaultComputation.execucao;
  migrated.computation = {
    ...defaultComputation,
    ...computation,
    revision: roomRevision,
    fisico: { ...defaultComputation.fisico, ...(isRecord(computation.fisico) ? computation.fisico : {}) },
    dispositivos: {
      ...defaultComputation.dispositivos,
      ...(isRecord(computation.dispositivos) ? computation.dispositivos : {}),
    },
    preferencias: migrated.preferences,
    decisao: isRecord(computation.decisao) ? computation.decisao : null,
    episodio_aberto: isRecord(computation.episodio_aberto) ? computation.episodio_aberto : null,
    execucao,
    metricas: cycleMetrics.slice(-1),
    resumo: migrated.run_summary,
  };
  migrated.trace = Array.isArray(migrated.trace) ? migrated.trace : [];
  return migrated;
}

/** @param {IDBDatabase} database @param {IDBTransaction} transaction @param {() => string} idFactory */
function migration002(database, transaction, idFactory) {
  if (database.objectStoreNames.contains(STORE_NAMES.rooms)) {
    migrateRecords(transaction.objectStore(STORE_NAMES.rooms), (room) => migrateRoomVersion2(room, idFactory));
  }
}

/** @param {IDBDatabase} database @param {IDBTransaction} transaction @param {() => string} idFactory */
function migration003(database, transaction, idFactory) {
  ensureObjectStore(database, STORE_NAMES.quarantine, 'quarantine_id');
  if (database.objectStoreNames.contains(STORE_NAMES.checkpoints)) {
    const checkpoints = transaction.objectStore(STORE_NAMES.checkpoints);
    ensureIndex(checkpoints, 'by_identity_revision', ['identity_id', 'revision']);
  }
  if (database.objectStoreNames.contains(STORE_NAMES.rooms)) {
    ensureIndex(transaction.objectStore(STORE_NAMES.rooms), 'by_revision', 'revision');
  }
  if (database.objectStoreNames.contains(STORE_NAMES.rooms)) {
    migrateRecords(transaction.objectStore(STORE_NAMES.rooms), (room) => (
      migrateRoomVersion3(migrateRoomVersion2(room, idFactory), idFactory)
    ));
  }
  if (database.objectStoreNames.contains(STORE_NAMES.operations)) {
    const operations = transaction.objectStore(STORE_NAMES.operations);
    ensureIndex(operations, 'by_status', 'status');
    migrateRecords(operations, (operation) => {
      const migrated = { ...operation };
      if (typeof migrated.operation_key !== 'string'
        && typeof migrated.identity_id === 'string'
        && typeof migrated.operation_id === 'string') {
        migrated.operation_key = operationKey(migrated.identity_id, migrated.operation_id);
      }
      if (typeof migrated.status !== 'string') migrated.status = 'pending';
      if (!OPERATION_STATUSES.includes(/** @type {never} */ (migrated.status))) migrated.status = 'pending';
      if (typeof migrated.operation !== 'string'
        || !OPERATION_KINDS.includes(/** @type {never} */ (migrated.operation))) {
        migrated.operation = OPERATION_KINDS.includes(/** @type {never} */ (migrated.kind))
          ? migrated.kind : 'checkpoint';
      }
      if (!isNonNegativeInteger(migrated.attempts)) migrated.attempts = 0;
      if (typeof migrated.payload_hash !== 'string') migrated.payload_hash = '';
      if (!isNonNegativeInteger(migrated.base_revision)) migrated.base_revision = 0;
      if (!isNonNegativeInteger(migrated.new_revision)) migrated.new_revision = migrated.base_revision;
      if (!Object.hasOwn(migrated, 'response')) migrated.response = null;
      if (!isNonNegativeInteger(migrated.identity_generation)) migrated.identity_generation = 0;
      return migrated;
    });
  }
}

/** @param {IDBDatabase} database @param {IDBTransaction} transaction @param {() => string} idFactory */
function migration004(database, transaction, idFactory) {
  ensureObjectStore(database, STORE_NAMES.cycle_metrics, 'record_key');
  ensureObjectStore(database, STORE_NAMES.trace_events, 'record_key');
  const metrics = transaction.objectStore(STORE_NAMES.cycle_metrics);
  const events = transaction.objectStore(STORE_NAMES.trace_events);
  ensureIndex(metrics, 'by_identity', 'identity_id');
  ensureIndex(metrics, 'by_identity_run', 'identity_run_key');
  ensureIndex(events, 'by_identity', 'identity_id');
  ensureIndex(events, 'by_identity_run', 'identity_run_key');
  if (!database.objectStoreNames.contains(STORE_NAMES.rooms)) return;

  const rooms = transaction.objectStore(STORE_NAMES.rooms);
  const request = rooms.getAll();
  request.onsuccess = () => {
    for (const roomValue of /** @type {unknown[]} */ (request.result)) {
      if (!isRecord(roomValue)) continue;
      const room = migrateRoomVersion3(
        migrateRoomVersion2(roomValue, idFactory),
        idFactory,
      );
      const identityId = String(room.identity_id);
      const runId = String(room.run_id);
      const cycleMetrics = Array.isArray(room.cycle_metrics) ? room.cycle_metrics : [];
      const trace = Array.isArray(room.trace) ? room.trace : [];
      for (const metric of cycleMetrics) {
        if (isRecord(metric)) metrics.put(cycleMetricRecord(identityId, runId, metric));
      }
      for (const [index, eventValue] of trace.entries()) {
        events.put(traceEventRecord(
          identityId,
          runId,
          migrateTraceEvent(eventValue, identityId, runId, index),
        ));
      }
      rooms.put(compactRoomSnapshot(/** @type {RoomSnapshot} */ (room)));
    }
  };
}

/** @param {IDBTransaction} transaction @param {RoomSnapshot} snapshot */
function replaceHistoryForSnapshot(transaction, snapshot) {
  const metrics = transaction.objectStore(STORE_NAMES.cycle_metrics);
  const events = transaction.objectStore(STORE_NAMES.trace_events);
  /** @type {JsonRecord[] | null} */
  let existingMetrics = null;
  /** @type {JsonRecord[] | null} */
  let existingEvents = null;
  const write = () => {
    if (existingMetrics === null || existingEvents === null) return;
    for (const record of existingMetrics) metrics.delete(String(record.record_key));
    for (const record of existingEvents) events.delete(String(record.record_key));
    for (const metric of snapshot.cycle_metrics) {
      if (isRecord(metric)) metrics.put(cycleMetricRecord(snapshot.identity_id, snapshot.run_id, metric));
    }
    for (const event of snapshot.trace) {
      if (isRecord(event)) events.put(traceEventRecord(snapshot.identity_id, snapshot.run_id, event));
    }
  };
  const metricsRequest = metrics.index('by_identity').getAll(snapshot.identity_id);
  metricsRequest.onsuccess = () => {
    existingMetrics = Array.isArray(metricsRequest.result)
      ? /** @type {JsonRecord[]} */ (metricsRequest.result.filter(isRecord))
      : [];
    write();
  };
  const eventsRequest = events.index('by_identity').getAll(snapshot.identity_id);
  eventsRequest.onsuccess = () => {
    existingEvents = Array.isArray(eventsRequest.result)
      ? /** @type {JsonRecord[]} */ (eventsRequest.result.filter(isRecord))
      : [];
    write();
  };
}

/** @param {IDBTransaction} transaction @param {RoomSnapshot} snapshot @param {JsonRecord} response @param {string} operationKind */
function appendHistoryForResponse(transaction, snapshot, response, operationKind) {
  const metrics = transaction.objectStore(STORE_NAMES.cycle_metrics);
  const events = transaction.objectStore(STORE_NAMES.trace_events);
  const computation = isRecord(response.computation) ? response.computation : {};
  const latestMetrics = Array.isArray(computation.metricas) ? computation.metricas : [];
  if (operationKind === 'cycle' || operationKind === 'feedback') {
    for (const metric of latestMetrics) {
      if (isRecord(metric)) metrics.put(cycleMetricRecord(snapshot.identity_id, snapshot.run_id, metric));
    }
  }
  const eventCount = Array.isArray(response.events) ? response.events.length : 0;
  const recentEvents = eventCount ? snapshot.trace.slice(-eventCount) : [];
  for (const event of recentEvents) {
    if (isRecord(event)) events.put(traceEventRecord(snapshot.identity_id, snapshot.run_id, event));
  }
}

/** @param {IDBDatabase} database @param {IDBTransaction} transaction @param {number} oldVersion @param {number} newVersion @param {() => string} idFactory */
function runMigrations(database, transaction, oldVersion, newVersion, idFactory) {
  if (oldVersion < 1 && newVersion >= 1) migration001(database, transaction, idFactory);
  if (oldVersion < 2 && newVersion >= 2) migration002(database, transaction, idFactory);
  if (oldVersion < 3 && newVersion >= 3) migration003(database, transaction, idFactory);
  if (oldVersion < 4 && newVersion >= 4) migration004(database, transaction, idFactory);
}

/** @param {IDBRequest} request @returns {Promise<unknown>} */
function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(asError(request.error));
  });
}

/** @param {IDBTransaction} transaction @returns {Promise<void>} */
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(asError(transaction.error ?? new Error('IndexedDB transaction aborted.')));
    transaction.onerror = () => {};
  });
}

/** @param {unknown} response @param {OperationRecord} operation @returns {JsonRecord} */
function validateResponse(response, operation) {
  let parsed = response;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch (error) {
      throw new RoomStoreError(`Operation response parsing failed: ${asError(error).message}`, 'invalid_response_json');
    }
  }
  if (!isRecord(parsed)
    || parsed.status !== 'success'
    || parsed.schema_version !== 1
    || parsed.identity_id !== operation.identity_id
    || parsed.identity_generation !== operation.identity_generation
    || parsed.operation_id !== operation.operation_id
    || parsed.operation !== operation.operation
    || parsed.payload_hash !== operation.payload_hash
    || parsed.base_revision !== operation.base_revision
    || parsed.new_revision !== operation.new_revision
    || !isValidComputation(parsed.computation, operation.new_revision)
    || !Array.isArray(parsed.events)
    || !Object.hasOwn(parsed, 'snapshot')
    || (parsed.snapshot !== null
      && (!isValidSnapshot(parsed.snapshot)
        || parsed.snapshot.identity_id !== operation.identity_id
        || parsed.snapshot.identity_generation !== operation.identity_generation
        || parsed.snapshot.revision !== operation.new_revision))) {
    throw new RoomStoreError('Operation response does not match the operation contract.', 'invalid_response_schema');
  }
  return parsed;
}

/** @param {JsonRecord} input @returns {OperationRecord} */
function validateOperation(input) {
  requireNonEmptyString(input.identity_id, 'identity_id');
  requireNonEmptyString(input.operation_id, 'operation_id');
  requireNonEmptyString(input.payload_hash, 'payload_hash');
  if (input.identity_id.length > 128 || input.operation_id.length > 128) {
    throw new RoomStoreError('Identity and operation IDs must be at most 128 characters.', 'invalid_operation_schema');
  }
  if (!/^[a-f0-9]{64}$/.test(input.payload_hash)) {
    throw new RoomStoreError('payload_hash must be a lowercase SHA-256 hex digest.', 'invalid_operation_schema');
  }
  if (typeof input.operation !== 'string'
    || !OPERATION_KINDS.includes(/** @type {never} */ (input.operation))) {
    throw new RoomStoreError('Operation kind is invalid.', 'invalid_operation_schema');
  }
  if (!isNonNegativeInteger(input.identity_generation)
    || !isNonNegativeInteger(input.base_revision)
    || !isNonNegativeInteger(input.new_revision)
    || input.new_revision !== input.base_revision + 1) {
    throw new RoomStoreError('Operation identity and revisions are invalid.', 'invalid_operation_schema');
  }
  const status = typeof input.status === 'string' ? input.status : 'accepted';
  if (!OPERATION_STATUSES.includes(/** @type {never} */ (status))) {
    throw new RoomStoreError('Operation status is invalid.', 'invalid_operation_schema');
  }
  return {
    ...input,
    identity_id: input.identity_id,
    identity_generation: input.identity_generation,
    operation_id: input.operation_id,
    operation_key: operationKey(input.identity_id, input.operation_id),
    payload_hash: input.payload_hash,
    base_revision: input.base_revision,
    new_revision: input.new_revision,
    operation: input.operation,
    status,
    attempts: isNonNegativeInteger(input.attempts) ? input.attempts : 0,
    response: Object.hasOwn(input, 'response') ? input.response : null,
  };
}

/**
 * IndexedDB persistence for local room snapshots and accepted operations.
 * @example const store = await openRoomDatabase();
 */
class RoomStore {
  /** @type {IDBFactory} */
  indexedDB;
  /** @type {string} */
  databaseName;
  /** @type {() => string} */
  idFactory;
  /** @type {(event: { operation: OperationRecord, snapshot: RoomSnapshot }) => void} */
  onCommitted;
  /** @type {(error: Error) => void} */
  onNotificationError;
  /** @type {IDBDatabase | null} */
  database;
  /** @type {Promise<IDBDatabase> | null} */
  openPromise;

  /**
   * @param {{ indexedDB?: IDBFactory, databaseName?: string, idFactory?: () => string, onCommitted?: (event: { operation: OperationRecord, snapshot: RoomSnapshot }) => void, onNotificationError?: (error: Error) => void }} [options]
   * @throws {RoomStoreError} when IndexedDB is unavailable.
   * @example const store = new RoomStore({ indexedDB });
   */
  constructor(options = {}) {
    const factory = options.indexedDB ?? globalThis.indexedDB;
    if (!factory) throw new RoomStoreError('IndexedDB is unavailable.', 'indexeddb_unavailable');
    this.indexedDB = factory;
    this.databaseName = options.databaseName ?? DATABASE_NAME;
    this.idFactory = options.idFactory ?? createOpaqueId;
    this.onCommitted = options.onCommitted ?? (() => {});
    this.onNotificationError = options.onNotificationError ?? (() => {});
    this.database = null;
    this.openPromise = null;
  }

  /**
   * Opens the database once per store instance and applies numbered upgrades in order.
   * @returns {Promise<IDBDatabase>}
   * @throws {RoomStoreError} when opening or upgrading fails.
   * @example const database = await store.open();
   */
  open() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
      request.onupgradeneeded = (event) => {
        const oldVersion = event.oldVersion;
        const transaction = request.transaction;
        if (!transaction) {
          reject(new RoomStoreError('Upgrade transaction is unavailable.', 'upgrade_failed'));
          return;
        }
        try {
          runMigrations(request.result, transaction, oldVersion, DATABASE_VERSION, this.idFactory);
        } catch (error) {
          transaction.abort();
          reject(asError(error));
        }
      };
      request.onerror = () => {
        this.openPromise = null;
        reject(asError(request.error));
      };
      request.onsuccess = () => {
        this.database = request.result;
        this.database.onversionchange = () => this.close();
        resolve(this.database);
      };
    });
    return this.openPromise;
  }

  /**
   * Closes the connection so another tab can upgrade the database.
   * @returns {void}
   * @example store.close();
   */
  close() {
    this.database?.close();
    this.database = null;
    this.openPromise = null;
  }

  /**
   * Returns the open database connection, opening it lazily when needed.
   * @returns {Promise<IDBDatabase>}
   * @throws {RoomStoreError} when IndexedDB cannot open.
   * @example const database = await store.getDatabase();
   */
  async getDatabase() {
    return this.database ?? this.open();
  }

  /**
   * Loads a snapshot and optionally verifies its generation.
   * @param {string} identityId
   * @param {number} [identityGeneration]
   * @returns {Promise<RoomSnapshot | null>}
   * @throws {IdentityMismatchError} when the stored generation differs.
   * @example const room = await store.getRoom(identityId, 0);
   */
  async getRoom(identityId, identityGeneration) {
    const database = await this.getDatabase();
    const transaction = database.transaction([
      STORE_NAMES.rooms,
      STORE_NAMES.cycle_metrics,
      STORE_NAMES.trace_events,
    ], 'readonly');
    const done = transactionDone(transaction);
    /** @type {unknown} */
    let room;
    /** @type {unknown[]} */
    let metricRecords = [];
    /** @type {unknown[]} */
    let traceRecords = [];
    const roomRequest = transaction.objectStore(STORE_NAMES.rooms).get(identityId);
    roomRequest.onsuccess = () => {
      room = roomRequest.result;
      if (!isRecord(room)) return;
      const runKey = historyIdentityRunKey(identityId, String(room.run_id));
      const metricsRequest = transaction.objectStore(STORE_NAMES.cycle_metrics)
        .index('by_identity_run').getAll(runKey);
      metricsRequest.onsuccess = () => {
        metricRecords = Array.isArray(metricsRequest.result) ? metricsRequest.result : [];
      };
      const traceRequest = transaction.objectStore(STORE_NAMES.trace_events)
        .index('by_identity_run').getAll(runKey);
      traceRequest.onsuccess = () => {
        traceRecords = Array.isArray(traceRequest.result) ? traceRequest.result : [];
      };
    };
    await done;
    if (room === undefined) return null;
    if (!isRecord(room)) return null;
    if (identityGeneration !== undefined && room.identity_generation !== identityGeneration) {
      throw new IdentityMismatchError('The requested generation does not match the stored snapshot.');
    }
    return hydrateRoomSnapshot(
      room,
      metricRecords,
      traceRecords,
    );
  }

  /**
   * Loads all persisted identity snapshots.
   * @returns {Promise<RoomSnapshot[]>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const rooms = await store.getRooms();
   */
  async getRooms() {
    const database = await this.getDatabase();
    const transaction = database.transaction([
      STORE_NAMES.rooms,
      STORE_NAMES.cycle_metrics,
      STORE_NAMES.trace_events,
    ], 'readonly');
    const done = transactionDone(transaction);
    const [roomResult, metricResult, traceResult] = await Promise.all([
      requestResult(transaction.objectStore(STORE_NAMES.rooms).getAll()),
      requestResult(transaction.objectStore(STORE_NAMES.cycle_metrics).getAll()),
      requestResult(transaction.objectStore(STORE_NAMES.trace_events).getAll()),
    ]);
    await done;
    const metricsByRun = new Map();
    for (const record of Array.isArray(metricResult) ? metricResult : []) {
      if (!isRecord(record) || typeof record.identity_run_key !== 'string') continue;
      const values = metricsByRun.get(record.identity_run_key) ?? [];
      values.push(record);
      metricsByRun.set(record.identity_run_key, values);
    }
    const traceByRun = new Map();
    for (const record of Array.isArray(traceResult) ? traceResult : []) {
      if (!isRecord(record) || typeof record.identity_run_key !== 'string') continue;
      const values = traceByRun.get(record.identity_run_key) ?? [];
      values.push(record);
      traceByRun.set(record.identity_run_key, values);
    }
    return (Array.isArray(roomResult) ? roomResult : [])
      .filter(isRecord)
      .map((room) => {
        const key = historyIdentityRunKey(String(room.identity_id), String(room.run_id));
        return hydrateRoomSnapshot(
          room,
          metricsByRun.get(key) ?? [],
          traceByRun.get(key) ?? [],
        );
      });
  }

  /**
   * Stores a snapshot without allowing identity mixing or revision rollback.
   * @param {RoomSnapshot} snapshot
   * @returns {Promise<void>}
   * @throws {RoomStoreError | IdentityMismatchError | RevisionConflictError} when validation fails.
   * @example await store.putRoom(snapshot);
   */
  async putRoom(snapshot) {
    if (!isValidSnapshot(snapshot)) throw new RoomStoreError('Snapshot schema is invalid.', 'invalid_snapshot_schema');
    const database = await this.getDatabase();
    const transaction = database.transaction([
      STORE_NAMES.rooms,
      STORE_NAMES.cycle_metrics,
      STORE_NAMES.trace_events,
    ], 'readwrite');
    const done = transactionDone(transaction);
    const rooms = transaction.objectStore(STORE_NAMES.rooms);
    /** @type {Error | null} */
    let validationError = null;
    const request = rooms.get(snapshot.identity_id);
    request.onsuccess = () => {
      const existing = request.result;
      if (existing && existing.identity_generation !== snapshot.identity_generation) {
        validationError = new IdentityMismatchError('Snapshot identity_generation does not match the stored identity.');
        transaction.abort();
        return;
      }
      if (existing && existing.revision > snapshot.revision) {
        validationError = new RevisionConflictError('Snapshot revision cannot move backwards.');
        transaction.abort();
        return;
      }
      replaceHistoryForSnapshot(transaction, snapshot);
      rooms.put(compactRoomSnapshot(snapshot));
    };
    try {
      await done;
    } catch (error) {
      throw validationError ?? asError(error);
    }
  }

  /**
   * Loads an operation by identity and operation ID.
   * @param {string} identityId
   * @param {string} operationId
   * @returns {Promise<OperationRecord | null>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const operation = await store.getOperation(identityId, operationId);
   */
  async getOperation(identityId, operationId) {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.operations], 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(STORE_NAMES.operations)
      .get(operationKey(identityId, operationId)));
    await done;
    return result === undefined ? null : /** @type {OperationRecord} */ (result);
  }

  /**
   * Loads operations through the by_status index.
   * @param {string} status
   * @returns {Promise<OperationRecord[]>}
   * @throws {RoomStoreError} when the status or IndexedDB request is invalid.
   * @example const pending = await store.getOperationsByStatus('pending');
   */
  async getOperationsByStatus(status) {
    if (!OPERATION_STATUSES.includes(/** @type {never} */ (status))) {
      throw new RoomStoreError('Operation status is invalid.', 'invalid_operation_schema');
    }
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.operations], 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(STORE_NAMES.operations).index('by_status').getAll(status));
    await done;
    return /** @type {OperationRecord[]} */ (result);
  }

  /**
   * Stores a validated operation under its composite key.
   * @param {JsonRecord} operation
   * @returns {Promise<void>}
   * @throws {RoomStoreError | IdentityMismatchError} when the record does not match its identity.
   * @example await store.putOperation(operation);
   */
  async putOperation(operation) {
    const normalized = validateOperation(operation);
    const room = await this.getRoom(normalized.identity_id);
    if (!room || room.identity_generation !== normalized.identity_generation) {
      throw new IdentityMismatchError('Operation identity does not match a stored snapshot.');
    }
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.operations], 'readwrite');
    const done = transactionDone(transaction);
    const operations = transaction.objectStore(STORE_NAMES.operations);
    /** @type {Error | null} */
    let validationError = null;
    const existingRequest = operations.get(normalized.operation_key);
    existingRequest.onsuccess = () => {
      const existing = existingRequest.result;
      const identityChanged = isRecord(existing)
        && (existing.identity_id !== normalized.identity_id
          || existing.identity_generation !== normalized.identity_generation
          || existing.operation !== normalized.operation);
      const contractChanged = isRecord(existing)
        && (existing.payload_hash !== normalized.payload_hash
          || existing.base_revision !== normalized.base_revision
          || existing.new_revision !== normalized.new_revision);
      const mayRebaseUnsent = isRecord(existing)
        && existing.status === 'pending'
        && (existing.attempts ?? 0) === 0
        && normalized.status === 'pending'
        && normalized.attempts === 0;
      if (identityChanged || (contractChanged && !mayRebaseUnsent)) {
        validationError = new RoomStoreError('An operation_id cannot be reused with a different operation contract.', 'operation_conflict');
        transaction.abort();
        return;
      }
      if (isRecord(existing)
        && (existing.status === 'persisted'
          || (existing.status === 'accepted' && normalized.status !== 'accepted' && normalized.status !== 'persisted'))) {
        return;
      }
      operations.put(normalized);
    };
    try {
      await done;
    } catch (error) {
      throw validationError ?? asError(error);
    }
  }

  /**
   * Loads the lease owned by an identity.
   * @param {string} identityId
   * @returns {Promise<JsonRecord | null>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const lease = await store.getLease(identityId);
   */
  async getLease(identityId) {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.leases], 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(STORE_NAMES.leases).get(identityId));
    await done;
    return result === undefined ? null : /** @type {JsonRecord} */ (result);
  }

  /**
   * Atomically claims an available identity lease or renews this owner's lease.
   * @param {string} identityId
   * @param {number} identityGeneration
   * @param {string} ownerId
   * @param {number} now
   * @param {number} ttlMs
   * @returns {Promise<{ acquired: boolean, lease: JsonRecord | null }>}
   * @throws {RoomStoreError | IdentityMismatchError} when the identity or lease data is invalid.
   * @example const claim = await store.claimLease(identityId, 0, tabId, Date.now(), 3000);
   */
  async claimLease(identityId, identityGeneration, ownerId, now, ttlMs) {
    requireNonEmptyString(identityId, 'identity_id');
    requireNonEmptyString(ownerId, 'owner_id');
    if (!isNonNegativeInteger(identityGeneration)
      || !isNonNegativeInteger(now)
      || !Number.isSafeInteger(ttlMs)
      || ttlMs <= 0
      || !Number.isSafeInteger(now + ttlMs)) {
      throw new RoomStoreError('Lease timing or identity fields are invalid.', 'invalid_lease_schema');
    }

    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.rooms, STORE_NAMES.leases], 'readwrite');
    const done = transactionDone(transaction);
    const rooms = transaction.objectStore(STORE_NAMES.rooms);
    const leases = transaction.objectStore(STORE_NAMES.leases);
    /** @type {JsonRecord | null} */
    let resultLease = null;
    let acquired = false;
    /** @type {Error | null} */
    let validationError = null;
    let roomReady = false;
    let leaseReady = false;
    let roomValue;
    let leaseValue;
    const finishClaim = () => {
      if (!roomReady || !leaseReady) return;
      if (!isValidSnapshot(roomValue) || roomValue.identity_id !== identityId
        || roomValue.identity_generation !== identityGeneration) {
        validationError = new IdentityMismatchError('Lease identity does not match a stored snapshot.');
        transaction.abort();
        return;
      }
      if (leaseValue !== undefined && (!isRecord(leaseValue)
        || leaseValue.identity_id !== identityId
        || leaseValue.identity_generation !== identityGeneration)) {
        validationError = new IdentityMismatchError('Stored lease belongs to another identity generation.');
        transaction.abort();
        return;
      }

      const existing = isRecord(leaseValue) ? leaseValue : null;
      const existingOwner = existing?.owner_id ?? existing?.tab_id;
      const expiresAt = existing?.expires_at;
      const active = existing !== null
        && existing.released !== true
        && typeof expiresAt === 'number'
        && expiresAt > now;
      if (active && existingOwner !== ownerId) {
        resultLease = existing;
        return;
      }

      const existingEpoch = isNonNegativeInteger(existing?.epoch) ? existing.epoch : 0;
      const renewing = active && existingOwner === ownerId;
      if (!renewing && existingEpoch >= Number.MAX_SAFE_INTEGER) {
        validationError = new RoomStoreError('Lease epoch limit has been reached.', 'lease_epoch_exhausted');
        transaction.abort();
        return;
      }
      const lease = {
        identity_id: identityId,
        identity_generation: identityGeneration,
        owner_id: ownerId,
        epoch: renewing ? existingEpoch : existingEpoch + 1,
        heartbeat_at: now,
        expires_at: now + ttlMs,
        released: false,
      };
      resultLease = lease;
      acquired = true;
      leases.put(lease);
    };
    const roomRequest = rooms.get(identityId);
    roomRequest.onsuccess = () => {
      roomValue = roomRequest.result;
      roomReady = true;
      finishClaim();
    };
    const leaseRequest = leases.get(identityId);
    leaseRequest.onsuccess = () => {
      leaseValue = leaseRequest.result;
      leaseReady = true;
      finishClaim();
    };

    try {
      await done;
    } catch (error) {
      throw validationError ?? asError(error);
    }
    return { acquired, lease: resultLease };
  }

  /**
   * Expires a lease only when its owner and epoch still match, preserving the epoch tombstone.
   * @param {string} identityId
   * @param {number} identityGeneration
   * @param {string} ownerId
   * @param {number} epoch
   * @param {number} now
   * @returns {Promise<boolean>}
   * @throws {RoomStoreError | IdentityMismatchError} when the identity or lease data is invalid.
   * @example await store.releaseLease(identityId, 0, tabId, epoch, Date.now());
   */
  async releaseLease(identityId, identityGeneration, ownerId, epoch, now) {
    requireNonEmptyString(identityId, 'identity_id');
    requireNonEmptyString(ownerId, 'owner_id');
    if (!isNonNegativeInteger(identityGeneration)
      || !isNonNegativeInteger(epoch)
      || !isNonNegativeInteger(now)) {
      throw new RoomStoreError('Lease identity or epoch fields are invalid.', 'invalid_lease_schema');
    }

    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.rooms, STORE_NAMES.leases], 'readwrite');
    const done = transactionDone(transaction);
    const rooms = transaction.objectStore(STORE_NAMES.rooms);
    const leases = transaction.objectStore(STORE_NAMES.leases);
    /** @type {Error | null} */
    let validationError = null;
    let roomReady = false;
    let leaseReady = false;
    let roomValue;
    let leaseValue;
    let released = false;
    const finishRelease = () => {
      if (!roomReady || !leaseReady) return;
      if (!isValidSnapshot(roomValue) || roomValue.identity_id !== identityId
        || roomValue.identity_generation !== identityGeneration) {
        validationError = new IdentityMismatchError('Lease identity does not match a stored snapshot.');
        transaction.abort();
        return;
      }
      if (isRecord(leaseValue)
        && leaseValue.identity_generation !== identityGeneration) {
        validationError = new IdentityMismatchError('Stored lease belongs to another identity generation.');
        transaction.abort();
        return;
      }
      const owner = isRecord(leaseValue) ? leaseValue.owner_id ?? leaseValue.tab_id : null;
      if (!isRecord(leaseValue) || owner !== ownerId || leaseValue.epoch !== epoch) return;
      leases.put({ ...leaseValue, heartbeat_at: now, expires_at: now, released: true });
      released = true;
    };
    const roomRequest = rooms.get(identityId);
    roomRequest.onsuccess = () => {
      roomValue = roomRequest.result;
      roomReady = true;
      finishRelease();
    };
    const leaseRequest = leases.get(identityId);
    leaseRequest.onsuccess = () => {
      leaseValue = leaseRequest.result;
      leaseReady = true;
      finishRelease();
    };
    try {
      await done;
    } catch (error) {
      throw validationError ?? asError(error);
    }
    return released;
  }

  /**
   * Stores a lease after matching it to an existing identity generation.
   * @param {JsonRecord} lease
   * @returns {Promise<void>}
   * @throws {RoomStoreError | IdentityMismatchError} when lease data is invalid.
   * @example await store.putLease(lease);
   */
  async putLease(lease) {
    requireNonEmptyString(lease.identity_id, 'identity_id');
    if (!isNonNegativeInteger(lease.identity_generation)) {
      throw new RoomStoreError('Lease identity_generation is invalid.', 'invalid_lease_schema');
    }
    const room = await this.getRoom(lease.identity_id);
    if (!room || room.identity_generation !== lease.identity_generation) {
      throw new IdentityMismatchError('Lease identity does not match a stored snapshot.');
    }
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.leases], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAMES.leases).put(lease);
    await done;
  }

  /**
   * Stores a valid checkpoint snapshot.
   * @param {JsonRecord} checkpoint
   * @returns {Promise<void>}
   * @throws {RoomStoreError | IdentityMismatchError} when checkpoint data is invalid.
   * @example await store.putCheckpoint(checkpoint);
   */
  async putCheckpoint(checkpoint) {
    requireNonEmptyString(checkpoint.identity_id, 'identity_id');
    if (!isNonNegativeInteger(checkpoint.identity_generation)
      || !isNonNegativeInteger(checkpoint.revision)
      || !isValidSnapshot(checkpoint.snapshot)
      || checkpoint.snapshot.identity_id !== checkpoint.identity_id
      || checkpoint.snapshot.identity_generation !== checkpoint.identity_generation
      || checkpoint.snapshot.revision !== checkpoint.revision) {
      throw new RoomStoreError('Checkpoint schema is invalid.', 'invalid_checkpoint_schema');
    }
    const room = await this.getRoom(checkpoint.identity_id);
    if (room && room.identity_generation !== checkpoint.identity_generation) {
      throw new IdentityMismatchError('Checkpoint identity does not match the stored snapshot.');
    }
    const record = {
      ...checkpoint,
      checkpoint_id: typeof checkpoint.checkpoint_id === 'string'
        ? checkpoint.checkpoint_id : `${checkpoint.identity_id}:${checkpoint.revision}`,
    };
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.checkpoints], 'readwrite');
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAMES.checkpoints).put(record);
    await done;
  }

  /**
   * Loads the newest valid checkpoint for an identity.
   * @param {string} identityId
   * @returns {Promise<JsonRecord | null>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const checkpoint = await store.getLatestCheckpoint(identityId);
   */
  async getLatestCheckpoint(identityId) {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.checkpoints], 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(STORE_NAMES.checkpoints).getAll());
    await done;
    const checkpoints = /** @type {JsonRecord[]} */ (result)
      .filter((checkpoint) => checkpoint.identity_id === identityId
        && isValidSnapshot(checkpoint.snapshot)
        && checkpoint.snapshot.identity_id === identityId
        && checkpoint.snapshot.identity_generation === checkpoint.identity_generation
        && checkpoint.snapshot.revision === checkpoint.revision)
      .sort((left, right) => Number(right.revision) - Number(left.revision));
    return checkpoints[0] ?? null;
  }

  /**
   * Loads a checkpoint by its primary key.
   * @param {string} checkpointId
   * @returns {Promise<JsonRecord | null>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const checkpoint = await store.getCheckpoint(checkpointId);
   */
  async getCheckpoint(checkpointId) {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.checkpoints], 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(transaction.objectStore(STORE_NAMES.checkpoints).get(checkpointId));
    await done;
    return result === undefined ? null : /** @type {JsonRecord} */ (result);
  }

  /**
   * Loads records isolated in quarantine.
   * @returns {Promise<QuarantineRecord[]>}
   * @throws {RoomStoreError} when the IndexedDB request fails.
   * @example const quarantined = await store.getQuarantineRecords();
   */
  async getQuarantineRecords() {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.quarantine], 'readonly');
    const done = transactionDone(transaction);
    const records = await requestResult(transaction.objectStore(STORE_NAMES.quarantine).getAll());
    await done;
    return /** @type {QuarantineRecord[]} */ (records);
  }

  /**
   * Returns the valid room snapshot or the newest valid checkpoint.
   * @param {string} identityId
   * @returns {Promise<RoomSnapshot | null>}
   * @throws {RoomStoreError} when recovery reads fail.
   * @example const snapshot = await store.recoverSnapshot(identityId);
   */
  async recoverSnapshot(identityId) {
    const room = await this.getRoom(identityId);
    if (isValidSnapshot(room)) return room;
    const checkpoint = await this.getLatestCheckpoint(identityId);
    return checkpoint && isValidSnapshot(checkpoint.snapshot)
      ? /** @type {RoomSnapshot} */ (checkpoint.snapshot) : null;
  }

  /**
   * Atomically stores an accepted response, snapshot, then lease state.
   * @param {JsonRecord} input
   * @returns {Promise<{ status: 'committed' | 'retryable' | 'quarantined', snapshot?: RoomSnapshot, operation?: OperationRecord, error?: Error }>}
   * @throws {IdentityMismatchError | RevisionConflictError} when the stored identity or revision changed.
   * @example await store.commitOperation({ operation, response, snapshot, lease });
   */
  async commitOperation(input) {
    const operation = validateOperation(isRecord(input.operation) ? input.operation : {});
    let response;
    try {
      response = validateResponse(input.response, operation);
    } catch (error) {
      await this.quarantineOperation(operation, input.response, asError(error));
      return { status: 'quarantined', error: asError(error) };
    }

    const snapshot = input.snapshot ?? response.snapshot;
    if (!isValidSnapshot(snapshot)
      || snapshot.identity_id !== operation.identity_id
      || snapshot.identity_generation !== operation.identity_generation
      || snapshot.revision !== operation.new_revision) {
      const error = new RoomStoreError('Snapshot schema or identity does not match the operation.', 'invalid_snapshot_schema');
      await this.quarantineOperation(operation, input.response, error);
      return { status: 'quarantined', error };
    }
    const lease = input.lease;
    if (lease !== null && lease !== undefined
      && (!isRecord(lease)
        || lease.identity_id !== operation.identity_id
        || lease.identity_generation !== operation.identity_generation)) {
      const error = new IdentityMismatchError('Lease identity does not match the operation.');
      await this.quarantineOperation(operation, input.response, error);
      return { status: 'quarantined', error };
    }

    const database = await this.getDatabase();
    const storedOperation = {
      ...operation,
      status: 'persisted',
      response,
    };
    const transaction = database.transaction([
      STORE_NAMES.rooms,
      STORE_NAMES.operations,
      STORE_NAMES.leases,
      STORE_NAMES.cycle_metrics,
      STORE_NAMES.trace_events,
    ], 'readwrite');
    const done = transactionDone(transaction);
    const operations = transaction.objectStore(STORE_NAMES.operations);
    const rooms = transaction.objectStore(STORE_NAMES.rooms);
    const leases = transaction.objectStore(STORE_NAMES.leases);
    /** @type {Error | null} */
    let validationError = null;
    let committedSnapshot = snapshot;
    let roomReady = false;
    let leaseReady = false;
    let existingRoom;
    let existingLease;
    const commit = () => {
      if (!roomReady || !leaseReady) return;
      const existing = existingRoom;
      if (!isValidSnapshot(existing)) {
        validationError = new IdentityMismatchError('No valid local snapshot exists for this identity.');
        transaction.abort();
        return;
      }
      if (existing.identity_generation !== operation.identity_generation) {
        validationError = new IdentityMismatchError('Operation identity_generation does not match the stored snapshot.');
        transaction.abort();
        return;
      }
      if (existing.revision !== operation.base_revision) {
        validationError = new RevisionConflictError('Operation base_revision does not match the stored snapshot.');
        transaction.abort();
        return;
      }
      committedSnapshot = normalizePersistedSnapshot(snapshot, existing);
      operations.put(storedOperation);
      if (existing.run_id !== committedSnapshot.run_id) {
        replaceHistoryForSnapshot(transaction, committedSnapshot);
      } else {
        appendHistoryForResponse(
          transaction,
          committedSnapshot,
          response,
          operation.operation,
        );
      }
      rooms.put(compactRoomSnapshot(committedSnapshot));
      if (lease) {
        const previousEpoch = isRecord(existingLease) && isNonNegativeInteger(existingLease.epoch)
          ? existingLease.epoch : -1;
        const nextEpoch = isRecord(lease) && isNonNegativeInteger(lease.epoch) ? lease.epoch : -1;
        const sameEpochDifferentOwner = isRecord(existingLease) && isRecord(lease)
          && previousEpoch === nextEpoch
          && (existingLease.owner_id ?? existingLease.tab_id) !== (lease.owner_id ?? lease.tab_id);
        const releasedAtSameEpoch = isRecord(existingLease)
          && existingLease.released === true
          && previousEpoch === nextEpoch;
        if (nextEpoch > previousEpoch
          || (nextEpoch === previousEpoch && !sameEpochDifferentOwner && !releasedAtSameEpoch)) {
          leases.put(lease);
        }
      } else if (input.preserve_lease !== true) {
        leases.delete(operation.identity_id);
      }
    };
    const existingRequest = rooms.get(operation.identity_id);
    existingRequest.onsuccess = () => {
      existingRoom = existingRequest.result;
      roomReady = true;
      commit();
    };
    const leaseRequest = leases.get(operation.identity_id);
    leaseRequest.onsuccess = () => {
      existingLease = leaseRequest.result;
      leaseReady = true;
      commit();
    };

    try {
      await done;
    } catch (error) {
      if (validationError) throw validationError;
      if (!isQuotaError(error)) throw asError(error);
      const retryableOperation = { ...storedOperation, status: 'retryable' };
      try {
        await this.putOperation(retryableOperation);
      } catch {
        return { status: 'retryable', operation: retryableOperation, error: asError(error) };
      }
      return { status: 'retryable', operation: retryableOperation, error: asError(error) };
    }

    const event = { operation: storedOperation, snapshot: committedSnapshot };
    try {
      const notify = typeof input.onCommitted === 'function' ? input.onCommitted : this.onCommitted;
      notify(event);
    } catch (error) {
      try {
        this.onNotificationError(asError(error));
      } catch {}
    }
    return { status: 'committed', operation: storedOperation, snapshot: committedSnapshot };
  }

  /**
   * Preserves malformed operation data while keeping the last valid snapshot.
   * @param {OperationRecord} operation
   * @param {unknown} rawResponse
   * @param {Error} error
   * @returns {Promise<void>}
   * @throws {RoomStoreError} when quarantine cannot be written.
   * @example await store.quarantineOperation(operation, response, error);
   */
  async quarantineOperation(operation, rawResponse, error) {
    const latestCheckpoint = await this.getLatestCheckpoint(operation.identity_id);
    const previousSnapshot = await this.recoverSnapshot(operation.identity_id);
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.quarantine, STORE_NAMES.operations], 'readwrite');
    const done = transactionDone(transaction);
    const quarantineId = this.idFactory();
    transaction.objectStore(STORE_NAMES.quarantine).put({
      quarantine_id: quarantineId,
      identity_id: operation.identity_id,
      identity_generation: operation.identity_generation,
      operation_key: operation.operation_key,
      reason: error.message,
      error_code: error instanceof RoomStoreError ? error.code : 'invalid_record',
      record: { ...operation, response: rawResponse },
      last_valid_snapshot: previousSnapshot,
      last_valid_checkpoint: latestCheckpoint,
      created_at: new Date().toISOString(),
    });
    transaction.objectStore(STORE_NAMES.operations).put({
      ...operation,
      status: 'failed',
      response: rawResponse,
      quarantine_id: quarantineId,
    });
    await done;
  }

  /**
   * Creates an isolated identity with a generation above all stored identities.
   * @param {string} [previousIdentityId]
   * @returns {Promise<RoomSnapshot>}
   * @throws {RoomStoreError | IdentityMismatchError} when creation fails.
   * @example const nextRoom = await store.createIdentity(currentIdentityId);
   */
  async createIdentity(previousIdentityId) {
    const database = await this.getDatabase();
    const transaction = database.transaction([STORE_NAMES.rooms], 'readwrite');
    const done = transactionDone(transaction);
    const rooms = transaction.objectStore(STORE_NAMES.rooms);
    /** @type {RoomSnapshot | null} */
    let createdSnapshot = null;
    /** @type {Error | null} */
    let creationError = null;
    const request = rooms.getAll();
    request.onsuccess = () => {
      const snapshots = /** @type {JsonRecord[]} */ (request.result).filter(isRecord);
      const previous = previousIdentityId
        ? snapshots.find((snapshot) => snapshot.identity_id === previousIdentityId)
        : null;
      const highestGeneration = snapshots.reduce((highest, snapshot) => (
        isNonNegativeInteger(snapshot.identity_generation)
          ? Math.max(highest, snapshot.identity_generation)
          : highest
      ), -1);
      if (previousIdentityId && !previous) {
        creationError = new IdentityMismatchError('The previous identity does not exist.');
        transaction.abort();
        return;
      }
      const identityId = this.idFactory();
      if (snapshots.some((snapshot) => snapshot.identity_id === identityId)) {
        creationError = new RoomStoreError('The identity ID generator returned an existing ID.', 'identity_creation_failed');
        transaction.abort();
        return;
      }
      const previousGeneration = isNonNegativeInteger(previous?.identity_generation)
        ? previous.identity_generation : -1;
      const generation = Math.max(highestGeneration, previousGeneration) + 1;
      if (!isNonNegativeInteger(generation)) {
        creationError = new RoomStoreError('Identity generation limit has been reached.', 'identity_generation_exhausted');
        transaction.abort();
        return;
      }
      createdSnapshot = createEmptySnapshot(identityId, generation, this.idFactory);
      rooms.put(createdSnapshot);
    };
    try {
      await done;
    } catch (error) {
      throw creationError ?? asError(error);
    }
    if (!createdSnapshot) throw new RoomStoreError('A new identity could not be created.', 'identity_creation_failed');
    return createdSnapshot;
  }
}

/**
 * Opens `peas-room-v1` and returns its idempotent store API.
 * @param {ConstructorParameters<typeof RoomStore>[0]} [options]
 * @returns {Promise<RoomStore>}
 * @throws {RoomStoreError} when IndexedDB or a cryptographic ID source is unavailable.
 * @example const store = await openRoomDatabase({ indexedDB: fakeIndexedDB });
 */
async function openRoomDatabase(options = {}) {
  const store = new RoomStore(options);
  await store.open();
  return store;
}

/**
 * Creates a store instance without opening IndexedDB.
 * @param {ConstructorParameters<typeof RoomStore>[0]} [options]
 * @returns {RoomStore}
 * @throws {RoomStoreError} when IndexedDB is unavailable.
 * @example const store = createRoomStore({ indexedDB });
 */
function createRoomStore(options = {}) {
  return new RoomStore(options);
}

/**
 * Creates an isolated identity through an open room store.
 * @param {RoomStore} store
 * @param {string} [previousIdentityId]
 * @returns {Promise<RoomSnapshot>}
 * @throws {TypeError} when `store` is not a RoomStore instance.
 * @throws {RoomStoreError | IdentityMismatchError} when identity creation fails.
 * @example const nextRoom = await createIdentity(store, currentIdentityId);
 */
function createIdentity(store, previousIdentityId) {
  if (!(store instanceof RoomStore)) throw new TypeError('store must be a RoomStore instance.');
  return store.createIdentity(previousIdentityId);
}

const exported = Object.freeze({ createIdentity,
  DATABASE_NAME,
  DATABASE_VERSION,
  STORE_NAMES,
  RoomStore,
  RoomStoreError,
  IdentityMismatchError,
  RevisionConflictError,
  createEmptySnapshot,
  createRoomStore,
  operationKey,
  openRoomDatabase,
});

if (typeof globalThis === 'object') {
  const globalRoot = /** @type {{ PEAS?: Record<string, unknown> }} */ (/** @type {unknown} */ (globalThis));
  globalRoot.PEAS = isRecord(globalRoot.PEAS) ? globalRoot.PEAS : {};
  globalRoot.PEAS.roomStore = exported;
}
if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
