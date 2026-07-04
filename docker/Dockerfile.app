# Dev-mode container; source is bind-mounted by docker-compose, node_modules stays in the image
FROM node:22-alpine

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.11.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm prisma generate

EXPOSE 3000
CMD ["pnpm", "dev"]
