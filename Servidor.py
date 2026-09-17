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
    response = services.ajustar(
        request.args.get('temperatura'),
        request.args.get('umidade'),
        request.args.get('dormir'),
        request.args.get('aberta'),
    )
    return jsonify(response), 200


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050, debug=False, use_reloader=False)
