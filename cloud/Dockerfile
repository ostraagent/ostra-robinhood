# Ostra Cloud's image (design 12 Nov 2026): one image for the enclave's four services (signer, gateway, egress,
# front), run with a different command each (cloud/compose.yml). Built from two source trees, both from git at the
# commits the build names (cloud/build.sh): ostra-robinhood (sdk, core, mcp, deployments) and ostra-swap (sdk,
# deployments). Dependencies come from the lockfiles only (npm ci, no dev dependencies, no install scripts).
#
# NODE_IMAGE is node 24's Debian image pinned by digest (the build passes it). bubblewrap is the gateway's per-agent
# sandbox; flock(1) (util-linux, in the base image) holds each agent's home.

ARG NODE_IMAGE
FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && test -x /usr/bin/flock && test -x /usr/bin/bwrap

WORKDIR /opt/ostra
# The lockfiles first: the dependencies are a layer of their own.
COPY ostra-robinhood/sdk/package.json ostra-robinhood/sdk/package-lock.json ostra-robinhood/sdk/
COPY ostra-robinhood/core/package.json ostra-robinhood/core/package-lock.json ostra-robinhood/core/
COPY ostra-robinhood/mcp/package.json ostra-robinhood/mcp/package-lock.json ostra-robinhood/mcp/
COPY ostra-swap/sdk/package.json ostra-swap/sdk/package-lock.json ostra-swap/sdk/
RUN for d in ostra-swap/sdk ostra-robinhood/sdk ostra-robinhood/core ostra-robinhood/mcp; do \
      (cd "$d" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || exit 1; \
    done \
 && npm cache clean --force

COPY ostra-swap/sdk/src ostra-swap/sdk/src
COPY ostra-swap/deployments ostra-swap/deployments
COPY ostra-robinhood/sdk/src ostra-robinhood/sdk/src
COPY ostra-robinhood/core/src ostra-robinhood/core/src
COPY ostra-robinhood/mcp/src ostra-robinhood/mcp/src
COPY ostra-robinhood/deployments ostra-robinhood/deployments
COPY SOURCES /opt/ostra/SOURCES

# The volumes' mount points, owned by the services' user (a new volume takes them as they are here).
RUN install -d -o node -g node -m 0700 /var/lib/ostra-signer /var/lib/ostra-signer-admin /var/lib/ostra-remote \
 && install -d -o node -g node -m 0750 /run/ostra-signer \
 && install -d -o node -g node -m 0700 /run/ostra-users \
 && chown -R root:root /opt/ostra && chmod -R a+rX,go-w /opt/ostra

USER node
ENV NODE_ENV=production
