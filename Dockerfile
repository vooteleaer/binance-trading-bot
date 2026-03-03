FROM node:22-alpine AS build-stage
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --silent
COPY . .
RUN npm run build:webpack && npm run build:grunt

FROM node:22-alpine AS dev-stage
ENV NODE_ENV=development
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --silent
COPY . .
RUN npm run build:grunt
RUN mv node_modules ../
EXPOSE 80
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "run", "dev"]

FROM node:22-alpine AS production-stage
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --production --silent && mv node_modules ../
COPY --from=build-stage /usr/src/app/dist ./dist
COPY --from=build-stage /usr/src/app/public/dist ./public/dist
COPY . .
EXPOSE 80
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "start"]
