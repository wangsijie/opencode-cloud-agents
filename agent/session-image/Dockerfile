# The session image the Docker agent runs.
#
# The Cloudflare side builds from `cloudflare/sandbox`, whose whole point is the
# SDK's in-container agent — a control plane this host does not use, because the
# agent drives containers with the docker CLI instead. So this image starts from
# stock Node and installs the same tools at the same pins, and the two stay
# comparable by having the same versions rather than the same base.
#
# Build from the repository root, which is where the SSH client config lives:
#
#   docker build -f agent/session-image/Dockerfile -t opencode-session:latest .
#
# Keep OPENCODE_VERSION in step with `Dockerfile` and with `@opencode-ai/sdk` in
# package.json: the site speaks to this server with that client.
FROM node:22-bookworm-slim

ARG OPENCODE_VERSION=1.18.4
ARG GH_VERSION=2.93.0
ARG WRANGLER_VERSION=4.112.0
ARG PNPM_VERSION=11.17.0

ENV DEBIAN_FRONTEND=noninteractive

# What the agent itself needs from the image, beyond what a session does:
# `procps` for the pgrep that decides whether an OpenCode server is already
# serving, and coreutils' `timeout` (in the base) for bounded exec. `findutils`
# provides the GNU `find -printf` the file listing parses.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends \
        ca-certificates \
        coreutils \
        curl \
        findutils \
        git \
        less \
        openssh-client \
        procps \
    && rm -rf /var/lib/apt/lists/*

RUN case "$(dpkg --print-architecture)" in \
        amd64) GH_ARCH=amd64; GH_SHA256=02d1290eba130e0b896f3709ffff22e1c75a51475ddb70476a85abc6b5807af0 ;; \
        arm64) GH_ARCH=arm64; GH_SHA256=c55feb33684abba57e9909737340d5b39282257c0363e1edde6785ac4a413be7 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error \
        "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz" \
        --output /tmp/gh.tar.gz \
    && echo "${GH_SHA256}  /tmp/gh.tar.gz" | sha256sum --check --status \
    && tar --extract --gzip --file /tmp/gh.tar.gz \
        --directory /usr/local/bin --strip-components=2 \
        "gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" \
    && rm -f /tmp/gh.tar.gz \
    && test "$(gh --version | awk 'NR == 1 { print $3 }')" = "${GH_VERSION}"

RUN npm install --global \
        "opencode-ai@${OPENCODE_VERSION}" \
        "pnpm@${PNPM_VERSION}" \
        "wrangler@${WRANGLER_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(wrangler --version)" = "${WRANGLER_VERSION}"

# The host key pin and client config are not secrets. Every credential — the SSH
# key pair, the gh login, git identity and signing, environment variables and
# OpenCode skills — lives in the site's settings table and is written into the
# container on every wake (see src/container-credentials.ts). Nothing here is
# baked in, which is also why an image upgrade needs no credential migration.
RUN install -d -m 0700 /root/.ssh
COPY --chmod=0644 docker/ssh/config /root/.ssh/config
COPY --chmod=0644 docker/ssh/known_hosts /root/.ssh/known_hosts

# The mount point for the session's named volume. Unlike the Cloudflare image,
# what lands here survives the container: the volume is the persistence, and
# there is no snapshot.
RUN mkdir -p /workspace
WORKDIR /workspace

# OpenCode's port, published to loopback by the agent.
EXPOSE 4096

# PID 1 does nothing on purpose. OpenCode is started later, by
# `POST /sessions/:id/opencode/start`, as a detached `docker exec` — so a server
# that crashes leaves the container (and the site's file browser, and the next
# start) alive. `docker run --init` puts a reaper in front of this.
CMD ["sleep", "infinity"]
