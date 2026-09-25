"""Rotas de interface e fronteira de contratos HTTP do simulador."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from typing import cast

from flask import Blueprint, Response, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, HTTPException

import services
import transition
from shared import peas_protocol as protocol


inter_bp = Blueprint("interf", __name__)
_MAX_REQUEST_ARRAY_ITEMS = protocol.MAX_TRACE_PAGE_LIMIT
_SNAPSHOT_REQUEST_FIELDS = frozenset(
    {
        "schema_version",
        "identity_id",
        "identity_generation",
        "operation_id",
        "payload_hash",
        "purpose",
        "snapshot",
    }
)
_SNAPSHOT_PURPOSES = frozenset(
    {"bootstrap", "recovery", "emergency_sync", "reset", "new_run"}
)
_ENVIRONMENT_PAYLOAD_FIELDS = (
    "hora",
    "temperatura_externa",
    "umidade",
    "chuva",
    "presenca_interna",
    "presenca_externa",
    "dormir",
)


def _json_payload() -> object:
    """Lê um corpo JSON sem confundir ausência com JSON malformado."""

    if not request.data:
        return services.NO_BODY
    if not request.is_json:
        raise services.ContractValidationError(
            services.JSON_INVALID,
            "O corpo da requisição deve usar JSON válido.",
        )
    try:
        return cast(object, request.get_json(silent=False))
    except BadRequest as error:
        raise services.ContractValidationError(
            services.JSON_INVALID,
            "O corpo da requisição contém JSON inválido.",
        ) from error


def _error_response(
    error: services.ContractValidationError,
) -> tuple[Response, int]:
    """Serializa uma falha de contrato sem detalhes internos."""

    return (
        jsonify(
            services.error_response(
                error.code,
                error.message,
                error.fields,
            )
        ),
        error.status_code,
    )


def _internal_error(error: Exception) -> tuple[Response, int]:
    """Registra uma falha inesperada e devolve somente o contrato público."""

    current_app.logger.error(
        "Unexpected simulator request failure",
        extra={
            "path": request.path,
            "method": request.method,
            "error_type": type(error).__name__,
        },
    )
    return (
        jsonify(
            services.error_response(
                services.INTERNAL_ERROR,
                "Falha interna ao processar a requisição.",
            )
        ),
        500,
    )


def _protocol_error(
    code: protocol.ErrorCode,
    message: str,
    fields: tuple[str, ...] = (),
    *,
    operation_id: str | None = None,
    received_revision: int | None = None,
    current_revision: int | None = None,
) -> protocol.TransitionError:
    """Build a protocol error without exposing internal details."""

    return protocol.validate_transition_error(
        {
            "status": "error",
            "schema_version": 1,
            "code": code,
            "http_status": protocol.ERROR_HTTP_STATUS[code],
            "message": message,
            "fields": list(fields),
            "operation_id": operation_id,
            "received_revision": received_revision,
            "current_revision": current_revision,
            "snapshot": None,
        }
    )


def _internal_protocol_error(error: Exception) -> protocol.TransitionError:
    """Log request context and return only the public error envelope."""

    current_app.logger.error(
        "Unexpected stateless protocol request failure",
        extra={
            "path": request.path,
            "method": request.method,
            "error_type": type(error).__name__,
        },
    )
    return _protocol_error(
        "internal_error",
        "The request could not be completed.",
    )


def _oversized_array_field(value: object, path: tuple[str, ...] = ()) -> str | None:
    """Return the first array path that exceeds the protocol item limit."""

    if isinstance(value, list):
        items = cast(list[object], value)
        maximum = (
            protocol.MAX_CYCLE_HISTORY
            if path and path[-1] == "cycle_metrics"
            else _MAX_REQUEST_ARRAY_ITEMS
        )
        if len(items) > maximum:
            return ".".join(path) or "body"
        for index, item in enumerate(items):
            oversized = _oversized_array_field(item, (*path, str(index)))
            if oversized is not None:
                return oversized
    elif isinstance(value, Mapping):
        fields = cast(Mapping[str, object], value)
        for key, item in fields.items():
            if isinstance(key, str):
                oversized = _oversized_array_field(item, (*path, key))
                if oversized is not None:
                    return oversized
    return None


def _handle_json(
    operation: Callable[[object], Mapping[str, object]],
    *,
    allow_empty_get: bool = False,
    protocol_response: bool = False,
) -> tuple[Response, int]:
    """Executa uma operação e traduz contratos e falhas internas para JSON."""

    snapshot = None if protocol_response else deepcopy(services.estado_quarto)
    try:
        payload = _json_payload()
        if allow_empty_get and request.method == "GET" and payload is services.NO_BODY:
            payload = {}
        body = operation(payload)
    except services.ContractValidationError as error:
        if snapshot is not None:
            services._restore_state(services.estado_quarto, snapshot)
        if protocol_response:
            protocol_error = _protocol_error(
                "invalid_json"
                if error.code == services.JSON_INVALID
                else "invalid_payload",
                error.message,
                tuple(error.fields),
            )
            return jsonify(protocol_error), protocol_error["http_status"]
        return _error_response(error)
    except Exception as error:
        if snapshot is not None:
            services._restore_state(services.estado_quarto, snapshot)
        if protocol_response:
            protocol_error = _internal_protocol_error(error)
            return jsonify(protocol_error), protocol_error["http_status"]
        return _internal_error(error)
    if not protocol_response:
        return jsonify(body), 200
    status_code = body.get("http_status", 200)
    if type(status_code) is not int or status_code not in (200, 400, 409, 422, 500):
        protocol_error = _internal_protocol_error(
            ValueError("Protocol response has an invalid HTTP status.")
        )
        return jsonify(protocol_error), protocol_error["http_status"]
    return jsonify(body), status_code


def _legacy_json_response(body: Mapping[str, object]) -> tuple[Response, int]:
    envelope = body.get("envelope")
    status_code = (
        envelope.get("http_status", 200)
        if isinstance(envelope, Mapping)
        else 200
    )
    if type(status_code) is not int or status_code not in (200, 400, 409, 422, 500):
        status_code = 500
    response = jsonify(body)
    response.status_code = status_code
    response.headers["Deprecation"] = "true"
    return response, status_code


def _handle_legacy_json(
    operation: Callable[[object], Mapping[str, object]],
    *,
    allow_empty_get: bool = False,
) -> tuple[Response, int]:
    raw_input: object = (
        request.args.to_dict()
        if request.method == "GET"
        else request.get_data(as_text=True)
    )
    try:
        payload = _json_payload()
        if allow_empty_get and request.method == "GET" and payload is services.NO_BODY:
            payload = {}
        if request.method == "POST":
            raw_input = payload
        body = operation(payload)
    except services.ContractValidationError as error:
        body = services.legacy_validation_response(
            error,
            request.path,
            raw_input,
        )
    except Exception as error:
        current_app.logger.error(
            "Unexpected legacy adapter failure",
            extra={
                "path": request.path,
                "method": request.method,
                "error_type": type(error).__name__,
            },
        )
        body = services.legacy_internal_error_response(request.path, raw_input)
    return _legacy_json_response(body)


def _validate_transition_http_limits(
    payload: object,
) -> tuple[protocol.IdentityRef | None, protocol.TransitionError | None]:
    """Validate bounded request fields before invoking the stateless runner."""

    if not isinstance(payload, Mapping):
        return None, _protocol_error(
            "invalid_payload",
            "TransitionRequest must be an object.",
            ("body",),
        )
    fields = cast(Mapping[str, object], payload)

    try:
        protocol.validate_schema_version(fields.get("schema_version"))
    except protocol.ProtocolValidationError as error:
        return None, _protocol_error(
            "schema_unsupported",
            str(error),
            ("schema_version",),
        )

    try:
        identity = protocol.validate_identity_ref(
            {
                "identity_id": fields.get("identity_id"),
                "identity_generation": fields.get("identity_generation"),
            }
        )
    except protocol.ProtocolValidationError as error:
        field = (
            "identity_generation"
            if "identity_generation" in str(error)
            else "identity_id"
        )
        return None, _protocol_error("invalid_payload", str(error), (field,))

    try:
        operation_id = protocol.validate_operation_id(fields.get("operation_id"))
    except protocol.ProtocolValidationError as error:
        return None, _protocol_error(
            "invalid_payload",
            str(error),
            ("operation_id",),
        )

    try:
        protocol.validate_payload_hash(fields.get("payload_hash"))
    except protocol.ProtocolValidationError as error:
        return None, _protocol_error(
            "invalid_payload",
            str(error),
            ("payload_hash",),
            operation_id=operation_id,
        )

    try:
        received_revision = protocol.validate_revision(
            fields.get("base_revision"),
            "base_revision",
        )
    except protocol.ProtocolValidationError as error:
        return None, _protocol_error(
            "invalid_payload",
            str(error),
            ("base_revision",),
            operation_id=operation_id,
        )

    computation = fields.get("computation")
    if isinstance(computation, Mapping):
        computation_fields = cast(Mapping[str, object], computation)
        try:
            current_revision = protocol.validate_revision(
                computation_fields.get("revision")
            )
        except protocol.ProtocolValidationError as error:
            return None, _protocol_error(
                "invalid_state",
                str(error),
                ("computation.revision",),
                operation_id=operation_id,
                received_revision=received_revision,
            )
        try:
            protocol.validate_physical_state(computation_fields.get("fisico"))
        except protocol.ProtocolValidationError as error:
            return None, _protocol_error(
                "invalid_state",
                str(error),
                ("computation.fisico",),
                operation_id=operation_id,
                received_revision=received_revision,
                current_revision=current_revision,
            )

    if fields.get("operation") == "environment":
        environment = fields.get("payload")
        if not isinstance(environment, Mapping):
            return None, _protocol_error(
                "invalid_payload",
                "Environment payload must be an object.",
                ("payload",),
                operation_id=operation_id,
                received_revision=received_revision,
            )
        environment_fields = cast(Mapping[str, object], environment)
        try:
            services.validate_environment_request(
                {
                    field: environment_fields.get(field)
                    for field in _ENVIRONMENT_PAYLOAD_FIELDS
                }
            )
        except services.ContractValidationError as error:
            fields = tuple(f"payload.{field}" for field in error.fields)
            return None, _protocol_error(
                "invalid_payload",
                error.message,
                fields,
                operation_id=operation_id,
                received_revision=received_revision,
            )

    return identity, None


@inter_bp.route("/transition", methods=["POST"])
def apply_transition() -> tuple[Response, int]:
    """Validate and run a stateless transition against its supplied computation."""

    def operation(payload: object) -> Mapping[str, object]:
        oversized_field = _oversized_array_field(payload)
        if oversized_field is not None:
            return _protocol_error(
                "invalid_payload",
                "An array exceeds the maximum number of items.",
                (oversized_field,),
            )
        expected_identity, error = _validate_transition_http_limits(payload)
        if error is not None:
            return error
        if expected_identity is None:
            return _protocol_error(
                "invalid_payload",
                "Transition identity could not be validated.",
                ("identity_id", "identity_generation"),
            )
        return transition.run_transition(
            payload,
            expected_identity=expected_identity,
        )

    return _handle_json(operation, protocol_response=True)


@inter_bp.route("/transition/checkpoint", methods=["POST"])
def create_transition_checkpoint() -> tuple[Response, int]:
    """Validate a complete checkpoint request and echo its canonical snapshot."""

    def operation(payload: object) -> Mapping[str, object]:
        oversized_field = _oversized_array_field(payload)
        if oversized_field is not None:
            return _protocol_error(
                "invalid_payload",
                "An array exceeds the maximum number of items.",
                (oversized_field,),
            )
        if (
            not isinstance(payload, Mapping)
            or not all(isinstance(key, str) for key in payload)
            or set(payload) != _SNAPSHOT_REQUEST_FIELDS
        ):
            return _protocol_error(
                "invalid_payload",
                "SnapshotRequest has incompatible fields.",
                ("body",),
            )
        fields = cast(Mapping[str, object], payload)

        try:
            protocol.validate_schema_version(fields["schema_version"])
        except protocol.ProtocolValidationError as error:
            return _protocol_error(
                "schema_unsupported",
                str(error),
                ("schema_version",),
            )

        try:
            identity = protocol.validate_identity_ref(
                {
                    "identity_id": fields["identity_id"],
                    "identity_generation": fields["identity_generation"],
                }
            )
        except protocol.ProtocolValidationError as error:
            field = (
                "identity_generation"
                if "identity_generation" in str(error)
                else "identity_id"
            )
            return _protocol_error("invalid_payload", str(error), (field,))
        try:
            operation_id = protocol.validate_operation_id(fields["operation_id"])
        except protocol.ProtocolValidationError as error:
            return _protocol_error("invalid_payload", str(error), ("operation_id",))
        try:
            payload_hash = protocol.validate_payload_hash(fields["payload_hash"])
        except protocol.ProtocolValidationError as error:
            return _protocol_error("invalid_payload", str(error), ("payload_hash",))

        purpose = fields["purpose"]
        if not isinstance(purpose, str) or purpose not in _SNAPSHOT_PURPOSES:
            return _protocol_error(
                "invalid_payload",
                "purpose is not supported.",
                ("purpose",),
                operation_id=operation_id,
            )

        try:
            snapshot = protocol.validate_full_snapshot(fields["snapshot"])
        except protocol.ProtocolValidationError as error:
            return _protocol_error(
                "invalid_state",
                str(error),
                ("snapshot",),
                operation_id=operation_id,
            )

        if (
            identity["identity_id"] != snapshot["identity_id"]
            or identity["identity_generation"] != snapshot["identity_generation"]
        ):
            return _protocol_error(
                "identity_mismatch",
                "Snapshot identity does not match the request identity.",
                ("identity_id", "identity_generation"),
                operation_id=operation_id,
                current_revision=snapshot["revision"],
            )

        try:
            calculated_hash = protocol.compute_payload_hash(fields)
        except protocol.ProtocolValidationError as error:
            return _protocol_error(
                "invalid_payload",
                str(error),
                ("payload_hash",),
                operation_id=operation_id,
            )
        if calculated_hash.lower() != payload_hash.lower():
            return _protocol_error(
                "invalid_payload",
                "payload_hash does not match the canonical request.",
                ("payload_hash",),
                operation_id=operation_id,
                current_revision=snapshot["revision"],
            )

        response: protocol.SnapshotSuccess = {
            "status": "success",
            "schema_version": 1,
            "identity_id": identity["identity_id"],
            "identity_generation": identity["identity_generation"],
            "operation_id": operation_id,
            "payload_hash": payload_hash,
            "revision": snapshot["revision"],
            "snapshot": cast(protocol.FullSnapshot, deepcopy(dict(snapshot))),
        }
        return protocol.validate_snapshot_success(response)

    return _handle_json(operation, protocol_response=True)


@inter_bp.app_errorhandler(services.ContractValidationError)
def handle_contract_error(
    error: services.ContractValidationError,
) -> tuple[Response, int]:
    """Aplica o envelope de contrato também às rotas fora do blueprint."""

    return _error_response(error)


@inter_bp.app_errorhandler(Exception)
def handle_unexpected_error(
    error: Exception,
) -> tuple[Response, int] | HTTPException:
    """Evita HTML, stack trace e detalhes internos em falhas inesperadas."""

    if isinstance(error, HTTPException):
        return error
    return _internal_error(error)


@inter_bp.route("/status_geral", methods=["GET"])
def get_general_status() -> tuple[Response, int]:
    """Retorna os parâmetros gerais do modo dormir e do limite térmico."""

    return jsonify(services.status_geral()), 200


@inter_bp.route("/ambiente", methods=["POST"])
def apply_environment() -> tuple[Response, int]:
    """Aplica os sete parâmetros ambientais e devolve uma prévia."""

    return _handle_json(services.apply_environment_request)


@inter_bp.route("/ciclo", methods=["POST"])
def validate_cycle() -> tuple[Response, int]:
    """Execute one validated cycle and return its confirmed result."""

    def operation(payload: object) -> Mapping[str, object]:
        cycle_request = services.validate_cycle_request(payload)
        return services.run_cycle(cycle_request)

    return _handle_json(operation)


@inter_bp.route("/trace/query", methods=["POST"])
def query_trace() -> tuple[Response, int]:
    """Return one ordered page from the active run's retained trace."""

    return _handle_json(services.query_trace)


