FROM python:3.12-slim

WORKDIR /app

# Polyglot toolchains so every Script language is snap-ready on first boot
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    gcc \
    g++ \
    nodejs \
    npm \
    ruby \
    perl \
    php-cli \
    lua5.4 \
    default-jdk-headless \
    golang-go \
    rustc \
    r-base-core \
    curl \
    ca-certificates \
  && ln -sf /usr/bin/lua5.4 /usr/local/bin/lua \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py launch.py user_app.py resolve_hub.py wallet_cli.py sync_node.py compute.py relay.py treasury_cli.py federation_cli.py security_check.py news_mesh.py golem_chat.py desk_product.py newsroom_workflow.py proofpath_packet.py chat_history.py canvas_runtime.py workflow_generator.py phone_bridge.py device_bridge.py device_agent.py device-agent.sh entrypoint.json join.sh install.sh install.ps1 ./
COPY connection-layer/ connection-layer/
COPY html/ html/
COPY client/ client/
COPY docs/ docs/
COPY scripts/ scripts/

RUN mkdir -p connection-layer/data connection-layer/data/wallets

EXPOSE 5052 5053

ENV PYTHONUNBUFFERED=1
ENV ALLOW_FAUCET=limited
ENV FAUCET_MAX_AMOUNT=50

# Single worker = single in-memory chain authority per hub (threads keep concurrency).
CMD ["gunicorn", "--bind", "0.0.0.0:5052", "--workers", "1", "--threads", "8", "--timeout", "120", "app:app"]
