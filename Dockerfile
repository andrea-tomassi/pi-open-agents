FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Install plugin dependencies (tsx for dev, types for IDE)
COPY package.json /root/pi-open-agents/package.json
RUN cd /root/pi-open-agents && npm install --ignore-scripts

# Copy plugin source
COPY src/ /root/pi-open-agents/src/
COPY ATTRIBUTION.md /root/pi-open-agents/ATTRIBUTION.md
COPY LICENSE /root/pi-open-agents/LICENSE
COPY README.md /root/pi-open-agents/README.md

# Minimal settings: only pi-open-agents, no old plugins
RUN mkdir -p /root/.pi/agent
COPY docker/settings.json /root/.pi/agent/settings.json

# Test agents in global dir
COPY docker/agents/ /root/.pi/agent/agents/

WORKDIR /workspace
ENTRYPOINT ["pi"]
