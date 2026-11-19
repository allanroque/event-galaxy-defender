#!/usr/bin/env python3
"""AAP e Orchestrator de mentira, só para desenvolver o modo ao vivo sem tocar no ambiente real.

Responde às mesmas rotas que o coletor consulta, no mesmo formato que o AAP 2.7 e o AO devolvem,
e faz os jobs andarem sozinhos (na fila -> rodando -> sucesso ou falha).

    python3 dev/aap_falso.py            # http://127.0.0.1:8790
    AAP_URL=http://127.0.0.1:8790 AAP_TOKEN=x AO_URL=http://127.0.0.1:8790 AO_TOKEN=x python3 server.py

    curl -X POST 127.0.0.1:8790/dev/lancar -d '{"nome": "Apache - Remediar", "dura": 12}'
    curl -X POST 127.0.0.1:8790/dev/lancar -d '{"nome": "AIOPS-REMEDIATE-SERVICE", "dura": 9, "eda": "FirewallParado"}'
    curl -X POST 127.0.0.1:8790/dev/lancar -d '{"nome": "NETWORK-STOP-LAB", "dura": 6, "falha": true}'
    curl -X POST 127.0.0.1:8790/dev/workflow -d '{"nome": "WF-LINUX-DEPLOY-WEBSTACK", "etapas": ["LINUX-DEPLOY-NGINX", "LINUX-DEPLOY-APP"], "aprovacao": "Aprovar deploy"}'
    curl -X POST 127.0.0.1:8790/dev/execucao -d '{"nome": "Disk remediation com IA (alerta)", "etapas": ["diagnostico", "agente", "aprovar", "remediar"]}'
    curl -X POST 127.0.0.1:8790/dev/aprovar
"""
import json
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

trava = threading.Lock()
jobs, fluxos, execucoes = [], [], []
seq = [1000]
aprovado = threading.Event()


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z") if t else None


def novo_id():
    seq[0] += 1
    return seq[0]


def situacao(item, agora):
    """Estado de um job de mentira em função do tempo."""
    if agora < item["comeca"]:
        return "pending"
    if agora < item["comeca"] + item["dura"]:
        return "running"
    return "failed" if item.get("falha") else "successful"


def job_json(j, agora):
    st = situacao(j, agora)
    fim = j["comeca"] + j["dura"] if st in ("successful", "failed") else None
    extra = {"alvo": j.get("alvo", "server01.lab.example.com")}
    if j.get("eda"):
        extra["ansible_eda"] = {"ruleset": "Jornada - correção disparada por alerta", "rule": j.get("regra", "Firewall parado"),
                                "event": {"payload": {"alerts": [{"status": "firing", "labels": {"alertname": j["eda"], "host": "server01.lab.example.com"}}]}}}
    resumo = {"created_by": {"username": j.get("quem", "admin")}, "inventory": {"name": "INV-DEMO-LAB"},
              "labels": {"results": [{"name": "time:demo"}]}}
    if j.get("pai"):
        resumo["source_workflow_job"] = {"id": j["pai"], "name": "wf"}
    return {"id": j["id"], "type": "job", "name": j["nome"], "status": st, "launch_type": j.get("launch", "manual"),
            "created": iso(j["criado"]), "started": iso(j["comeca"]) if st != "pending" else None, "finished": iso(fim),
            "elapsed": round((fim or agora) - j["comeca"], 3) if st != "pending" else 0.0,
            "job_explanation": "Playbook falhou em 1 host" if st == "failed" else "", "limit": "",
            "launched_by": {"name": j.get("quem", "admin"), "type": "user"}, "extra_vars": json.dumps(extra), "summary_fields": resumo}


def fluxo_json(w, agora):
    filhos = [j for j in jobs if j.get("pai") == w["id"]]
    estados = [situacao(j, agora) for j in filhos]
    esperando = w.get("aprovacao") and not w.get("aprovado")
    if any(e == "failed" for e in estados):
        st = "failed"
    elif estados and all(e == "successful" for e in estados) and not esperando and len(filhos) == len(w["etapas"]):
        st = "successful"
    else:
        st = "running"
    fim = max((j["comeca"] + j["dura"] for j in filhos), default=agora) if st != "running" else None
    return {"id": w["id"], "type": "workflow_job", "name": w["nome"], "status": st, "launch_type": "manual",
            "created": iso(w["criado"]), "started": iso(w["criado"]), "finished": iso(fim),
            "elapsed": round((fim or agora) - w["criado"], 3), "job_explanation": "", "limit": None,
            "launched_by": {"name": "admin", "type": "user"}, "extra_vars": "{}", "summary_fields": {"created_by": {"username": "admin"}, "labels": {"results": []}}}


def andar_fluxos(agora):
    """Cria o próximo job de cada workflow quando o anterior termina (e a aprovação, se houver, saiu)."""
    for w in fluxos:
        filhos = [j for j in jobs if j.get("pai") == w["id"]]
        if len(filhos) >= len(w["etapas"]):
            continue
        if filhos and situacao(filhos[-1], agora) != "successful":
            continue
        if w.get("aprovacao") and len(filhos) == 1 and not w.get("aprovado"):
            continue  # para depois da primeira etapa até alguém aprovar
        jobs.append({"id": novo_id(), "nome": w["etapas"][len(filhos)], "criado": agora, "comeca": agora + 1, "dura": w.get("dura", 6), "pai": w["id"], "launch": "workflow"})


