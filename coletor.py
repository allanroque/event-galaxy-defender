"""Coletor somente leitura: lê o que está rodando no AAP e no Automation Orchestrator.

Só faz GET (e o POST de login do Orchestrator, quando ele usa usuário e senha). Não lança job,
não aprova, não altera nada. Cada job, workflow job ou execução vira uma "ocorrência":

    id        "aap-job-982" | "aap-wf-1015" | "ao-<uuid>"
    fonte     "eda" (job disparado por regra) | "aap" (job/workflow do Controller) | "ao"
    titulo    nome do job template / workflow — é a arma no jogo
    classe    "alerta" | "incidente" | "demanda" — é a cor do meteoro
    origem    "eda" | "manual" | "agendado" | "webhook" | ...
    estado    "pendente" | "rodando" | "sucesso" | "falha" | "cancelado"
    etapas    [{nome, tipo, estado}] para workflows e execuções
    aguardando  nome da aprovação pendente, quando há
    inicio, fim (epoch), dur (segundos, só quando terminou), quem, alvo, regra, evento, erro

Configuração por variáveis de ambiente (ver README): AAP_URL, AAP_TOKEN, AO_URL, AO_TOKEN ou
AO_USERNAME + AO_PASSWORD, *_VERIFY_TLS, POLL_SECONDS.
"""
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime

TERMINAIS = ("sucesso", "falha", "cancelado")
MAX_OCORRENCIAS = 300

ESTADO_AAP = {
    "new": "pendente", "pending": "pendente", "waiting": "pendente", "running": "rodando",
    "successful": "sucesso", "failed": "falha", "error": "falha", "canceled": "cancelado",
}
ORIGEM_AAP = {
    "manual": "manual", "scheduled": "agendado", "workflow": "workflow", "webhook": "webhook",
    "relaunch": "relançado", "callback": "callback", "dependency": "dependência", "sync": "sync",
}
ESTADO_AO = {
    "pending": "pendente", "scheduled": "pendente", "queued": "pendente", "running": "rodando",
    "waiting": "rodando", "paused": "rodando", "completed": "sucesso", "succeeded": "sucesso",
    "failed": "falha", "terminated": "falha", "timed_out": "falha", "cancelled": "cancelado",
    "canceled": "cancelado", "skipped": "pulado",
}
# variáveis em que os playbooks do lab costumam receber o host alvo
CHAVES_ALVO = ("alvo", "target_hosts", "target_host", "host", "hosts", "target")


def env_bool(nome, padrao):
    return os.environ.get(nome, str(padrao)).strip().lower() not in ("0", "false", "no", "nao", "não", "off")


