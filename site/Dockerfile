FROM node:22-alpine AS build
WORKDIR /site
COPY . .
ARG SITE_URL=https://5050mail.5050cloud.com
ENV SITE_URL=$SITE_URL
RUN node build/build.mjs

FROM nginx:1.27-alpine
COPY --from=build /site/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  location = /health { return 200 "ok"; }\n  location / { try_files $uri $uri/ $uri.html =404; }\n  error_page 404 /404.html;\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
