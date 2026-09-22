FROM node:20-bullseye

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN npx prisma generate

CMD ["tail", "-f", "/dev/null"]
