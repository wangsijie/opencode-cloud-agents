FROM docker.io/cloudflare/sandbox:0.12.3-opencode

# Use a public sample repository so this experiment never copies this private
# repository's proxy configuration or credentials into the sandbox image.
RUN git clone --depth 1 https://github.com/cloudflare/agents.git /home/user/agents

WORKDIR /home/user/agents

# OpenCode server port.
EXPOSE 4096
