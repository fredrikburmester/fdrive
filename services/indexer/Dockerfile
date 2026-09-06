FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng tesseract-ocr-swe \
      ffmpeg \
      libglib2.0-0 \
      curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir -e ".[dev]"

ENV PYTHONUNBUFFERED=1

EXPOSE 8010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fs http://localhost:8010/health || exit 1

CMD ["python", "-m", "fdrive_indexer.main"]
