FROM node:22-bookworm-slim AS build
WORKDIR /workspace
COPY sdks/node/package.json sdks/node/package-lock.json ./sdks/node/
WORKDIR /workspace/sdks/node
RUN npm ci
COPY sdks/node /workspace/sdks/node
RUN npm run build
COPY examples/nextjs-bullmq-stripe /workspace/examples/nextjs-bullmq-stripe
WORKDIR /workspace/examples/nextjs-bullmq-stripe
RUN --mount=type=cache,target=/root/.npm npm ci
RUN npm run build
RUN cp -r .next/static .next/standalone/examples/nextjs-bullmq-stripe/.next/static

FROM node:22-bookworm-slim
WORKDIR /workspace
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
COPY --from=build /workspace/sdks/node ./sdks/node
COPY --from=build /workspace/examples/nextjs-bullmq-stripe ./examples/nextjs-bullmq-stripe
WORKDIR /workspace/examples/nextjs-bullmq-stripe
EXPOSE 3000
CMD ["npm", "run", "start"]
