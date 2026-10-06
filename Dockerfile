# ShopHub - container image
#
# Two stages. The first installs the whole workspace so the lockfile is
# honoured and any native module is resolved against the target libc; the
# second copies only what is needed to run, so build leftovers, the test
# dependency and the dev-only scripts never reach the final image.
#
# no docker-compose.yml is needed: this app is one process and one file.

FROM node:24-slim AS build
WORKDIR /repo

# npm ci needs both manifests before it will restore anything: the root one
# declares the workspaces, the app one declares the runtime deps.
COPY package.json package-lock.json ./
COPY app/package.json app/package.json

# npm ci triggers node-gyp rebuild for better-sqlite3 purely because the
# package ships a binding.gyp - it has no install script of its own. Nothing
# here needs compiling: the prebuilt linux-x64 binary is inside the tarball
# and binding.js finds it at require time. --ignore-scripts skips the pointless
# compile, which would otherwise fail on a slim image with no compiler.
#
# The check below is the part that matters. Without it, a prebuild that did not
# load would only surface as a crash when the container first touched the
# database, and a failed build is much easier to read than a failed container.
RUN npm ci --omit=dev --ignore-scripts && \
    node -e "const D=require('better-sqlite3'); const d=new D(':memory:'); \
      d.exec('create table t(id integer primary key, n text)'); \
      d.prepare('insert into t(n) values (?)').run('ok'); \
      console.log('sqlite prebuild ok:', d.prepare('select n from t').get().n); d.close();"

# ------------------------------------------------------------------- runtime
FROM node:24-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/shop.db

WORKDIR /repo

# node:slim ships a root-owned working directory; make one that the process
# can write, since the database lives in it.
RUN mkdir -p /data && chown node:node /data

COPY --from=build /repo/node_modules ./node_modules
COPY package.json ./
COPY app/package.json ./app/package.json
COPY app/server.js ./app/server.js
COPY app/src ./app/src
COPY app/web ./app/web

USER node
VOLUME /data
EXPOSE 3000

# /healthz is a plain 200 with no dependency, so this works even when the
# database has not been seeded yet.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# server.js defaults to 127.0.0.1, which is correct on the host and wrong in
# a container: nothing outside it can reach loopback. HOST=0.0.0.0 makes the
# same code listen on all interfaces without changing what the host path does.
CMD ["sh", "-c", "HOST=0.0.0.0 exec node app/server.js"]
