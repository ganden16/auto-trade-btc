#!/bin/bash
# Sync local changes to VPS using Docker Compose container
docker compose --profile deploy run --rm deploy-vps
