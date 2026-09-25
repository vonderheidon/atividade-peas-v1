// @ts-check

/** @typedef {Record<string, unknown>} JsonRecord */
/** @typedef {'reativo' | 'cognitivo'} CycleMode */
/** @typedef {{ method?: string, headers?: Record<string, string>, body?: string }} RequestInitLike */
/** @typedef {{ ok?: boolean, status?: number, json: () => Promise<unknown> | unknown }} ResponseLike */
/** @typedef {(input: string, init?: RequestInitLike) => Promise<ResponseLike> | ResponseLike} FetchLike */
/** @typedef {(input: string, init?: RequestInitLike) => Promise<unknown> | unknown} JsonRequester */
/** @typedef {Error & { code?: unknown, response?: unknown, status?: number }} RequestError */
/** @typedef {{
 * applyResponse?: (response: unknown, state?: string) => boolean,
 * receiveResponse?: (response: unknown, state?: string) => boolean,
 * renderState?: (state: unknown) => boolean,
 * reportError?: (error: unknown) => void,
 * renderError?: (error: unknown) => void,
 * setUIState?: (state: string) => void,
 * setState?: (state: string) => void,
 * setFeedbackStatus?: (message: string) => void,
 * clearLearningResult?: () => void,
 * handleDeviceIntent?: (device: string) => void,
 * destroy: () => void,
 * }} SimulatorUIHandle */
/** @typedef {{ identity_id: string, identity_generation: number, revision: number, run_id: string, next_trace_order: number, pruned_before: number, computation: JsonRecord, trace: unknown[], [key: string]: unknown }} RoomSnapshot */
/** @typedef {{ idFactory?: () => string, getRooms: () => Promise<RoomSnapshot[]>, getRoom: (identityId: string, generation?: number) => Promise<RoomSnapshot | null>, recoverSnapshot?: (identityId: string) => Promise<RoomSnapshot | null>, putRoom?: (snapshot: RoomSnapshot) => Promise<void>, createIdentity?: () => Promise<RoomSnapshot>, getOperation: (identityId: string, operationId: string) => Promise<JsonRecord | null>, putOperation: (operation: JsonRecord) => Promise<void> }} RoomStoreLike */
/** @typedef {{ start: () => Promise<unknown>, enqueue: (input: { record: JsonRecord, payload: unknown, path: string }) => Promise<unknown>, dispose?: () => Promise<void>, currentSnapshot?: RoomSnapshot | null, isCoordinator?: boolean }} RoomCoordinatorLike */
/** @typedef {{ mountSimulatorUI: (options: Record<string, unknown>) => SimulatorUIHandle }} SimulatorUIModule */
/** @typedef {{
 * init: (options: Record<string, unknown>) => unknown,
 * updateSnapshot: (snapshot: JsonRecord) => void,
 * dispose: () => void,
 * }} RoomSceneModule */
/** @typedef {{
 * PEAS?: Record<string, unknown>,
 * THREE?: object,
 * crypto?: Crypto,
 * fetch?: unknown,
 * window?: object,
 * setTimeout?: (callback: () => void, delay: number) => number,
 * clearTimeout?: (handle: number) => void,
 * }} RuntimeRoot */
/** @typedef {{
 * document?: object,
 * window?: object,
 * root?: object,
 * sceneContainer?: object,
 * THREE?: object,
 * fetch?: FetchLike,
 * client?: { requestJson?: JsonRequester },
 * roomStore?: object,
 * roomCoordinator?: object,
 * coordinator?: RoomCoordinatorLike,
 * coordinatorOptions?: Record<string, unknown>,
 * operationIdFactory?: () => string,
 * simulatorUI?: SimulatorUIModule,
 * roomScene?: RoomSceneModule,
 * ui?: SimulatorUIHandle,
 * automaticDelayMs?: number,
 * cycleMode?: CycleMode,
 * setTimeout?: (callback: () => void, delay: number) => number,
 * clearTimeout?: (handle: number) => void,
 * }} BootstrapOptions */

