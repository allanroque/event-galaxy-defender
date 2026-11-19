#!/usr/bin/env python3
"""Event Galaxy Defender — servidor (só biblioteca padrão).

Serve a pasta web/ e entrega ao jogo, por Server-Sent Events, o que o coletor lê do AAP e do
Automation Orchestrator (ver coletor.py). Sem credenciais configuradas, o jogo roda em simulação.

    GET  /api/stream    eventos para a tela: um retrato inicial e depois cada mudança
    GET  /api/estado    diagnóstico: quais fontes estão ligadas e se estão respondendo
    POST /api/eventos   lança um meteoro simulado: {"tipo": "ApacheDown", "host": "server07"}

Uso:
    python3 server.py                 # http://127.0.0.1:8777
    HOST=0.0.0.0 PORT=8777 python3 server.py

Não há autenticação na tela: quem alcança a porta vê nomes de jobs, hosts e usuários do AAP.
Por isso o padrão é escutar só em 127.0.0.1; publique apenas em ambiente de laboratório.
"""
import json
import os
import queue
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import coletor

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
TAMANHO_MAXIMO = 64 * 1024

assinantes = set()
trava = threading.Lock()
estado = coletor.Estado()


def difundir(dado):
    # json.dumps não emite quebra de linha crua, então cabe em uma linha "data:" do SSE.
    mensagem = json.dumps(dado, ensure_ascii=False)
    with trava:
        filas = list(assinantes)
    for fila in filas:
        try:
            fila.put_nowait(mensagem)
        except queue.Full:
            pass
    return len(filas)


estado.avisar = difundir


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, formato, *args):
        if self.path.startswith("/api/eventos"):
            super().log_message(formato, *args)

    def do_GET(self):
        rota = self.path.split("?")[0]
        if rota == "/api/stream":
            return self.stream()
        if rota == "/api/estado":
            retrato = estado.snapshot()
            por_estado = {}
            for oc in retrato["ocorrencias"]:
                por_estado[oc["estado"]] = por_estado.get(oc["estado"], 0) + 1
            return self.responder(200, {"modo": retrato["modo"], "fontes": retrato["fontes"], "ocorrencias": por_estado})
        return super().do_GET()

    def stream(self):
        fila = queue.Queue(maxsize=500)
        with trava:
            assinantes.add(fila)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"data: {json.dumps(estado.snapshot(), ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()
            while True:
                try:
                    self.wfile.write(f"data: {fila.get(timeout=15)}\n\n".encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            with trava:
                assinantes.discard(fila)

    def do_POST(self):
        if self.path.split("?")[0] != "/api/eventos":
            return self.responder(404, {"erro": "rota desconhecida"})
        try:
            tamanho = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            tamanho = 0
        if tamanho <= 0:
            return self.responder(400, {"erro": "corpo vazio"})
        if tamanho > TAMANHO_MAXIMO:
            return self.responder(413, {"erro": "corpo grande demais"})
        try:
            dado = json.loads(self.rfile.read(tamanho))
        except (ValueError, UnicodeDecodeError):
            return self.responder(400, {"erro": "JSON inválido"})
        if not isinstance(dado, dict):
            return self.responder(400, {"erro": "esperado um objeto JSON"})
        dado.pop("canal", None)  # "canal" é reservado às mensagens do coletor
        self.responder(202, {"telas": difundir(dado)})

    def responder(self, status, corpo):
        dados = json.dumps(corpo, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(dados)))
        self.end_headers()
        self.wfile.write(dados)


def main():
    host = os.environ.get("HOST", "127.0.0.1")
    porta = int(os.environ.get("PORT", "8777"))
    ligados = coletor.iniciar(estado)
    servidor = ThreadingHTTPServer((host, porta), partial(Handler, directory=RAIZ))
    servidor.daemon_threads = True
    print(f"Event Galaxy Defender em http://{host}:{porta}", flush=True)
    print("Fontes ao vivo: " + (", ".join(ligados) if ligados else "nenhuma (modo simulação)"), flush=True)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
