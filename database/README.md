# database/

Vazio de propósito nesta fase (F0). Quem cria o schema é o Prisma
(`cd backend && npm run prisma:migrate`), não um script SQL manual aqui — o
`docker-compose.yml` da raiz usa a imagem oficial `postgres:16-alpine` sem
customização.

Esta pasta existe para o dia em que precisar de algo que o Postgres padrão
não oferece — um `Dockerfile` com extensões compiladas (ex.: `pg_cron`,
`postgis`), ou um script de `docker-entrypoint-initdb.d/` para algo que
precisa rodar ANTES de qualquer migration (ex.: criar um segundo banco/role
para um serviço externo). Até lá, fica só este README.
