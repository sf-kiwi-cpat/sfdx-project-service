FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY dist/ dist/
COPY node_modules/ node_modules/
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
