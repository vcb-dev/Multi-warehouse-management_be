#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_NAME="${IMAGE_NAME:-viejhaf/warehouse-be}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
FULL_IMAGE="${IMAGE_NAME}:${IMAGE_TAG}"

echo "==> Building ${FULL_IMAGE}"
docker build -t "${FULL_IMAGE}" .

echo ""
echo "==> Done. Image created:"
docker images "${IMAGE_NAME}" --format "  {{.Repository}}:{{.Tag}}  ({{.Size}})"
echo ""
echo "Run locally:"
echo "  docker run --rm -p 3001:3001 --env-file .env ${FULL_IMAGE}"
echo ""
echo "Save to file (copy sang server):"
echo "  docker save ${FULL_IMAGE} | gzip > ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz"
echo ""
echo "Load on server:"
echo "  gunzip -c ${IMAGE_NAME}-${IMAGE_TAG}.tar.gz | docker load"
