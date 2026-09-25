# Simulador do Quarto Inteligente (Agente PEAS 3D)

Observatório e simulador de Inteligência Artificial baseado no modelo **PEAS** (*Performance, Environment, Actuators, Sensors* / Desempenho, Ambiente, Atuadores e Sensores), aplicado ao controle ambiental de um quarto inteligente.

O sistema integra uma interface web com cena 3D interativa (Three.js) a um backend em Python (Flask) que processa a física do ambiente, gerencia as restrições de segurança e executa ciclos de decisão para os atuadores.

---

## Modos de Operação do Agente

- **Modo Reativo**: Decisões imediatas baseadas em regras de precedência fixa e salvaguardas físicas (ex.: impedir abertura da janela sob chuva ou ligar o ar-condicionado sem antes fechar a janela).
- **Modo Cognitivo**: Avaliação de alternativas ponderadas por função de utilidade, balanceando conforto térmico, economia de energia e minimização de transições de atuadores. Suporta adaptação contextual via feedback do usuário (aceitar, rejeitar ou corrigir decisões).
- **Suporte Multi-Aba / Multi-Cliente**: Coordenação determinística entre abas via IndexedDB e BroadcastChannel, com sincronização de snapshots e transições de ciclo.

---

## Tecnologias Utilizadas

- **Backend**: Python 3.12+, Flask
- **Frontend**: HTML5, CSS3, JavaScript (ES6+), Three.js (WebGL com carregamento de modelo GLTF), IndexedDB
- **Gerenciamento e Execução**: `uv` e `Docker`

---

## Estrutura do Repositório

```text
.
├── Servidor.py           # Ponto de entrada do servidor Flask (porta 5050)
├── interface_bp.py       # Blueprint com as rotas REST da API do simulador
├── services.py           # Regras de negócio, física ambiental, políticas e utilidade
├── transition.py         # Motor de transição de estado determinístico
├── config.py             # Estado em memória, presets e rastro de eventos
├── pyproject.toml        # Metadados do projeto e entrypoint para deploy na Vercel
├── vercel.json           # Configuração de runtime e empacotamento para a Vercel
├── requirements.txt      # Dependências Python (Flask)
├── Dockerfile            # Configuração para execução em container
├── shared/               # Contratos e validação do protocolo PEAS
│   └── peas_protocol.py  # Tipos, validação de schema e hashing determinístico
├── templates/
│   └── homeinfo.html     # Template principal do observatório/painel
└── public/
    └── static/
        └── simulador/    # Cena 3D (Three.js), coordenador multi-abas, persistência e estilos
```

---

## Como Rodar

O servidor roda por padrão na porta **5050**. Certifique-se de que a porta esteja disponível.

### Opção 1: Usando `uv`

O `uv` permite executar a aplicação de forma rápida, com ou sem a criação manual de ambiente virtual.

#### Modo direto (sem gerenciar venv manualmente)

```bash
uv run --with-requirements requirements.txt python Servidor.py
```

#### Modo com ambiente virtual dedicado

1. Crie o ambiente virtual:
   ```bash
   uv venv
   ```

2. Instale as dependências:
   ```bash
   uv pip install -r requirements.txt
   ```

3. Inicie o servidor:
   ```bash
   uv run python Servidor.py
   ```

---

### Opção 2: Usando Docker

O projeto já inclui um `Dockerfile` configurado com verificação de integridade (*healthcheck*).

1. Construa a imagem Docker:
   ```bash
   docker build -t quarto-simulador .
   ```

2. Inicie o container mapeando a porta 5050:
   ```bash
   docker run -d -p 5050:5050 --name quarto-simulador quarto-simulador
   ```

3. Verifique os logs da aplicação:
   ```bash
   docker logs -f quarto-simulador
   ```

4. Para parar o container:
   ```bash
   docker stop quarto-simulador
   ```

---

### Opção 3: Deploy na Vercel

O repositório está configurado para a Vercel com suporte nativo ao Flask:
1. Conecte o repositório na [Vercel](https://vercel.com).
2. O framework preset identificará o Flask via `pyproject.toml` (`[tool.vercel] entrypoint = "Servidor:app"`).
3. Os assets estáticos e o modelo 3D (`quarto.glb`) são servidos diretamente pela CDN da Vercel através da pasta `public/static/`.

---

## Acesso à Aplicação

Após iniciar o servidor (via `uv` ou `Docker`), acesse no navegador:

- **Interface Principal (Painel e Simulador 3D)**: [http://localhost:5050](http://localhost:5050)
- **Status do Quarto (JSON)**: [http://localhost:5050/status](http://localhost:5050/status)
- **Status Geral da Interface (JSON)**: [http://localhost:5050/interf/status_geral](http://localhost:5050/interf/status_geral)
