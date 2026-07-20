FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042

ARG OPENCODE_VERSION=1.18.3

# The base image includes Git but not an SSH client. Install it so repositories
# can authenticate to GitHub with the dedicated key bundled below.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Keep the Cloudflare runtime separate from the agent so OpenCode can be
# upgraded independently of the Sandbox SDK release cadence.
RUN npm install --global "opencode-ai@${OPENCODE_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}"

RUN install -d -m 0700 /root/.ssh
COPY --chmod=0600 docker/ssh/id_ed25519 /root/.ssh/id_ed25519
COPY --chmod=0644 docker/ssh/id_ed25519.pub /root/.ssh/id_ed25519.pub
COPY --chmod=0644 docker/ssh/config /root/.ssh/config
COPY --chmod=0644 docker/ssh/known_hosts /root/.ssh/known_hosts

# Keep repositories under one parent directory so more can be added later.
RUN mkdir -p /opt/repos \
    && git clone --depth 1 git@github.com:wangsijie/opencode-cloud.git \
        /opt/repos/opencode-cloud

WORKDIR /opt/repos/opencode-cloud

# OpenCode server port.
EXPOSE 4096
