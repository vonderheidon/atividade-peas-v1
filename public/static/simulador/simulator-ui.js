// @ts-check
/** @typedef {{
 *   PEAS?: Record<string, unknown>,
 *   setTimeout?: (callback: () => void, delay: number) => unknown,
 *   clearTimeout?: (handle: unknown) => void,
 * }} RuntimeRoot */
(function registerSimulatorUI(/** @type {RuntimeRoot} */ root) {
  'use strict';

  /**
   * @typedef {Record<string, unknown>} JsonRecord
   * @typedef {JsonRecord} LearningResult
   * @typedef {'pronto' | 'processando' | 'automatico' | 'pausado' | 'erro'} UIState
   * @typedef {'reativo' | 'cognitivo'} CycleMode
   * @typedef {'janela' | 'ar' | 'ventilador' | 'umidificador' | 'lampada'} DeviceName
   * @typedef {'aceitar' | 'rejeitar'} FeedbackType
   * @typedef {0 | 1} BinaryValue
   * @typedef {{
   *   hora: number,
   *   temperatura_externa: number,
   *   umidade: number,
   *   chuva: BinaryValue,
   *   presenca_interna: BinaryValue,
   *   presenca_externa: BinaryValue,
   *   dormir: BinaryValue,
   * }} EnvironmentRequest
   * @typedef {(...args: unknown[]) => unknown} IntentCallback
   * @typedef {{
   *   onEnvironment?: IntentCallback,
   *   onEnvironmentChange?: IntentCallback,
   *   onPreset?: IntentCallback,
   *   onReset?: IntentCallback,
   *   onCycle?: IntentCallback,
   *   onPause?: IntentCallback,
   *   onAuto?: IntentCallback,
   *   onAutomatic?: IntentCallback,
   *   onDevice?: IntentCallback,
   *   onDeviceIntent?: IntentCallback,
   *   onFeedback?: IntentCallback,
   *   onIntent?: IntentCallback,
   *   setTimeout?: (callback: () => void, delay: number) => unknown,
   *   clearTimeout?: (handle: unknown) => void,
   * }} IntentCallbacks
   * @typedef {IntentCallbacks & {
   *   document?: Document,
   *   documentRef?: Document,
   *   root?: HTMLElement,
   *   callbacks?: IntentCallbacks,
   * }} MountOptions
   * @typedef {HTMLElement & {
   *   checked: boolean,
   *   disabled: boolean,
   *   type: string,
   *   value: string,
   *   dataset: DOMStringMap,
   * }} UIElement
   * @typedef {{
   *   applyResponse: (response: unknown, state?: UIState) => boolean,
   *   receiveResponse: (response: unknown, state?: UIState) => boolean,
   *   updateSnapshot: (snapshot: unknown) => boolean,
   *   reportError: (error: unknown) => void,
   *   renderState: (state: unknown) => boolean,
   *   renderError: (error: unknown) => void,
   *   setUIState: (state: UIState) => void,
   *   setState: (state: UIState) => void,
   *   clearLearningResult: () => void,
   *   setSnapshot: (snapshot: unknown) => boolean,
   *   render: () => void,
   *   handleEnvironmentChange: (event: Event) => void,
   *   handleDeviceIntent: (device: string) => void,
   *   handleFeedback: (feedback: string) => void,
   *   destroy: () => void,
   * }} SimulatorUIHandle
   */

  /** @type {readonly DeviceName[]} */
  const DEVICE_NAMES = Object.freeze([
    'janela',
    'ar',
    'ventilador',
    'umidificador',
    'lampada',
  ]);

  /** @type {readonly string[]} */
  const ENVIRONMENT_FIELDS = Object.freeze([
    'hora',
    'temperatura_externa',
    'umidade',
    'chuva',
    'presenca_interna',
    'presenca_externa',
    'dormir',
  ]);

  /** @type {Readonly<Record<string, string>>} */
  const DEVICE_LABELS = Object.freeze({
    janela: 'Janela',
    ar: 'Ar-condicionado',
    ventilador: 'Ventilador',
    umidificador: 'Umidificador',
    lampada: 'Lâmpada',
  });

  /** @type {Readonly<Record<string, string>>} */
  const ACTION_LABELS = Object.freeze({
    manter: 'Manter o ambiente',
    fechar: 'Fechar a janela',
    ventilar: 'Ventilar o quarto',
    resfriar: 'Resfriar o quarto',
    ventilacao_natural: 'Ventilação natural',
    ventilacao_assistida: 'Ventilação com ventilador',
    circulacao_interna: 'Circulação interna',
    resfriamento: 'Resfriamento com ar-condicionado',
    resfriamento_assistido: 'Resfriamento com ar e ventilador',
    umidificar: 'Ajustar umidade',
    iluminar: 'Ajustar iluminação',
  });

  const OBJECTIVE_LABELS = Object.freeze({
    termico: 'temperatura',
    umidade: 'umidade',
    iluminacao: 'iluminação',
    manutencao: 'manutenção do conforto',
    seguranca: 'segurança',
  });

  /** @type {Readonly<Record<string, string>>} */
  const UI_STATE_LABELS = Object.freeze({
    pronto: 'pronto',
    processando: 'processando',
    automatico: 'automatico',
    pausado: 'pausado',
    erro: 'erro',
  });

  /** @type {Readonly<Record<string, string>>} */
  const ENVIRONMENT_IDS = Object.freeze({
    hora: 'hora',
    temperatura_externa: 'temperatura_externa',
    umidade: 'umidade',
    chuva: 'chuva',
    presenca_interna: 'presenca_interna',
    presenca_externa: 'presenca_externa',
    dormir: 'dormir',
  });

  /** @type {WeakMap<HTMLElement, SimulatorUIHandle>} */
  const mountedRoots = new WeakMap();
  /** @type {WeakMap<Document, {decision: JsonRecord, stages: JsonRecord[], state: JsonRecord | null}>} */
  const cycleResults = new WeakMap();
  /** @type {WeakMap<Document, string>} */
  const decisionContentSnapshots = new WeakMap();

  /** @param {unknown} value @returns {value is JsonRecord} */
  function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  /** @param {JsonRecord} object @param {string} key @returns {boolean} */
  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
  }

  /** @param {unknown} value @returns {string} */
  function errorMessage(value) {
    if (value instanceof Error) return value.message;
    if (isRecord(value) && typeof value.mensagem === 'string') return value.mensagem;
    if (isRecord(value) && typeof value.message === 'string') return value.message;
    return String(value);
  }

  /** @param {unknown} value @returns {string} */
  function responseMessage(value) {
    if (isRecord(value) && typeof value.mensagem === 'string') return value.mensagem;
    if (isRecord(value) && typeof value.message === 'string') return value.message;
    return '';
  }

  /** @param {unknown} value @returns {string} */
  function escapeHTML(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  /** @param {unknown} value @param {number} fallback @returns {number} */
  function numberValue(value, fallback = 0) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }

  /** @param {unknown} value @returns {string} */
  function formatHour(value) {
    const hour = Math.max(0, Math.min(23, Math.round(numberValue(value))));
    return `${String(hour).padStart(2, '0')}:00`;
  }

  /** @param {unknown} value @returns {string} */
  function formatDecimal(value) {
    return numberValue(value).toFixed(1).replace('.', ',');
  }

  /** @param {unknown} value @returns {string} */
  function formatMetric(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value.toFixed(2).replace('.', ',');
  }

  /** @param {unknown} value @returns {string} */
  function actionLabel(value) {
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_LABELS, value)) {
      return ACTION_LABELS[value];
    }
    return typeof value === 'string' && value.trim() ? value : 'Aguardando próximo ciclo';
  }

  /** @param {unknown} value @returns {string} */
  function objectiveLabel(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OBJECTIVE_LABELS, value)
      ? OBJECTIVE_LABELS[value] : 'ambiente';
  }

  /** @param {unknown} value @returns {string} */
  function deviceLabel(value) {
    if (typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEVICE_LABELS, value)) {
      return DEVICE_LABELS[value];
    }
    return typeof value === 'string' && value.trim() ? value : 'Dispositivo';
  }

  /** @param {unknown} device @param {unknown} command @returns {string} */
  function commandLabel(device, command) {
    if (device === 'ventilador' && (command === 2 || command === '2')) {
      return 'Velocidade 2';
    }
    const binary = command === 1 || command === '1' || command === true;
    if (device === 'janela') return binary ? 'Aberta' : 'Fechada';
    return binary ? 'Ligado' : 'Desligado';
  }

  /** @param {unknown} value @returns {string} */
  function stateLabel(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UI_STATE_LABELS, value)
      ? UI_STATE_LABELS[value]
      : 'indeterminado';
  }

  /** @param {unknown} value @returns {JsonRecord | null} */
  function asRecord(value) {
    return isRecord(value) ? value : null;
  }

  /** @param {unknown} value @returns {JsonRecord | null} */
  function responseState(value) {
    const response = asRecord(value);
    if (!response) return null;
    const state = asRecord(response.estado);
    if (state) return state;
    if (hasOwn(response, 'hora') && hasOwn(response, 'dispositivos')) return response;
    return null;
  }

  /** @param {unknown} value @returns {JsonRecord | null} */
  function responseDecision(value) {
    const response = asRecord(value);
    return response ? asRecord(response.decisao) : null;
  }

  /** @param {unknown} value @returns {JsonRecord | null} */
  function responseSnapshot(value) {
    const response = asRecord(value);
    if (!response) return null;
    const supplied = asRecord(response.room_snapshot) ?? asRecord(response.snapshot);
    if (supplied && asRecord(supplied.computation)) return supplied;
    return asRecord(response.computation) && Array.isArray(response.trace) ? response : null;
  }

  /** @param {unknown} value @param {JsonRecord | null} snapshot @returns {{ identityId: string, generation: number, mismatch: boolean } | null} */
  function responseIdentity(value, snapshot) {
    const response = asRecord(value);
    const responseHasIdentity = typeof response?.identity_id === 'string'
      && typeof response.identity_generation === 'number'
      && Number.isSafeInteger(response.identity_generation);
    const snapshotHasIdentity = typeof snapshot?.identity_id === 'string'
      && typeof snapshot.identity_generation === 'number'
      && Number.isSafeInteger(snapshot.identity_generation);
    if (responseHasIdentity) {
      return {
        identityId: /** @type {string} */ (response.identity_id),
        generation: /** @type {number} */ (response.identity_generation),
        mismatch: Boolean(snapshotHasIdentity
          && (response.identity_id !== snapshot?.identity_id
            || response.identity_generation !== snapshot?.identity_generation)),
      };
    }
    return snapshotHasIdentity
      ? { identityId: /** @type {string} */ (snapshot.identity_id), generation: /** @type {number} */ (snapshot.identity_generation), mismatch: false }
      : null;
  }

  /** @param {unknown} value @param {JsonRecord | null} snapshot @returns {number | null} */
  function responseRevision(value, snapshot) {
    const response = asRecord(value);
    const revision = snapshot?.revision ?? response?.revision;
    return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
      ? revision
      : null;
  }

  /** @param {unknown} value @returns {JsonRecord[]} */
  function recordList(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
  }

  /** @param {unknown} value @returns {UIState | null} */
  function validUIState(value) {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(UI_STATE_LABELS, value)
      ? /** @type {UIState} */ (value)
      : null;
  }

  /** @param {unknown} value @returns {Document | null} */
  function resolveDocument(value) {
    if (value && typeof value === 'object') return /** @type {Document} */ (value);
    return typeof document === 'undefined' ? null : document;
  }

  /** @param {Document} documentRef @param {unknown} value @returns {HTMLElement | null} */
  function resolveRoot(documentRef, value) {
    if (value && typeof value === 'object') return /** @type {HTMLElement} */ (value);
    return /** @type {HTMLElement | null} */ (documentRef.getElementById('prototypeRoot'));
  }

  /** @param {Document} documentRef @param {string} id @returns {UIElement | null} */
  function getElement(documentRef, id) {
    return /** @type {UIElement | null} */ (documentRef.getElementById(id));
  }

  /** @param {Document} documentRef @param {string} id @param {string} value */
  function setText(documentRef, id, value) {
    const element = getElement(documentRef, id);
    if (element) element.textContent = value;
  }

  /** @param {Document} documentRef @param {string} id @param {string} value */
  function setHTML(documentRef, id, value) {
    const element = getElement(documentRef, id);
    if (element) element.innerHTML = value;
  }

  /** @param {Document} documentRef @param {string} id @param {string} name @param {string} value */
  function setAttribute(documentRef, id, name, value) {
    const element = getElement(documentRef, id);
    element?.setAttribute(name, value);
  }

  /** @param {JsonRecord | null} decision @returns {string[]} */
  function decisionActions(decision) {
    if (!decision) return [];
    const strategyId = decisionStrategyId(decision);
    const primaryAction = strategyId ?? decision.acao;
    const actions = Array.isArray(decision.acoes)
      ? decision.acoes.filter((value) => typeof value === 'string' && value.trim())
      : [];
    if (strategyId && typeof decision.acao === 'string' && decision.acao.trim()) {
      for (let index = 0; index < actions.length; index += 1) {
        if (actions[index] === decision.acao) actions[index] = strategyId;
      }
    }
    if (typeof primaryAction === 'string' && primaryAction.trim() && !actions.includes(primaryAction)) {
      actions.unshift(primaryAction);
    }
    return actions;
  }

  /** @param {JsonRecord | null} decision @returns {unknown} */
  function decisionPrimaryAction(decision) {
    return decisionStrategyId(decision) ?? decision?.acao;
  }

  /** @param {Document} documentRef @param {string} message */
  function renderAlertToast(documentRef, message) {
    const element = getElement(documentRef, 'simulator-alert');
    if (!element) return;
    const visible = Boolean(message);
    element.textContent = message;
    element.classList?.toggle('is-visible', false);
    if (visible) {
      void element.offsetWidth;
      element.classList?.toggle('is-visible', true);
    }
    element.setAttribute('aria-hidden', String(!visible));
  }

  /** @param {Document} documentRef @param {string} id @param {boolean} hidden */
  function setHidden(documentRef, id, hidden) {
    const element = getElement(documentRef, id);
    if (element) element.hidden = hidden;
  }

  /** @param {Document} documentRef @param {string} id @param {boolean} active */
  function setCycleButtonState(documentRef, id, active) {
    const element = getElement(documentRef, id);
    if (!element) return;
    element.classList?.toggle('is-active', active);
    element.setAttribute('aria-pressed', String(active));
  }

  /** @param {Document} documentRef @param {UIState} uiState @param {JsonRecord | null} state */
  function renderCycleControls(documentRef, uiState, state) {
    const automaticRunning = uiState === 'automatico';
    setCycleButtonState(documentRef, 'cycle_pause', uiState === 'pausado');
    const pauseButton = getElement(documentRef, 'cycle_pause');
    if (pauseButton) {
      pauseButton.disabled = !automaticRunning;
      pauseButton.setAttribute('aria-disabled', String(!automaticRunning));
      pauseButton.setAttribute('title', automaticRunning
        ? 'Pausar execução automática'
        : 'A execução automática não está rodando.');
    }
    setCycleButtonState(documentRef, 'cycle_auto', uiState === 'automatico');
    const presetSelected = typeof state?.preset_atual === 'string' && state.preset_atual.trim().length > 0;
    for (const [id, label] of [['cycle_next', 'Próximo ciclo'], ['cycle_auto', 'Executar automaticamente']]) {
      const button = getElement(documentRef, id);
      if (!button) continue;
      button.disabled = !presetSelected;
      button.setAttribute('aria-disabled', String(!presetSelected));
      button.setAttribute('title', presetSelected ? label : 'Selecione um preset para habilitar este controle.');
    }
  }

  /** @param {Document} documentRef @param {string} id @param {string} width */
  function setMeterWidth(documentRef, id, width) {
    const element = getElement(documentRef, id);
    if (element?.style) element.style.width = width;
  }

  /** @param {Document} documentRef @param {string} id @returns {UIElement | null} */
  function inputFor(documentRef, id) {
    return getElement(documentRef, id);
  }

  /** @param {JsonRecord} state @param {string} key @returns {unknown} */
  function environmentValue(state, key) {
    return state[key];
  }

  /** @param {unknown} value @returns {boolean} */
  function binaryValue(value) {
    return value === true || value === 1 || value === '1';
  }

  /** @param {Event} event @param {string} selector @returns {UIElement | null} */
  function closestTarget(event, selector) {
    const target = event.target;
    if (!target || typeof target !== 'object') return null;
    const candidate = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (target));
    const closest = candidate.closest;
    if (typeof closest === 'function') {
      const result = closest.call(target, selector);
      return result && typeof result === 'object' ? /** @type {UIElement} */ (result) : null;
    }
    return candidate.dataset ? /** @type {UIElement} */ (target) : null;
  }

  /** @param {MountOptions} options @param {string[]} names @returns {IntentCallback | undefined} */
  function callbackFor(options, names) {
    const direct = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options));
    const grouped = options.callbacks
      ? /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (options.callbacks))
      : {};
    for (const name of names) {
      const candidate = direct[name] ?? grouped[name];
      if (typeof candidate === 'function') return /** @type {IntentCallback} */ (candidate);
    }
    return undefined;
  }

  /** @param {unknown} value @returns {MountOptions} */
  function normalizeOptions(value) {
    if (!isRecord(value)) return {};
    return /** @type {MountOptions} */ (value);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} fallback @returns {EnvironmentRequest} */
  function environmentPayload(documentRef, fallback) {
    /** @param {string} field @returns {number} */
    const readNumber = (field) => {
      const input = inputFor(documentRef, ENVIRONMENT_IDS[field]);
      const value = input ? Number(input.value) : Number(environmentValue(fallback ?? {}, field));
      return Number.isFinite(value) ? value : 0;
    };
    /** @param {string} field @returns {BinaryValue} */
    const readBinary = (field) => {
      const input = inputFor(documentRef, ENVIRONMENT_IDS[field]);
      return input ? (input.checked ? 1 : 0) : binaryValue(environmentValue(fallback ?? {}, field)) ? 1 : 0;
    };
    return {
      hora: Math.round(readNumber('hora')),
      temperatura_externa: readNumber('temperatura_externa'),
      umidade: readNumber('umidade'),
      chuva: readBinary('chuva'),
      presenca_interna: readBinary('presenca_interna'),
      presenca_externa: readBinary('presenca_externa'),
      dormir: readBinary('dormir'),
    };
  }

  /** @param {Document} documentRef @returns {CycleMode} */
  function selectedCycleMode(documentRef) {
    const control = inputFor(documentRef, 'cycle_mode');
    return control?.value === 'cognitivo' ? 'cognitivo' : 'reativo';
  }

  /** @param {Document} documentRef @param {CycleMode} mode */
  function renderCycleModeHelp(documentRef, mode) {
    const selectedMode = mode === 'cognitivo' ? 'cognitivo' : 'reativo';
    setHidden(documentRef, 'open-utility-formula-help', selectedMode !== 'cognitivo');
    const panels = [
      getElement(documentRef, 'cycle-mode-help-reactive'),
      getElement(documentRef, 'cycle-mode-help-cognitive'),
    ];
    const activePanel = getElement(documentRef, `cycle-mode-help-${selectedMode === 'cognitivo' ? 'cognitive' : 'reactive'}`);
    if (!activePanel) return;

    for (const panel of panels) {
      if (!panel) continue;
      const active = panel === activePanel;
      panel.hidden = !active;
      panel.setAttribute('aria-hidden', String(!active));
    }

    const title = activePanel.dataset.cycleHelpTitle ?? (selectedMode === 'cognitivo' ? 'Modo cognitivo' : 'Modo reativo');
    const description = activePanel.dataset.cycleHelpDescription ?? '';
    setText(documentRef, 'cycle-mode-help-title', title);
    setText(documentRef, 'cycle-mode-help-description', description);
    setAttribute(documentRef, 'cycle-mode-help-modal', 'data-cycle-mode', selectedMode);
    setAttribute(documentRef, 'open-cycle-mode-help', 'aria-label', `Abrir ajuda sobre ${title.toLowerCase()}`);
    setAttribute(documentRef, 'open-cycle-mode-help', 'title', `Sobre ${title.toLowerCase()}`);
  }

  /** @param {JsonRecord} state @param {string} field @returns {unknown} */
  function readEnvironmentControl(state, field) {
    return environmentValue(state, field);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state */
  function renderEnvironment(documentRef, state) {
    if (!state) return;
    for (const field of ENVIRONMENT_FIELDS) {
      const id = ENVIRONMENT_IDS[field];
      const input = inputFor(documentRef, id);
      if (!input) continue;
      const value = readEnvironmentControl(state, field);
      if (input.type === 'checkbox') input.checked = binaryValue(value);
      else input.value = String(value ?? '');
    }
    setText(documentRef, 'hora_valor', formatHour(state.hora));
    setText(documentRef, 'temperatura_externa_valor', `${formatDecimal(state.temperatura_externa)} °C`);
    setText(documentRef, 'temperatura_interna_valor', `${formatDecimal(state.temperatura_interna)} °C`);
    setText(documentRef, 'umidade_valor', `${Math.round(numberValue(state.umidade))}%`);
    setText(documentRef, 'hora_atual', formatHour(state.hora));
    const tempBadge = getElement(documentRef, 'room-temperature-badge');
    if (tempBadge && state.temperatura_interna !== undefined) {
      tempBadge.setAttribute('title', `Temperatura interna: ${formatDecimal(state.temperatura_interna)} °C`);
    }
  }

  /** @param {Document} documentRef @param {UIElement} input */
  function previewEnvironmentRange(documentRef, input) {
    const value = Number(input.value);
    if (input.dataset.environment === 'hora') {
      setText(documentRef, 'hora_valor', formatHour(value));
    } else if (input.dataset.environment === 'temperatura_externa') {
      setText(documentRef, 'temperatura_externa_valor', `${formatDecimal(value)} °C`);
    } else if (input.dataset.environment === 'umidade') {
      setText(documentRef, 'umidade_valor', `${Math.round(value)}%`);
    }
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state */
  function renderConfirmedDevices(documentRef, state) {
    if (!state) return;
    const devices = asRecord(state.dispositivos);
    if (!devices) return;
    for (const device of DEVICE_NAMES) {
      const element = getElement(documentRef, `device_${device}`);
      if (!element) continue;
      const value = devices[device];
      element.dataset.confirmedValue = String(value ?? 'indeterminado');
      element.setAttribute('aria-busy', value === undefined || value === null ? 'true' : 'false');
      const isActive = typeof value === 'number' ? value > 0 : Boolean(value);
      element.classList.toggle('is-active', isActive);
      element.dataset.active = isActive ? 'true' : 'false';
      element.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      const statusLabel = commandLabel(device, value);
      const name = device === 'lampada' ? 'Luz' : deviceLabel(device);
      element.setAttribute('aria-label', `${name}: ${statusLabel}`);
      element.setAttribute('title', `${name}: ${statusLabel} (clique para alternar)`);
      const tooltip = typeof element.querySelector === 'function'
        ? element.querySelector('.device-tooltip')
        : null;
      if (tooltip) tooltip.textContent = `${name} • ${statusLabel}`;
    }
  }

  /** @param {JsonRecord | null} decision @returns {JsonRecord[]} */
  function decisionAlternatives(decision) {
    return decision ? recordList(decision.alternativas) : [];
  }

  /** @param {JsonRecord | null} decision @param {JsonRecord[]} stages @returns {JsonRecord[]} */
  function decisionPlan(decision, stages) {
    const plan = decision ? recordList(decision.plano) : [];
    return plan.length > 0 ? plan : stages;
  }

  /** @param {JsonRecord} step @returns {string} */
  function stepText(step) {
    return `${deviceLabel(step.dispositivo)}: ${commandLabel(step.dispositivo, step.comando)}`;
  }

  /** @param {unknown} value @returns {0 | 1 | null} */
  function binaryStepValue(value) {
    if (value === 0 || value === '0') return 0;
    if (value === 1 || value === '1') return 1;
    return null;
  }

  /** @param {JsonRecord} step @param {'estado_anterior' | 'estado_novo'} key @returns {string} */
  function planStateText(step, key) {
    const rawValue = step[key] === undefined && key === 'estado_novo'
      ? step.comando
      : step[key];
    const value = binaryStepValue(rawValue);
    return value === null ? 'Não informado' : commandLabel(step.dispositivo, value);
  }

  /** @param {JsonRecord} step @returns {string} */
  function resultText(step) {
    const before = binaryStepValue(step.estado_anterior);
    const rawAfter = step.estado_novo === undefined ? step.comando : step.estado_novo;
    const after = binaryStepValue(rawAfter);
    if (step.status === 'falhou') return 'Falhou';
    if (before === null || after === null) {
      return step.status === 'confirmado' ? 'Confirmado' : 'Pendente';
    }
    return before === after ? 'Já estava nesse estado' : 'Alterado e confirmado';
  }

  /** @param {JsonRecord} decision @param {string} key @returns {unknown} */
  function selectedMetric(decision, key) {
    const selected = selectedAlternative(decision);
    return selected ? selected[key] : undefined;
  }

  /** @param {JsonRecord | null} decision @returns {JsonRecord | null} */
  function selectedAlternative(decision) {
    const alternatives = decisionAlternatives(decision);
    const selected = alternatives.find((alternative) => alternativeMatchesDecision(decision, alternative));
    if (selected) return selected;
    return decisionStrategyId(decision) === null ? alternatives[0] ?? null : null;
  }

  /** @param {JsonRecord | null} decision @returns {JsonRecord[] | null} */
  function decisionCorrections(decision) {
    if (Array.isArray(decision?.correcoes_permitidas)) {
      return recordList(decision.correcoes_permitidas);
    }
    const selected = selectedAlternative(decision);
    return Array.isArray(selected?.correcoes_permitidas)
      ? recordList(selected.correcoes_permitidas)
      : null;
  }

  /** @param {JsonRecord | null} decision @returns {string | null} */
  function decisionStrategyId(decision) {
    const strategyId = decision?.strategy_id;
    return typeof strategyId === 'string' && strategyId.trim() ? strategyId : null;
  }

  /** @param {JsonRecord | null} decision @param {JsonRecord} alternative @returns {boolean} */
  function alternativeMatchesDecision(decision, alternative) {
    const strategyId = decisionStrategyId(decision);
    if (strategyId !== null) return alternative.strategy_id === strategyId;
    return typeof decision?.acao === 'string' && alternative.acao === decision.acao;
  }

  /** @param {unknown} value @returns {string} */
  function signedValue(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return value > 0 ? `+${value}` : String(value);
  }

  /** @param {unknown} value @returns {string} */
  function signedMetric(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const formatted = formatMetric(value);
    return value > 0 ? `+${formatted}` : formatted;
  }

  /** @param {unknown} value @param {string} unit @param {number} [decimalPlaces] @returns {string} */
  function metricWithUnit(value, unit, decimalPlaces = 2) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    const formatted = value.toFixed(decimalPlaces).replace('.', ',');
    return formatted === '—' ? formatted : `${formatted} ${unit}`;
  }

  /** @param {unknown} value @param {string} positive @param {string} negative @returns {string} */
  function binaryLabel(value, positive, negative) {
    return binaryValue(value) ? positive : negative;
  }

  /** @param {unknown} value @returns {string} */
  function metricWidth(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '0%';
    const percentage = Math.max(0, Math.min(100, value * 100));
    return `${percentage}%`;
  }

  /** @param {JsonRecord} context @returns {string} */
  function learningContextText(context) {
    const parts = [];
    if (typeof context.hora === 'number') parts.push(`hora ${formatHour(context.hora)}`);
    if (typeof context.faixa_horario === 'string') parts.push(`período ${context.faixa_horario}`);
    if (typeof context.preset === 'string') parts.push(`perfil selecionado ${context.preset}`);
    if (typeof context.faixa_temperatura === 'string') {
      parts.push(`faixa térmica ${context.faixa_temperatura}`);
    }
    /** @type {Readonly<Record<string, string>>} */
    const luminosityLabels = { escuro: 'escura', adequado: 'adequada', claro: 'clara' };
    if (typeof context.luminosidade === 'string') {
      const luminosity = luminosityLabels[context.luminosidade] ?? context.luminosidade;
      parts.push(`luminosidade ${luminosity}`);
    }
    parts.push(`modo dormir ${binaryValue(context.dormir) ? 'ativo' : 'inativo'}`);
    parts.push(`presença interna ${binaryValue(context.presenca_interna) ? 'detectada' : 'ausente'}`);
    return `${parts.join('; ')}. A preferência aprendida é registrada por objetivo e estratégia.`;
  }

  /** @param {JsonRecord} correction @returns {string} */
  function manualCorrectionLabel(correction) {
    const device = correction.dispositivo;
    const enabled = binaryValue(correction.comando);
    if (device === 'janela') return enabled ? 'Abrir a janela' : 'Fechar a janela';
    if (device === 'ar') return enabled ? 'Ligar o ar-condicionado' : 'Desligar o ar-condicionado';
    if (device === 'ventilador') return enabled ? 'Ligar o ventilador' : 'Desligar o ventilador';
    if (device === 'umidificador') return enabled ? 'Ligar o umidificador' : 'Desligar o umidificador';
    if (device === 'lampada') return enabled ? 'Acender a lâmpada' : 'Apagar a lâmpada';
    return `${deviceLabel(device)}: ${commandLabel(device, correction.comando)}`;
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state @param {JsonRecord | null} decision @param {UIState} uiState */
  function renderEvidence(documentRef, state, decision, uiState) {
    if (!state) {
      setText(documentRef, 'evidence_ambiente', 'Aguardando leitura confirmada do ambiente.');
      setText(documentRef, 'evidence_contexto', 'Aguardando contexto confirmado do ciclo.');
      setText(documentRef, 'evidence_restricoes', 'As restrições aparecerão após um ciclo.');
      return;
    }
    const temperature = `${formatDecimal(state.temperatura_interna)} °C internos / ${formatDecimal(state.temperatura_externa)} °C externos`;
    const humidity = `${Math.round(numberValue(state.umidade))}% de umidade`;
    const luminosity = typeof state.luminosidade === 'string' ? state.luminosidade : 'luminosidade indeterminada';
    setText(documentRef, 'evidence_ambiente', `${temperature}; ${humidity}; luminosidade ${luminosity}.`);
    if (!decision) {
      setText(documentRef, 'evidence_contexto', 'Aguardando o próximo ciclo.');
      setText(documentRef, 'evidence_restricoes', 'Nenhuma decisão foi devolvida para este estado.');
      return;
    }
    const context = asRecord(decision.contexto);
    const contextText = context
      ? learningContextText(context)
      : decision.modo === 'cognitivo'
        ? 'O registro desta decisão não guardou as condições originais.'
        : 'Esta decisão reativa não usa o contexto de aprendizagem cognitiva.';
    const corrections = decisionCorrections(decision);
    const restrictionText = corrections === null
      ? 'O registro desta decisão não guardou a lista de correções.'
      : corrections.length === 0
        ? 'Nenhum ajuste manual pode ser associado a esta decisão.'
        : `Mudanças que contam como correção: ${corrections.map(manualCorrectionLabel).join('; ')}. A preferência muda no próximo ciclo se o estado final corresponder a uma estratégia conhecida.`;
    setText(documentRef, 'evidence_contexto', contextText);
    setText(documentRef, 'evidence_restricoes', restrictionText);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} decision */
  function renderAlternatives(documentRef, decision) {
    const alternatives = decisionAlternatives(decision);
    if (alternatives.length === 0) {
      setHTML(documentRef, 'alternatives-list', '<tr><td colspan="7" class="table-empty">As alternativas aparecerão após uma decisão recebida.</td></tr>');
      return;
    }
    const rows = alternatives.map((alternative) => {
      const selected = alternativeMatchesDecision(decision, alternative);
      const eligible = alternative.elegivel !== false;
      const eligibility = eligible ? (selected ? 'escolhida' : 'elegível') : 'bloqueada';
      const reason = typeof alternative.motivo_bloqueio === 'string' && alternative.motivo_bloqueio
        ? ` · ${alternative.motivo_bloqueio}`
        : '';
      const forecast = typeof alternative.temperatura_em_tres_horas === 'number' && Number.isFinite(alternative.temperatura_em_tres_horas)
        ? `${formatDecimal(alternative.temperatura_em_tres_horas)} °C`
        : '—';
      return `<tr><td>${escapeHTML(actionLabel(alternative.strategy_id ?? alternative.acao))}</td><td>${escapeHTML(`${eligibility}${reason}`)}</td><td>${escapeHTML(formatMetric(alternative.conforto))}</td><td>${escapeHTML(formatMetric(alternative.custo))}</td><td>${escapeHTML(forecast)}</td><td>${escapeHTML(signedValue(alternative.preferencia_contextual))}</td><td>${escapeHTML(formatMetric(alternative.pontuacao_total))}</td></tr>`;
    }).join('');
    setHTML(documentRef, 'alternatives-list', rows);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} decision @param {JsonRecord[]} stages */
  function renderPlan(documentRef, decision, stages) {
    const plan = decisionPlan(decision, stages);
    if (plan.length === 0) {
      setHTML(documentRef, 'plan-list', '<tr><td colspan="5" class="table-empty">Nenhuma etapa confirmada foi devolvida.</td></tr>');
      return;
    }
    const rows = plan.map((step) => {
      const order = typeof step.ordem === 'number' ? String(step.ordem) : '—';
      return `<tr><td>${escapeHTML(order)}</td><td>${escapeHTML(deviceLabel(step.dispositivo))}</td><td>${escapeHTML(planStateText(step, 'estado_anterior'))}</td><td>${escapeHTML(planStateText(step, 'estado_novo'))}</td><td>${escapeHTML(resultText(step))}</td></tr>`;
    }).join('');
    setHTML(documentRef, 'plan-list', rows);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} decision */
  function renderMetrics(documentRef, decision) {
    const selected = selectedAlternative(decision);
    const metrics = [
      ['metrica_conforto', 'metrica_conforto_bar', 'conforto'],
      ['metrica_economia', 'metrica_economia_bar', 'economia'],
      ['metrica_utilidade', 'metrica_utilidade_bar', 'utilidade'],
    ];
    for (const [valueId, barId, key] of metrics) {
      const value = decision ? selectedMetric(decision, key) : undefined;
      setText(documentRef, valueId, formatMetric(value));
      setMeterWidth(documentRef, barId, metricWidth(value));
    }
    setText(documentRef, 'metrica_custo', formatMetric(selected?.custo));
    setText(documentRef, 'metrica_pontuacao_base', formatMetric(selected?.pontuacao_base));
    setText(documentRef, 'metrica_preferencia_contextual', signedValue(selected?.preferencia_contextual));
    setText(documentRef, 'metrica_pontuacao_total', formatMetric(selected?.pontuacao_total));
    setText(documentRef, 'metrica_influenciada', selected?.influenciada === true ? 'sim' : selected ? 'não' : '—');
    const influence = typeof selected?.motivo_influencia === 'string'
      ? selected.motivo_influencia
      : selected && typeof selected.ajuste_familia_ar === 'number' && selected.ajuste_familia_ar < 0
        ? 'A rejeição anterior ao ar-condicionado foi considerada também nesta estratégia.'
        : selected && typeof selected.preferencia_contextual === 'number' && selected.preferencia_contextual !== 0
          ? `Uma preferência aprendida por ${actionLabel(decisionPrimaryAction(decision))} foi considerada nesta escolha.`
          : 'Nenhuma preferência aprendida influenciou esta escolha.';
    setText(documentRef, 'decision-influence', influence);
  }

  /** @param {Document} documentRef @param {LearningResult | null} result */
  function renderLearningResult(documentRef, result) {
    setHidden(documentRef, 'learning-result-region', !result);
    if (!result) return;
    setText(documentRef, 'learning-result-type', typeof result.tipo === 'string' ? result.tipo : '—');
    setText(documentRef, 'learning-result-action', actionLabel(result.acao));
    setText(documentRef, 'learning-result-previous', signedValue(result.preferencia_anterior));
    setText(documentRef, 'learning-result-delta', signedValue(result.delta));
    setText(documentRef, 'learning-result-current', signedValue(result.preferencia_atual));
    setText(documentRef, 'learning-result-condition', typeof result.condicao_reaplicacao === 'string'
      ? result.condicao_reaplicacao
      : 'Condição de reaplicação não informada na resposta.');
  }

  /** @param {Document} documentRef @param {JsonRecord | null} decision @param {LearningResult | null} learningResult */
  function renderFeedbackControls(documentRef, decision, learningResult) {
    const cognitive = decision?.modo === 'cognitivo' || decision?.modo === 'cognitive';
    const confirmed = !decision?.status || decision.status === 'confirmada' || decision.status === 'confirmed';
    const selected = selectedAlternative(decision);
    const resultBelongsToDecision = learningResult?.decisao_id === decision?.decisao_id;
    const preference = resultBelongsToDecision && typeof learningResult?.preferencia_atual === 'number'
      ? learningResult.preferencia_atual
      : selected?.preferencia_contextual;
    setHidden(documentRef, 'feedback-region', !decision || !cognitive || !confirmed);
    setHidden(documentRef, 'feedback-actions', !cognitive || !confirmed);
    if (!decision) {
      setText(documentRef, 'feedback-copy', 'Aguardando uma decisão cognitiva confirmada.');
    } else if (cognitive) {
      setText(documentRef, 'feedback-copy', `Feedback sobre: ${actionLabel(decisionPrimaryAction(decision))}. Registre uma avaliação depois de uma decisão cognitiva confirmada.`);
    } else {
      setText(documentRef, 'feedback-copy', 'Feedback disponível apenas para decisões cognitivas.');
    }
    for (const id of ['feedback_aceitar', 'feedback_rejeitar']) {
      const button = getElement(documentRef, id);
      if (!button) continue;
      const disabled = !cognitive || !confirmed || preference === 3 && id === 'feedback_aceitar' || preference === -3 && id === 'feedback_rejeitar';
      button.disabled = disabled;
      button.setAttribute('aria-disabled', String(disabled));
    }
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state @param {UIState} uiState @param {unknown} error @param {JsonRecord | null} response */
  function renderStatus(documentRef, state, uiState, error, response) {
    const label = stateLabel(uiState);
    const message = error ? errorMessage(error) : responseMessage(response);
    setText(documentRef, 'estado_interface', label);
    setText(documentRef, 'decisao_estado', label);
    setText(documentRef, 'cycle_status', uiState === 'automatico' ? 'execução automática' : `simulação ${label}`);
    setText(documentRef, 'renderer-status', state ? 'Quarto atualizado.' : 'Carregando o quarto.');
    setText(documentRef, 'scene_status', state ? 'quarto atualizado' : 'carregando o quarto');
    setText(documentRef, 'environment-status', state
      ? (error ? 'Falha sem alterar o último estado confirmado.' : 'Campos ambientais confirmados pelo simulador.')
      : 'Aguardando estado confirmado.');
    renderAlertToast(documentRef, error ? `Falha: ${errorMessage(error)}` : '');
    renderCycleControls(documentRef, uiState, state);
  }

  /** @param {unknown} value @param {string} positive @param {string} negative @returns {string} */
  function binaryLabel(value, positive, negative) {
    return value === 1 || value === '1' || value === true || value === 'true' ? positive : negative;
  }

  /** @param {Document} documentRef @param {JsonRecord | null} decision */
  function renderIdentity(documentRef, decision) {
    const identity = decision ? asRecord(decision.identidade) : null;
    setText(documentRef, 'identidade_preset', typeof identity?.preset === 'string' ? identity.preset : '—');
    setText(documentRef, 'identidade_modo', typeof identity?.modo === 'string' ? identity.modo : '—');
    setText(documentRef, 'identidade_faixa_horario', typeof identity?.faixa_horario === 'string' ? identity.faixa_horario : '—');
    setText(documentRef, 'identidade_dormir', identity && hasOwn(identity, 'dormir') ? binaryLabel(identity.dormir, 'ativo', 'inativo') : '—');
    setText(documentRef, 'identidade_faixa_temperatura', typeof identity?.faixa_temperatura === 'string' ? identity.faixa_temperatura : '—');
    setText(documentRef, 'identidade_luminosidade', typeof identity?.luminosidade === 'string' ? identity.luminosidade : '—');
    setText(documentRef, 'identidade_presenca_interna', identity && hasOwn(identity, 'presenca_interna')
      ? binaryLabel(identity.presenca_interna, 'detectada', 'ausente')
      : '—');
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state @param {JsonRecord | null} decision */
  function renderDecision(documentRef, state, decision) {
    const hasDecision = Boolean(decision);
    const actions = decisionActions(decision);
    setHidden(documentRef, 'decision-influence', !hasDecision || decision?.modo !== 'cognitivo');
    setHidden(documentRef, 'open-reasoning', !hasDecision);
    if (!decision) {
      setText(documentRef, 'decision-action-label', 'resultado do último ciclo');
      setText(documentRef, 'decisao_acao', 'Nenhum ciclo executado');
      setHTML(documentRef, 'decisao_acoes', '');
      setText(documentRef, 'decisao_motivo', 'Clique em “Próximo ciclo” para avaliar o ambiente e executar a decisão.');
      setText(documentRef, 'decisao_modo', '—');
      setText(documentRef, 'decisao_objetivo', '—');
      setText(documentRef, 'decisao_strategy_id', '—');
      setText(documentRef, 'decisao_plano', 'Nenhum plano recebido.');
      setText(documentRef, 'decision-card', '');
      setText(documentRef, 'decision-modal', '');
      return;
    }
    setText(documentRef, 'decision-action-label', 'resultado do último ciclo');
    const primaryAction = decisionPrimaryAction(decision);
    setText(documentRef, 'decisao_acao', actionLabel(primaryAction));
    setHTML(documentRef, 'decisao_acoes', actions.length > 1
      ? actions.map((action) => `<li class="decision-action-chip${action === primaryAction ? ' is-primary' : ''}">${escapeHTML(actionLabel(action))}</li>`).join('')
      : '');
    const alternatives = decisionAlternatives(decision);
    const outsideTooHot = alternatives.some((alternative) => typeof alternative.motivo_bloqueio === 'string'
      && alternative.motivo_bloqueio.includes('ar externo está tão quente'));
    const thermalStrategy = decisionStrategyId(decision);
    const selected = selectedAlternative(decision);
    const projected = selected?.temperatura_em_tres_horas;
    const currentTemperature = state?.temperatura_interna;
    const ventilationReason = typeof projected === 'number' && typeof currentTemperature === 'number'
      ? projected > currentTemperature
        ? `A ventilação mantém o ar desligado, mas a temperatura pode subir para ${formatMetric(projected)} °C em três ciclos. Custo: ${formatMetric(selected?.custo)} por ciclo.`
        : `A ventilação mantém o ar desligado. Temperatura prevista em três ciclos: ${formatMetric(projected)} °C; custo: ${formatMetric(selected?.custo)} por ciclo.`
      : 'O agente escolheu ventilação ao comparar conforto, energia e preferência aprendida.';
    const shortReason = outsideTooHot && decision.objetivo === 'termico'
      ? 'Lá fora está mais quente que no quarto. O agente mantém a janela fechada e usa o ar-condicionado para reduzir o calor.'
      : decision.objetivo === 'termico' && (thermalStrategy === 'ventilacao_natural' || thermalStrategy === 'ventilacao_assistida')
        ? ventilationReason
        : decision.modo === 'cognitivo'
          ? `O agente comparou as opções para ${objectiveLabel(decision.objetivo)} e escolheu a melhor combinação de conforto, energia e preferência aprendida.`
          : typeof decision.motivo === 'string' ? decision.motivo : 'O agente avaliou o ambiente antes de agir.';
    setText(documentRef, 'decisao_motivo', shortReason);
    setText(documentRef, 'decisao_modo', typeof decision.modo === 'string' ? decision.modo : '—');
    setText(documentRef, 'decisao_objetivo', objectiveLabel(decision.objetivo));
    setText(documentRef, 'decisao_strategy_id', typeof decision.strategy_id === 'string' ? decision.strategy_id : '—');
    setText(documentRef, 'decisao_plano', decisionPlan(decision, []).map(stepText).join(' · ') || 'Plano sem etapas.');
    const summary = `${actionLabel(primaryAction)} ${shortReason}`.trim();
    setText(documentRef, 'decision-card', summary);
    setText(documentRef, 'decision-modal', summary);
  }

  /** @param {Document} documentRef */
  function animateDecisionContentIfChanged(documentRef) {
    const body = documentRef.querySelector('#decision-region .decision-body');
    if (!body) return;

    const signature = Array.from(body.querySelectorAll('[id]'))
      .filter((element) => !element.closest('[hidden]'))
      .map((element) => `${element.id}:${element.textContent?.trim() ?? ''}`)
      .join('\u001f');
    const previousSignature = decisionContentSnapshots.get(documentRef);
    decisionContentSnapshots.set(documentRef, signature);
    if (previousSignature === undefined || previousSignature === signature) return;
    if (documentRef.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    body.classList.remove('is-content-updated');
    void body.offsetWidth;
    body.classList.add('is-content-updated');
  }

  /** @param {JsonRecord | null} snapshot @returns {JsonRecord | null} */
  function snapshotComputation(snapshot) {
    return snapshot ? asRecord(snapshot.computation) : null;
  }

  /** @param {JsonRecord | null} snapshot @returns {JsonRecord | null} */
  function canonicalDecision(snapshot) {
    return asRecord(snapshotComputation(snapshot)?.decisao);
  }

  /** @param {JsonRecord | null} snapshot @returns {JsonRecord | null} */
  function latestCycleMetric(snapshot) {
    const computation = snapshotComputation(snapshot);
    const values = recordList(snapshot?.cycle_metrics ?? computation?.metricas);
    const runId = snapshot?.run_id;
    return values.slice().reverse().find((metric) => (
      typeof runId !== 'string' || metric.run_id === runId
    )) ?? null;
  }

  /** @param {unknown} value @returns {string} */
  function countText(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      ? String(value)
      : '—';
  }

  /** @param {unknown} value @returns {string} */
  function securityLabel(value) {
    if (value === 'seguro') return 'Seguro';
    if (value === 'prevencao') return 'Prevenção';
    if (value === 'incidente') return 'Incidente';
    return '—';
  }

  /** @param {unknown} value @returns {string[]} */
  function stringList(value) {
    return Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' && entry.trim())
      : [];
  }

  /** @param {Document} documentRef @param {JsonRecord | null} snapshot @param {JsonRecord | null} decision */
  function renderApplicablePreference(documentRef, snapshot, decision) {
    const computation = snapshotComputation(snapshot);
    const preferences = recordList(snapshot?.preferences ?? computation?.preferencias);
    const canonical = canonicalDecision(snapshot);
    const selected = selectedAlternative(decision);
    const objective = typeof canonical?.objetivo === 'string'
      ? canonical.objetivo
      : typeof decision?.objetivo === 'string' ? decision.objetivo : '';
    const strategyId = typeof canonical?.strategy_id === 'string'
      ? canonical.strategy_id
      : typeof decision?.strategy_id === 'string'
        ? decision.strategy_id
        : typeof selected?.strategy_id === 'string' ? selected.strategy_id : '';
    const applicable = objective && strategyId
      ? preferences.find((preference) => preference.objetivo === objective && preference.strategy_id === strategyId)
      : undefined;
    setText(documentRef, 'decision-preference-objective', objective ? objectiveLabel(objective) : '—');
    setText(documentRef, 'decision-preference-strategy', strategyId ? actionLabel(strategyId) : '—');
    setText(documentRef, 'decision-preference-value', applicable ? signedValue(applicable.valor) : '—');
    setHidden(documentRef, 'decision-preference-region', !objective || !strategyId);
  }

  /** @param {Document} documentRef @param {JsonRecord | null} snapshot @param {JsonRecord | null} decision */
  function renderCycleMetrics(documentRef, snapshot, decision) {
    const metric = latestCycleMetric(snapshot);
    const hasMetric = Boolean(metric);
    setHidden(documentRef, 'cycle-metrics-region', !hasMetric);
    if (!metric) {
      for (const id of [
        'cycle_metric_number', 'cycle_metric_temperature', 'cycle_metric_comfort', 'cycle_metric_cost',
        'cycle_metric_economy', 'cycle_metric_preference', 'cycle_metric_strategy', 'cycle_metric_security',
        'cycle_metric_blocks', 'cycle_metric_incidents', 'cycle_metric_feedback',
      ]) setText(documentRef, id, '—');
      return;
    }
    const canonical = canonicalDecision(snapshot);
    const strategyId = typeof metric.strategy_id === 'string' ? metric.strategy_id
      : typeof canonical?.strategy_id === 'string' ? canonical.strategy_id
        : typeof decision?.strategy_id === 'string' ? decision.strategy_id : '—';
    const blocks = stringList(metric.bloqueios);
    const incidents = stringList(metric.incidentes);
    setText(documentRef, 'cycle_metric_number', countText(metric.numero_ciclo));
    setText(documentRef, 'cycle_metric_temperature', metricWithUnit(metric.temperatura_projetada, '°C', 1));
    setText(documentRef, 'cycle_metric_comfort', formatMetric(metric.conforto));
    setText(documentRef, 'cycle_metric_cost', formatMetric(metric.custo_energetico));
    setText(documentRef, 'cycle_metric_economy', formatMetric(metric.economia));
    setText(documentRef, 'cycle_metric_preference', signedMetric(metric.ajuste_preferencia));
    setText(documentRef, 'cycle_metric_strategy', actionLabel(strategyId));
    setText(documentRef, 'cycle_metric_security', securityLabel(metric.seguranca));
    setText(documentRef, 'cycle_metric_blocks', blocks.length ? blocks.join(' · ') : 'Nenhum bloqueio registrado.');
    setText(documentRef, 'cycle_metric_incidents', incidents.length ? incidents.join(' · ') : 'Nenhum incidente registrado.');
    setText(documentRef, 'cycle_metric_feedback', typeof metric.feedback === 'string' ? metric.feedback : '—');
  }

  /** @param {Document} documentRef @param {JsonRecord | null} snapshot */
  function renderRunSummary(documentRef, snapshot) {
    const computation = snapshotComputation(snapshot);
    const summary = asRecord(snapshot?.run_summary) ?? asRecord(computation?.resumo);
    setHidden(documentRef, 'run-summary-region', !summary);
    const values = [
      ['run_summary_cycles', summary ? countText(summary.ciclos) : '—'],
      ['run_summary_energy_total', summary ? formatMetric(summary.custo_energetico_total) : '—'],
      ['run_summary_energy_average', summary ? formatMetric(summary.custo_energetico_medio) : '—'],
      ['run_summary_comfort_average', summary ? formatMetric(summary.conforto_medio) : '—'],
      ['run_summary_safe_cycles', summary ? countText(summary.ciclos_seguros) : '—'],
      ['run_summary_preventions', summary ? countText(summary.prevencoes) : '—'],
      ['run_summary_incidents', summary ? countText(summary.incidentes) : '—'],
      ['run_summary_acceptances', summary ? countText(summary.aceitacoes) : '—'],
      ['run_summary_corrections', summary ? countText(summary.correcoes) : '—'],
      ['run_summary_satisfaction', summary ? formatMetric(summary.satisfacao_observada) : '—'],
    ];
    for (const [id, value] of values) setText(documentRef, id, value);
  }

  /** @param {JsonRecord | null} snapshot @returns {JsonRecord | null} */
  function latestEpisode(snapshot) {
    const computation = snapshotComputation(snapshot);
    const openEpisode = asRecord(computation?.episodio_aberto);
    if (openEpisode) return openEpisode;
    const episodes = recordList(snapshot?.episodes);
    return episodes.length ? episodes[episodes.length - 1] : null;
  }

  /** @param {Document} documentRef @param {JsonRecord | null} snapshot */
  function renderEpisode(documentRef, snapshot) {
    const episode = latestEpisode(snapshot);
    setHidden(documentRef, 'episode-region', !episode);
    setText(documentRef, 'episode-status', episode?.status === 'aberto' ? 'Aberto'
      : episode?.status === 'fechado' ? 'Fechado'
        : episode?.status === 'cancelado' ? 'Cancelado' : '—');
    setText(documentRef, 'episode-objective', episode?.objetivo ? objectiveLabel(episode.objetivo) : '—');
    setText(documentRef, 'episode-strategy', typeof episode?.estrategia_sugerida === 'string' ? episode.estrategia_sugerida : '—');
    setText(documentRef, 'episode-corrected-strategy', typeof episode?.estrategia_corrigida === 'string' ? episode.estrategia_corrigida : 'Nenhuma correção');
    const commands = recordList(episode?.comandos).map((command) => stepText(command));
    setText(documentRef, 'episode-commands', commands.length ? commands.join(' · ') : 'Nenhum comando registrado.');
  }

  /** @param {JsonRecord | null} snapshot @returns {JsonRecord[]} */
  function traceEvents(snapshot) {
    return snapshot ? recordList(snapshot.trace) : [];
  }

  /** @param {unknown} value @returns {string} */
  function traceEventLabel(value) {
    const labels = {
      cycle: 'Ciclo',
      environment: 'Ambiente',
      manual_command: 'Comando manual',
      feedback: 'Feedback',
      episode: 'Episódio',
      reset: 'Reinício',
      run: 'Execução',
    };
    return typeof value === 'string' && hasOwn(labels, value)
      ? labels[/** @type {keyof typeof labels} */ (value)]
      : typeof value === 'string' ? value : 'Evento';
  }

  /** @param {Document} documentRef @param {JsonRecord | null} snapshot @param {number} [pageIndex] */
  function renderTraceHistory(documentRef, snapshot, pageIndex = 0) {
    const events = traceEvents(snapshot);
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(events.length / pageSize));
    const page = Math.min(Math.max(0, pageIndex), pageCount - 1);
    const end = Math.max(0, events.length - page * pageSize);
    const start = Math.max(0, end - pageSize);
    const visible = events.slice(start, end);
    const watermark = snapshot && typeof snapshot.pruned_before === 'number'
      ? countText(snapshot.pruned_before)
      : '—';
    const rows = visible.map((event) => {
      const order = countText(event.ordem);
      const decisionId = typeof event.decisao_id === 'string' ? event.decisao_id : '—';
      return `<li><span class="trace-order">${escapeHTML(order)}</span><span>${escapeHTML(traceEventLabel(event.tipo))}</span><span>${escapeHTML(decisionId)}</span></li>`;
    }).join('');
    setHidden(documentRef, 'trace-region', !snapshot);
    setHTML(documentRef, 'trace-list', rows || '<li class="table-empty">Ainda não há eventos retidos.</li>');
    setText(documentRef, 'trace-cursor', visible.length ? countText(visible[0].ordem) : watermark);
    setText(documentRef, 'trace-watermark', watermark);
    setText(documentRef, 'trace-page-status', events.length
      ? `Página ${page + 1} de ${pageCount} · ${start + 1}–${end} de ${events.length} eventos retidos`
      : 'Nenhum evento retido');
    const older = getElement(documentRef, 'trace-older');
    const newer = getElement(documentRef, 'trace-newer');
    if (older) older.disabled = page >= pageCount - 1;
    if (newer) newer.disabled = page === 0;
  }

  /** @param {Document} documentRef @param {JsonRecord | null} state @param {JsonRecord | null} decision @param {JsonRecord[]} stages @param {UIState} uiState @param {unknown} error @param {JsonRecord | null} response @param {LearningResult | null} learningResult @param {JsonRecord | null} snapshot @param {number} [historyPage] */
  function renderAll(documentRef, state, decision, stages, uiState, error, response, learningResult, snapshot, historyPage = 0) {
    const preview = decision?.status === 'prevista';
    const confirmed = decision && (!decision.status || decision.status === 'confirmada' || decision.status === 'confirmed');
    const previous = cycleResults.get(documentRef);
    if (!decision) cycleResults.delete(documentRef);
    else if (confirmed) {
      const sameCycle = previous && previous.decision.decisao_id === decision.decisao_id && previous.decision.acao === decision.acao;
      cycleResults.set(documentRef, {
        decision,
        stages: sameCycle && !stages.length ? previous.stages : stages,
        state: sameCycle ? previous.state : state,
      });
    }
    const result = cycleResults.get(documentRef);
    const displayedDecision = result?.decision ?? null;
    const environmentChanged = Boolean(result && state && ['hora', 'temperatura_externa', 'umidade', 'chuva', 'presenca_interna', 'presenca_externa', 'dormir']
      .some((field) => state[field] !== result.state?.[field]));
    setHidden(documentRef, 'decision-details', !displayedDecision);
    setHidden(documentRef, 'decision-preview', !preview && !environmentChanged);
    setText(documentRef, 'decision-preview-label', preview ? 'Prévia · não executada' : 'Ambiente alterado');
    setText(documentRef, 'decision-preview-action', preview ? decisionActions(decision).map(actionLabel).join(' · ') : '');
    setText(documentRef, 'decision-preview-copy', !preview
      ? 'O resultado acima pertence ao último ciclo. A próxima decisão será calculada ao avançar o ciclo.'
      : result
      ? 'Ambiente alterado. Esta prévia ainda não foi executada. O resultado acima pertence ao último ciclo; avance para recalcular e executar a próxima decisão.'
      : 'Ainda não executada. Os dispositivos mantêm o estado atual até a execução de um comando. Avance o ciclo para recalcular e executar a decisão.');
    setText(documentRef, 'decision-result-status', displayedDecision ? 'Confirmado' : 'Aguardando execução');
    renderEnvironment(documentRef, state);
    renderConfirmedDevices(documentRef, state);
    renderDecision(documentRef, state, displayedDecision);
    renderIdentity(documentRef, displayedDecision);
    renderEvidence(documentRef, result?.state ?? state, displayedDecision, uiState);
    renderAlternatives(documentRef, displayedDecision);
    renderPlan(documentRef, displayedDecision, result?.stages ?? []);
    renderMetrics(documentRef, displayedDecision);
    renderApplicablePreference(documentRef, snapshot, displayedDecision);
    renderCycleMetrics(documentRef, snapshot, displayedDecision);
    renderRunSummary(documentRef, snapshot);
    renderEpisode(documentRef, snapshot);
    renderTraceHistory(documentRef, snapshot, historyPage);
    renderLearningResult(documentRef, learningResult);
    renderFeedbackControls(documentRef, decision, learningResult);
    renderStatus(documentRef, state, uiState, error, response);
    animateDecisionContentIfChanged(documentRef);
  }

  /** @param {unknown} value @returns {boolean} */
  function isErrorResponse(value) {
    const response = asRecord(value);
    return response !== null && (response.status === 'erro' || response.status === 'error' || response.status === 'failed');
  }

  /** @param {unknown} value @returns {boolean} */
  function isConfirmedResponse(value) {
    const response = asRecord(value);
    return response !== null && (!hasOwn(response, 'status') || response.status === 'sucesso' || response.status === 'success');
  }

  /** @param {unknown} value @returns {JsonRecord[]} */
  function responseStages(value) {
    const response = asRecord(value);
    return response ? recordList(response.etapas) : [];
  }

  /** @param {IntentCallback | undefined} callback @param {unknown[]} args @param {(error: unknown) => void} onError */
  function invokeCallback(callback, args, onError) {
    if (!callback) return;
    try {
      const result = callback(...args);
      void Promise.resolve(result).catch(onError);
    } catch (error) {
      onError(error);
    }
  }

  /** @param {MountOptions | undefined} input @returns {SimulatorUIHandle} */
  function mountSimulatorUI(input = {}) {
    const options = normalizeOptions(input);
    const documentCandidate = resolveDocument(options.document ?? options.documentRef);
    if (!documentCandidate) throw new TypeError('mountSimulatorUI requires a document');
    const documentRef = /** @type {Document} */ (documentCandidate);
    const rootCandidate = resolveRoot(documentRef, options.root);
    if (!rootCandidate) throw new Error('Simulator root #prototypeRoot was not found');
    const rootElement = /** @type {HTMLElement} */ (rootCandidate);
    mountedRoots.get(rootElement)?.destroy();

    let disposed = false;
    /** @type {UIState} */
    let uiState = validUIState(rootElement.dataset.uiState) ?? 'pausado';
    /** @type {JsonRecord | null} */
    let confirmedState = null;
    /** @type {JsonRecord | null} */
    let currentDecision = null;
    /** @type {JsonRecord | null} */
    let lastResponse = null;
    /** @type {JsonRecord | null} */
    let confirmedSnapshot = null;
    /** @type {{ identityId: string, generation: number } | null} */
    let confirmedIdentity = null;
    /** @type {number | null} */
    let confirmedRevision = null;
    let historyPage = 0;
    /** @type {string | null} */
    let historyRunId = null;
    /** @type {LearningResult | null} */
    let lastLearningResult = null;
    /** @type {JsonRecord[]} */
    let confirmedStages = [];
    /** @type {unknown} */
    let currentError = null;
    /** @type {UIElement | null} */
    const cycleModeControl = getElement(documentRef, 'cycle_mode');

    function clearLearningResult() {
      if (disposed) return;
      lastLearningResult = null;
      renderLearningResult(documentRef, null);
    }

    const environmentCallback = callbackFor(options, ['onEnvironmentChange', 'onEnvironmentIntent', 'onEnvironment']);
    const presetCallback = callbackFor(options, ['onPresetIntent', 'onPreset']);
    const resetCallback = callbackFor(options, ['onResetIntent', 'onReset']);
    const cycleCallback = callbackFor(options, ['onCycleIntent', 'onCycle']);
    const pauseCallback = callbackFor(options, ['onPauseIntent', 'onPause']);
    const autoCallback = callbackFor(options, ['onAutoIntent', 'onAutomatic', 'onAuto']);
    const deviceCallback = callbackFor(options, ['onDeviceIntent', 'onDevice']);
    const feedbackCallback = callbackFor(options, ['onFeedbackIntent', 'onFeedback']);
    const intentCallback = callbackFor(options, ['onIntent']);

    /** @param {UIState} nextState */
    function setUIState(nextState) {
      if (disposed) return;
      uiState = nextState;
      rootElement.dataset.uiState = nextState;
      rootElement.setAttribute('data-ui-state', nextState);
      renderStatus(documentRef, confirmedState, uiState, currentError, lastResponse);
    }

    /** @param {unknown} error */
    function reportError(error) {
      if (disposed) return;
      currentError = error;
      setUIState('erro');
      renderAll(documentRef, confirmedState, currentDecision, confirmedStages, uiState, currentError, lastResponse, lastLearningResult, confirmedSnapshot, historyPage);
    }

    /** @param {string} type @param {unknown} payload @param {IntentCallback | undefined} callback */
    function emitIntent(type, payload, callback) {
      if (disposed) return;
      const handler = callback ?? intentCallback;
      if (!handler) return;
      currentError = null;
      setUIState('processando');
      const intent = payload === undefined ? { type } : { type, payload };
      invokeCallback(handler, callback ? (payload === undefined ? [] : [payload]) : [intent], reportError);
    }

    /** @param {UIElement} input */
    function commitEnvironmentChange(input) {
      const base = confirmedState ?? {};
      const payload = environmentPayload(documentRef, base);
      const field = input.dataset.environment;
      if (!field) return;
      const payloadRecord = /** @type {JsonRecord} */ (/** @type {unknown} */ (payload));
      payloadRecord[field] = input.type === 'checkbox' ? (input.checked ? 1 : 0) : Number(input.value);
      emitIntent('environment', payload, environmentCallback);
    }

    /** @param {Event} event */
    function handleEnvironmentChange(event) {
      if (disposed) return;
      const input = closestTarget(event, '[data-environment]');
      if (!input || !ENVIRONMENT_FIELDS.includes(input.dataset.environment ?? '')) return;
      const isRange = input.type === 'range';
      if (isRange && event.type !== 'input' && event.type !== 'change') return;
      if (!isRange && event.type !== 'change') return;
      if (isRange && event.type === 'input') {
        previewEnvironmentRange(documentRef, input);
        return;
      }
      commitEnvironmentChange(input);
    }

    function clearCycleModeSelectionMarker() {
      if (cycleModeControl?.dataset) delete cycleModeControl.dataset.cycleSelectionCommitted;
    }

    function handleCycleModeChange() {
      if (cycleModeControl?.dataset) cycleModeControl.dataset.cycleSelectionCommitted = 'true';
      renderCycleModeHelp(documentRef, selectedCycleMode(documentRef));
    }

    function handleCycleModeMouseDown() {
      clearCycleModeSelectionMarker();
    }

    function handleCycleModeMouseEnter() {
      clearCycleModeSelectionMarker();
    }

    /** @param {string} device */
    function handleDeviceIntent(device) {
      if (!DEVICE_NAMES.includes(/** @type {DeviceName} */ (device))) return;
      emitIntent('device', device, deviceCallback);
    }

    /** @param {string} feedback */
    function handleFeedback(feedback) {
      if (feedback !== 'aceitar' && feedback !== 'rejeitar') return;
      const selected = selectedAlternative(currentDecision);
      const cognitive = currentDecision?.modo === 'cognitivo' || currentDecision?.modo === 'cognitive';
      const confirmed = !currentDecision?.status || currentDecision.status === 'confirmada' || currentDecision.status === 'confirmed';
      const preference = selected?.preferencia_contextual;
      if (!cognitive || !confirmed) return;
      if (feedback === 'aceitar' && preference === 3) return;
      if (feedback === 'rejeitar' && preference === -3) return;
      renderAll(documentRef, confirmedState, currentDecision, confirmedStages, uiState, currentError, lastResponse, lastLearningResult, confirmedSnapshot, historyPage);
      emitIntent('feedback', feedback, feedbackCallback);
    }

    /** @param {Element | null | undefined} dialog */
    function resetDialogScroll(dialog) {
      if (!dialog) return;
      const target = /** @type {HTMLElement} */ (dialog);
      if (typeof target.scrollTo === 'function') {
        target.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      } else {
        target.scrollTop = 0;
        target.scrollLeft = 0;
      }
      const scrollables = target.querySelectorAll?.(
        '.modal-shell, .modal-body, .cycle-mode-help-body, .peas-help-body, .reasoning-body, .table-frame'
      ) ?? [];
      for (const container of scrollables) {
        const elem = /** @type {HTMLElement} */ (container);
        if (typeof elem.scrollTo === 'function') {
          elem.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        } else {
          elem.scrollTop = 0;
          elem.scrollLeft = 0;
        }
      }
    }

    function updateModalScrollLock() {
      const dialogs = [
        getElement(documentRef, 'reasoning-modal'),
        getElement(documentRef, 'peas-help-modal'),
        getElement(documentRef, 'cycle-mode-help-modal'),
        getElement(documentRef, 'utility-formula-modal'),
      ];
      const isOpen = dialogs.some((dialog) => {
        if (!dialog) return false;
        const record = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (dialog));
        if (typeof record.open === 'boolean') return record.open;
        if (typeof dialog.hasAttribute === 'function' && dialog.hasAttribute('open')) return true;
        return record.__isModalOpen === true;
      });
      documentRef.documentElement?.classList?.toggle?.('modal-open', isOpen);
      documentRef.body?.classList?.toggle?.('modal-open', isOpen);
    }

    /** @param {Event} event */
    function handleClick(event) {
      if (disposed) return;
      const reasoningDialog = getElement(documentRef, 'reasoning-modal');
      const peasHelpDialog = getElement(documentRef, 'peas-help-modal');
      const cycleModeHelpDialog = getElement(documentRef, 'cycle-mode-help-modal');
      const utilityFormulaDialog = getElement(documentRef, 'utility-formula-modal');
      const closeDialog = (dialog) => {
        const record = dialog && /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (dialog));
        const close = record && record.close;
        if (typeof close === 'function') close.call(dialog);
        else if (dialog) dialog.hidden = true;
        if (record) record.__isModalOpen = false;
        resetDialogScroll(dialog);
        updateModalScrollLock();
      };
      const showDialog = (dialog) => {
        const record = dialog && /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (dialog));
        const showModal = record && record.showModal;
        resetDialogScroll(dialog);
        if (typeof showModal === 'function') showModal.call(dialog);
        else if (dialog) dialog.hidden = false;
        if (record) record.__isModalOpen = true;
        resetDialogScroll(dialog);
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => resetDialogScroll(dialog));
        }
        const closeBtn = dialog?.querySelector?.('.modal-close');
        if (closeBtn && typeof /** @type {HTMLElement} */ (closeBtn).focus === 'function') {
          /** @type {HTMLElement} */ (closeBtn).focus({ preventScroll: true });
        }
        updateModalScrollLock();
      };
      if (reasoningDialog && event.target === reasoningDialog) {
        closeDialog(reasoningDialog);
        return;
      }
      if (peasHelpDialog && event.target === peasHelpDialog) {
        closeDialog(peasHelpDialog);
        return;
      }
      if (cycleModeHelpDialog && event.target === cycleModeHelpDialog) {
        closeDialog(cycleModeHelpDialog);
        return;
      }
      if (utilityFormulaDialog && event.target === utilityFormulaDialog) {
        closeDialog(utilityFormulaDialog);
        return;
      }
      const button = closestTarget(event, 'button');
      if (!button) return;
      if (button.dataset.tracePage === 'older' || button.dataset.tracePage === 'newer' || button.dataset.tracePage === 'latest') {
        const pageCount = Math.max(1, Math.ceil(traceEvents(confirmedSnapshot).length / 10));
        if (button.dataset.tracePage === 'older') historyPage = Math.min(historyPage + 1, pageCount - 1);
        else if (button.dataset.tracePage === 'newer') historyPage = Math.max(0, historyPage - 1);
        else historyPage = 0;
        render();
        return;
      }
      if (button.dataset.dialog === 'raciocinio') {
        showDialog(reasoningDialog);
        return;
      }
      if (button.dataset.dialog === 'peas-ajuda') {
        showDialog(peasHelpDialog);
        return;
      }
      if (button.dataset.dialog === 'modo-ciclo-ajuda') {
        renderCycleModeHelp(documentRef, selectedCycleMode(documentRef));
        showDialog(cycleModeHelpDialog);
        return;
      }
      if (button.dataset.dialog === 'formula-utilidade-ajuda') {
        showDialog(utilityFormulaDialog);
        return;
      }
      if (button.dataset.dialog === 'fechar') {
        closeDialog(reasoningDialog);
        return;
      }
      if (button.dataset.dialog === 'fechar-peas') {
        closeDialog(peasHelpDialog);
        return;
      }
      if (button.dataset.dialog === 'fechar-modo-ciclo') {
        closeDialog(cycleModeHelpDialog);
        return;
      }
      if (button.dataset.dialog === 'fechar-formula-utilidade') {
        closeDialog(utilityFormulaDialog);
        return;
      }
      if (button.dataset.preset) {
        emitIntent('preset', button.dataset.preset, presetCallback);
        return;
      }
      if (button.dataset.reset !== undefined) {
        emitIntent('reset', undefined, resetCallback);
        return;
      }
      if (button.dataset.cycle === 'next') {
        emitIntent('cycle', selectedCycleMode(documentRef), cycleCallback);
        return;
      }
      if (button.dataset.cycle === 'pause') {
        emitIntent('pause', undefined, pauseCallback);
        return;
      }
      if (button.dataset.cycle === 'auto') {
        emitIntent('auto', selectedCycleMode(documentRef), autoCallback);
        return;
      }
      if (button.dataset.device) {
        handleDeviceIntent(button.dataset.device);
        return;
      }
      if (button.dataset.feedback) handleFeedback(button.dataset.feedback);
    }

    /** @param {Event} event */
    function handleDialogCancel(event) {
      const dialogs = [
        getElement(documentRef, 'reasoning-modal'),
        getElement(documentRef, 'peas-help-modal'),
        getElement(documentRef, 'cycle-mode-help-modal'),
        getElement(documentRef, 'utility-formula-modal'),
      ];
      const dialog = dialogs.find((candidate) => candidate && event.target === candidate);
      const record = dialog && /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (dialog));
      const close = record && record.close;
      if (typeof close === 'function') close.call(dialog);
      else if (dialog) dialog.hidden = true;
      if (record) record.__isModalOpen = false;
      resetDialogScroll(dialog);
      updateModalScrollLock();
    }

    /** @param {Event} event */
    function handleDialogClose(event) {
      resetDialogScroll(/** @type {Element | null | undefined} */ (event.target));
      updateModalScrollLock();
    }

    /** @param {unknown} value @param {UIState | undefined} nextState @returns {boolean} */
    function applyResponse(value, nextState) {
      if (disposed) return false;
      if (!isRecord(value) || isErrorResponse(value) || !isConfirmedResponse(value)) {
        reportError(value);
        return false;
      }
      const incomingSnapshot = responseSnapshot(value);
      const incomingIdentity = responseIdentity(value, incomingSnapshot);
      if (incomingIdentity?.mismatch || confirmedIdentity && incomingIdentity
        && (incomingIdentity.identityId !== confirmedIdentity.identityId
          || incomingIdentity.generation !== confirmedIdentity.generation)) {
        reportError(new Error('A resposta pertence a outra identidade.'));
        return false;
      }
      const incomingRevision = responseRevision(value, incomingSnapshot);
      if (confirmedRevision !== null && incomingRevision !== null && incomingRevision < confirmedRevision) {
        reportError(new Error('A resposta está desatualizada e foi ignorada.'));
        return false;
      }
      const state = responseState(value);
      if (!state) {
        reportError(new Error('A resposta não contém estado confirmado.'));
        return false;
      }
      const incomingRunId = typeof incomingSnapshot?.run_id === 'string' ? incomingSnapshot.run_id : null;
      if (incomingRunId && historyRunId && incomingRunId !== historyRunId) historyPage = 0;
      else if (incomingSnapshot) {
        historyPage = Math.min(historyPage, Math.max(0, Math.ceil(traceEvents(incomingSnapshot).length / 10) - 1));
      }
      if (incomingRunId) historyRunId = incomingRunId;
      confirmedState = state;
      confirmedSnapshot = incomingSnapshot;
      if (incomingIdentity) {
        confirmedIdentity = { identityId: incomingIdentity.identityId, generation: incomingIdentity.generation };
      }
      confirmedRevision = incomingRevision;
      lastResponse = value;
      if (hasOwn(value, 'decisao')) {
        currentDecision = responseDecision(value);
        if (currentDecision?.status === 'prevista') {
          lastLearningResult = null;
        }
      }
      if (hasOwn(value, 'aprendizagem')) {
        lastLearningResult = asRecord(value.aprendizagem);
      } else if (hasOwn(value, 'decisao') && value.decisao === null) {
        lastLearningResult = null;
      }
      confirmedStages = responseStages(value);
      currentError = null;
      uiState = validUIState(nextState) ?? (uiState === 'automatico' ? 'automatico' : 'pronto');
      rootElement.dataset.uiState = uiState;
      rootElement.setAttribute('data-ui-state', uiState);
      renderAll(documentRef, confirmedState, currentDecision, confirmedStages, uiState, currentError, lastResponse, lastLearningResult, confirmedSnapshot, historyPage);
      return true;
    }

    /** @param {unknown} snapshot @returns {boolean} */
    function updateSnapshot(snapshot) {
      return applyResponse({ status: 'sucesso', estado: snapshot }, uiState);
    }

    /** @param {unknown} value @returns {boolean} */
    function renderState(value) {
      if (disposed) return false;
      const stateInput = asRecord(value);
      const nextState = validUIState(stateInput?.uiState) ?? validUIState(value);
      const snapshot = stateInput && hasOwn(stateInput, 'snapshot') ? stateInput.snapshot : value;
      if (responseState(snapshot)) {
        const accepted = applyResponse(snapshot, nextState ?? undefined);
        if (!accepted) return false;
        return true;
      }
      if (!nextState) {
        render();
        return false;
      }
      setUIState(nextState);
      render();
      return true;
    }

    /** @param {unknown} error */
    function renderError(error) {
      reportError(error);
      const message = errorMessage(error);
      setText(documentRef, 'error-message', message);
      setText(documentRef, 'ui-error', message);
    }

    function render() {
      if (disposed) return;
      renderAll(documentRef, confirmedState, currentDecision, confirmedStages, uiState, currentError, lastResponse, lastLearningResult, confirmedSnapshot, historyPage);
    }

    function destroy() {
      if (disposed) return;
      disposed = true;
      rootElement.removeEventListener('input', handleEnvironmentChange);
      rootElement.removeEventListener('change', handleEnvironmentChange);
      rootElement.removeEventListener('click', handleClick);
      cycleModeControl?.removeEventListener('change', handleCycleModeChange);
      cycleModeControl?.removeEventListener('mousedown', handleCycleModeMouseDown);
      cycleModeControl?.removeEventListener('mouseenter', handleCycleModeMouseEnter);
      const reasoningDialog = getElement(documentRef, 'reasoning-modal');
      const peasHelpDialog = getElement(documentRef, 'peas-help-modal');
      const cycleModeHelpDialog = getElement(documentRef, 'cycle-mode-help-modal');
      const utilityFormulaDialog = getElement(documentRef, 'utility-formula-modal');
      reasoningDialog?.removeEventListener('cancel', handleDialogCancel);
      peasHelpDialog?.removeEventListener('cancel', handleDialogCancel);
      cycleModeHelpDialog?.removeEventListener('cancel', handleDialogCancel);
      utilityFormulaDialog?.removeEventListener('cancel', handleDialogCancel);
      reasoningDialog?.removeEventListener('close', handleDialogClose);
      peasHelpDialog?.removeEventListener('close', handleDialogClose);
      cycleModeHelpDialog?.removeEventListener('close', handleDialogClose);
      utilityFormulaDialog?.removeEventListener('close', handleDialogClose);
      documentRef.documentElement?.classList?.toggle?.('modal-open', false);
      documentRef.body?.classList?.toggle?.('modal-open', false);
      mountedRoots.delete(rootElement);
    }

    rootElement.addEventListener('input', handleEnvironmentChange);
    rootElement.addEventListener('change', handleEnvironmentChange);
    rootElement.addEventListener('click', handleClick);
    cycleModeControl?.addEventListener('change', handleCycleModeChange);
    cycleModeControl?.addEventListener('mousedown', handleCycleModeMouseDown);
    cycleModeControl?.addEventListener('mouseenter', handleCycleModeMouseEnter);
    const reasoningDialog = getElement(documentRef, 'reasoning-modal');
    const peasHelpDialog = getElement(documentRef, 'peas-help-modal');
    const cycleModeHelpDialog = getElement(documentRef, 'cycle-mode-help-modal');
    const utilityFormulaDialog = getElement(documentRef, 'utility-formula-modal');
    reasoningDialog?.addEventListener('cancel', handleDialogCancel);
    peasHelpDialog?.addEventListener('cancel', handleDialogCancel);
    cycleModeHelpDialog?.addEventListener('cancel', handleDialogCancel);
    utilityFormulaDialog?.addEventListener('cancel', handleDialogCancel);
    reasoningDialog?.addEventListener('close', handleDialogClose);
    peasHelpDialog?.addEventListener('close', handleDialogClose);
    cycleModeHelpDialog?.addEventListener('close', handleDialogClose);
    utilityFormulaDialog?.addEventListener('close', handleDialogClose);
    renderCycleModeHelp(documentRef, selectedCycleMode(documentRef));

    /** @type {SimulatorUIHandle} */
    const handle = Object.freeze({
      applyResponse,
      receiveResponse: applyResponse,
      updateSnapshot,
      reportError,
      renderState,
      renderError,
      setUIState,
      setState: setUIState,
      clearLearningResult,
      setSnapshot: updateSnapshot,
      render,
      handleEnvironmentChange,
      handleDeviceIntent,
      handleFeedback,
      destroy,
    });
    mountedRoots.set(rootElement, handle);
    render();
    return handle;
  }

  const exported = Object.freeze({ mountSimulatorUI });
  const globalRoot = /** @type {{ PEAS?: Record<string, unknown> }} */ (/** @type {unknown} */ (root));
  globalRoot.PEAS = globalRoot.PEAS ?? {};
  globalRoot.PEAS.simulatorUI = exported;

  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})(/** @type {RuntimeRoot} */ (typeof globalThis === 'object' ? globalThis : {}));