@inter_bp.route("/preset", methods=["POST"])
def apply_preset() -> tuple[Response, int]:
    """Aplica um preset determinístico sem limpar a aprendizagem."""

    return _handle_json(services.apply_preset_request)


@inter_bp.route("/reset", methods=["POST"])
def reset_environment() -> tuple[Response, int]:
    """Limpa a jornada visível, preservando aprendizagem e rastro."""

    return _handle_json(services.reset_environment)


@inter_bp.route("/cancelar", methods=["POST"])
def cancel_correction() -> tuple[Response, int]:
    """Cancel a manual correction before sending a command to an actuator."""

    return _handle_json(services.cancel_manual_correction)


def _requests_correction() -> bool:
    """Distinguish a correlated correction from a bare legacy command."""

    if request.method != "POST":
        return False
    try:
        payload = _json_payload()
    except services.ContractValidationError:
        return False
    return isinstance(payload, Mapping) and "decisao_id" in payload


def _execute_manual_payload(
    payload: object,
    *,
    device: services.DeviceName,
    command: services.Binary,
) -> Mapping[str, object]:
    """Validate and run one legacy command through the stateless confirmer."""

    if request.method == "GET" and (request.data or request.args):
        raise services.ContractValidationError(
            services.JSON_INVALID,
            "A consulta GET não aceita corpo ou correlação de correção.",
        )

    manual_request = services.validate_manual_request(
        {} if payload is services.NO_BODY else payload
    )
    decision_id = manual_request.get("decisao_id")
    if decision_id is not None:
        steps = services.execute_manual(
            services.estado_quarto,
            device,
            command,
            decision_id=decision_id,
        )
        return {
            "status": "sucesso",
            "mensagem": "Comando manual confirmado.",
            "estado": services.public_state(),
            "decisao": deepcopy(services.estado_quarto["decisao"]),
            "etapas": deepcopy(steps),
        }
    result = services.run_legacy_transition(
        request.path,
        "manual_command",
        {
            "device": device,
            "command": command,
            "decisao_id": decision_id,
        },
        raw_input=manual_request,
    )
    return services.legacy_response(
        result,
        message="Comando manual confirmado.",
    )


