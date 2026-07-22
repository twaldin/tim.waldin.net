FROM node:24-alpine

WORKDIR /app/backend/proxy-validator

COPY backend/proxy-validator/index.js backend/proxy-validator/validate.js ./
COPY backend/sandbox-policy.js ../sandbox-policy.js

EXPOSE 2376

CMD ["node", "index.js"]
