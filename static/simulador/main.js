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
/** @typedef {{ mountSimulatorUI: (options: Record<string, unknown>) => SimulatorUIHandle }} SimulatorUIModule */
/** @typedef {{
 * init: (options: Record<string, unknown>) => unknown,
 * updateSnapshot: (snapshot: JsonRecord) => void,
 * dispose: () => void,
 * }} RoomSceneModule */
/** @typedef {{
 * PEAS?: Record<string, unknown>,
 * THREE?: object,
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
        if (decision?.status === 'prevista') {
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

    /** @param {string} path @param {JsonRecord} payload @param {string | (() => string)} state @param {string} source @param {string} [device] @returns {Promise<unknown | null>} */
    async function post(path, payload, state, source, device) {
      const requestInit = {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
      const response = clientRequest
        ? await Promise.resolve(clientRequest.call(client, path, requestInit))
        : await requestJson(path, requestInit, fetcher ?? undefined);
      const accepted = !destroyed && acceptResponse(response, typeof state === 'function' ? state() : state, source, device);
      return accepted ? response : null;
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
      stopAutomatic(false);
      if (!isRecord(payload)) {
        report(new Error('O ajuste ambiental requer os sete campos do ambiente.'));
        return null;
      }
      return safePost('/interf/ambiente', payload, 'pronto', 'environment');
    }

    /** @param {unknown} preset */
    function handlePreset(preset) {
      stopAutomatic(false);
      clearCorrelation();
      return safePost('/interf/preset', { preset }, 'pronto', 'preset');
    }

    function handleReset() {
      stopAutomatic(false);
      clearCorrelation();
      return safePost('/interf/reset', {}, 'pausado', 'reset');
    }

    /** @param {unknown} device @returns {Promise<unknown | null>} */
    async function handleDevice(device) {
      stopAutomatic(false);
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
      stopAutomatic(false);
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
    }

    /** @param {unknown} [mode] */
    function handleAutomatic(mode) {
      if (automatic) {
        stopAutomatic(true);
        return null;
      }
      if (destroyed) return null;
      clearLearningResult(ui);
      selectedCycleMode = normalizeCycleMode(mode ?? selectedCycleMode);
      automatic = true;
      setUIState(ui, 'automatico');
      scheduleAutomaticCycle();
      return null;
    }

    /** @param {unknown} [mode] */
    function handleCycle(mode) {
      if (automatic) {
        stopAutomatic(true);
        return null;
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
    const ready = fetchRequest('/status', { method: 'GET', headers: { Accept: 'application/json' } })
      .then((response) => {
        if (!destroyed) acceptResponse(response, 'pausado', 'status');
        return response;
      })
      .catch((error) => {
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
        if (sceneModule) sceneModule.dispose();
      }
    }

    return Object.freeze({ ui, scene, ready, requestJson: fetchRequest, pause: handlePause, destroy, dispose: destroy });
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