def epoch(texto):
    if not texto:
        return None
    try:
        return datetime.fromisoformat(str(texto).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def nome_curto(valor):
    """'server01.lab.example.com' -> 'server01'; listas viram 'server01 +2'; IP fica como está."""
    partes = [p for p in re.split(r"[,:\s]+", str(valor or "").strip()) if p]
    if not partes:
        return ""
    primeiro = partes[0]
    if not re.fullmatch(r"[\d.]+", primeiro):
        primeiro = primeiro.split(".")[0]
    return (primeiro + (f" +{len(partes) - 1}" if len(partes) > 1 else ""))[:40]


def motivo(exc):
    """Mensagem de erro curta, sem URL nem credencial."""
    if isinstance(exc, urllib.error.HTTPError):
        dica = {401: " (credencial recusada)", 403: " (sem permissão de leitura)", 404: " (rota não encontrada)"}
        return f"HTTP {exc.code}{dica.get(exc.code, '')}"
    if isinstance(exc, urllib.error.URLError):
        return f"sem conexão ({str(exc.reason)[:80]})"
    return f"{type(exc).__name__}: {str(exc)[:100]}"


class Cliente:
    def __init__(self, base, verificar_tls=True, timeout=12):
        self.base = base.rstrip("/")
        self.timeout = timeout
        self.contexto = None if verificar_tls else ssl._create_unverified_context()

    def pedir(self, metodo, caminho, cabecalhos=None, corpo=None):
        pedido = urllib.request.Request(self.base + caminho, method=metodo)
        pedido.add_header("Accept", "application/json")
        for chave, valor in (cabecalhos or {}).items():
            pedido.add_header(chave, valor)
        if corpo is not None:
            pedido.data = json.dumps(corpo).encode("utf-8")
            pedido.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(pedido, timeout=self.timeout, context=self.contexto) as resposta:
            return json.loads(resposta.read().decode("utf-8") or "null")


class Estado:
    """Guarda as ocorrências e avisa quem estiver ouvindo quando algo muda."""

    def __init__(self):
        self.trava = threading.Lock()
        self.ocorrencias = {}
        self.fontes = {}
        self.jobs_do_ao = {}  # id do job no AAP -> id da ocorrência do AO que o lançou
        self.avisar = lambda mensagem: None

    def configurada(self, nome, **campos):
        self.fontes[nome] = dict({"ok": None, "erro": None}, **campos)

    def fonte(self, nome, **campos):
        with self.trava:
            atual = self.fontes.get(nome, {})
            novo = dict(atual, **campos)
            mudou = {k: v for k, v in novo.items() if k != "ultima"} != {k: v for k, v in atual.items() if k != "ultima"}
            self.fontes[nome] = novo
        if mudou:
            self.avisar({"canal": "fontes", "fontes": self.fontes_publicas()})

    def fontes_publicas(self):
        return {nome: dict(f) for nome, f in self.fontes.items()}

    def publicar(self, oc):
        with self.trava:
            if self.ocorrencias.get(oc["id"]) == oc:
                return
            self.ocorrencias[oc["id"]] = oc
            if len(self.ocorrencias) > MAX_OCORRENCIAS:
                velhas = sorted(
                    (o for o in self.ocorrencias.values() if o["estado"] in TERMINAIS),
                    key=lambda o: o.get("fim") or o.get("inicio") or 0,
                )
                for o in velhas[: len(self.ocorrencias) - MAX_OCORRENCIAS]:
                    del self.ocorrencias[o["id"]]
        self.avisar({"canal": "ocorrencia", "o": oc})

    def snapshot(self):
        with self.trava:
            ocorrencias = list(self.ocorrencias.values())
        return {
            "canal": "snapshot",
            "agora": time.time(),
            "modo": "ao-vivo" if self.fontes else "simulacao",
            "fontes": self.fontes_publicas(),
            "ocorrencias": ocorrencias,
        }


# --------------------------------------------------------------------------- AAP


def extra_vars(job):
    bruto = job.get("extra_vars")
    if isinstance(bruto, dict):
        return bruto
    try:
        dado = json.loads(bruto or "{}")
        return dado if isinstance(dado, dict) else {}
    except ValueError:
        return {}


def evento_do_eda(ev):
    """Extrai regra e alerta do bloco ansible_eda que o EDA injeta nas extra vars do job."""
    eda = ev.get("ansible_eda")
    if not isinstance(eda, dict):
        return None
    evento = eda.get("event") if isinstance(eda.get("event"), dict) else {}
    if not evento and isinstance(eda.get("events"), dict):
        evento = next((v for v in eda["events"].values() if isinstance(v, dict)), {})
    payload = evento.get("payload") if isinstance(evento.get("payload"), dict) else evento
    tipo, host = None, None
    alertas = payload.get("alerts") if isinstance(payload, dict) else None
    if isinstance(alertas, list) and alertas and isinstance(alertas[0], dict):
        rotulos = alertas[0].get("labels") or {}
        tipo = rotulos.get("alertname")
        host = rotulos.get("host") or rotulos.get("instance")
    elif isinstance(payload, dict):
        tipo = payload.get("alertname") or payload.get("type") or payload.get("event_type")
        host = payload.get("host") or payload.get("instance")
    return {
        "regra": str(eda.get("rule") or "")[:80],
        "ruleset": str(eda.get("ruleset") or "")[:80],
        "tipo": str(tipo or eda.get("rule") or "evento")[:60],
        "host": nome_curto(host),
    }


def base_aap(job, prefixo):
    resumo = job.get("summary_fields") or {}
    estado = ESTADO_AAP.get(job.get("status"), "pendente")
    quem = (job.get("launched_by") or {}).get("name") or (resumo.get("created_by") or {}).get("username") or ""
    return {
        "id": f"{prefixo}-{job['id']}",
        "titulo": str(job.get("name") or "job")[:80],
        "estado": estado,
        "quem": str(quem)[:40],
        "inicio": epoch(job.get("started")) or epoch(job.get("created")),
        "fim": epoch(job.get("finished")),
        "dur": round(float(job.get("elapsed") or 0), 1) if estado in TERMINAIS else None,
        "erro": str(job.get("job_explanation") or "")[:160] if estado == "falha" else "",
        "rotulos": [r.get("name") for r in ((resumo.get("labels") or {}).get("results") or [])][:6],
        "etapas": [],
        "aguardando": None,
    }


class ColetorAAP(threading.Thread):
    def __init__(self, estado, url, token, verificar_tls, intervalo):
        super().__init__(daemon=True, name="coletor-aap")
        self.estado = estado
        self.cliente = Cliente(url, verificar_tls)
        self.cabecalho = {"Authorization": f"Bearer {token}"}
        self.intervalo = intervalo
        estado.configurada("aap")
        estado.configurada("eda")

    def get(self, caminho):
        return self.cliente.pedir("GET", caminho, self.cabecalho)

    def run(self):
        while True:
            try:
                self.ciclo()
                self.estado.fonte("aap", ok=True, erro=None, ultima=time.time())
            except Exception as exc:  # o laço não pode morrer por uma resposta inesperada
                self.estado.fonte("aap", ok=False, erro=motivo(exc))
            try:
                self.ativacoes()
            except Exception as exc:
                self.estado.fonte("eda", ok=False, erro=motivo(exc))
            time.sleep(self.intervalo)

    def ativacoes(self):
        """Só para o indicador: quantas rulebook activations estão rodando."""
        lista = self.get("/api/eda/v1/activations/?page_size=100").get("results") or []
        rodando = [a for a in lista if a.get("status") == "running"]
        self.estado.fonte("eda", ok=True, erro=None, ativas=len(rodando), total=len(lista), ultima=time.time())

    def ciclo(self):
        jobs = self.get("/api/controller/v2/jobs/?order_by=-id&page_size=30").get("results") or []
        fluxos = self.get("/api/controller/v2/workflow_jobs/?order_by=-id&page_size=12").get("results") or []
        try:
            aprovacoes = self.get("/api/controller/v2/workflow_approvals/?status=pending&page_size=20").get("results") or []
        except Exception:
            aprovacoes = []

        pendentes = {}
        for aprovacao in aprovacoes:
            resumo = aprovacao.get("summary_fields") or {}
            pai = resumo.get("workflow_job") or resumo.get("source_workflow_job") or {}
            if pai.get("id"):
                pendentes[pai["id"]] = str(aprovacao.get("name") or "aprovação")[:60]

        filhos = {}
        for job in jobs:
            pai = (job.get("summary_fields") or {}).get("source_workflow_job")
            if pai and pai.get("id"):
                filhos.setdefault(pai["id"], []).append(job)

        for fluxo in fluxos:
            if (fluxo.get("summary_fields") or {}).get("source_workflow_job"):
                continue  # workflow aninhado: aparece como etapa do pai
            self.estado.publicar(self.workflow(fluxo, filhos.get(fluxo["id"], []), pendentes.get(fluxo["id"])))
        for job in jobs:
            if (job.get("summary_fields") or {}).get("source_workflow_job"):
                continue  # job de workflow: aparece como etapa
            self.estado.publicar(self.job(job))

    def job(self, job):
        oc = base_aap(job, "aap-job")
        variaveis = extra_vars(job)
        eda = evento_do_eda(variaveis)
        origem = ORIGEM_AAP.get(job.get("launch_type"), str(job.get("launch_type") or "manual"))
        alvo = next((variaveis[c] for c in CHAVES_ALVO if isinstance(variaveis.get(c), str) and variaveis[c]), None)
        alvo = alvo or job.get("limit") or (eda or {}).get("host")
        oc.update({
            "fonte": "eda" if eda else "aap",
            "tipo": "job",
            "origem": "eda" if eda else origem,
            "classe": "alerta" if eda else ("incidente" if origem == "webhook" else "demanda"),
            "alvo": nome_curto(alvo) or str(((job.get("summary_fields") or {}).get("inventory") or {}).get("name") or "")[:40],
            "regra": (eda or {}).get("regra"),
            "evento": {"tipo": eda["tipo"], "host": eda["host"]} if eda else None,
        })
        pai = self.estado.jobs_do_ao.get(job["id"])
        if pai:
            oc["pai"] = pai  # lançado por um workflow do Orchestrator: é etapa dele, não um meteoro próprio
        return oc

    def workflow(self, fluxo, filhos, aprovacao):
        oc = base_aap(fluxo, "aap-wf")
        origem = ORIGEM_AAP.get(fluxo.get("launch_type"), str(fluxo.get("launch_type") or "manual"))
        etapas = [
            {"nome": str(f.get("name") or "job")[:60], "tipo": "job", "estado": ESTADO_AAP.get(f.get("status"), "pendente")}
            for f in sorted(filhos, key=lambda f: f["id"])
        ]
        if aprovacao and oc["estado"] not in TERMINAIS:
            etapas.append({"nome": aprovacao, "tipo": "aprovacao", "estado": "rodando"})
        oc.update({
            "fonte": "aap",
            "tipo": "workflow",
            "origem": origem,
            "classe": "incidente" if origem == "webhook" else "demanda",
            "alvo": nome_curto(fluxo.get("limit")),
            "regra": None,
            "evento": None,
            "etapas": etapas,
            "aguardando": aprovacao if oc["estado"] not in TERMINAIS else None,
        })
        return oc


# --------------------------------------------------------------------------- Automation Orchestrator


def achar_job_ids(dado, achados, profundidade=0):
    """Procura ids de job do AAP na saída de uma atividade do Orchestrator."""
    if profundidade > 5:
        return
    if isinstance(dado, dict):
        for chave, valor in dado.items():
            if chave in ("job_id", "aap_job_id", "unified_job_id") and str(valor).isdigit():
                achados.add(int(valor))
            else:
                achar_job_ids(valor, achados, profundidade + 1)
    elif isinstance(dado, list):
        for item in dado[:20]:
            achar_job_ids(item, achados, profundidade + 1)


class ColetorAO(threading.Thread):
    def __init__(self, estado, url, verificar_tls, intervalo, token=None, usuario=None, senha=None):
        super().__init__(daemon=True, name="coletor-ao")
        self.estado = estado
        self.cliente = Cliente(url, verificar_tls)
        self.intervalo = intervalo
        self.token_fixo = token
        self.usuario = usuario
        self.senha = senha
        self.token = token
        self.etapas_finais = {}  # execuções já encerradas: não precisa buscar atividades de novo
        estado.configurada("ao")

    def entrar(self):
        if self.token_fixo:
            self.token = self.token_fixo
            return
        resposta = self.cliente.pedir("POST", "/api/v1/auth/login", corpo={"username": self.usuario, "password": self.senha})
        self.token = resposta["access_token"]

    def get(self, caminho):
        if not self.token:
            self.entrar()
        try:
            return self.cliente.pedir("GET", caminho, {"Authorization": f"Bearer {self.token}"})
        except urllib.error.HTTPError as exc:
            if exc.code != 401 or self.token_fixo:
                raise
            self.entrar()  # token de sessão venceu
            return self.cliente.pedir("GET", caminho, {"Authorization": f"Bearer {self.token}"})

    def run(self):
        while True:
            try:
                self.ciclo()
                self.estado.fonte("ao", ok=True, erro=None, ultima=time.time())
            except Exception as exc:
                self.estado.fonte("ao", ok=False, erro=motivo(exc))
            time.sleep(self.intervalo)

    def ciclo(self):
        execucoes = self.get("/api/v1/executions?limit=50").get("resources") or []
        execucoes.sort(key=lambda e: e.get("created_at") or "", reverse=True)
        for execucao in execucoes[:25]:
            self.estado.publicar(self.execucao(execucao))

    def execucao(self, ex):
        ident = f"ao-{ex['id']}"
        estado = ESTADO_AO.get(ex.get("status"), "rodando")
        if estado == "pulado":
            estado = "cancelado"
        etapas = self.etapas_finais.get(ident)
        if etapas is None:
            etapas = self.atividades(ex["id"], ident)
            if estado in TERMINAIS:
                self.etapas_finais[ident] = etapas
                if len(self.etapas_finais) > 400:
                    self.etapas_finais.pop(next(iter(self.etapas_finais)))
        aguardando = None
        if ex.get("approval_pending") and estado not in TERMINAIS:
            aguardando = next((e["nome"] for e in etapas if e["tipo"] == "aprovacao" and e["estado"] != "sucesso"), "aprovação")
        gatilho = str(ex.get("trigger_type") or "manual").replace("_trigger", "")
        inicio, fim = epoch(ex.get("created_at")), epoch(ex.get("completed_at"))
        return {
            "id": ident,
            "fonte": "ao",
            "tipo": "execucao",
            "titulo": str(ex.get("workflow_name") or "workflow")[:80],
            "estado": estado,
            "origem": gatilho,
            "classe": "incidente" if gatilho in ("webhook", "event") else "demanda",
            "quem": str((ex.get("created_by") or {}).get("name") or "")[:40],
            "alvo": nome_curto(next((ex["input_data"][c] for c in CHAVES_ALVO if isinstance((ex.get("input_data") or {}).get(c), str)), "")),
            "inicio": inicio,
            "fim": fim,
            "dur": round(fim - inicio, 1) if estado in TERMINAIS and inicio and fim else None,
            "erro": str(ex.get("error_details") or "")[:160] if estado == "falha" else "",
            "rotulos": [],
            "etapas": etapas,
            "aguardando": aguardando,
            "regra": None,
            "evento": None,
        }

    def atividades(self, execucao_id, ident):
        try:
            brutas = self.get(f"/api/v1/executions/{execucao_id}/activities?limit=100").get("resources") or []
        except Exception:
            return []
        brutas.sort(key=lambda a: a.get("created_at") or "")
        etapas, indice = [], {}
        for atividade in brutas:
            nome = str(atividade.get("activity_name") or "etapa").split("#")[0][:60]  # "body#iter-3" -> "body"
            tipo_no = str(atividade.get("node_type") or "")
            situacao = ESTADO_AO.get(atividade.get("status"), "rodando")
            if situacao == "pulado":
                continue
            tipo = "aprovacao" if "approval" in tipo_no else "agente" if "agent" in tipo_no else "job"
            if "aap" in tipo_no:
                achados = set()
                achar_job_ids(atividade.get("output_data"), achados)
                for job_id in achados:
                    self.estado.jobs_do_ao[job_id] = ident
            if nome in indice:  # iterações de um loop viram uma etapa só
                etapa = etapas[indice[nome]]
                if situacao in ("rodando", "falha") or etapa["estado"] == "pendente":
                    etapa["estado"] = situacao
                continue
            indice[nome] = len(etapas)
            etapas.append({"nome": nome, "tipo": tipo, "estado": situacao})
        return etapas[-14:]


# --------------------------------------------------------------------------- arranque


def iniciar(estado):
    """Liga os coletores para os quais há configuração. Devolve os nomes ligados."""
    intervalo = max(1.0, float(os.environ.get("POLL_SECONDS", "3")))
    ligados = []
    aap_url, aap_token = os.environ.get("AAP_URL", "").strip(), os.environ.get("AAP_TOKEN", "").strip()
    if aap_url and aap_token:
        ColetorAAP(estado, aap_url, aap_token, env_bool("AAP_VERIFY_TLS", True), intervalo).start()
        ligados.append("aap")
    ao_url = os.environ.get("AO_URL", "").strip()
    ao_token = os.environ.get("AO_TOKEN", "").strip()
    ao_usuario, ao_senha = os.environ.get("AO_USERNAME", "").strip(), os.environ.get("AO_PASSWORD", "")
    if ao_url and (ao_token or (ao_usuario and ao_senha)):
        ColetorAO(estado, ao_url, env_bool("AO_VERIFY_TLS", True), intervalo, ao_token or None, ao_usuario, ao_senha).start()
        ligados.append("ao")
    return ligados
