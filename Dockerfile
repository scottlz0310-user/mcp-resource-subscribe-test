FROM node:26.7.0-alpine AS base
ARG PNPM_VERSION=11.4.0
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME/bin:$PATH
RUN touch /root/.shrc \
  && wget -qO- https://get.pnpm.io/install.sh | env PNPM_VERSION=$PNPM_VERSION SHELL=/bin/sh ENV=/root/.shrc sh - \
  && pnpm --version

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# リファレンスサーバーは devDependencies（express / @modelcontextprotocol/{server,node}）で動くため --prod では起動できない。
RUN pnpm install --frozen-lockfile
COPY --from=build /app/dist ./dist
EXPOSE 8089
CMD ["node", "dist/src/server/index.js"]
