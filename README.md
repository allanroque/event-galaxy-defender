# Event Galaxy Defender

Uma visão em forma de jogo do que a automação está fazendo: **eventos caem do céu como meteoros; cada
automação é uma arma no chão.** Feito para Ansible Automation Platform (Controller e Event-Driven Ansible)
e Automation Orchestrator.

Tem dois modos:

- **Ao vivo** — lê o AAP e o Orchestrator e mostra o que está rodando de verdade. Somente leitura.
- **Simulação** — um catálogo de casos com botões para provocar eventos. Não precisa de credencial nenhuma.

## O que aparece na tela

| Na tela | Significa |
|---|---|
| Meteoro âmbar / vermelho / lilás | alerta / incidente / demanda |
| Arma verde | regra do EDA que disparou um job template |
| Arma amarelo-limão (só ao vivo) | job template ou workflow do Controller, lançado à mão, por agenda ou por API |
| Arma azul | workflow do Automation Orchestrator |
| Bolinhas no rótulo do meteoro | etapas: feitas, atual, pendentes |
| Anel amarelo pulsando | parado numa aprovação |
| Meteoro que chega ao chão | ao vivo: o job falhou ou foi cancelado. Na simulação: ninguém tratou a tempo |
| Quadro "Onde ganhamos, onde perdemos" | por automação: quantas execuções deram certo e quantas não |

Não há game over: o que cai no chão vira número no placar e baixa a saúde do ambiente, que se recupera.

## Modo ao vivo

O servidor consulta as APIs a cada poucos segundos (`POLL_SECONDS`, padrão 3) e empurra as mudanças para a
tela. Cada job do Controller, workflow job ou execução do Orchestrator vira um meteoro:

| Estado real | No jogo |
|---|---|
| na fila / rodando | o meteoro desce e a arma atira enquanto o job roda |
| aguardando aprovação | o meteoro para, com o anel amarelo; a arma espera |
| sucesso | tiro final; o tempo mostrado é a duração real do job |
| falha ou cancelamento | o meteoro cai no chão, com a explicação do AAP no registro |

De onde vem cada informação:

- **Origem EDA**: um job lançado por regra carrega `ansible_eda` nas extra vars. É dali que saem o nome da
  regra e o alerta (`alertname` e host), sem precisar consultar a API do EDA.
- **Workflows do Controller**: os jobs filhos aparecem como etapas do workflow, não como meteoros soltos.
- **Aprovações**: `workflow_approvals` pendentes no Controller e `approval_pending` no Orchestrator.
- **EDA**: a API do EDA é usada só para o indicador de quantas rulebook activations estão rodando.

É **somente leitura**: o servidor faz apenas `GET` (e o login do Orchestrator). Não lança job, não aprova,
não altera nada. Clicar num meteoro ao vivo não faz nada.

### Credenciais

| Variável | Para quê |
|---|---|
| `AAP_URL`, `AAP_TOKEN` | AAP. Token OAuth2 com escopo **Read** (Access Management > Users > usuário > Tokens) |
| `AO_URL`, `AO_USERNAME`, `AO_PASSWORD` | Orchestrator, com login por usuário e senha |
| `AO_TOKEN` | alternativa ao usuário e senha, se você já tiver um token |
| `AAP_VERIFY_TLS`, `AO_VERIFY_TLS` | `false` para certificado autoassinado (CRC). Padrão `true` |
| `POLL_SECONDS` | intervalo de consulta. Padrão `3` |

Recomendado: um usuário só de auditoria (leitura) e token com escopo Read. Sem `AAP_*` nem `AO_*`, o jogo
sobe em simulação.

A tela não tem login. Quem alcança a URL vê nomes de jobs, hosts e usuários. Publique só em laboratório.

## Rodar

```bash
python3 server.py            # http://127.0.0.1:8777 — simulação
```

Ao vivo, localmente:

```bash
AAP_URL=https://aap.exemplo.com AAP_TOKEN=... python3 server.py
```

### OpenShift

```bash
./deploy/openshift/deploy.sh          # namespace event-galaxy-defender, build no cluster, Route
./deploy/openshift/credenciais.sh     # pergunta URL e credenciais, grava o Secret, reinicia
```

Se o cluster não alcança `registry.access.redhat.com` (CRC sem saída para a internet), construa com o
podman local: `BUILD=podman ./deploy/openshift/deploy.sh`.

`GET /api/estado` mostra quais fontes estão ligadas e se estão respondendo (sem expor credencial).

## Controles

| Tecla | Faz |
|---|---|
| `V` | alterna entre ao vivo e simulação |
| `Espaço` / `R` | pausa / zera o placar (ao vivo, ressincroniza com o servidor) |
| `1`–`9` | simulação: provoca um caso do catálogo |
| `E` / `O` | simulação: liga e desliga o EDA / o Orchestrator |
| `M` | simulação: aprovação manual — o workflow para até `Enter` ou clique no meteoro |
| `A` | simulação: chuva automática |

## Simulação

Tudo o que cai e tudo o que responde está em [`web/catalogo.js`](web/catalogo.js): eventos, automações,
etapas e tempos (regra do EDA em ~10 s, workflow do Orchestrator em 15 a 20 s). O catálogo que acompanha o
projeto reproduz um laboratório com Parasol, Apache, WildFly e triagem de chamados; troque pelos seus casos.

Também dá para lançar um meteoro simulado de fora:

```bash
curl -X POST http://127.0.0.1:8777/api/eventos -H 'Content-Type: application/json' \
  -d '{"tipo": "ApacheDown", "host": "server07"}'
```

## Desenvolver sem tocar no ambiente real

`dev/aap_falso.py` responde às mesmas rotas que o coletor consulta, no mesmo formato, e faz os jobs andarem
sozinhos:

```bash
python3 dev/aap_falso.py
AAP_URL=http://127.0.0.1:8790 AAP_TOKEN=x AO_URL=http://127.0.0.1:8790 AO_TOKEN=x python3 server.py
curl -X POST 127.0.0.1:8790/dev/lancar -d '{"nome": "Apache - Remediar", "dura": 12}'
```

## Estrutura

```
server.py      servidor HTTP e Server-Sent Events
coletor.py     leitura do AAP e do Orchestrator -> "ocorrências"
web/           o jogo (canvas, sem dependências)
deploy/        OpenShift
dev/           AAP e Orchestrator de mentira para testes
```

## Próximos passos

- Alertas sem resposta: ler o Alertmanager e mostrar como meteoro o alerta que nenhuma regra tratou.
- Evento sem automação → construir: animação da automação sendo criada enquanto o meteoro cai.
- Graduação: o caso resolvido pelo Orchestrator vira regra do EDA, e nasce uma arma nova.