(function registerSimulatorBootstrap(/** @type {RuntimeRoot} */ root) {
  'use strict';

  const DEVICE_NAMES = Object.freeze(['janela', 'ar', 'ventilador', 'umidificador', 'lampada']);
  /** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */
  const DEVICE_ROUTES = Object.freeze({
    janela: Object.freeze({ '0': 'abrir', '1': 'fechar' }),
    ar: Object.freeze({ '0': 'ligarar', '1': 'desligarar' }),
    ventilador: Object.freeze({ '0': 'ligarventilador', '1': 'desligarventilador' }),
    umidificador: Object.freeze({ '0': 'ligarumidificador', '1': 'desligarumidificador' }),
    lampada: Object.freeze({ '0': 'ligarlampada', '1': 'desligarlampada' }),
  });

  /** @param {unknown} value @returns {value is JsonRecord} */
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** @param {unknown} value @returns {value is RoomSnapshot} */
  function isValidRoomSnapshot(value) {
    if (!isRecord(value)
      || typeof value.identity_id !== 'string'
      || value.identity_id.length === 0
      || value.identity_id.length > 128
      || typeof value.identity_generation !== 'number'
      || !Number.isSafeInteger(value.identity_generation)
      || value.identity_generation < 0
      || value.schema_version !== 1
      || typeof value.revision !== 'number'
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || typeof value.run_id !== 'string'
      || value.run_id.length === 0
      || typeof value.next_trace_order !== 'number'
      || !Number.isSafeInteger(value.next_trace_order)
      || value.next_trace_order <= 0
      || typeof value.pruned_before !== 'number'
      || !Number.isSafeInteger(value.pruned_before)
      || value.pruned_before < 0
      || !Array.isArray(value.trace)) return false;

    const computation = value.computation;
    return isRecord(computation)
      && computation.revision === value.revision
      && isRecord(computation.fisico)
      && isRecord(computation.dispositivos)
      && Array.isArray(computation.preferencias)
      && (computation.decisao === null || isRecord(computation.decisao))
      && (computation.episodio_aberto === null || isRecord(computation.episodio_aberto))
      && isRecord(computation.execucao)
      && typeof computation.execucao.pausada === 'boolean'
      && Array.isArray(computation.metricas)
      && computation.metricas.length <= 1
      && isRecord(computation.resumo)
      && (!Object.hasOwn(value, 'preferences') || Array.isArray(value.preferences))
      && (!Object.hasOwn(value, 'episodes') || Array.isArray(value.episodes))
      && Array.isArray(value.cycle_metrics)
      && (!Object.hasOwn(value, 'run_summary') || isRecord(value.run_summary))
      && (!Object.hasOwn(value, 'legacy_preferences') || isRecord(value.legacy_preferences));
  }

  /** @param {unknown} value @returns {FetchLike | null} */
  function asFetch(value) {
    return typeof value === 'function' ? /** @type {FetchLike} */ (value) : null;
  }

  /** @param {unknown} value @returns {SimulatorUIModule | null} */
  function asSimulatorUI(value) {
    return isRecord(value) && typeof value.mountSimulatorUI === 'function'
      ? /** @type {SimulatorUIModule} */ (value) : null;
  }

  /** @param {unknown} value @returns {RoomSceneModule | null} */
  function asRoomScene(value) {
    return isRecord(value)
      && typeof value.init === 'function'
      && typeof value.updateSnapshot === 'function'
      && typeof value.dispose === 'function'
      ? /** @type {RoomSceneModule} */ (value) : null;
  }

  /** @param {unknown} value @returns {object | null} */
  function asObject(value) {
    return value && typeof value === 'object' ? value : null;
  }

  /** @param {object} documentRef @param {unknown} supplied @param {string} id @returns {object | null} */
  function getElement(documentRef, supplied, id) {
    if (asObject(supplied)) return asObject(supplied);
    const getElementById = /** @type {Record<string, unknown>} */ (documentRef).getElementById;
    if (typeof getElementById !== 'function') return null;
    return asObject(getElementById.call(documentRef, id));
  }

  /** @param {unknown} value @returns {string} */
  function responseMessage(value) {
    if (isRecord(value) && typeof value.mensagem === 'string') return value.mensagem;
    if (isRecord(value) && typeof value.message === 'string') return value.message;
    return '';
  }

  /** @param {unknown} value @returns {RequestError} */
  function requestError(value) {
    if (value instanceof Error) return /** @type {RequestError} */ (value);
    return /** @type {RequestError} */ (new Error(String(value)));
  }

  /** @param {unknown} value @returns {string | null} */
  function responseCodeOf(value) {
    if (isRecord(value) && typeof value.codigo === 'string') return value.codigo;
    if (value instanceof Error) {
      const error = /** @type {RequestError} */ (value);
      if (typeof error.code === 'string') return error.code;
      if (isRecord(error.response) && typeof error.response.codigo === 'string') {
        return error.response.codigo;
      }
    }
    return null;
  }

  /** @param {unknown} value @returns {RequestError} */
  function responseError(value) {
    const error = /** @type {RequestError} */ (
      new Error(responseMessage(value) || 'A resposta do simulador não confirmou o estado.')
    );
    if (isRecord(value) && typeof value.codigo === 'string') error.code = value.codigo;
    if (isRecord(value) && typeof value.status === 'number') error.status = value.status;
    error.response = value;
    return error;
  }

  /** @param {unknown} value @returns {boolean} */
  function isConfirmedResponse(value) {
    if (!isRecord(value)) return false;
    const status = value.status;
    if (status !== undefined && status !== 'sucesso' && status !== 'success') return false;
    return stateOf(value) !== null;
  }

  /** @param {unknown} value @returns {CycleMode} */
  function normalizeCycleMode(value) {
    return value === 'cognitivo' ? 'cognitivo' : 'reativo';
  }

  /** @param {string} path @param {RequestInitLike | FetchLike} [init] @param {FetchLike} [transport] @returns {Promise<unknown>} */
  async function requestJson(path, init = {}, transport = undefined) {
    const requestInit = typeof init === 'function' || !isRecord(init) ? {} : init;
    const fetcher = asFetch(typeof init === 'function' ? init : transport ?? root.fetch);
    const nativeFetchAvailable = typeof fetch === 'function';
    if (!fetcher && !nativeFetchAvailable) throw new Error('O cliente HTTP requer fetch.');

    let response;
    try {
      response = await Promise.resolve(
        fetcher ? fetcher(path, requestInit) : fetch(path, requestInit),
      );
    } catch (error) {
      throw requestError(error);
    }

    let body;
    try {
      body = await Promise.resolve(response.json());
    } catch {
      const error = /** @type {RequestError} */ (new Error('A resposta do servidor não contém JSON válido.'));
      error.status = response.status;
      throw error;
    }

    const status = response.status;
    const failedStatus = response.ok === false
      || (typeof status === 'number' && (status < 200 || status >= 300));
    const failedEnvelope = isRecord(body)
      && (body.status === 'erro' || body.status === 'error' || body.status === 'failed');
    if (failedStatus || failedEnvelope) {
      const error = /** @type {RequestError} */ (
        new Error(responseMessage(body) || `Falha HTTP ${status ?? 'desconhecida'}.`)
      );
      error.response = body;
      error.status = status;
      if (isRecord(body) && typeof body.codigo === 'string') error.code = body.codigo;
      throw error;
    }
    return body;
  }

  /** @param {unknown} value @returns {JsonRecord | null} */
  function stateOf(value) {
    if (!isRecord(value)) return null;
    if (isRecord(value.estado)) return value.estado;
    return Object.prototype.hasOwnProperty.call(value, 'hora')
      && Object.prototype.hasOwnProperty.call(value, 'dispositivos') ? value : null;
  }

  /** @param {unknown} value @returns {string | null} */
  function decisionIdOf(value) {
    if (!isRecord(value) || !isRecord(value.decisao)) return null;
    return typeof value.decisao.decisao_id === 'string' ? value.decisao.decisao_id : null;
  }

  /** @param {unknown} response @param {string | null} decisionId @param {string} device @param {number} command @returns {string | null} */
  function correctionDecisionId(response, decisionId, device, command) {
    const decision = isRecord(response) && isRecord(response.decisao) ? response.decisao : null;
    if (!decisionId || decision?.decisao_id !== decisionId || decision.status !== 'confirmada'
      || decision.modo !== 'cognitivo') return null;
    const permitted = Array.isArray(decision.correcoes_permitidas) ? decision.correcoes_permitidas : null;
    const alternatives = Array.isArray(decision.alternativas) ? decision.alternativas : null;
    let corrections = permitted ? permitted.filter(isRecord) : [];
    if (!permitted && alternatives && alternatives.length > 0) {
      const selected = alternatives.find((alternative) => isRecord(alternative)
        && (typeof decision.strategy_id === 'string'
          ? alternative.strategy_id === decision.strategy_id
          : alternative.acao === decision.acao));
      corrections = isRecord(selected) && Array.isArray(selected.correcoes_permitidas)
        ? selected.correcoes_permitidas.filter(isRecord)
        : [];
    }
    if (!permitted && (!alternatives || alternatives.length === 0)) {
      return decisionId;
    }
    return corrections.some((correction) => isRecord(correction)
      && correction.dispositivo === device && correction.comando === command)
      ? decisionId : null;
  }

  /** @param {unknown} value @param {string} device @returns {number | null} */
  function deviceValueOf(value, device) {
    const state = stateOf(value);
    const devices = state && isRecord(state.dispositivos) ? state.dispositivos : null;
    const current = devices?.[device];
    return current === 0 || current === 1 ? current : null;
  }

  /** @param {unknown} value @param {string} device @returns {string | null} */
  function commandIdOf(value, device) {
    if (!isRecord(value) || !Array.isArray(value.etapas)) return null;
    const stages = value.etapas.filter(isRecord);
    const matching = stages.filter((stage) => stage.dispositivo === device);
    const candidates = device ? matching : stages;
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const commandId = candidates[index].comando_id;
      if (typeof commandId === 'string' && commandId) return commandId;
    }
    return null;
  }

  /** @param {string} value @returns {string} */
  function actionForStrategy(value) {
    const actions = {
      manter: 'manter',
      ventilacao_natural: 'ventilar',
      ventilacao_assistida: 'ventilar',
      circulacao_interna: 'ventilar',
      resfriamento: 'resfriar',
      resfriamento_assistido: 'resfriar',
      umidificacao: 'umidificar',
      iluminacao: 'iluminar',
    };
    return actions[value] ?? value;
  }

  /** @param {RoomSnapshot} snapshot @param {unknown} [transitionResponse] @returns {JsonRecord} */
  function responseFromSnapshot(snapshot, transitionResponse = undefined) {
    const storedLegacyResponse = isRecord(snapshot.legacy_response) ? snapshot.legacy_response : null;
    const suppliedLegacyResponse = isRecord(transitionResponse) && stateOf(transitionResponse)
      ? transitionResponse
      : null;
    const legacyResponse = suppliedLegacyResponse ?? storedLegacyResponse;
    if (legacyResponse && stateOf(legacyResponse)) {
      return {
        ...legacyResponse,
        revision: snapshot.revision,
        identity_id: snapshot.identity_id,
        identity_generation: snapshot.identity_generation,
        room_snapshot: snapshot,
      };
    }
    const computation = snapshot.computation;
    const physical = isRecord(computation.fisico) ? computation.fisico : {};
    const devices = isRecord(computation.dispositivos) ? computation.dispositivos : {};
    const decision = isRecord(computation.decisao) ? computation.decisao : null;
    /** @type {JsonRecord | null} */
    let legacyDecision = null;
    if (decision) {
      const action = actionForStrategy(String(decision.strategy_id ?? ''));
      const alternatives = Array.isArray(decision.alternativas)
        ? decision.alternativas.filter(isRecord).map((alternative) => ({
          ...alternative,
          acao: actionForStrategy(String(alternative.strategy_id ?? '')),
        }))
        : [];
      legacyDecision = {
        ...decision,
        acao: action,
        acoes: [action],
        motivo: typeof decision.motivo === 'string' ? decision.motivo : '',
        alternativas: alternatives,
      };
    }
    const responseRecord = isRecord(transitionResponse) ? transitionResponse : null;
    const eventCandidates = Array.isArray(responseRecord?.events)
      ? responseRecord.events.filter(isRecord)
      : snapshot.trace.filter(isRecord).slice(-4);
    const latestActionEvent = [...eventCandidates].reverse().find((event) => (
      event.tipo === 'cycle' || event.tipo === 'manual_command'
    ));
    const latestData = isRecord(latestActionEvent?.dados) ? latestActionEvent.dados : null;
    const stages = Array.isArray(latestData?.steps)
      ? latestData.steps.filter(isRecord)
      : decision && Array.isArray(decision.plano) ? decision.plano.filter(isRecord) : [];
    return {
      status: 'success',
      mensagem: typeof responseRecord?.message === 'string' ? responseRecord.message : '',
      revision: snapshot.revision,
      identity_id: snapshot.identity_id,
      identity_generation: snapshot.identity_generation,
      room_snapshot: snapshot,
      estado: {
        ...physical,
        dispositivos: devices,
        ...(typeof decision?.modo === 'string' ? { modo: decision.modo } : {}),
      },
      decisao: legacyDecision,
      etapas: stages,
    };
  }

  /** @param {unknown} value @returns {string} */
  function canonicalJson(value) {
    const encoder = new TextEncoder();
    /** @param {number} value @returns {string} */
    function pythonNumber(value) {
      if (!Number.isFinite(value)) throw new TypeError('A transição contém um número não finito.');
      if (value === 0) return '0';
      if (Object.is(value, -0)) return '0';
      const negative = value < 0;
      const raw = Math.abs(value).toString().toLowerCase();
      const [coefficient, exponentText = '0'] = raw.split('e');
      const exponent = Number(exponentText);
      const point = coefficient.indexOf('.');
      let decimalPosition = (point < 0 ? coefficient.length : point) + exponent;
      let digits = coefficient.replace('.', '');
      while (digits.startsWith('0')) {
        digits = digits.slice(1);
        decimalPosition -= 1;
      }
      while (digits.endsWith('0')) digits = digits.slice(0, -1);
      const sign = negative ? '-' : '';
      const scientificExponent = decimalPosition - 1;
      if (scientificExponent >= -4 && scientificExponent < 16) {
        if (decimalPosition <= 0) return `${sign}0.${'0'.repeat(-decimalPosition)}${digits}`;
        if (decimalPosition >= digits.length) return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
        return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
      }
      const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
      const exponentSign = scientificExponent >= 0 ? '+' : '-';
      const exponentDigits = String(Math.abs(scientificExponent)).padStart(2, '0');
      return `${sign}${mantissa}e${exponentSign}${exponentDigits}`;
    }

    /** @param {unknown} input @returns {string} */
    function serialize(input) {
      if (input === null) return 'null';
      if (typeof input === 'boolean') return input ? 'true' : 'false';
      if (typeof input === 'number') return pythonNumber(input);
      if (typeof input === 'string') return JSON.stringify(input);
      if (Array.isArray(input)) return `[${input.map(serialize).join(',')}]`;
      if (!isRecord(input)) throw new TypeError('A transição contém dados que não podem ser serializados.');
      const byteCache = new Map();
      const keys = Object.keys(input).sort((left, right) => {
        const leftBytes = byteCache.get(left) ?? encoder.encode(left);
        const rightBytes = byteCache.get(right) ?? encoder.encode(right);
        byteCache.set(left, leftBytes);
        byteCache.set(right, rightBytes);
        const limit = Math.min(leftBytes.length, rightBytes.length);
        for (let index = 0; index < limit; index += 1) {
          if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
        }
        return leftBytes.length - rightBytes.length;
      });
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(input[key])}`).join(',')}}`;
    }
    return serialize(value);
  }

  /** @param {JsonRecord} envelope @returns {Promise<string>} */
  async function payloadHash(envelope) {
    const cryptoRef = /** @type {Crypto | undefined} */ (root.crypto);
    if (!cryptoRef?.subtle) throw new Error('O cliente requer Web Crypto para assinar operações.');
    const hashInput = { ...envelope };
    delete hashInput.payload_hash;
    const bytes = new TextEncoder().encode(canonicalJson(hashInput));
    const digest = await cryptoRef.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /** @param {JsonRecord} operation @param {unknown} payload @param {RoomSnapshot} snapshot @returns {Promise<{ operation: JsonRecord, payload: JsonRecord }>} */
  async function rebaseTransitionOperation(operation, payload, snapshot) {
    const previousRequest = isRecord(payload) ? payload : {};
    const transitionPayload = isRecord(previousRequest.payload)
      ? previousRequest.payload
      : { kind: operation.operation };
    const envelope = {
      schema_version: 1,
      identity_id: operation.identity_id,
      identity_generation: operation.identity_generation,
      base_revision: snapshot.revision,
      operation_id: operation.operation_id,
      payload_hash: '',
      operation: operation.operation,
      computation: snapshot.computation,
      payload: transitionPayload,
    };
    envelope.payload_hash = await payloadHash(envelope);
    return {
      operation: {
        ...operation,
        base_revision: snapshot.revision,
        new_revision: snapshot.revision + 1,
        payload_hash: envelope.payload_hash,
        payload: envelope,
      },
      payload: envelope,
    };
  }

  /** @param {unknown} response @param {JsonRecord} operation @param {RoomSnapshot} current @returns {RoomSnapshot | null} */
  function snapshotFromTransition(response, operation, current) {
    const operationIdentityId = operation.identity_id;
    const operationIdentityGeneration = operation.identity_generation;
    const operationRevision = operation.new_revision;
    if (!isRecord(response)
      || typeof operationIdentityId !== 'string'
      || typeof operationIdentityGeneration !== 'number'
      || typeof operationRevision !== 'number'
      || response.status !== 'success'
      || response.identity_id !== operationIdentityId
      || response.identity_generation !== operationIdentityGeneration
      || response.new_revision !== operationRevision
      || !isRecord(response.computation)
      || response.computation.revision !== operationRevision) return null;
    const computation = response.computation;
    const nextRunId = isRecord(computation.resumo) && typeof computation.resumo.run_id === 'string'
      ? computation.resumo.run_id
      : current.run_id;
    const newRun = nextRunId !== current.run_id;
    const trace = newRun ? [] : [...current.trace];
    const cycleMetrics = newRun
      ? []
      : Array.isArray(current.cycle_metrics) ? [...current.cycle_metrics] : [];
    const incomingMetrics = Array.isArray(computation.metricas)
      ? computation.metricas.filter(isRecord)
      : [];
    for (const metric of incomingMetrics) {
      const existingIndex = cycleMetrics.findIndex(
        (item) => isRecord(item) && item.cycle_id === metric.cycle_id,
      );
      if (existingIndex >= 0) cycleMetrics[existingIndex] = metric;
      else cycleMetrics.push(metric);
    }
    let nextTraceOrder = newRun ? 1 : current.next_trace_order;
    const events = Array.isArray(response.events) ? response.events.filter(isRecord) : [];
    for (const event of events) {
      if (event.run_id !== nextRunId) return null;
      trace.push({ ...event, ordem: nextTraceOrder });
      nextTraceOrder += 1;
    }
    let episodes = newRun
      ? []
      : Array.isArray(current.episodes) ? [...current.episodes] : [];
    for (const event of events) {
      if (event.tipo !== 'episode' || !isRecord(event.dados)) continue;
      const episodeId = event.dados.episode_id;
      const status = event.dados.status;
      if (typeof episodeId !== 'string' || typeof status !== 'string') continue;
      const position = episodes.findIndex((episode) => isRecord(episode) && episode.episode_id === episodeId);
      const closedEpisode = isRecord(event.dados.episode)
        && event.dados.episode.episode_id === episodeId
        ? event.dados.episode
        : null;
      if (position >= 0) {
        episodes[position] = {
          ...episodes[position],
          ...(closedEpisode ?? {}),
          status,
        };
      } else if (closedEpisode) {
        episodes.push({ ...closedEpisode, status });
      }
    }
    if (isRecord(computation.episodio_aberto)) {
      const openEpisode = computation.episodio_aberto;
      const position = episodes.findIndex((episode) => isRecord(episode) && episode.episode_id === openEpisode.episode_id);
      if (position >= 0) episodes[position] = openEpisode;
      else episodes.push(openEpisode);
    }
    return {
      ...current,
      identity_id: operationIdentityId,
      identity_generation: operationIdentityGeneration,
      schema_version: 1,
      revision: operationRevision,
      run_id: nextRunId,
      next_trace_order: nextTraceOrder,
      pruned_before: newRun ? 0 : current.pruned_before,
      computation,
      trace,
      preferences: Array.isArray(computation.preferencias) ? computation.preferencias : [],
      episodes,
      cycle_metrics: cycleMetrics,
      run_summary: isRecord(computation.resumo) ? computation.resumo : {},
      legacy_preferences: isRecord(current.legacy_preferences) ? current.legacy_preferences : {},
    };
  }

  /** @param {unknown} value @returns {SimulatorUIHandle} */
  function requireUI(value) {
    if (!isRecord(value) || typeof value.destroy !== 'function') {
      throw new TypeError('O bootstrap requer uma UI do simulador montada.');
    }
    return /** @type {SimulatorUIHandle} */ (value);
  }

  /** @param {SimulatorUIHandle} ui @param {unknown} response @param {string} state @returns {boolean} */
  function deliverToUI(ui, response, state) {
    const apply = /** @type {((value: unknown, nextState?: string) => unknown) | undefined} */ (
      ui.applyResponse ?? ui.receiveResponse ?? ui.renderState
    );
    return typeof apply !== 'function' || apply.call(ui, response, state) !== false;
  }

  /** @param {SimulatorUIHandle} ui @param {unknown} error */
  function reportToUI(ui, error) {
    const report = ui.reportError ?? ui.renderError;
    if (typeof report === 'function') report.call(ui, error);
  }

  /** @param {SimulatorUIHandle} ui @param {string} state */
  function setUIState(ui, state) {
    const setState = ui.setUIState ?? ui.setState;
    if (typeof setState === 'function') setState.call(ui, state);
  }

  /** @param {SimulatorUIHandle} ui @param {string} message */
  function setFeedbackStatus(ui, message) {
    if (typeof ui.setFeedbackStatus === 'function') ui.setFeedbackStatus(message);
  }

  /** @param {SimulatorUIHandle} ui */
  function clearLearningResult(ui) {
    if (typeof ui.clearLearningResult === 'function') ui.clearLearningResult.call(ui);
  }

  /** @param {BootstrapOptions} [input] */
  function bootstrapSimulator(input = {}) {
    const options = isRecord(input) ? /** @type {BootstrapOptions} */ (input) : {};
    const documentRef = asObject(options.document) ?? (typeof document === 'undefined' ? null : document);
    if (!documentRef) throw new TypeError('bootstrapSimulator requer um document.');
    const rootElement = getElement(documentRef, options.root, 'prototypeRoot');
    if (!rootElement) throw new Error('A raiz #prototypeRoot do simulador não foi encontrada.');

    const namespace = isRecord(root.PEAS) ? root.PEAS : {};
    const uiModule = asSimulatorUI(options.simulatorUI ?? namespace.simulatorUI);
    const sceneModule = asRoomScene(options.roomScene ?? namespace.roomScene);
    const roomStoreDependency = asObject(options.roomStore ?? namespace.roomStore);
    const roomCoordinatorDependency = asObject(options.roomCoordinator ?? namespace.roomCoordinator);
    const sceneContainer = getElement(documentRef, options.sceneContainer, 'scene-region');
    const three = options.THREE ?? root.THREE;
    const fetcher = asFetch(options.fetch ?? root.fetch);
    const client = isRecord(options.client) ? options.client : null;
    const clientRequest = client && typeof client.requestJson === 'function'
      ? /** @type {JsonRequester} */ (client.requestJson)
      : null;
    if (!options.ui && (!uiModule || typeof uiModule.mountSimulatorUI !== 'function')) {
      throw new TypeError('bootstrapSimulator requer simulator-ui.js.');
    }

    /** @type {SimulatorUIHandle} */
    let ui;
    let destroyed = false;
    let sceneInitialized = false;
    let scene = null;
    let automatic = false;
    let cycleInFlight = false;
    /** @type {CycleMode} */
    let selectedCycleMode = normalizeCycleMode(options.cycleMode);
    /** @type {number | null} */
    let automaticTimer = null;
    /** @type {string | null} */
    let confirmedDecisionId = null;
    /** @type {JsonRecord | null} */
    let lastResponse = null;
    /** @type {RoomStoreLike | null} */
    let roomStore = null;
    /** @type {RoomCoordinatorLike | null} */
    let coordinator = options.coordinator ?? null;
    /** @type {RoomSnapshot | null} */
    let confirmedSnapshot = null;
    /** @type {string | null} */
    let identityId = null;
    /** @type {number | null} */
    let identityGeneration = null;
    /** @type {Promise<unknown | null>} */
    let ready = Promise.resolve(null);

    function clearCorrelation() {
      confirmedDecisionId = null;
    }

    /** @param {string} source @param {unknown} error */
    function clearCorrelationOnFailure(source, error) {
      const code = responseCodeOf(error);
      if (source === 'preset'
        || source === 'reset'
        || source === 'cycle'
        || code === 'decisao_obsoleta') {
        clearCorrelation();
      }
    }

    /** @param {unknown} error */
    function report(error) {
      if (!destroyed) reportToUI(ui, requestError(error));
    }

    /** @param {unknown} response @param {string} state @param {string} source @param {string} [device] @returns {boolean} */
    function acceptResponse(response, state, source, device) {
      if (destroyed) return false;
      if (!isConfirmedResponse(response)) {
        clearCorrelationOnFailure(source, response);
        reportToUI(ui, responseError(response));
        return false;
      }
      if (!deliverToUI(ui, response, state)) {
        clearCorrelationOnFailure(source, response);
        return false;
      }
      const snapshot = stateOf(response);
      if (snapshot && sceneInitialized && sceneModule) {
        try {
          sceneModule.updateSnapshot(snapshot);
        } catch (error) {
          sceneInitialized = false;
          report(error);
        }
      }
      if (isRecord(response)) lastResponse = response;
      if (source !== 'feedback') setFeedbackStatus(ui, '');
      if (source === 'environment') {
        const decision = isRecord(response) && isRecord(response.decisao)
          ? response.decisao
          : null;
        if (decision?.status === 'prevista' || decision?.status === 'invalidada') {
          clearCorrelation();
        } else {
          const decisionId = decisionIdOf(response);
          if (decisionId) confirmedDecisionId = decisionId;
        }
      } else if (source === 'cycle') {
        confirmedDecisionId = decisionIdOf(response);
      } else if (source === 'manual') {
        const decisionId = decisionIdOf(response);
        if (decisionId) confirmedDecisionId = decisionId;
      } else if (source === 'preset' || source === 'reset') {
        clearCorrelation();
      }
      return true;
    }

    /** @param {RoomSnapshot} snapshot @param {unknown} [transitionResponse] @param {string} [state] @param {string} [source] @param {string} [device] @returns {boolean} */
    function renderPersistedSnapshot(snapshot, transitionResponse = undefined, state = 'pausado', source = 'status', device = undefined) {
      if (!isValidRoomSnapshot(snapshot)) return false;
      if (identityId !== null && snapshot.identity_id !== identityId) return false;
      if (identityGeneration !== null && snapshot.identity_generation !== identityGeneration) return false;
      if (confirmedSnapshot && snapshot.revision < confirmedSnapshot.revision) return false;
      if (confirmedSnapshot && snapshot.revision === confirmedSnapshot.revision) return true;
      const response = responseFromSnapshot(snapshot, transitionResponse);
      if (!acceptResponse(response, state, source, device)) return false;
      confirmedSnapshot = snapshot;
      const decision = isRecord(snapshot.computation.decisao) ? snapshot.computation.decisao : null;
      const legacyDecision = isRecord(snapshot.legacy_response) && isRecord(snapshot.legacy_response.decisao)
        ? snapshot.legacy_response.decisao
        : null;
      confirmedDecisionId = decision?.status === 'confirmada' && typeof decision.decisao_id === 'string'
        ? decision.decisao_id
        : legacyDecision?.status === 'confirmada' && typeof legacyDecision.decisao_id === 'string'
          ? legacyDecision.decisao_id
          : null;
      return true;
    }

    /** @param {unknown} error */
    function responseBodyFromError(error) {
      const request = requestError(error);
      return isRecord(request.response) ? request.response : null;
    }

    /** @param {JsonRecord} operation @param {JsonRecord} payload @param {string} state @param {string} source @param {string} [device] @returns {Promise<unknown | null>} */
    async function enqueueMutation(operation, payload, state, source, device) {
      await ready;
      if (destroyed) return null;
      if (!roomStore || !coordinator || identityId === null || identityGeneration === null) {
        throw new Error('O cliente coordenado não carregou uma identidade persistida.');
      }
      let snapshot = coordinator.currentSnapshot
        ?? await roomStore.getRoom(identityId, identityGeneration);
      if (!snapshot
        || snapshot.identity_id !== identityId
        || snapshot.identity_generation !== identityGeneration) {
        throw new Error('O snapshot confirmado desta identidade não está disponível.');
      }
      if (operation.operation === 'reset') {
        // Reset is the recovery path for malformed nested state persisted by an older client.
        // Send a known-valid seed at the current revision; the accepted response replaces the room.
        snapshot = {
          ...snapshot,
          computation: {
            revision: snapshot.revision,
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
            resumo: {
              run_id: identityId,
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
            },
          },
        };
      }
      const configuredFactory = options.operationIdFactory
        ?? (isRecord(roomStore) && typeof roomStore.idFactory === 'function'
          ? /** @type {() => string} */ (roomStore.idFactory)
          : null);
      const cryptoRef = root.crypto;
      const operationId = configuredFactory
        ? configuredFactory()
        : typeof cryptoRef?.randomUUID === 'function'
          ? cryptoRef.randomUUID()
          : (() => {
            if (!cryptoRef || typeof cryptoRef.getRandomValues !== 'function') {
              throw new Error('O cliente requer aleatoriedade criptográfica para criar operation_id.');
            }
            const bytes = new Uint8Array(16);
            cryptoRef.getRandomValues(bytes);
            return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
          })();
      if (typeof operationId !== 'string' || operationId.length === 0) {
        throw new TypeError('operation_id precisa ser uma string não vazia.');
      }
      const pendingOperation = {
        identity_id: identityId,
        identity_generation: identityGeneration,
        operation_id: operationId,
        payload_hash: '',
        base_revision: snapshot.revision,
        new_revision: snapshot.revision + 1,
        operation: operation.operation,
        status: 'pending',
        attempts: 0,
        enqueued_at: Date.now(),
        path: '/interf/transition',
      };
      const prepared = await rebaseTransitionOperation(pendingOperation, { payload }, snapshot);
      const record = { ...prepared.operation, status: 'pending', attempts: 0 };
      const expectedRevision = snapshot.revision + 1;
      const transitionResponse = await coordinator.enqueue({
        record,
        payload: prepared.payload,
        path: '/interf/transition',
      });
      const latestSnapshot = await roomStore.getRoom(identityId, identityGeneration);
      if (!latestSnapshot
        || latestSnapshot.identity_id !== identityId
        || latestSnapshot.identity_generation !== identityGeneration
        || latestSnapshot.revision < expectedRevision) {
        report(new Error('A resposta não corresponde a um snapshot persistido compatível.'));
        return null;
      }
      const responseRevision = isRecord(transitionResponse) ? transitionResponse.new_revision : null;
      const confirmedTransition = responseRevision === latestSnapshot.revision ? transitionResponse : undefined;
      const accepted = !destroyed && renderPersistedSnapshot(
        latestSnapshot,
        confirmedTransition,
        state,
        source,
        device,
      );
      return accepted ? responseFromSnapshot(latestSnapshot, confirmedTransition) : null;
    }

    /** @param {string} path @param {JsonRecord} payload @param {string | (() => string)} state @param {string} source @param {string} [device] @returns {Promise<unknown | null>} */
    async function post(path, payload, state, source, device) {
      let operation;
      let operationPayload;
      if (path === '/interf/ciclo') {
        operation = 'cycle';
        operationPayload = { kind: 'cycle', mode: normalizeCycleMode(payload.modo) };
      } else if (path === '/interf/ambiente') {
        operation = 'environment';
        operationPayload = { kind: 'environment', ...payload };
      } else if (path === '/interf/preset') {
        operation = 'preset';
        operationPayload = { kind: 'preset', preset: payload.preset };
      } else if (path === '/interf/reset') {
        operation = 'reset';
        operationPayload = { kind: 'reset' };
      } else if (path === '/interf/feedback') {
        operation = 'feedback';
        operationPayload = {
          kind: 'feedback',
          decisao_id: payload.decisao_id,
          tipo: payload.tipo,
          comando_id: payload.comando_id ?? null,
        };
      } else if (source === 'manual' && device) {
        const current = deviceValueOf(lastResponse, device);
        if (current === null) throw new Error('O dispositivo ainda não possui estado confirmado.');
        const command = current === 1 ? 0 : 1;
        operation = 'manual_command';
        operationPayload = {
          kind: 'manual_command',
          device,
          command,
          decisao_id: correctionDecisionId(lastResponse, confirmedDecisionId, device, command),
        };
      } else {
        throw new Error(`A mutação coordenada não reconhece a rota ${path}.`);
      }
      const nextState = typeof state === 'function' ? state() : state;
      return enqueueMutation({ operation }, operationPayload, nextState, source, device);
    }

    /** @param {string} operation @param {JsonRecord} payload @param {string} state @param {string} source @returns {Promise<unknown | null>} */
    async function postRoomOperation(operation, payload, state, source) {
      return enqueueMutation({ operation }, { kind: operation, ...payload }, state, source);
    }

    /** @param {string} path @param {JsonRecord} payload @param {string} state @param {string} source @param {string} [device] @returns {Promise<unknown | null>} */
    async function safePost(path, payload, state, source, device) {
      try {
        return await post(path, payload, state, source, device);
      } catch (error) {
        clearCorrelationOnFailure(source, error);
        report(error);
        return null;
      }
    }

    /** @param {string} operation @param {JsonRecord} payload @param {string} state @param {string} source @returns {Promise<unknown | null>} */
    async function safeRoomOperation(operation, payload, state, source) {
      try {
        return await postRoomOperation(operation, payload, state, source);
      } catch (error) {
        clearCorrelationOnFailure(source, error);
        report(error);
        return null;
      }
    }

    /** @param {string} feedback @returns {string} */
    function feedbackMessage(feedback) {
      if (feedback === 'aceitar') return 'Feedback aceito; preferência atualizada.';
      if (feedback === 'rejeitar') return 'Feedback rejeitado; preferência atualizada.';
      return 'Correção registrada; preferência ajustada para este contexto.';
    }

    /** @param {string} decisionId @param {string} feedback @param {string | undefined} commandId */
    async function postFeedback(decisionId, feedback, commandId = undefined) {
      const response = await safePost(
        '/interf/feedback',
        {
          decisao_id: decisionId,
          tipo: feedback,
          ...(commandId ? { comando_id: commandId } : {}),
        },
        'pronto',
        'feedback',
      );
      if (response) setFeedbackStatus(ui, feedbackMessage(feedback));
      return response;
    }

    const setTimer = options.setTimeout
      ?? (typeof root.setTimeout === 'function' ? root.setTimeout.bind(root) : null);
    const clearTimer = options.clearTimeout
      ?? (typeof root.clearTimeout === 'function' ? root.clearTimeout.bind(root) : null);

    /** @param {boolean} [renderPaused=true] */
    function stopAutomatic(renderPaused = true) {
      automatic = false;
      if (automaticTimer !== null) {
        clearTimer?.(automaticTimer);
        automaticTimer = null;
      }
      if (renderPaused && !destroyed) setUIState(ui, 'pausado');
    }

    function stopAutomaticForMutation() {
      const wasAutomatic = automatic;
      stopAutomatic(false);
      if (wasAutomatic) void safeRoomOperation('pause', {}, 'pausado', 'pause');
    }

    function scheduleAutomaticCycle() {
      if (destroyed || !automatic || cycleInFlight || automaticTimer !== null) return;
      if (!setTimer) {
        automatic = false;
        report(new Error('O cliente não encontrou um agendador para o modo automático.'));
        return;
      }
      const configuredDelay = options.automaticDelayMs;
      const delay = typeof configuredDelay === 'number' && Number.isFinite(configuredDelay) && configuredDelay >= 0
        ? configuredDelay : 1000;
      automaticTimer = setTimer(() => {
        automaticTimer = null;
        void runCycle(true, selectedCycleMode);
      }, delay);
    }

    /** @param {boolean} isAutomatic @param {unknown} [mode] @returns {Promise<unknown | null>} */
    async function runCycle(isAutomatic, mode = selectedCycleMode) {
      if (destroyed || cycleInFlight) return null;
      cycleInFlight = true;
      clearLearningResult(ui);
      try {
        return await post(
          '/interf/ciclo',
          { modo: normalizeCycleMode(mode) },
          () => isAutomatic && automatic ? 'automatico' : 'pausado',
          'cycle',
        );
      } catch (error) {
        automatic = false;
        if (automaticTimer !== null) {
          clearTimer?.(automaticTimer);
          automaticTimer = null;
        }
        clearCorrelationOnFailure('cycle', error);
        report(error);
        return null;
      } finally {
        cycleInFlight = false;
        if (!destroyed && automatic && isAutomatic) scheduleAutomaticCycle();
      }
    }

    /** @param {unknown} payload @returns {Promise<unknown | null>} */
    async function handleEnvironment(payload) {
      stopAutomaticForMutation();
      if (!isRecord(payload)) {
        report(new Error('O ajuste ambiental requer os sete campos do ambiente.'));
        return null;
      }
      return safePost('/interf/ambiente', payload, 'pronto', 'environment');
    }

    /** @param {unknown} preset */
    function handlePreset(preset) {
      stopAutomaticForMutation();
      clearCorrelation();
      return safePost('/interf/preset', { preset }, 'pronto', 'preset');
    }

    function handleReset() {
      stopAutomaticForMutation();
      clearCorrelation();
      return safePost('/interf/reset', {}, 'pausado', 'reset');
    }

    function handleNewRun() {
      stopAutomaticForMutation();
      clearCorrelation();
      return safeRoomOperation('new_run', {}, 'pausado', 'new_run');
    }

    /** @param {unknown} device @returns {Promise<unknown | null>} */
    async function handleDevice(device) {
      stopAutomaticForMutation();
      if (typeof device !== 'string' || !DEVICE_NAMES.includes(device)) {
        report(new Error('Dispositivo desconhecido.'));
        return null;
      }
      const current = deviceValueOf(lastResponse, device);
      if (current === null) {
        report(new Error('O dispositivo ainda não possui estado confirmado.'));
        return null;
      }
      const routes = /** @type {Record<string, string>} */ (DEVICE_ROUTES[device]);
      const route = routes[String(current)];
      return safePost(`/interf/${route}`, {}, 'pronto', 'manual', device);
    }

    /** @param {unknown} feedback @returns {Promise<unknown | null>} */
    async function handleFeedback(feedback) {
      stopAutomaticForMutation();
      if (feedback !== 'aceitar' && feedback !== 'rejeitar') {
        report(new Error('Tipo de feedback desconhecido.'));
        return null;
      }
      if (!confirmedDecisionId) {
        report(new Error('O feedback requer uma decisão confirmada.'));
        return null;
      }
      return postFeedback(
        confirmedDecisionId,
        feedback,
      );
    }

    function handlePause() {
      stopAutomatic(true);
      return safeRoomOperation('pause', {}, 'pausado', 'pause');
    }

    /** @param {unknown} [mode] */
    function handleAutomatic(mode) {
      if (automatic) {
        return handlePause();
      }
      if (destroyed) return null;
      clearLearningResult(ui);
      selectedCycleMode = normalizeCycleMode(mode ?? selectedCycleMode);
      automatic = true;
      setUIState(ui, 'automatico');
      void safeRoomOperation('resume', {}, 'automatico', 'resume').then((response) => {
        if (!response && automatic) stopAutomatic(true);
        else if (automatic) scheduleAutomaticCycle();
      });
      return null;
    }

    /** @param {unknown} [mode] */
    function handleCycle(mode) {
      if (automatic) {
        return handlePause();
      }
      selectedCycleMode = normalizeCycleMode(mode ?? selectedCycleMode);
      stopAutomatic(false);
      return runCycle(false, selectedCycleMode);
    }

    const callbacks = {
      onEnvironment: handleEnvironment,
      onEnvironmentChange: handleEnvironment,
      onEnvironmentIntent: handleEnvironment,
      onPreset: handlePreset,
      onPresetIntent: handlePreset,
      onReset: handleReset,
      onResetIntent: handleReset,
      onNewRun: handleNewRun,
      onNewRunIntent: handleNewRun,
      onCycle: handleCycle,
      onCycleIntent: handleCycle,
      onPause: handlePause,
      onPauseIntent: handlePause,
      onAuto: handleAutomatic,
      onAutoIntent: handleAutomatic,
      onAutomatic: handleAutomatic,
      onDevice: handleDevice,
      onDeviceIntent: handleDevice,
      onFeedback: handleFeedback,
      onFeedbackIntent: handleFeedback,
    };

    ui = requireUI(options.ui ?? uiModule?.mountSimulatorUI({
      document: documentRef,
      root: rootElement,
      callbacks,
      ...callbacks,
    }));
    setUIState(ui, 'pausado');

    const sceneIntent = typeof ui.handleDeviceIntent === 'function' ? ui.handleDeviceIntent : handleDevice;
    if (sceneModule && sceneContainer && three) {
      try {
        scene = sceneModule.init({ THREE: three, container: sceneContainer, onDeviceIntent: sceneIntent });
        sceneInitialized = Boolean(scene);
      } catch (error) {
        scene = null;
        sceneInitialized = false;
        report(error);
      }
    }

    /** @param {string} path @param {RequestInitLike} [init] @returns {Promise<unknown>} */
    const fetchRequest = (path, init = {}) => clientRequest
      ? Promise.resolve(clientRequest.call(client, path, init))
      : requestJson(path, init, fetcher ?? undefined);

    /** @param {unknown} event */
    function handleCoordinatorState(event) {
      if (!isRecord(event)) return;
      if (event.type === 'committed'
        && roomStore
        && identityId
        && typeof identityGeneration === 'number') {
        void roomStore.getRoom(identityId, identityGeneration)
          .then((snapshot) => {
            if (snapshot && !destroyed) {
              renderPersistedSnapshot(snapshot, undefined, automatic ? 'automatico' : 'pausado', 'status');
            }
          })
          .catch(report);
        return;
      }
      if (event.type === 'identity_mismatch'
        || event.type === 'stale'
        || event.type === 'error'
        || event.type === 'operation_error'
        || (event.type === 'operation_status' && event.status === 'unknown')) {
        const message = typeof event.error === 'string'
          ? event.error
          : event.type === 'operation_status'
            ? 'A operação está sem confirmação; o coordinator continuará o retry com o mesmo ID.'
            : event.type === 'identity_mismatch'
              ? 'A resposta pertence a outra identidade e foi descartada.'
              : event.type === 'stale'
                ? 'A resposta está obsoleta e foi descartada.'
                : 'O coordinator não conseguiu confirmar a operação.';
        report(new Error(message));
      }
    }

    /** @returns {Promise<unknown | null>} */
    async function initializeClient() {
      if (!roomStoreDependency) throw new TypeError('bootstrapSimulator requer room-store.js.');
      if (typeof roomStoreDependency.getRooms === 'function'
        && typeof roomStoreDependency.getRoom === 'function') {
        roomStore = /** @type {RoomStoreLike} */ (roomStoreDependency);
      } else if (typeof roomStoreDependency.openRoomDatabase === 'function') {
        roomStore = /** @type {RoomStoreLike} */ (
          await Promise.resolve(roomStoreDependency.openRoomDatabase.call(roomStoreDependency))
        );
      }
      if (!roomStore) throw new TypeError('room-store.js não fornece um store aberto.');

      let rooms = await roomStore.getRooms();
      rooms = rooms.filter((room) => isRecord(room)
        && typeof room.identity_id === 'string'
        && typeof room.identity_generation === 'number');
      rooms.sort((left, right) => right.identity_generation - left.identity_generation
        || right.revision - left.revision);
      let selectedRoom = rooms[0] ?? null;
      if (!selectedRoom) {
        const createStoreIdentity = /** @type {Record<string, unknown>} */ (roomStore).createIdentity;
        const createModuleIdentity = roomStoreDependency.createIdentity;
        if (typeof createStoreIdentity === 'function') {
          selectedRoom = /** @type {RoomSnapshot} */ (
            await Promise.resolve(createStoreIdentity.call(roomStore))
          );
        } else if (typeof createModuleIdentity === 'function') {
          selectedRoom = /** @type {RoomSnapshot} */ (
            await Promise.resolve(createModuleIdentity.call(roomStoreDependency, roomStore))
          );
        } else {
          throw new Error('O room-store não tem identidade persistida nem pode criar uma.');
        }
      }
      identityId = selectedRoom.identity_id;
      identityGeneration = selectedRoom.identity_generation;
      let persistedSnapshot = await roomStore.getRoom(identityId, identityGeneration);
      if (!isValidRoomSnapshot(persistedSnapshot)) {
        const recoverSnapshot = /** @type {Record<string, unknown>} */ (roomStore).recoverSnapshot;
        const recoveredSnapshot = typeof recoverSnapshot === 'function'
          ? await Promise.resolve(recoverSnapshot.call(roomStore, identityId))
          : null;
        if (!isValidRoomSnapshot(recoveredSnapshot)
          || recoveredSnapshot.identity_id !== identityId
          || recoveredSnapshot.identity_generation !== identityGeneration) {
          throw new Error('O snapshot persistido não corresponde ao schema da identidade.');
        }
        const putRoom = /** @type {Record<string, unknown>} */ (roomStore).putRoom;
        if (typeof putRoom !== 'function') {
          throw new Error('O snapshot de recuperação não pode ser restaurado em rooms.');
        }
        await Promise.resolve(putRoom.call(roomStore, recoveredSnapshot));
        persistedSnapshot = await roomStore.getRoom(identityId, identityGeneration);
      }
      if (!isValidRoomSnapshot(persistedSnapshot)
        || persistedSnapshot.identity_id !== identityId
        || persistedSnapshot.identity_generation !== identityGeneration) {
        throw new Error('O snapshot confirmado da identidade não está válido em rooms.');
      }

      if (!coordinator) {
        const createCoordinator = roomCoordinatorDependency?.createRoomCoordinator;
        if (typeof createCoordinator !== 'function') {
          throw new TypeError('bootstrapSimulator requer room-coordinator.js.');
        }
        const coordinatorOptions = {
          ...(isRecord(options.coordinatorOptions) ? options.coordinatorOptions : {}),
          roomStore,
          identityId,
          identityGeneration,
          sendRequest: async (_operation, payload, path) => {
            const init = {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              body: canonicalJson(payload),
            };
            try {
              return await fetchRequest(path, init);
            } catch (error) {
              const response = responseBodyFromError(error);
              if (response) return response;
              throw error;
            }
          },
          snapshotFromResponse: snapshotFromTransition,
          rebaseOperation: rebaseTransitionOperation,
          onState: handleCoordinatorState,
        };
        coordinator = /** @type {RoomCoordinatorLike} */ (
          createCoordinator.call(roomCoordinatorDependency, coordinatorOptions)
        );
      }
      if (!coordinator || typeof coordinator.start !== 'function' || typeof coordinator.enqueue !== 'function') {
        throw new TypeError('O coordinator injetado não implementa start e enqueue.');
      }
      await coordinator.start();
      if (destroyed) {
        await coordinator.dispose?.();
        return null;
      }
      const latestSnapshot = await roomStore.getRoom(identityId, identityGeneration);
      if (!isValidRoomSnapshot(latestSnapshot)
        || latestSnapshot.identity_id !== identityId
        || latestSnapshot.identity_generation !== identityGeneration) {
        throw new Error('O snapshot confirmado desapareceu ou está inválido durante o bootstrap.');
      }
      if (!renderPersistedSnapshot(latestSnapshot, undefined, 'pausado', 'status')) {
        throw new Error('O snapshot confirmado não pôde ser aplicado durante o bootstrap.');
      }
      return responseFromSnapshot(latestSnapshot);
    }

    ready = initializeClient().catch((error) => {
      report(error);
      return null;
    });

    const windowRef = options.window ?? root.window ?? null;
    const windowRecord = asObject(windowRef);
    const addEventListener = windowRecord && /** @type {Record<string, unknown>} */ (windowRecord).addEventListener;
    const removeEventListener = windowRecord && /** @type {Record<string, unknown>} */ (windowRecord).removeEventListener;
    let pagehideAttached = false;
    const onPageHide = () => { destroy(); };
    if (typeof addEventListener === 'function') {
      addEventListener.call(windowRef, 'pagehide', onPageHide, { once: true });
      pagehideAttached = true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      automatic = false;
      if (automaticTimer !== null) {
        clearTimer?.(automaticTimer);
        automaticTimer = null;
      }
      if (pagehideAttached && typeof removeEventListener === 'function') {
        removeEventListener.call(windowRef, 'pagehide', onPageHide);
        pagehideAttached = false;
      }
      try {
        ui.destroy();
      } finally {
        const disposed = coordinator?.dispose?.();
        if (disposed && typeof disposed.then === 'function') {
          const closeStore = () => {
            const close = roomStore && /** @type {Record<string, unknown>} */ (roomStore).close;
            if (typeof close === 'function') close.call(roomStore);
          };
          void disposed.then(closeStore, closeStore);
        } else {
          const close = roomStore && /** @type {Record<string, unknown>} */ (roomStore).close;
          if (typeof close === 'function') close.call(roomStore);
        }
        if (sceneModule) sceneModule.dispose();
      }
    }

    return Object.freeze({
      ui,
      scene,
      ready,
      requestJson: fetchRequest,
      pause: handlePause,
      get identity() {
        return identityId !== null && identityGeneration !== null
          ? { identity_id: identityId, identity_generation: identityGeneration }
          : null;
      },
      destroy,
      dispose: destroy,
    });
  }

  /**
   * @param {unknown} input
   * @returns {Promise<unknown | null>}
   */
  async function runAutomaticCycle(input = {}) {
    const options = isRecord(input) ? input : {};
    const client = isRecord(options.client) ? options.client : null;
    const request = typeof options.requestJson === 'function'
      ? options.requestJson
      : client && typeof client.requestJson === 'function'
        ? client.requestJson
        : requestJson;
    const requestThis = typeof options.requestJson === 'function' ? undefined : client;
    const paused = typeof options.isPaused === 'function'
      ? options.isPaused
      : typeof options.getPaused === 'function'
        ? options.getPaused
        : () => false;
    const shouldContinue = typeof options.shouldContinue === 'function'
      ? options.shouldContinue
      : () => !paused();
    const onResponse = typeof options.onResponse === 'function'
      ? options.onResponse
      : typeof options.onCycle === 'function'
        ? options.onCycle
        : null;
    const mode = normalizeCycleMode(options.modo ?? options.mode);
    let lastResponse = null;

    while (!paused() && shouldContinue()) {
      const init = {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ modo: mode }),
      };
      lastResponse = await Promise.resolve(request.call(requestThis, '/interf/ciclo', init));
      if (onResponse) await Promise.resolve(onResponse(lastResponse));
    }
    return lastResponse;
  }

  const exported = Object.freeze({ bootstrapSimulator, requestJson, runAutomaticCycle });
  root.PEAS = isRecord(root.PEAS) ? root.PEAS : {};
  root.PEAS.main = exported;
  root.PEAS.bootstrapSimulator = bootstrapSimulator;
  root.PEAS.runAutomaticCycle = runAutomaticCycle;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  if (typeof document !== 'undefined' && typeof window !== 'undefined') bootstrapSimulator();
})(typeof globalThis === 'object' ? globalThis : {});