def execucao_json(e, agora):
    n = len(e["etapas"])
    passo = int((agora - e["criado"]) // e["dura"])
    parada = e.get("aprovacao_em")
    if parada is not None and not e.get("aprovado") and passo >= parada:
        passo = parada
    else:
        if parada is not None and e.get("aprovado"):
            passo = min(n, parada + 1 + int((agora - e["aprovado"]) // e["dura"]))
    fim = passo >= n
    return {"id": e["id"], "workflow_name": e["nome"], "status": "completed" if fim else "running", "created_at": iso(e["criado"]),
            "completed_at": iso(e.setdefault("fim", agora)) if fim else None,
            "created_by": {"name": "admin"}, "trigger_type": e.get("gatilho", "webhook_trigger"), "input_data": {"host": "server07.lab.example.com"},
            "error_details": None, "approval_pending": parada is not None and not e.get("aprovado") and passo == parada, "_passo": passo}


def atividades_json(e, agora):
    passo = execucao_json(e, agora)["_passo"]
    saida = []
    for i, nome in enumerate(e["etapas"][: passo + 1]):
        tipo = "approval" if "aprov" in nome else "agentic" if "agente" in nome else "aap_job_template"
        saida.append({"activity_name": nome, "node_type": tipo, "status": "completed" if i < passo else "running", "created_at": iso(e["criado"] + i * e["dura"]), "output_data": {}})
    return saida


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def enviar(self, corpo, status=200):
        dados = json.dumps(corpo).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)

    def do_GET(self):
        rota, agora = self.path.split("?")[0], time.time()
        with trava:
            andar_fluxos(agora)
            if rota == "/api/controller/v2/jobs/":
                return self.enviar({"results": [job_json(j, agora) for j in reversed(jobs[-30:])]})
            if rota == "/api/controller/v2/workflow_jobs/":
                return self.enviar({"results": [fluxo_json(w, agora) for w in reversed(fluxos[-12:])]})
            if rota == "/api/controller/v2/workflow_approvals/":
                pend = [w for w in fluxos if w.get("aprovacao") and not w.get("aprovado") and len([j for j in jobs if j.get("pai") == w["id"]]) == 1
                        and situacao([j for j in jobs if j.get("pai") == w["id"]][0], agora) == "successful"]
                return self.enviar({"results": [{"name": w["aprovacao"], "summary_fields": {"workflow_job": {"id": w["id"]}}} for w in pend]})
            if rota == "/api/eda/v1/activations/":
                return self.enviar({"results": [{"name": "EDA-AIOPS-SELFHEAL", "status": "running"}, {"name": "Alertas para o AO", "status": "failed"}]})
            if rota == "/api/v1/executions":
                return self.enviar({"resources": [{k: v for k, v in execucao_json(e, agora).items() if k != "_passo"} for e in execucoes[-25:]]})
            if rota.startswith("/api/v1/executions/") and rota.endswith("/activities"):
                ident = rota.split("/")[4]
                e = next((x for x in execucoes if x["id"] == ident), None)
                return self.enviar({"resources": atividades_json(e, agora) if e else []})
        self.enviar({"detail": "Not Found"}, 404)

    def do_POST(self):
        tam = int(self.headers.get("Content-Length") or 0)
        d = json.loads(self.rfile.read(tam) or b"{}") if tam else {}
        agora = time.time()
        with trava:
            if self.path == "/dev/lancar":
                j = {"id": novo_id(), "nome": d.get("nome", "Demo Job Template"), "criado": agora, "comeca": agora + d.get("fila", 1.5), "dura": d.get("dura", 8),
                     "falha": d.get("falha", False), "eda": d.get("eda"), "regra": d.get("regra", "Firewall parado"), "quem": d.get("quem", "admin"),
                     "launch": d.get("launch", "manual"), "alvo": d.get("alvo", "server01.lab.example.com")}
                jobs.append(j)
                return self.enviar({"id": j["id"]})
            if self.path == "/dev/workflow":
                w = {"id": novo_id(), "nome": d.get("nome", "WF"), "criado": agora, "etapas": d.get("etapas", ["a", "b"]), "aprovacao": d.get("aprovacao"), "dura": d.get("dura", 6)}
                fluxos.append(w)
                return self.enviar({"id": w["id"]})
            if self.path == "/dev/execucao":
                etapas = d.get("etapas", ["diagnostico", "agente", "aprovar", "remediar"])
                parada = next((i for i, n in enumerate(etapas) if "aprov" in n), None)
                e = {"id": f"ex-{novo_id()}", "nome": d.get("nome", "Workflow AO"), "criado": agora, "etapas": etapas, "dura": d.get("dura", 4), "aprovacao_em": parada, "gatilho": d.get("gatilho", "webhook_trigger")}
                execucoes.append(e)
                return self.enviar({"id": e["id"]})
            if self.path == "/dev/aprovar":
                for w in fluxos:
                    w["aprovado"] = True
                for e in execucoes:
                    e.setdefault("aprovado", agora)
                return self.enviar({"ok": True})
        self.enviar({"detail": "Not Found"}, 404)


if __name__ == "__main__":
    base = time.time()
    # um pouco de histórico, para o placar não nascer vazio
    for k, (nome, dura, falha, eda) in enumerate([("LINUX-COLLECT-FACTS", 10, False, None), ("SECURITY-HARDEN-SSH", 11, False, None),
                                                   ("NETWORK-STOP-LAB", 13, True, None), ("AIOPS-REMEDIATE-SERVICE", 9, False, "ParasolPortalForaDoAr"),
                                                   ("Demo Job Template", 4, False, None), ("AIOPS-REMEDIATE-SERVICE", 10, False, "FirewallParado")]):
        jobs.append({"id": novo_id(), "nome": nome, "criado": base - 900 + k * 120, "comeca": base - 898 + k * 120, "dura": dura, "falha": falha, "eda": eda,
                     "regra": "Portal da Parasol fora do ar" if eda == "ParasolPortalForaDoAr" else "Firewall parado"})
    print("AAP/AO de mentira em http://127.0.0.1:8790", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8790), H).serve_forever()
