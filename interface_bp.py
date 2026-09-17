"""Rotas de interface e fronteira de contratos HTTP do simulador."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from copy import deepcopy
from typing import cast

from flask import Blueprint, Response, current_app, jsonify, request
from werkzeug.exceptions import BadRequest, HTTPException

import services


inter_bp = Blueprint("interf", __name__)


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


def _handle_json(
    operation: Callable[[object], Mapping[str, object]],
    *,
    allow_empty_get: bool = False,
) -> tuple[Response, int]:
    """Executa uma operação e traduz contratos e falhas internas para JSON."""

    snapshot = deepcopy(services.estado_quarto)
    try:
        payload = _json_payload()
        if allow_empty_get and request.method == "GET" and payload is services.NO_BODY:
            payload = {}
        body = operation(payload)
    except services.ContractValidationError as error:
        services._restore_state(services.estado_quarto, snapshot)
        return _error_response(error)
    except Exception as error:
        services._restore_state(services.estado_quarto, snapshot)
        return _internal_error(error)
    return jsonify(body), 200


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


def _execute_manual_payload(
    payload: object,
    *,
    device: services.DeviceName,
    command: services.Binary,
) -> Mapping[str, object]:
    """Validate and execute one command through the local confirmer."""

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
        services._validate_manual_correction(
            services.estado_quarto,
            device,
            command,
            decision_id,
        )
    steps = services.execute_manual(
        services.estado_quarto,
        device,
        command,
        decision_id=decision_id,
    )
    response = services.pegar_status()
    response["mensagem"] = "Comando manual confirmado."
    response["etapas"] = deepcopy(steps)
    if decision_id is not None:
        response["decisao"] = services.confirmed_decision(
            services.estado_quarto,
            decision_id,
        )
    return response


def _manual_route(
    device: services.DeviceName,
    command: services.Binary,
) -> tuple[Response, int]:
    """Handle a manual route while preserving its POST and GET methods."""

    return _handle_json(
        lambda payload: _execute_manual_payload(
            payload,
            device=device,
            command=command,
        ),
        allow_empty_get=True,
    )


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
    learning = services.record_feedback(
        services.estado_quarto,
        decision=feedback["decisao_id"],
        feedback_type=feedback["tipo"],
        command_id=cast(str | None, command_id),
    )
    response = services.pegar_status()
    response["decisao"] = services.confirmed_decision(
        services.estado_quarto,
        feedback["decisao_id"],
    )
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
