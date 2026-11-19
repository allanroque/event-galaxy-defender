#!/usr/bin/env bash
# Cria (ou troca) o Secret com as credenciais de LEITURA que o jogo usa no modo ao vivo.
# Rode você mesmo, num terminal: as senhas são pedidas sem eco e não ficam no histórico.
#
#     ./deploy/openshift/credenciais.sh
#
# AAP: um token com escopo "Read" (AAP > Access Management > Users > seu usuário > Tokens >
#      Create token, Scope: Read). O jogo só faz GET; com escopo Read o token nem conseguiria
#      lançar um job.
# Orchestrator: usuário e senha de uma conta que consiga ver execuções (ou AO_TOKEN, se tiver).
# Deixe em branco o que não quiser ligar.
set -euo pipefail
NS=event-galaxy-defender
SECRET=event-galaxy-defender-credenciais

rota() { oc get route "$2" -n "$1" -o jsonpath='https://{.spec.host}' 2>/dev/null || true; }
perguntar() { # perguntar VAR "texto" "padrão"
  local resposta
  read -r -p "$2 [${3:-vazio}]: " resposta
  printf -v "$1" '%s' "${resposta:-${3:-}}"
}
segredo() { # segredo VAR "texto"
  local resposta
  read -r -s -p "$2: " resposta; echo
  printf -v "$1" '%s' "$resposta"
}

echo "Cluster: $(oc whoami --show-server)  |  namespace: $NS"
echo
echo "--- Ansible Automation Platform ---"
perguntar AAP_URL "URL do AAP" "$(rota aap aap)"
segredo AAP_TOKEN "Token do AAP com escopo Read (Enter para pular)"
echo
echo "--- Automation Orchestrator ---"
perguntar AO_URL "URL do Orchestrator" "$(rota automation-orchestrator ao)"
perguntar AO_USERNAME "Usuário do Orchestrator (Enter para pular)" ""
AO_PASSWORD=""
[ -n "$AO_USERNAME" ] && segredo AO_PASSWORD "Senha de $AO_USERNAME"
echo
perguntar VERIFICAR "Verificar o certificado TLS? No CRC o certificado é autoassinado (true/false)" "false"

args=(--from-literal=AAP_VERIFY_TLS="$VERIFICAR" --from-literal=AO_VERIFY_TLS="$VERIFICAR")
if [ -n "$AAP_URL" ] && [ -n "$AAP_TOKEN" ]; then
  args+=(--from-literal=AAP_URL="$AAP_URL" --from-literal=AAP_TOKEN="$AAP_TOKEN")
fi
if [ -n "$AO_URL" ] && [ -n "$AO_USERNAME" ] && [ -n "$AO_PASSWORD" ]; then
  args+=(--from-literal=AO_URL="$AO_URL" --from-literal=AO_USERNAME="$AO_USERNAME" --from-literal=AO_PASSWORD="$AO_PASSWORD")
fi

oc create secret generic "$SECRET" -n "$NS" "${args[@]}" --dry-run=client -o yaml | oc apply -f - >/dev/null
unset AAP_TOKEN AO_PASSWORD
oc rollout restart deploy/event-galaxy-defender -n "$NS" >/dev/null
oc rollout status deploy/event-galaxy-defender -n "$NS" --timeout=120s
echo
echo "Secret $SECRET gravado. Conferindo as fontes (aguarde alguns segundos):"
sleep 6
oc exec -n "$NS" deploy/event-galaxy-defender -- python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/estado').read().decode())"
