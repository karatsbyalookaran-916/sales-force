FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node app ./app
COPY --chown=node:node fonts ./fonts
COPY --chown=node:node karats-pdf-libs ./karats-pdf-libs
COPY --chown=node:node Karats-Elite-Plan-Brochure-source.html Karats-Smart-Capital-Calculator.html sw.js manifest.webmanifest ./
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=4173 KARATS_DB=/app/data/karats.sqlite
EXPOSE 4173
CMD ["node", "server/server.mjs"]
