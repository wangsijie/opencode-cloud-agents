FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042 AS base

ARG OPENCODE_VERSION=1.18.4
ARG GH_VERSION=2.93.0
ARG WRANGLER_VERSION=4.112.0
ARG PNPM_VERSION=11.17.0

# The base image includes Git but not an SSH client. Ubuntu 22.04's gh package
# is several years old, so install the current CLI from GitHub's official release.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl openssh-client \
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

# Keep the Cloudflare runtime separate from the agent so OpenCode can be
# upgraded independently of the Sandbox SDK release cadence.
RUN npm install --global \
        "opencode-ai@${OPENCODE_VERSION}" \
        "pnpm@${PNPM_VERSION}" \
        "wrangler@${WRANGLER_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(wrangler --version)" = "${WRANGLER_VERSION}"

# The host key pin and client config are not secrets; every credential — the
# SSH key pair, the gh login, git identity and signing, environment variables
# and OpenCode skills — lives in the Worker's settings table and is injected
# by the Sandbox on every wake (see src/container-credentials.ts).
RUN install -d -m 0700 /root/.ssh
COPY --chmod=0644 docker/ssh/config /root/.ssh/config
COPY --chmod=0644 docker/ssh/known_hosts /root/.ssh/known_hosts

# /workspace is supported by the Sandbox backup/restore API. The image leaves it
# empty: repositories are cloned at wake time and later container starts overlay
# the latest R2 snapshot.
RUN mkdir -p /workspace

FROM base AS final

WORKDIR /workspace

# OpenCode server port.
EXPOSE 4096
