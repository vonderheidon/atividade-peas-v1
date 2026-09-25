from flask import Flask, jsonify, render_template, request

import services
from interface_bp import inter_bp


app = Flask(
    __name__,
    static_folder="static",
    static_url_path="/static",
    template_folder="templates",
)


app.register_blueprint(inter_bp, url_prefix="/interf")


@app.route('/', methods=['GET'])
def home():
    return render_template('homeinfo.html')


@app.route('/status', methods=['GET'])
def get_status():
    return jsonify(services.pegar_status()), 200


@app.route('/ajustar', methods=['GET'])
def adjust_legacy_environment():
    raw_input = request.args.to_dict()
    try:
        body = services.ajustar(
            request.args.get('temperatura'),
            request.args.get('umidade'),
            request.args.get('dormir'),
            request.args.get('aberta'),
        )
    except Exception as error:
        app.logger.error(
            "Unexpected legacy environment adapter failure",
            extra={
                "path": request.path,
                "method": request.method,
                "error_type": type(error).__name__,
            },
        )
        body = services.legacy_internal_error_response(request.path, raw_input)
    envelope = body.get('envelope')
    status_code = (
        envelope.get('http_status', 200)
        if isinstance(envelope, dict)
        else 200
    )
    if type(status_code) is not int or status_code not in (200, 400, 409, 422, 500):
        status_code = 500
    response = jsonify(body)
    response.status_code = status_code
    response.headers['Deprecation'] = 'true'
    return response, status_code


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=False, use_reloader=False)
