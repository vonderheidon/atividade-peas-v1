"""Stateless, transactional computation transitions for the PEAS protocol."""

from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
import logging
from typing import Literal, NoReturn, cast, get_args

import config
import services
from shared import peas_protocol as protocol


_LOGGER = logging.getLogger(__name__)
_MUTATION_KINDS = frozenset(
    {
        "cycle",
        "environment",
        "manual_command",
        "feedback",
        "preset",
        "pause",
        "resume",
        "new_run",
        "reset",
    }
)
_PAYLOAD_FIELDS: dict[str, frozenset[str]] = {
    "cycle": frozenset({"kind", "mode"}),
    "environment": frozenset(
        {
            "kind",
            "hora",
            "temperatura_externa",
            "umidade",
            "chuva",
            "presenca_interna",
            "presenca_externa",
            "dormir",
        }
    ),
    "manual_command": frozenset(
        {"kind", "device", "command", "decisao_id"}
    ),
    "feedback": frozenset(
        {"kind", "decisao_id", "tipo", "comando_id"}
    ),
    "preset": frozenset({"kind", "preset"}),
    "pause": frozenset({"kind"}),
    "resume": frozenset({"kind"}),
    "new_run": frozenset({"kind"}),
    "reset": frozenset({"kind"}),
}
_PHYSICAL_FIELDS = (
    "preset_atual",
    "hora",
    "temperatura_externa",
    "temperatura_interna",
    "umidade",
    "luminosidade",
    "chuva",
    "presenca_interna",
    "presenca_externa",
    "dormir",
)
_DEVICE_NAMES = frozenset(
    {"janela", "ar", "ventilador", "umidificador", "lampada"}
)
_STRATEGY_ACTIONS: dict[str, str] = {
    "manter": "manter",
    "ventilacao_natural": "ventilar",
    "ventilacao_assistida": "ventilar",
    "circulacao_interna": "ventilar",
    "resfriamento": "resfriar",
    "resfriamento_assistido": "resfriar",
    "umidificacao": "umidificar",
    "iluminacao": "iluminar",
}
_ACTION_STRATEGIES: dict[str, str] = {
    "manter": "manter",
    "fechar": "manter",
    "ventilar": "ventilacao_natural",
    "resfriar": "resfriamento",
    "umidificar": "umidificacao",
    "iluminar": "iluminacao",
}
_ENVIRONMENT_PAYLOAD_FIELDS = frozenset(
    {
        "hora",
        "temperatura_externa",
        "umidade",
        "chuva",
        "presenca_interna",
        "presenca_externa",
        "dormir",
    }
)


class _TransitionFailure(Exception):
    def __init__(
        self,
        code: protocol.ErrorCode,
        message: str,
        fields: tuple[str, ...] = (),
    ) -> None:
        self.code = code
        self.fields = fields
        super().__init__(message)


def _fail(
    code: protocol.ErrorCode,
    message: str,
    *fields: str,
) -> NoReturn:
    raise _TransitionFailure(code, message, fields)


