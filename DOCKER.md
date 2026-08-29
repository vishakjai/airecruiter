# Running PAIR with Docker

The default Compose stack runs a production Next.js container, the FastAPI
service, PostgreSQL, and Redis. Local SSO is disabled and the API uses a local
administrator identity; this bypass is confined to the Docker build and local
API environment.

## Start the stack

```bash
docker compose up --build -d
docker compose ps
```

Open PAIR at <http://localhost:4200>. The API documentation is available at
<http://localhost:8000/docs>, and readiness is reported at
<http://localhost:8000/health>.

## Logs and shutdown

```bash
docker compose logs -f web api
docker compose down
```

PostgreSQL and Redis data live in named Docker volumes, so `docker compose
down` preserves them. To intentionally start with empty local data, run
`docker compose down --volumes` before starting the stack again.

## External integrations

The stack boots without external credentials by loading the non-secret local
defaults in `deployment/docker/api.env`. The committed `apps/api/.env.example`
documents the credentials for OpenAI, JobDiva, Unipile, and optional enrichment
providers. Copy real values into the ignored `apps/api/.env` when those
integrations are required. Values in that file override the local defaults.
Docker excludes it from the image build; Compose injects it only at runtime.
