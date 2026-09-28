FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    TZ=Asia/Taipei \
    TWSTOCK_DATA_DIR=/data \
    PORT=8000

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY twstock ./twstock

VOLUME ["/data"]
EXPOSE 8000
CMD ["sh", "-c", "uvicorn twstock.main:app --host 0.0.0.0 --port ${PORT} --proxy-headers --forwarded-allow-ips='*'"]
