# Ostra Cloud's image (design 12 Nov 2026): one image for the enclave's four services (signer, gateway, egress,
# front), run with a different command each (cloud/compose.yml). Built from two source trees, both from git at the
# commits the build names in SOURCES: ostra-robinhood (sdk, core, mcp, deployments) and ostra-swap (sdk,
# deployments). Dependencies come from the lockfiles only (npm ci, no install scripts).
#
# Two stages. The build stage installs the packages and bundles each service, with everything it imports, into one
# file (mcp/scripts/cloud-bundle.ts): signer, gateway, egress, front, and the agent server the gateway starts for each
# home. The image holds node, bubblewrap, the five bundles and the deployment records, and no node_modules: sysbox
# clones the gateway's root file system and changes the owner of every file in it at each start (dstack OS 0.6.1), and
# with node_modules (some 63,000 entries) that ran past its 10-minute limit (first deploy, 12 Nov 2026). npm, npx and
# corepack are left out too: nothing in the image installs anything.
#
# NODE_IMAGE is node 24's Debian image pinned by digest (the build passes it). bubblewrap is the gateway's per-agent
# sandbox; flock(1) (util-linux, in the base image) holds each agent's home.

ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS build

WORKDIR /src
# The lockfiles first: the dependencies are a layer of their own. mcp's development dependencies hold esbuild.
COPY ostra-robinhood/sdk/package.json ostra-robinhood/sdk/package-lock.json ostra-robinhood/sdk/
COPY ostra-robinhood/core/package.json ostra-robinhood/core/package-lock.json ostra-robinhood/core/
COPY ostra-robinhood/mcp/package.json ostra-robinhood/mcp/package-lock.json ostra-robinhood/mcp/
COPY ostra-swap/sdk/package.json ostra-swap/sdk/package-lock.json ostra-swap/sdk/
RUN for d in ostra-swap/sdk ostra-robinhood/sdk ostra-robinhood/core; do \
      (cd "$d" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund) || exit 1; \
    done \
 && (cd ostra-robinhood/mcp && npm ci --ignore-scripts --no-audit --no-fund)

COPY ostra-swap/sdk/src ostra-swap/sdk/src
COPY ostra-robinhood/sdk/src ostra-robinhood/sdk/src
COPY ostra-robinhood/core/src ostra-robinhood/core/src
COPY ostra-robinhood/mcp/src ostra-robinhood/mcp/src
COPY ostra-robinhood/mcp/scripts/cloud-bundle.ts ostra-robinhood/mcp/scripts/cloud-bundle.ts
RUN cd ostra-robinhood/mcp && node scripts/cloud-bundle.ts /out

FROM ${NODE_IMAGE}

RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && test -x /usr/bin/flock && test -x /usr/bin/bwrap

COPY --from=build /out /opt/ostra/dist
COPY ostra-swap/deployments /opt/ostra/ostra-swap/deployments
COPY ostra-robinhood/deployments /opt/ostra/ostra-robinhood/deployments
COPY SOURCES /opt/ostra/SOURCES

# The volumes' mount points, owned by the services' user (a new volume takes them as they are here).
RUN install -d -o node -g node -m 0700 /var/lib/ostra-signer /var/lib/ostra-signer-admin /var/lib/ostra-remote \
 && install -d -o node -g node -m 0750 /run/ostra-signer \
 && install -d -o node -g node -m 0700 /run/ostra-users \
 && chown -R root:root /opt/ostra && chmod -R a+rX,go-w /opt/ostra

USER node
ENV NODE_ENV=production
