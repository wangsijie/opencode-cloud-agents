FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042

ARG OPENCODE_VERSION=1.18.3

# Keep the Cloudflare runtime separate from the agent so OpenCode can be
# upgraded independently of the Sandbox SDK release cadence.
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

# Use a public sample repository so this experiment never copies this private
# repository's proxy configuration or credentials into the sandbox image.
RUN git clone --depth 1 https://github.com/cloudflare/agents.git /home/user/agents

WORKDIR /home/user/agents

# OpenCode server port.
EXPOSE 4096
