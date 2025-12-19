# Usa uma imagem leve do Node.js 20
FROM node:20-alpine

# Cria a pasta do app
WORKDIR /app

# Instala o TypeScript e o TSX globalmente no Linux (para garantir que o comando existe)
RUN npm install -g typescript tsx

# Copia os arquivos de configuração
COPY package*.json ./

# Instala as dependências do projeto
RUN npm install

# Copia o resto do código
COPY . .

# Expõe a porta
EXPOSE 3000

# O comando para iniciar (usando tsx direto, sem build)
CMD ["tsx", "server.ts"]