def _manual_route(
    device: services.DeviceName,
    command: services.Binary,
) -> tuple[Response, int]:
    """Handle a manual route while preserving its POST and GET methods."""

    def operation(payload: object) -> Mapping[str, object]:
        return _execute_manual_payload(payload, device=device, command=command)

    if _requests_correction():
        return _handle_json(operation, allow_empty_get=True)
    return _handle_legacy_json(operation, allow_empty_get=True)


@inter_bp.route("/abrir", methods=["POST", "GET"])
def open_window() -> tuple[Response, int]:
    """Open the window after the safety constraints are confirmed."""

    return _manual_route("janela", 1)


@inter_bp.route("/fechar", methods=["POST", "GET"])
def close_window() -> tuple[Response, int]:
    """Close the window through the local confirmation executor."""

    return _manual_route("janela", 0)


@inter_bp.route("/ligarar", methods=["POST", "GET"])
def turn_on_air() -> tuple[Response, int]:
    """Turn on the air conditioner, closing an open window first."""

    return _manual_route("ar", 1)


@inter_bp.route("/desligarar", methods=["POST", "GET"])
def turn_off_air() -> tuple[Response, int]:
    """Turn off the air conditioner through local confirmation."""

    return _manual_route("ar", 0)


@inter_bp.route("/ligarventilador", methods=["POST", "GET"])
def turn_on_fan() -> tuple[Response, int]:
    """Turn on the binary fan actuator."""

    return _manual_route("ventilador", 1)


