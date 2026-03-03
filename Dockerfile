FROM node:lts-alpine AS build-stage
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --silent
COPY . .
RUN npm run build:webpack

FROM node:lts-alpine AS dev-stage
ENV NODE_ENV=development
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --silent && mv node_modules ../
COPY . .
EXPOSE 80
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "run", "dev"]

FROM node:lts-alpine AS production-stage
ENV NODE_ENV=production
WORKDIR /usr/src/app
COPY ["package.json", "package-lock.json*", "npm-shrinkwrap.json*", "./"]
RUN npm install --production --silent && mv node_modules ../
COPY --from=build-stage /usr/src/app/dist ./dist
COPY . .
EXPOSE 80
RUN chown -R node /usr/src/app
USER node
CMD ["npm", "start"]