def _mapping(value: object, field_name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not all(
        isinstance(key, str) for key in value
    ):
        _fail("invalid_payload", f"{field_name} must be an object.", field_name)
    return cast(Mapping[str, object], value)


def _closed_mapping(
    value: object,
    expected_fields: frozenset[str],
    field_name: str,
) -> Mapping[str, object]:
    fields = _mapping(value, field_name)
    if set(fields) != expected_fields:
        _fail("invalid_payload", f"{field_name} has incompatible fields.", field_name)
    return fields


def _validate_request(
    value: object,
    expected_identity: protocol.IdentityRef | None,
) -> protocol.TransitionRequest:
    request_fields = _closed_mapping(
        value,
        frozenset(
            {
                "schema_version",
                "identity_id",
                "identity_generation",
                "base_revision",
                "operation_id",
                "payload_hash",
                "operation",
                "computation",
                "payload",
            }
        ),
        "TransitionRequest",
    )
    try:
        protocol.validate_schema_version(request_fields["schema_version"])
    except protocol.ProtocolValidationError as error:
        raise _TransitionFailure(
            "schema_unsupported", str(error), ("schema_version",)
        ) from error

    try:
        identity = protocol.validate_identity_ref(
            {
                "identity_id": request_fields["identity_id"],
                "identity_generation": request_fields["identity_generation"],
            }
        )
        protocol.validate_operation_id(request_fields["operation_id"])
        base_revision = protocol.validate_revision(
            request_fields["base_revision"], "base_revision"
        )
        payload_hash = protocol.validate_payload_hash(request_fields["payload_hash"])
    except protocol.ProtocolValidationError as error:
        raise _TransitionFailure("invalid_payload", str(error)) from error

    if expected_identity is None:
        _fail(
            "identity_mismatch",
            "An active identity is required to validate the request.",
            "identity_id",
            "identity_generation",
        )
    try:
        validated_expected = protocol.validate_identity_ref(expected_identity)
    except protocol.ProtocolValidationError as error:
        raise ValueError(
            "expected_identity is not a valid identity reference"
        ) from error
    if identity != validated_expected:
        _fail(
            "identity_mismatch",
            "The request identity does not match the active identity.",
            "identity_id",
            "identity_generation",
        )

    operation = request_fields["operation"]
    if not isinstance(operation, str) or operation not in _MUTATION_KINDS:
        _fail("invalid_payload", "operation is not a supported mutation.", "operation")

    payload = _closed_mapping(
        request_fields["payload"],
        _PAYLOAD_FIELDS[operation],
        "payload",
    )
    if payload.get("kind") != operation:
        _fail(
            "invalid_payload",
            "payload.kind must match operation.",
            "payload.kind",
        )

    canonical_request = dict(request_fields)
    try:
        calculated_hash = protocol.compute_payload_hash(canonical_request)
    except protocol.ProtocolValidationError as error:
        raise _TransitionFailure("invalid_payload", str(error)) from error
    if calculated_hash.lower() != payload_hash.lower():
        _fail(
            "invalid_payload",
            "payload_hash does not match the canonical request.",
            "payload_hash",
        )

    computation = _mapping(request_fields["computation"], "computation")
    summary = _mapping(computation.get("resumo"), "computation.resumo")
    run_id = summary.get("run_id")
    try:
        computation_revision = protocol.validate_revision(
            computation.get("revision")
        )
    except protocol.ProtocolValidationError as error:
        raise _TransitionFailure(
            "invalid_state",
            f"The computation revision is invalid: {error}",
            ("computation.revision",),
        ) from error
    try:
        protocol.validate_computation_state(
            computation,
            computation_revision,
            cast(str, run_id),
        )
    except (protocol.ProtocolValidationError, TypeError) as error:
        raise _TransitionFailure(
            "invalid_state",
            f"The computation state is invalid: {error}",
            ("computation",),
        ) from error

    if base_revision != computation_revision:
        _fail(
            "stale_revision",
            "base_revision does not match computation.revision.",
            "base_revision",
        )

    _validate_payload(operation, payload)
    return cast(protocol.TransitionRequest, dict(request_fields))


def _validate_payload(operation: str, payload: Mapping[str, object]) -> None:
    try:
        if operation == "cycle":
            mode = payload["mode"]
            if not isinstance(mode, str):
                _fail("invalid_payload", "mode must be a string.", "payload.mode")
            services.validate_cycle_request({"modo": mode})
        elif operation == "environment":
            services.validate_environment_request(
                {key: payload[key] for key in _ENVIRONMENT_PAYLOAD_FIELDS}
            )
        elif operation == "manual_command":
            device = payload["device"]
            command = payload["command"]
            decision_id = payload["decisao_id"]
            if not isinstance(device, str) or device not in _DEVICE_NAMES:
                _fail("invalid_payload", "device is not supported.", "payload.device")
            if type(command) is not int or command not in (0, 1):
                _fail("invalid_payload", "command must be 0 or 1.", "payload.command")
            if decision_id is not None:
                protocol.validate_payload_hash(decision_id)
            services.validate_manual_request(
                {} if decision_id is None else {"decisao_id": decision_id}
            )
        elif operation == "feedback":
            decision_id = payload["decisao_id"]
            command_id = payload["comando_id"]
            protocol.validate_payload_hash(decision_id)
            if command_id is not None:
                protocol.validate_payload_hash(command_id)
            feedback_payload: dict[str, object] = {
                "decisao_id": decision_id,
                "tipo": payload["tipo"],
            }
            if command_id is not None:
                feedback_payload["comando_id"] = command_id
            services.validate_feedback_request(feedback_payload)
        elif operation == "preset":
            services.validate_preset_request({"preset": payload["preset"]})
        elif operation == "reset":
            services.validate_reset_request({})
    except services.ContractValidationError as error:
        if error.code == services.UNSAFE_ACTION:
            _fail("unsafe_action", error.message, *error.fields)
        _fail("invalid_payload", error.message, *error.fields)
    except protocol.ProtocolValidationError as error:
        _fail("invalid_payload", str(error), "payload")


def _service_decision(
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> dict[str, object] | None:
    decision_snapshot = computation["decisao"]
    if decision_snapshot is None:
        return None
    action = _STRATEGY_ACTIONS[decision_snapshot["strategy_id"]]
    stored_context = decision_snapshot.get("contexto")
    context = (
        services._validated_context(cast(Mapping[str, object], stored_context))
        if isinstance(stored_context, Mapping)
        else services.build_learning_context(room_state)
    )
    decision: dict[str, object] = {
        "decisao_id": decision_snapshot["decisao_id"],
        "objetivo": decision_snapshot["objetivo"],
        "strategy_id": decision_snapshot["strategy_id"],
        "modo": decision_snapshot["modo"],
        "status": decision_snapshot["status"],
        "acao": action,
        "acoes": [action],
        "influenciada": decision_snapshot["influenciada"],
        "alternativas": deepcopy(decision_snapshot["alternativas"]),
        "plano": deepcopy(decision_snapshot["plano"]),
        "identidade": services._learning_identity(
            room_state,
            context,
            cast(services.Mode, decision_snapshot["modo"]),
        ),
    }
    if isinstance(stored_context, Mapping):
        decision["contexto"] = deepcopy(dict(stored_context))
    corrections = _decision_corrections(decision_snapshot)
    if corrections is not None:
        decision["correcoes_permitidas"] = deepcopy(corrections)
    return decision


def _room_state_from_computation(
    computation: protocol.ComputationState,
) -> services.RoomState:
    physical = computation["fisico"]
    summary = computation["resumo"]
    decision_snapshot = computation["decisao"]
    last_confirmed_action: str | None = None
    if decision_snapshot is not None and decision_snapshot["status"] == "confirmada":
        confirmed_steps = [
            step
            for step in decision_snapshot["plano"]
            if step.get("status") == "confirmado"
        ]
        if any(
            step.get("dispositivo") == "ar" and step.get("comando") == 1
            for step in confirmed_steps
        ):
            last_confirmed_action = "resfriar"
        elif any(
            (
                step.get("dispositivo") == "janela"
                or step.get("dispositivo") == "ventilador"
            )
            and step.get("comando") == 1
            for step in confirmed_steps
        ):
            last_confirmed_action = "ventilar"
        elif any(
            step.get("dispositivo") == "janela" and step.get("comando") == 0
            for step in confirmed_steps
        ):
            last_confirmed_action = "fechar"
        else:
            last_confirmed_action = _STRATEGY_ACTIONS[
                decision_snapshot["strategy_id"]
            ]
    state: dict[str, object] = {
        **physical,
        "revisao_estado": computation["revision"],
        "run_id": summary["run_id"],
        "pruned_before": 0,
        "modo": "reativo",
        "dispositivos": computation["dispositivos"],
        "ultima_acao_confirmada": last_confirmed_action,
        "decisao": None,
        "etapas": [],
        "preferencias": {},
        "metricas": computation["metricas"],
        "resumo": summary,
        "episodio_aberto": computation["episodio_aberto"],
        "feedbacks": [],
        "rastro": [],
        "decisao_pendente": None,
        "execucao_automatica": computation["execucao"],
    }
    typed_state = cast(services.RoomState, state)
    snapshot = decision_snapshot
    if snapshot is not None:
        typed_state["modo"] = snapshot["modo"]
        typed_state["decisao"] = _service_decision(computation, typed_state)
        typed_state["decisao_pendente"] = typed_state["decisao"]
        registry: dict[str, dict[str, object]] = {}
        for step in snapshot["plano"]:
            command_id = step.get("comando_id")
            if isinstance(command_id, str):
                registry[command_id] = cast(dict[str, object], deepcopy(step))
        cast(dict[str, object], typed_state)["_comandos_confirmados"] = registry
    return typed_state


def _computation_with_state(
    original: protocol.ComputationState,
    room_state: services.RoomState,
    *,
    revision: int,
) -> protocol.ComputationState:
    state = cast(dict[str, object], dict(original))
    state["revision"] = revision
    state["fisico"] = {field: room_state[field] for field in _PHYSICAL_FIELDS}
    state["dispositivos"] = room_state["dispositivos"]
    metrics = room_state["metricas"]
    state["metricas"] = metrics[-1:] if metrics else []
    state["resumo"] = room_state["resumo"]
    state["episodio_aberto"] = room_state["episodio_aberto"]
    state["execucao"] = room_state["execucao_automatica"]
    service_decision = room_state["decisao"]
    if isinstance(service_decision, Mapping):
        state["decisao"] = _protocol_decision(
            cast(Mapping[str, object], service_decision)
        )
    else:
        state["decisao"] = None
    return cast(protocol.ComputationState, state)


def _protocol_decision(
    decision: Mapping[str, object],
) -> protocol.DecisionSnapshot:
    action = decision.get("acao", "manter")
    strategy = decision.get("strategy_id")
    if not isinstance(strategy, str) or strategy not in get_args(protocol.StrategyId):
        strategy = _ACTION_STRATEGIES.get(str(action), "manter")
    alternatives = decision.get("alternativas", [])
    plan = decision.get("plano", [])
    decision_id = decision.get("decisao_id")
    objective = decision.get("objetivo", "manutencao")
    mode = decision.get("modo", "reativo")
    status = decision.get("status", "confirmada")
    result: dict[str, object] = {
        "decisao_id": cast(str, decision_id),
        "objetivo": cast(protocol.Objective, objective),
        "strategy_id": cast(protocol.StrategyId, strategy),
        "modo": cast(protocol.Mode, mode),
        "status": cast(Literal["prevista", "confirmada", "invalidada"], status),
        "influenciada": decision.get("influenciada") is True,
        "alternativas": cast(list[dict[str, object]], alternatives),
        "plano": cast(list[dict[str, object]], plan),
    }
    context = decision.get("contexto")
    if isinstance(context, Mapping):
        result["contexto"] = deepcopy(dict(context))
    corrections = _decision_corrections(decision)
    if corrections is not None:
        result["correcoes_permitidas"] = deepcopy(corrections)
    return cast(protocol.DecisionSnapshot, result)


def _decision_corrections(
    decision: Mapping[str, object],
) -> list[object] | None:
    """Return corrections attached to the decision or its selected alternative."""

    direct = decision.get("correcoes_permitidas")
    if isinstance(direct, list):
        return direct
    strategy_id = decision.get("strategy_id")
    alternatives = decision.get("alternativas")
    if isinstance(alternatives, list):
        selected = next(
            (
                alternative
                for alternative in alternatives
                if isinstance(alternative, Mapping)
                and alternative.get("strategy_id") == strategy_id
            ),
            None,
        )
        if isinstance(selected, Mapping):
            nested = selected.get("correcoes_permitidas")
            if isinstance(nested, list):
                return nested
    return None


def _service_preferences(
    preferences: list[protocol.PreferenceRecord],
) -> dict[str, int]:
    values: dict[str, int] = {}
    for record in preferences:
        key = services._preference_key_for_strategy(
            record["objetivo"],
            record["strategy_id"],
        )
        values[key] = record["valor"]
    return values


def _refresh_protocol_decision(
    computation: protocol.ComputationState,
) -> dict[str, object] | None:
    snapshot = computation["decisao"]
    if snapshot is None:
        return None
    decision: dict[str, object] = {
        "decisao_id": snapshot["decisao_id"],
        "objetivo": snapshot["objetivo"],
        "strategy_id": snapshot["strategy_id"],
        "modo": snapshot["modo"],
        "status": snapshot["status"],
        "acao": _STRATEGY_ACTIONS[snapshot["strategy_id"]],
        "acoes": [_STRATEGY_ACTIONS[snapshot["strategy_id"]]],
        "influenciada": snapshot["influenciada"],
        "alternativas": deepcopy(snapshot["alternativas"]),
        "plano": deepcopy(snapshot["plano"]),
    }
    state = _room_state_from_computation(computation)
    stored_context = snapshot.get("contexto")
    context = (
        services._validated_context(cast(Mapping[str, object], stored_context))
        if isinstance(stored_context, Mapping)
        else services.build_learning_context(state)
    )
    if isinstance(stored_context, Mapping):
        decision["contexto"] = deepcopy(dict(stored_context))
    corrections = _decision_corrections(snapshot)
    if corrections is not None:
        decision["correcoes_permitidas"] = deepcopy(corrections)
    decision["identidade"] = services._learning_identity(
        state,
        context,
        cast(services.Mode, snapshot["modo"]),
    )
    return decision


def _set_deterministic_command_ids(
    steps: list[services.PlanStep],
    request: protocol.TransitionRequest,
) -> list[services.PlanStep]:
    identified: list[services.PlanStep] = []
    for index, step in enumerate(steps):
        updated = cast(services.PlanStep, deepcopy(step))
        updated["comando_id"] = protocol.derive_deterministic_id(
            request["identity_generation"],
            request["base_revision"],
            request["operation_id"],
            100 + index,
        )
        identified.append(updated)
    return identified


def _event(
    request: protocol.TransitionRequest,
    run_id: str,
    *,
    order: int,
    kind: str,
    decision_id: str | None,
    command_id: str | None,
    data: Mapping[str, object],
) -> protocol.TraceEvent:
    return {
        "event_id": protocol.derive_deterministic_id(
            request["identity_generation"],
            request["base_revision"],
            request["operation_id"],
            10000 + order,
        ),
        "run_id": run_id,
        "ordem": order,
        "tipo": cast(
            Literal[
                "cycle",
                "environment",
                "manual_command",
                "feedback",
                "episode",
                "reset",
                "run",
            ],
            kind,
        ),
        "operation_id": request["operation_id"],
        "decisao_id": decision_id,
        "comando_id": command_id,
        "dados": cast(dict[str, object], deepcopy(dict(data))),
    }


def _new_run_id(request: protocol.TransitionRequest) -> str:
    return protocol.derive_deterministic_id(
        request["identity_generation"],
        request["base_revision"],
        request["operation_id"],
        2,
    )


def _thermal_vector(devices: protocol.DeviceVector) -> protocol.ThermalDeviceVector:
    return {
        "janela": devices["janela"],
        "ar": devices["ar"],
        "ventilador": devices["ventilador"],
    }


def _close_episode(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> tuple[protocol.ComputationState, protocol.EpisodeState | None, str | None]:
    opened_episode = computation["episodio_aberto"]
    if opened_episode is None:
        return cast(protocol.ComputationState, deepcopy(computation)), None, None

    closed_episode = cast(protocol.EpisodeState, deepcopy(opened_episode))
    final_vector = _thermal_vector(computation["dispositivos"])
    closed_episode["status"] = "fechado"
    closed_episode["vetor_final"] = final_vector

    updated = cast(protocol.ComputationState, deepcopy(computation))
    updated["episodio_aberto"] = None
    matched_strategy: str | None = None
    if closed_episode["objetivo"] == "termico":
        matched_strategy = services._strategy_for_thermal_vector(final_vector)
    if matched_strategy is None:
        return updated, closed_episode, None

    suggested_strategy = closed_episode["estrategia_sugerida"]
    records = cast(
        list[protocol.PreferenceRecord],
        deepcopy(computation["preferencias"]),
    )
    explanatory_context = cast(
        dict[str, str | int | float | bool],
        dict(services.build_learning_context(room_state)),
    )
    for strategy_id, delta in (
        (matched_strategy, 1),
        (suggested_strategy, -1),
    ):
        record = next(
            (
                item
                for item in records
                if item["objetivo"] == closed_episode["objetivo"]
                and item["strategy_id"] == strategy_id
            ),
            None,
        )
        previous = 0 if record is None else record["valor"]
        current = max(-3, min(3, previous + delta))
        if record is None:
            record = {
                "objetivo": closed_episode["objetivo"],
                "strategy_id": cast(protocol.StrategyId, strategy_id),
                "valor": cast(protocol.PreferenceValue, current),
                "updated_revision": request["base_revision"] + 1,
                "contexto_explicativo": explanatory_context,
            }
            records.append(record)
        else:
            record["valor"] = cast(protocol.PreferenceValue, current)
            record["updated_revision"] = request["base_revision"] + 1
            record["contexto_explicativo"] = explanatory_context
    updated["preferencias"] = records
    return updated, closed_episode, matched_strategy


def _handle_cycle(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    if computation["fisico"]["preset_atual"] is None:
        _fail(
            "invalid_state",
            "A preset must be selected before a cycle.",
            "fisico.preset_atual",
        )
    payload = cast(protocol.CyclePayload, request["payload"])
    starting_devices = deepcopy(computation["dispositivos"])
    events: list[protocol.TraceEvent] = []
    working_computation, closed_episode, matched_strategy = _close_episode(
        request,
        computation,
        room_state,
    )
    if closed_episode is not None:
        events.append(
            _event(
                request,
                computation["resumo"]["run_id"],
                order=len(events) + 1,
                kind="episode",
                decision_id=closed_episode["decisao_id"],
                command_id=None,
                data={
                    "episode_id": closed_episode["episode_id"],
                    "status": "fechado",
                    "episode": closed_episode,
                    "matched_strategy_id": matched_strategy,
                },
            )
        )
        room_state["episodio_aberto"] = None
        room_state["preferencias"] = _service_preferences(
            working_computation["preferencias"]
        )
    result = services.run_cycle(
        {"modo": payload["mode"]},
        state=room_state,
    )
    decision_value = result.get("decisao")
    if not isinstance(decision_value, Mapping):
        raise RuntimeError("run_cycle did not return a decision.")
    if room_state["metricas"]:
        room_state["metricas"][-1]["cycle_id"] = protocol.derive_deterministic_id(
            request["identity_generation"],
            request["base_revision"],
            request["operation_id"],
            2_000_000,
        )
    decision = dict(decision_value)
    decision_id = protocol.derive_deterministic_id(
        request["identity_generation"],
        request["base_revision"],
        request["operation_id"],
        0,
    )
    decision["decisao_id"] = decision_id
    steps_value = result.get("etapas")
    if not isinstance(steps_value, list):
        raise RuntimeError("run_cycle did not return its confirmed plan.")
    steps = _set_deterministic_command_ids(
        cast(list[services.PlanStep], steps_value), request
    )
    decision["plano"] = deepcopy(steps)
    decision["status"] = "confirmada"
    decision["influenciada"] = any(
        item.get("influenciada") is True
        for item in cast(list[dict[str, object]], decision.get("alternativas", []))
    )
    room_state["decisao"] = deepcopy(decision)
    room_state["decisao_pendente"] = None
    room_state["etapas"] = cast(list[dict[str, object]], deepcopy(steps))
    cast(dict[str, object], room_state)["_comandos_confirmados"] = {
        cast(str, step["comando_id"]): cast(dict[str, object], deepcopy(step))
        for step in steps
        if step["comando_id"] is not None
    }
    next_computation = _computation_with_state(
        working_computation,
        room_state,
        revision=request["base_revision"] + 1,
    )
    next_episode: protocol.EpisodeState | None = None
    if payload["mode"] == "cognitivo":
        episode_id = protocol.derive_deterministic_id(
            request["identity_generation"],
            request["base_revision"],
            request["operation_id"],
            1,
        )
        protocol_decision = next_computation["decisao"]
        if protocol_decision is None:
            raise RuntimeError("run_cycle did not return its protocol decision.")
        next_episode = {
            "episode_id": episode_id,
            "run_id": computation["resumo"]["run_id"],
            "decisao_id": decision_id,
            "objetivo": protocol_decision["objetivo"],
            "estrategia_sugerida": protocol_decision["strategy_id"],
            "vetor_inicial": _thermal_vector(starting_devices),
            "comandos": cast(list[dict[str, object]], deepcopy(steps)),
            "vetor_final": None,
            "estrategia_corrigida": None,
            "status": "aberto",
        }
        events.append(
            _event(
                request,
                computation["resumo"]["run_id"],
                order=len(events) + 1,
                kind="episode",
                decision_id=decision_id,
                command_id=None,
                data={"episode_id": episode_id, "status": "aberto"},
            )
        )
    next_computation["episodio_aberto"] = next_episode
    event = _event(
        request,
        computation["resumo"]["run_id"],
        order=len(events) + 1,
        kind="cycle",
        decision_id=decision_id,
        command_id=steps[0]["comando_id"] if steps else None,
        data={
            "mode": payload["mode"],
            "decision_id": decision_id,
            "steps": cast(list[dict[str, object]], deepcopy(steps)),
        },
    )
    events.append(event)
    return next_computation, events


def _handle_environment(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    payload = cast(protocol.EnvironmentPayload, request["payload"])
    environment = services.validate_environment_request(
        {key: payload[key] for key in _ENVIRONMENT_PAYLOAD_FIELDS}
    )
    confirmed_decision = room_state["decisao"]
    current_environment = cast(Mapping[str, object], room_state)
    validated_environment = cast(Mapping[str, object], environment)
    changed = any(
        current_environment[field] != validated_environment[field]
        for field in _ENVIRONMENT_PAYLOAD_FIELDS
    )
    candidate = cast(services.RoomState, deepcopy(room_state))
    identity_changed = False
    if changed:
        services._apply_environment_values(candidate, environment)
        identity_changed = services._environment_changes_decision_identity(
            cast(Mapping[str, object] | None, confirmed_decision),
            candidate,
        )
        services._apply_environment_values(room_state, environment)
    if identity_changed and computation["decisao"] is not None:
        computation = cast(protocol.ComputationState, deepcopy(computation))
        invalidated = cast(dict[str, object], deepcopy(computation["decisao"]))
        invalidated["status"] = "invalidada"
        computation["decisao"] = cast(protocol.DecisionSnapshot, invalidated)
        service_decision = room_state["decisao"]
        if isinstance(service_decision, dict):
            service_decision["status"] = "invalidada"
        room_state["decisao_pendente"] = None
        room_state["etapas"] = []
        room_state["feedbacks"] = []
        cast(dict[str, object], room_state)["_comandos_confirmados"] = {}
    updated = _computation_with_state(
        computation,
        room_state,
        revision=request["base_revision"] + 1,
    )
    decision = computation["decisao"]
    event = _event(
        request,
        computation["resumo"]["run_id"],
        order=1,
        kind="environment",
        decision_id=decision["decisao_id"] if decision is not None else None,
        command_id=None,
        data={key: payload[key] for key in _ENVIRONMENT_PAYLOAD_FIELDS},
    )
    return updated, [event]


def _handle_manual_command(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    payload = cast(protocol.ManualCommandPayload, request["payload"])
    decision_id = payload["decisao_id"]
    if decision_id is not None:
        active = computation["decisao"]
        if active is None or active["decisao_id"] != decision_id:
            _fail(
                "not_found",
                "The correlated decision does not exist.",
                "payload.decisao_id",
            )
    steps = services.execute_manual(
        room_state,
        payload["device"],
        payload["command"],
        decision_id=decision_id,
    )
    identified = _set_deterministic_command_ids(steps, request)
    room_state["etapas"] = cast(list[dict[str, object]], deepcopy(identified))
    state_mapping = cast(dict[str, object], room_state)
    state_mapping["_comandos_confirmados"] = {
        cast(str, step["comando_id"]): cast(dict[str, object], deepcopy(step))
        for step in identified
        if step["comando_id"] is not None
    }
    if decision_id is not None and computation["decisao"] is not None:
        updated = cast(protocol.ComputationState, deepcopy(computation))
        decision = cast(dict[str, object], deepcopy(updated["decisao"]))
        plan = cast(list[dict[str, object]], deepcopy(decision["plano"]))
        plan.extend(cast(list[dict[str, object]], deepcopy(identified)))
        decision["plano"] = plan
        updated["decisao"] = cast(protocol.DecisionSnapshot, decision)
        computation = updated
        room_state["decisao"] = _service_decision(computation, room_state)
        room_state["decisao_pendente"] = deepcopy(room_state["decisao"])
    opened_episode = room_state["episodio_aberto"]
    if (
        decision_id is not None
        and opened_episode is not None
        and opened_episode["decisao_id"] == decision_id
    ):
        correlated_commands = [
            {
                **cast(dict[str, object], deepcopy(step)),
                "decisao_id": decision_id,
                "origem": "manual_command",
            }
            for step in identified
        ]
        opened_episode["comandos"].extend(correlated_commands)
        if opened_episode["objetivo"] == "termico":
            corrected_strategy = services._strategy_for_thermal_vector(
                _thermal_vector(room_state["dispositivos"])
            )
            if corrected_strategy is not None:
                opened_episode["estrategia_corrigida"] = corrected_strategy
    updated_computation = _computation_with_state(
        computation,
        room_state,
        revision=request["base_revision"] + 1,
    )
    event = _event(
        request,
        computation["resumo"]["run_id"],
        order=1,
        kind="manual_command",
        decision_id=decision_id,
        command_id=identified[0]["comando_id"] if identified else None,
        data={
            "device": payload["device"],
            "command": payload["command"],
            "steps": cast(list[dict[str, object]], deepcopy(identified)),
        },
    )
    return updated_computation, [event]


def _handle_feedback(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
    room_state: services.RoomState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    payload = cast(protocol.FeedbackPayload, request["payload"])
    decision_snapshot = computation["decisao"]
    if (
        decision_snapshot is None
        or decision_snapshot["decisao_id"] != payload["decisao_id"]
    ):
        _fail(
            "not_found",
            "The feedback decision does not exist.",
            "payload.decisao_id",
        )
    if decision_snapshot["status"] != "confirmada":
        _fail(
            "invalid_payload",
            "Feedback requires a confirmed decision.",
            "payload.decisao_id",
        )
    decision = _refresh_protocol_decision(computation)
    if decision is None:
        raise RuntimeError("The active protocol decision could not be reconstructed.")
    services._ensure_cognitive_feedback(decision)
    action = services._decision_action(decision)
    context = services._decision_context(room_state, decision)
    feedback_type = cast(str, payload["tipo"])
    canonical_type, delta = services._normalise_feedback_type(feedback_type)
    command_id = payload["comando_id"]
    command: Mapping[str, object] | None = None
    if canonical_type == "corrigir":
        episode = computation["episodio_aberto"]
        if episode is not None and episode["decisao_id"] == payload["decisao_id"]:
            for step in episode["comandos"]:
                if (
                    step.get("comando_id") == command_id
                    and step.get("origem") == "manual_command"
                    and step.get("decisao_id") == payload["decisao_id"]
                    and step.get("status") == "confirmado"
                ):
                    command = step
                    break
        if command is None or not services.correction_is_eligible(
            decision,
            command,
            state=room_state,
        ):
            _fail(
                "unsafe_action",
                "The referenced command is not an eligible correction.",
                "payload.comando_id",
            )
    elif command_id is not None:
        _fail(
            "invalid_payload",
            "Only corrective feedback accepts command_id.",
            "payload.comando_id",
        )

    strategy_id = decision_snapshot["strategy_id"]
    objective = decision_snapshot["objetivo"]
    records = cast(
        list[protocol.PreferenceRecord],
        deepcopy(computation["preferencias"]),
    )
    record = next(
        (
            item
            for item in records
            if item["objetivo"] == objective and item["strategy_id"] == strategy_id
        ),
        None,
    )
    previous = 0 if record is None else record["valor"]
    current = previous + delta
    if not -3 <= current <= 3:
        _fail(
            "invalid_payload",
            "The preference value is already at its limit.",
            "preferencias",
        )
    if record is None:
        record = {
            "objetivo": objective,
            "strategy_id": strategy_id,
            "valor": cast(protocol.PreferenceValue, current),
            "updated_revision": request["base_revision"] + 1,
            "contexto_explicativo": cast(
                dict[str, str | int | float | bool],
                dict(context),
            ),
        }
        records.append(record)
    else:
        record["valor"] = cast(protocol.PreferenceValue, current)
        record["updated_revision"] = request["base_revision"] + 1
        record["contexto_explicativo"] = cast(
            dict[str, str | int | float | bool], dict(context)
        )

    updated = cast(protocol.ComputationState, deepcopy(computation))
    updated["preferencias"] = records
    updated["revision"] = request["base_revision"] + 1
    services.record_observed_feedback(
        room_state,
        payload["decisao_id"],
        cast(services.FeedbackType, canonical_type),
    )
    updated["metricas"] = deepcopy(room_state["metricas"])
    updated["resumo"] = deepcopy(room_state["resumo"])
    event = _event(
        request,
        updated["resumo"]["run_id"],
        order=1,
        kind="feedback",
        decision_id=payload["decisao_id"],
        command_id=command_id,
        data={
            "type": canonical_type,
            "action": action,
            "previous_preference": previous,
            "preference": current,
        },
    )
    return updated, [event]


def _handle_preset(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    payload = cast(protocol.PresetPayload, request["payload"])
    name = cast(protocol.PresetName, payload["preset"])
    preset = deepcopy(config.PRESETS[name])
    updated = cast(protocol.ComputationState, deepcopy(computation))
    physical = cast(dict[str, object], deepcopy(updated["fisico"]))
    for field in (
        "hora",
        "temperatura_externa",
        "temperatura_interna",
        "umidade",
        "chuva",
        "presenca_interna",
        "presenca_externa",
        "dormir",
    ):
        physical[field] = preset[field]
    physical["preset_atual"] = name
    physical["luminosidade"] = config._PRESET_LUMINOSITY[name]
    updated["fisico"] = cast(protocol.PhysicalState, physical)
    updated["dispositivos"] = deepcopy(preset["dispositivos"])
    updated["decisao"] = None
    updated["episodio_aberto"] = None
    updated["execucao"]["pausada"] = True
    updated["revision"] = request["base_revision"] + 1
    event = _event(
        request,
        updated["resumo"]["run_id"],
        order=1,
        kind="environment",
        decision_id=(
            computation["decisao"]["decisao_id"]
            if computation["decisao"]
            else None
        ),
        command_id=None,
        data={"preset": name},
    )
    return updated, [event]


def _handle_execution(
    request: protocol.TransitionRequest,
    computation: protocol.ComputationState,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    operation = request["operation"]
    updated = cast(protocol.ComputationState, deepcopy(computation))
    if operation == "pause":
        updated["execucao"]["pausada"] = True
    elif operation == "resume":
        updated["execucao"]["pausada"] = False
    elif operation == "new_run":
        run_id = _new_run_id(request)
        updated["resumo"] = {
            "run_id": run_id,
            "ciclos": 0,
            "custo_energetico_total": 0.0,
            "custo_energetico_medio": None,
            "conforto_acumulado": 0.0,
            "conforto_medio": None,
            "ciclos_seguros": 0,
            "prevencoes": 0,
            "incidentes": 0,
            "aceitacoes": 0,
            "correcoes": 0,
            "feedbacks_observados": 0,
            "satisfacao_acumulada": 0.0,
            "satisfacao_observada": None,
        }
        updated["metricas"] = []
        updated["decisao"] = None
        updated["episodio_aberto"] = None
        updated["execucao"]["pausada"] = False
    elif operation == "reset":
        run_id = _new_run_id(request)
        preset = deepcopy(config.PRESETS["conforto"])
        updated["fisico"] = {
            "preset_atual": None,
            "hora": preset["hora"],
            "temperatura_externa": preset["temperatura_externa"],
            "temperatura_interna": preset["temperatura_interna"],
            "umidade": preset["umidade"],
            "luminosidade": config._PRESET_LUMINOSITY["conforto"],
            "chuva": preset["chuva"],
            "presenca_interna": preset["presenca_interna"],
            "presenca_externa": preset["presenca_externa"],
            "dormir": preset["dormir"],
        }
        updated["dispositivos"] = deepcopy(preset["dispositivos"])
        updated["preferencias"] = []
        updated["resumo"] = {
            "run_id": run_id,
            "ciclos": 0,
            "custo_energetico_total": 0.0,
            "custo_energetico_medio": None,
            "conforto_acumulado": 0.0,
            "conforto_medio": None,
            "ciclos_seguros": 0,
            "prevencoes": 0,
            "incidentes": 0,
            "aceitacoes": 0,
            "correcoes": 0,
            "feedbacks_observados": 0,
            "satisfacao_acumulada": 0.0,
            "satisfacao_observada": None,
        }
        updated["metricas"] = []
        updated["decisao"] = None
        updated["episodio_aberto"] = None
        updated["execucao"]["pausada"] = True
    updated["revision"] = request["base_revision"] + 1
    kind = "reset" if operation == "reset" else "run"
    event = _event(
        request,
        updated["resumo"]["run_id"],
        order=1,
        kind=kind,
        decision_id=None,
        command_id=None,
        data={"operation": operation},
    )
    return updated, [event]


def _dispatch(
    request: protocol.TransitionRequest,
) -> tuple[protocol.ComputationState, list[protocol.TraceEvent]]:
    computation = cast(
        protocol.ComputationState,
        deepcopy(request["computation"]),
    )
    room_state = _room_state_from_computation(computation)
    room_state["preferencias"] = _service_preferences(computation["preferencias"])
    operation = request["operation"]
    if operation == "cycle":
        return _handle_cycle(request, computation, room_state)
    if operation == "environment":
        return _handle_environment(request, computation, room_state)
    if operation == "manual_command":
        return _handle_manual_command(request, computation, room_state)
    if operation == "feedback":
        return _handle_feedback(request, computation, room_state)
    if operation == "preset":
        return _handle_preset(request, computation)
    return _handle_execution(request, computation)


def _error_response(
    failure: _TransitionFailure,
    value: object,
    *,
    request: protocol.TransitionRequest | None = None,
) -> protocol.TransitionError:
    operation_id: str | None = None
    received_revision: int | None = None
    current_revision: int | None = None
    if request is not None:
        operation_id = request["operation_id"]
        received_revision = request["base_revision"]
        current_revision = request["computation"]["revision"]
    elif isinstance(value, Mapping):
        candidate_id = value.get("operation_id")
        if isinstance(candidate_id, str):
            try:
                operation_id = protocol.validate_operation_id(candidate_id)
            except protocol.ProtocolValidationError:
                operation_id = None
        candidate_revision = value.get("base_revision")
        if type(candidate_revision) is int and candidate_revision >= 0:
            received_revision = candidate_revision
        computation = value.get("computation")
        if isinstance(computation, Mapping):
            candidate_current_revision = computation.get("revision")
            if (
                type(candidate_current_revision) is int
                and candidate_current_revision >= 0
            ):
                current_revision = candidate_current_revision
    return {
        "status": "error",
        "schema_version": 1,
        "code": failure.code,
        "http_status": protocol.ERROR_HTTP_STATUS[failure.code],
        "message": str(failure),
        "fields": list(failure.fields),
        "operation_id": operation_id,
        "received_revision": received_revision,
        "current_revision": current_revision,
        "snapshot": None,
    }


def run_transition(
    value: object,
    *,
    expected_identity: protocol.IdentityRef | None = None,
) -> protocol.TransitionSuccess | protocol.TransitionError:
    """Validate and execute one transition against a private state copy."""

    request: protocol.TransitionRequest | None = None
    try:
        request = _validate_request(value, expected_identity)
        next_computation, events = _dispatch(request)
        next_computation["revision"] = request["base_revision"] + 1
        response: protocol.TransitionSuccess = {
            "status": "success",
            "schema_version": 1,
            "identity_id": request["identity_id"],
            "identity_generation": request["identity_generation"],
            "operation_id": request["operation_id"],
            "payload_hash": request["payload_hash"],
            "base_revision": request["base_revision"],
            "new_revision": request["base_revision"] + 1,
            "operation": request["operation"],
            "computation": next_computation,
            "events": events,
            "snapshot": None,
        }
        protocol.validate_transition_success(response)
        return response
    except _TransitionFailure as failure:
        return _error_response(failure, value, request=request)
    except services.ContractValidationError as error:
        code: protocol.ErrorCode
        if error.code == services.UNSAFE_ACTION:
            code = "unsafe_action"
        elif error.code in {services.PRESET_NOT_SELECTED}:
            code = "invalid_state"
        elif error.code in {
            services.DECISION_NOT_FOUND,
            services.DECISION_NOT_CONFIRMED,
            services.DECISION_OBSOLETE,
            services.COMMAND_NOT_CONFIRMED,
        }:
            code = "not_found"
        else:
            code = "invalid_payload"
        failure = _TransitionFailure(code, error.message, tuple(error.fields))
        return _error_response(failure, value, request=request)
    except services.PlanExecutionError as error:
        failure = _TransitionFailure(
            "internal_error",
            "The ordered device plan could not be completed.",
            tuple(
                str(step["dispositivo"])
                for step in error.failed_steps
            ),
        )
        _LOGGER.exception(
            "Transition plan execution failed",
            extra={"operation_id": request["operation_id"] if request else None},
        )
        return _error_response(failure, value, request=request)
    except (protocol.ProtocolValidationError, TypeError, ValueError) as error:
        failure = _TransitionFailure("invalid_state", str(error), ("computation",))
        return _error_response(failure, value, request=request)
    except Exception:
        _LOGGER.exception(
            "Transition operation failed",
            extra={
                "operation_id": request["operation_id"] if request else None,
                "operation": request["operation"] if request else None,
            },
        )
        failure = _TransitionFailure(
            "internal_error", "The transition could not be completed."
        )
        return _error_response(failure, value, request=request)


transition = run_transition
