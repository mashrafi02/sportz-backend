FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

ENV HOST=0.0.0.0
EXPOSE 8000

CMD ["npm", "start"]
