# Build the static SPA with Node, then serve dist/ with unprivileged nginx.
FROM node:26-alpine AS build
WORKDIR /app
# scripts/ is copied before `npm ci` so the postinstall (setup-libass) can vendor public/libass.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
RUN npm run build   # tsc --noEmit && vite build -> /app/dist (hashes baked into index.html)

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY deploy/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
