FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node server.mjs index.html suite.css ./
USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
