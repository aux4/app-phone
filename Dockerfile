FROM node:22-alpine
WORKDIR /app
COPY package/lib/phone-service.mjs /app/phone-service.mjs
USER node
CMD ["node", "/app/phone-service.mjs"]
