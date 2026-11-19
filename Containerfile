# Event Galaxy Defender — imagem para Podman / OpenShift (só Python, sem dependências)
FROM registry.access.redhat.com/ubi9/python-312:latest

WORKDIR /opt/app-root/src
COPY --chown=1001:0 server.py coletor.py ./
COPY --chown=1001:0 web ./web

ENV PORT=8080 HOST=0.0.0.0 PYTHONUNBUFFERED=1
EXPOSE 8080
USER 1001
CMD ["python3", "server.py"]
