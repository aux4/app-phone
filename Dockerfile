FROM node:22-alpine
WORKDIR /app
COPY package/lib/ /app/
USER node
CMD ["node", "/app/phone-service.mjs"]
