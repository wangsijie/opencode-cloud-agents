FROM docker.io/cloudflare/sandbox:0.12.3@sha256:23f67e16131b780865a5fa5aa3c8607408a730105c248836409f4e02bb6bf042 AS base

ARG OPENCODE_VERSION=1.18.4
ARG GH_VERSION=2.93.0
ARG WRANGLER_VERSION=4.112.0
ARG PNPM_VERSION=11.17.0
ARG NOTION_MCP_VERSION=2.5.1
ARG FIGMA_MCP_VERSION=0.13.2
ARG RCLONE_VERSION=1.74.4
ARG CLOUDFLARED_VERSION=2026.7.3

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

# rclone gives sessions Google Drive access. The image carries only the binary:
# the whole remote definition — service-account key included — arrives as
# RCLONE_CONFIG_* variables from the settings table's container env. rclone
# reads every RCLONE_* variable as a flag, so the verify step must hide the
# build ARG, which it would otherwise parse as --version.
RUN case "$(dpkg --print-architecture)" in \
        amd64) RCLONE_ARCH=amd64; RCLONE_SHA256=a9da2eaa70428c6dcc5acbb0b7eac0faec4c61643e0b468d9fe09ddf79b7e929 ;; \
        arm64) RCLONE_ARCH=arm64; RCLONE_SHA256=db39280cd0b680ef2ab2e9800882936358c33b959622512e6898ebbeaf0b7aea ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error \
        "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${RCLONE_ARCH}.deb" \
        --output /tmp/rclone.deb \
    && echo "${RCLONE_SHA256}  /tmp/rclone.deb" | sha256sum --check --status \
    && dpkg --install /tmp/rclone.deb \
    && rm -f /tmp/rclone.deb \
    && test "$(env -u RCLONE_VERSION rclone version | awk 'NR == 1 { print $2 }')" = "v${RCLONE_VERSION}"

# cloudflared exists for one purpose: the expose-dev-server built-in skill
# (src/builtin-skills.ts) lets the agent open a quick tunnel to a dev server
# when — and only when — the user asks for one. The image carries only the
# binary; nothing starts it.
RUN case "$(dpkg --print-architecture)" in \
        amd64) CLOUDFLARED_ARCH=amd64; CLOUDFLARED_SHA256=9d71c677db00134c1bd4144b7783486b654ad281b1ea62b4972098d19f770f17 ;; \
        arm64) CLOUDFLARED_ARCH=arm64; CLOUDFLARED_SHA256=65259e652a7bea08bf5df603233ab22b8bf3116af8df9f9206209af6a1b955c0 ;; \
        *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
    && curl --fail --location --silent --show-error \
        "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${CLOUDFLARED_ARCH}" \
        --output /usr/local/bin/cloudflared \
    && echo "${CLOUDFLARED_SHA256}  /usr/local/bin/cloudflared" | sha256sum --check --status \
    && chmod 0755 /usr/local/bin/cloudflared \
    && test "$(cloudflared --version | awk '{ print $3 }')" = "${CLOUDFLARED_VERSION}"

# Keep the Cloudflare runtime separate from the agent so OpenCode can be
# upgraded independently of the Sandbox SDK release cadence.
# The MCP servers are preinstalled because /root — and with it any npx cache —
# is wiped on every boot; the config template calls their bins directly.
RUN npm install --global \
        "opencode-ai@${OPENCODE_VERSION}" \
        "pnpm@${PNPM_VERSION}" \
        "wrangler@${WRANGLER_VERSION}" \
        "@notionhq/notion-mcp-server@${NOTION_MCP_VERSION}" \
        "figma-developer-mcp@${FIGMA_MCP_VERSION}" \
    && test "$(opencode --version)" = "${OPENCODE_VERSION}" \
    && test "$(pnpm --version)" = "${PNPM_VERSION}" \
    && test "$(wrangler --version)" = "${WRANGLER_VERSION}" \
    && command -v notion-mcp-server \
    && command -v figma-developer-mcp

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