@inter_bp.route("/desligarventilador", methods=["POST", "GET"])
def turn_off_fan() -> tuple[Response, int]:
    """Turn off the binary fan actuator."""

    return _manual_route("ventilador", 0)


@inter_bp.route("/ligarumidificador", methods=["POST", "GET"])
def turn_on_humidifier() -> tuple[Response, int]:
    """Turn on the binary humidifier actuator."""

    return _manual_route("umidificador", 1)


@inter_bp.route("/desligarumidificador", methods=["POST", "GET"])
def turn_off_humidifier() -> tuple[Response, int]:
    """Turn off the binary humidifier actuator."""

    return _manual_route("umidificador", 0)


@inter_bp.route("/ligarlampada", methods=["POST", "GET"])
def turn_on_lamp() -> tuple[Response, int]:
    """Turn on the binary lamp actuator."""

    return _manual_route("lampada", 1)


@inter_bp.route("/desligarlampada", methods=["POST", "GET"])
def turn_off_lamp() -> tuple[Response, int]:
    """Turn off the binary lamp actuator."""

    return _manual_route("lampada", 0)


def _apply_feedback_payload(payload: object) -> Mapping[str, object]:
    """Valida e correlaciona feedback somente com memória confirmada."""

    feedback = services.validate_feedback_request(payload)
    command_id = feedback.get("comando_id")
    decision = services.confirmed_decision(
        services.estado_quarto,
        feedback["decisao_id"],
    )
    learning = services.record_feedback(
        services.estado_quarto,
        decision=decision,
        feedback_type=feedback["tipo"],
        command_id=cast(str | None, command_id),
        decision_id=feedback["decisao_id"],
    )
    response = services.pegar_status()
    response["decisao"] = decision
    response["mensagem"] = {
        "aceitar": "Feedback aceito; preferência atualizada.",
        "rejeitar": "Feedback rejeitado; preferência atualizada.",
        "corrigir": "Correção registrada; preferência ajustada para este contexto.",
    }[feedback["tipo"]]
    response["aprendizagem"] = services.serialize_learning_result(learning)
    return response


@inter_bp.route("/feedback", methods=["POST"])
def apply_feedback() -> tuple[Response, int]:
    """Valida feedback e retorna falhas de correlação com código estável."""

    return _handle_json(_apply_feedback_payload)
