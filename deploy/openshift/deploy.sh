#!/usr/bin/env bash
# Instala ou atualiza o Event Galaxy Defender no OpenShift em que o `oc` está logado.
#
#     ./deploy/openshift/deploy.sh                # constrói a imagem dentro do cluster
#     BUILD=podman ./deploy/openshift/deploy.sh   # constrói aqui e envia ao registry interno
#
# Use BUILD=podman quando o cluster não alcança registry.access.redhat.com (CRC sem saída para
# a internet): o podman local usa a imagem base que já tem em cache. Precisa da rota padrão do
# registry interno (no CRC ela já vem habilitada).
#
# As credenciais de leitura ficam num Secret à parte: ./deploy/openshift/credenciais.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
NS=event-galaxy-defender

echo "==> Cluster: $(oc whoami --show-server)"
oc apply -f deploy/openshift/event-galaxy-defender.yaml

if [ "${BUILD:-cluster}" = podman ]; then
  REG=$(oc get route default-route -n openshift-image-registry -o jsonpath='{.spec.host}')
  IMG="$REG/$NS/event-galaxy-defender:latest"
  echo "==> Construindo com podman e enviando para $REG"
  podman build -q -t "$IMG" -f Containerfile .
  podman push -q --tls-verify=false --creds "$(oc whoami):$(oc whoami -t)" "$IMG"
else
  echo "==> Construindo a imagem no cluster"
  SRC=$(mktemp -d); trap 'rm -rf "$SRC"' EXIT
  cp -R Containerfile server.py coletor.py web "$SRC/"
  oc start-build event-galaxy-defender -n $NS --from-dir="$SRC" --follow --wait || {
    echo "Build no cluster falhou. Se foi ao baixar a imagem base, tente: BUILD=podman $0" >&2
    exit 1
  }
fi

oc rollout status deploy/event-galaxy-defender -n $NS --timeout=180s
echo
echo "Pronto: http://$(oc get route event-galaxy-defender -n $NS -o jsonpath='{.spec.host}')"
oc get secret event-galaxy-defender-credenciais -n $NS >/dev/null 2>&1 \
  || echo "Sem credenciais: rodando em simulação. Para o modo ao vivo: ./deploy/openshift/credenciais.sh"
