FROM python:3.12-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.py maintenance.py media_library.py public_sources.py streamingcommunity_resolver.py index.html icon.png favicon.png ./
ENV PYTHONUNBUFFERED=1
EXPOSE 8097
CMD ["python", "server.py"]
