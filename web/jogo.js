/*
 * Event Galaxy Defender.
 * Eventos (alerta, incidente, demanda) caem como meteoros; cada automação é uma arma no chão.
 *
 * Dois modos:
 *   simulação  o catálogo (catalogo.js) define eventos e automações; o tempo é do jogo.
 *   ao vivo    cada job do AAP ou execução do Orchestrator é um meteoro; a arma é o job template
 *              ou workflow que está rodando. Sucesso destrói, falha cai no chão. Só leitura.
 *
 * No console: egd.lancar('ApacheDown', 'server07'), egd.estado
 */
(() => {
  'use strict';

  const CAT = window.CATALOGO;
  const $ = (s) => document.querySelector(s);
  const canvas = $('#ceu');
  const ctx = canvas.getContext('2d');
  const logEl = $('#log');

  const TAU = Math.PI * 2;
  const FONTE = '"Red Hat Text", system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = '"Red Hat Mono", ui-monospace, Menlo, monospace';
  const COR = {
    alerta: '#ffb02e', incidente: '#ff5a4f', demanda: '#c792ff',
    eda: '#3fe0b5', aap: '#c6e84e', ao: '#5cb8ff', manual: '#e6e9ef', aprov: '#ffd166', agente: '#b9a5ff',
    texto: '#e8ecf3', fraco: '#8a93a6', apagado: '#4a5263',
  };
  const NOME_CLASSE = { alerta: 'ALERTA', incidente: 'INCIDENTE', demanda: 'DEMANDA' };
  const ALT_CHAO = 86;
  const VAGAS = 2; // espaços livres no lado do EDA (regras que ainda vão nascer)
  const menosMovimento = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const rand = (a, b) => a + Math.random() * (b - a);
  const sorteia = (l) => l[Math.floor(Math.random() * l.length)];
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  };

  // Duração de cada tipo de etapa, em segundos (o catálogo pode trocar qualquer uma).
  const T = Object.assign({ regra: 1, jobEda: 8, job: 3, agente: 4.5, aprovacao: 3, loop: 4 }, CAT.tempos);

  // Automação do EDA sem passos explícitos: a regra casa e o job template roda atirando.
  for (const a of CAT.automacoes) {
    if (!a.passos) {
      a.passos = [
        { tipo: 'regra', nome: 'regra: ' + a.regra },
        { tipo: 'job', nome: a.nome, tiros: 6, dur: T.jobEda },
      ];
    }
  }
  const automacaoDe = (ev) => ev.auto || (ev.automacao ? CAT.automacoes.find((a) => a.id === ev.automacao) : null);
  const passosDe = (e) => e.passos || e.a.passos; // meteoro ao vivo leva as próprias etapas
  const TEMPO = { eda: 'tEda', aap: 'tAap', ao: 'tAo' };
  const LIMITE_VIVO = { eda: 2, aap: 4, ao: 3 }; // armas por zona no modo ao vivo
  const TERMINAIS = ['sucesso', 'falha', 'cancelado'];
  const fmtDur = (seg) => (seg < 60
    ? `${Math.max(0, Math.round(seg))}s`
    : `${Math.floor(seg / 60)}m${String(Math.round(seg % 60)).padStart(2, '0')}`);
  const fmtTempo = (seg) => (seg < 100 ? seg.toFixed(1) + 's' : fmtDur(seg));

  let W = 0, H = 0, chaoY = 0;
  const S = {
    t: 0, seq: 0,
    meteoros: [], tiros: [], parts: [], aneis: [], pulsos: [], textos: [],
    canhoes: [], vagas: [], estrelas: [], racks: [], zonas: null,
    eda: true, aap: true, ao: true, chuva: false, intensidade: 2, aprovManual: false, pausa: false,
    saude: 100, tremor: 0, proxChuva: 0.6,
    radar: { x: 0 }, plantao: { x: 0, flash: 0 },
    n: null,
    porTipo: new Map(), // id do evento -> { rotulo, plat, auto, perdido }
    coberturaSuja: true,
    // ao vivo
    modo: 'simulacao', modoFixo: false, temFontes: false, conectado: false,
    fontes: {}, desvio: 0, // desvio: relógio do servidor menos o do navegador, em segundos
    ocs: new Map(), // id -> última ocorrência recebida
    vistas: new Map(), // id -> último estado já tratado
    reais: new Map(), // id -> meteoro no céu
    autosVivas: new Map(), // "fonte:titulo" -> automação (arma)
    durTipica: new Map(), // chave de cobertura -> duração da última execução
  };
  const zerarPlacar = () => {
    S.n = { eventos: 0, eda: 0, aap: 0, ao: 0, manual: 0, acoes: 0, impactos: 0, tEda: 0, tAap: 0, tAo: 0 };
  };
  zerarPlacar();

  // ------------------------------------------------------------------ layout

  function layout() {
    const caixa = canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(320, caixa.width);
    H = Math.max(240, caixa.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    chaoY = H - ALT_CHAO;

    posicionar();

    S.estrelas = Array.from({ length: Math.round((W * chaoY) / 6500) }, () => ({
      x: rand(0, W), y: rand(0, chaoY - 30), r: rand(0.4, 1.3), f: rand(0, TAU),
    }));
    S.racks = [];
    for (let x = rand(-10, 10); x < W;) {
      const w = rand(24, 50);
      S.racks.push({ x, w, h: rand(14, 40), alarme: 0, f: rand(0, TAU) });
      x += w + rand(4, 16);
    }
  }

  const automacoesAtivas = () => (S.modo === 'vivo' ? [...S.autosVivas.values()] : CAT.automacoes);

  // Distribui antena, armas e vagas pelo chão. Refeito quando a tela muda ou nasce uma arma.
  function posicionar() {
    const vivo = S.modo === 'vivo';
    const lista = automacoesAtivas();
    const edas = lista.filter((a) => a.plataforma === 'eda');
    const aaps = lista.filter((a) => a.plataforma === 'aap');
    const aos = lista.filter((a) => a.plataforma === 'ao');
    const vagas = vivo ? Math.max(0, 1 - edas.length) : VAGAS;
    const nE = 1 + edas.length + vagas; // antena + regras + vagas
    const uP = vivo ? Math.max(1, aaps.length) * 1.25 : 0; // a zona do Controller só existe ao vivo
    const uA = Math.max(1, aos.length) * 1.3;
    const pE = (W - 40) / (nE + 0.7 + uP + (uP ? 0.4 : 0) + uA);
    const zE = [20, 20 + pE * nE];
    const zP = uP ? [zE[1] + pE * 0.7, zE[1] + pE * (0.7 + uP)] : null;
    const zA = [zP ? zP[1] + pE * 0.4 : zE[1] + pE * 0.7, W - 20];
    const antigos = new Map(S.canhoes.map((c) => [c.a.id, c]));
    const canhao = (a, x, larg) => {
      const c = antigos.get(a.id) || {
        a, sobe: a.plataforma === 'eda' ? 1 : 0, ang: -Math.PI / 2,
        alvo: null, calor: 0, ocioso: 99, ativos: 0,
      };
      c.a = a;
      c.x = x;
      c.larg = larg;
      return c;
    };

    S.zonas = { eda: zE, aap: zP, ao: zA };
    S.radar.x = zE[0] + pE * 0.5;
    S.canhoes = [];
    edas.forEach((a, i) => S.canhoes.push(canhao(a, zE[0] + pE * (i + 1.5), pE)));
    S.vagas = [];
    for (let v = 0; v < vagas; v++) S.vagas.push(zE[0] + pE * (1 + edas.length + v + 0.5));
    S.plantao.x = zE[1] + pE * 0.35;
    if (zP) {
      const pP = (zP[1] - zP[0]) / Math.max(1, aaps.length);
      aaps.forEach((a, i) => S.canhoes.push(canhao(a, zP[0] + pP * (i + 0.5), pP)));
    }
    const pA = (zA[1] - zA[0]) / Math.max(1, aos.length);
    aos.forEach((a, i) => S.canhoes.push(canhao(a, zA[0] + pA * (i + 0.5), pA)));
  }

  const pivo = (c) => (c.a.plataforma === 'eda'
    ? { x: c.x, y: chaoY - 24, L: 24 }
    : { x: c.x, y: chaoY - 46 * c.sobe + 4, L: 32 });
  const boca = (c) => {
    const p = pivo(c);
    return { x: p.x + Math.cos(c.ang) * p.L, y: p.y + Math.sin(c.ang) * p.L };
  };

  // ------------------------------------------------------------------ eventos

  function lancar(ev, host) {
    if (S.meteoros.length >= 40) return null;
    const r = ev.raio || 18;
    const m = {
      id: ++S.seq, ev,
      host: host || sorteia(ev.hosts || ['host']),
      x: posicaoLivre(), y: -r - 6,
      vx: rand(-7, 7), vy: (chaoY + r) / (ev.queda || 12),
      r, rot: rand(0, TAU), vr: rand(-0.7, 0.7),
      forma: Array.from({ length: 12 }, () => rand(0.8, 1.1)),
      crateras: Array.from({ length: 3 }, () => ({ a: rand(0, TAU), d: rand(0.15, 0.55), r: rand(0.12, 0.24) })),
      idade: 0, detectado: false, reservado: false, exec: null, motivo: '',
      cliques: 0, acertos: 0, vida: ev.cliques || 5,
      rachas: 0, flash: 0, analise: 0, trava: 0, morto: false,
    };
    S.meteoros.push(m);
    S.n.eventos++;
    return m;
  }

  // Entre alguns sorteios, fica com o x mais distante dos meteoros que ainda estão no alto.
  function posicaoLivre() {
    const altos = S.meteoros.filter((m) => m.y < chaoY * 0.4);
    let melhor = rand(70, Math.max(80, W - 70));
    let folga = -1;
    for (let i = 0; i < 8 && altos.length; i++) {
      const x = rand(70, Math.max(80, W - 70));
      const d = Math.min(...altos.map((m) => Math.abs(m.x - x)));
      if (d > folga) { folga = d; melhor = x; }
    }
    return melhor;
  }

  function lancarPorNome(tipo, host, classe) {
    let ev = CAT.eventos.find((e) => e.id === tipo);
    if (!ev) {
      // Evento que o catálogo não conhece: cai como meteoro sem automação.
      ev = {
        id: String(tipo).slice(0, 40), rotulo: String(tipo).slice(0, 40),
        classe: NOME_CLASSE[classe] ? classe : 'alerta',
        automacao: null, hosts: ['host'], queda: 12, raio: 18, cliques: 5, dano: 12,
      };
    }
    return lancar(ev, host ? String(host).split(':')[0].slice(0, 30) : undefined);
  }

  function sortearEvento() {
    const total = CAT.eventos.reduce((s, e) => s + (e.peso || 1), 0);
    let x = Math.random() * total;
    for (const e of CAT.eventos) {
      x -= e.peso || 1;
      if (x <= 0) return e;
    }
    return CAT.eventos[0];
  }

  function tentarDespachar(m) {
    if (m.vivo) { despacharReal(m); return; }
    const a = automacaoDe(m.ev);
    if (!a) { m.motivo = 'sem automação'; return; }
    if (!S[a.plataforma]) { m.motivo = (a.plataforma === 'eda' ? 'EDA' : 'Orchestrator') + ' desligado'; return; }
    const c = S.canhoes.find((k) => k.a.id === a.id);
    if (!c) { m.motivo = 'sem automação'; return; }
    m.reservado = true;
    c.ocioso = 0; // o canhão começa a subir enquanto o evento é encaminhado
    S.pulsos.push({
      x0: S.radar.x, x1: c.x, t: 0,
      dur: Math.max(0.15, Math.min(0.5, Math.abs(c.x - S.radar.x) / 1500)),
      cor: COR[a.plataforma],
      fim: () => {
        if (m.morto) return;
        m.exec = { a, c, i: 0, t: 0, dur: 0, iniciado: false, espera: false, fim: false, rajada: null, finalDisparado: false };
        c.ativos++;
        c.alvo = m;
      },
    });
  }

  function iniciarPasso(m, e, p) {
    const ultimo = e.i === passosDe(e).length - 1;
    e.t = 0;
    e.rajada = null;
    e.espera = false;
    e.dur = p.dur || T[p.tipo] || T.job;
    switch (p.tipo) {
      case 'regra':
        e.c.calor = 1;
        break;
      case 'agente':
        m.analise = e.dur;
        break;
      case 'aprovacao':
        e.espera = S.aprovManual;
        break;
      default: {
        // job e loop: os tiros se espalham pela duração da etapa; o último sai no fim dela
        const n = p.tiros || (p.tipo === 'loop' ? 3 : 2);
        e.rajada = { n, gap: e.dur / n, t: e.dur / n, final: ultimo };
      }
    }
  }

  function avancar(m, dt) {
    const e = m.exec;
    if (e.fim) return;
    const plat = e.a.plataforma;
    if (!e.iniciado) {
      e.iniciado = true;
      iniciarPasso(m, e, passosDe(e)[e.i]);
    }
    e.t += dt;
    if (e.rajada && e.rajada.n > 0) {
      e.rajada.t -= dt;
      if (e.rajada.t <= 0) {
        e.rajada.n--;
        e.rajada.t = e.rajada.gap;
        const final = e.rajada.final && e.rajada.n === 0;
        if (final) e.finalDisparado = true;
        atirar(e.c, m, plat, final);
      }
      return;
    }
    if (e.espera || e.t < e.dur) return;
    if (e.i === passosDe(e).length - 1) {
      e.fim = true;
      if (!e.finalDisparado) destruir(m, plat); // catálogo sem tiro no último passo
    } else {
      e.i++;
      e.iniciado = false;
    }
  }

  function atirar(c, m, plat, final) {
    const p = pivo(c);
    c.alvo = m;
    c.ang = Math.atan2(m.y - p.y, m.x - p.x);
    c.calor = 1;
    const b = boca(c);
    S.tiros.push({ x: b.x, y: b.y, m, v: plat === 'eda' ? 1100 : 640, cor: COR[plat], plat, final, rastro: [] });
  }

  const pendentes = () => S.meteoros.filter((m) => !m.morto && m.exec && m.exec.espera);

  function aprovar(m) {
    m = m || pendentes()[0];
    if (!m || !m.exec || !m.exec.espera) return;
    const e = m.exec;
    e.espera = false;
    e.t = e.dur;
    S.aneis.push({ x: m.x, y: m.y, r: m.r, vr: 160, vida: 0.4, max: 0.4, cor: COR.aprov });
    registrar('aprov', 'Aprovado', `${passosDe(e)[e.i].nome} · ${m.host}`);
  }

  function soltar(m) {
    if (!m.exec) return;
    m.exec.c.ativos = Math.max(0, m.exec.c.ativos - 1);
    m.exec.c.ocioso = 0;
  }

  // Ganhamos quando uma automação resolveu; perdemos quando caiu no chão ou foi no braço.
  function contar(m, ganhou) {
    const chave = m.ev.cobertura || m.ev.id;
    let t = S.porTipo.get(chave);
    if (!t) {
      const a = automacaoDe(m.ev);
      t = { id: chave, rotulo: m.ev.rotulo || m.ev.id, plat: a ? a.plataforma : null, auto: 0, perdido: 0 };
      S.porTipo.set(chave, t);
    }
    t[ganhou ? 'auto' : 'perdido']++;
    S.coberturaSuja = true;
  }

  function destruir(m, por) {
    if (m.morto) return;
    m.morto = true;
    soltar(m);
    contar(m, por !== 'manual');
    explodir(m.x, m.y, COR[m.ev.classe], m.r, false);
    let t = m.idade;
    if (m.vivo) { // ao vivo o tempo é o do job real, não o do jogo
      S.reais.delete(m.real.id);
      t = m.real.dur != null ? m.real.dur : idadeReal(m.real);
      S.durTipica.set(m.ev.cobertura, t);
    }
    if (por === 'manual') {
      S.n.manual++;
      registrar('manual', 'Plantão (manual)', `${m.ev.id} · ${m.host} · ${m.cliques} ações`, t);
      flutuar(m.x, m.y, `manual ${t.toFixed(1)}s`, COR.manual);
    } else {
      S.n[por]++;
      S.n[TEMPO[por]] += t;
      registrar(por, m.exec ? m.exec.a.nome : por, detalheDe(m), t);
      flutuar(m.x, m.y, `${(m.exec && m.exec.a.desfecho) || 'resolvido'} ${fmtTempo(t)}`, COR[por]);
    }
  }

  function impacto(m) {
    if (m.morto) return;
    const porque = m.exec ? `caiu durante "${statusDe(m)}"` : (m.motivo || 'sem automação');
    m.morto = true;
    soltar(m);
    explodir(m.x, chaoY, COR.incidente, m.r * 1.5, true);
    S.tremor = 1;
    S.saude = Math.max(0, S.saude - (m.ev.dano || 12));
    S.n.impactos++;
    contar(m, false);
    for (const r of S.racks) if (Math.abs(r.x + r.w / 2 - m.x) < 70) r.alarme = 4;
    if (m.vivo) {
      const o = m.real;
      const como = o.estado === 'cancelado' ? 'Cancelado' : 'Falhou';
      S.reais.delete(o.id);
      registrar('impacto', `${como} — ${o.titulo}`, detalheDe(m) + (o.erro ? ' · ' + o.erro : ''));
      flutuar(m.x, chaoY - 24, como.toLowerCase(), COR.incidente);
    } else {
      registrar('impacto', 'Impacto — plantão acionado', `${m.ev.id} · ${m.host} · ${porque}`);
      flutuar(m.x, chaoY - 24, 'impacto', COR.incidente);
    }
  }

  const detalheDe = (m) => m.ev.id + (m.host && m.host !== '—' ? ' · ' + m.host : '');

  function statusDe(m) {
    if (m.vivo) {
      const o = m.real;
      if (o.estado === 'falha') return `${o.titulo} · falhou`;
      if (o.estado === 'cancelado') return `${o.titulo} · cancelado`;
      if (o.estado === 'sucesso') return `${o.titulo} · concluído`;
      if (o.aguardando) return `aguardando aprovação: ${o.aguardando}`;
      if (o.estado === 'pendente') return `${o.titulo} · na fila`;
      const p = m.exec && m.exec.passos[m.exec.i];
      const etapa = p && p.tipo !== 'regra' && p.nome !== o.titulo ? ` › ${p.nome}` : '';
      return `${o.titulo}${etapa} · ${fmtDur(idadeReal(o))}`;
    }
    if (m.exec) {
      const e = m.exec;
      const p = passosDe(e)[Math.min(e.i, passosDe(e).length - 1)];
      const nome = p.tipo === 'regra' ? 'regra: ' + (m.ev.regra || e.a.regra) : p.nome;
      return (e.espera ? 'aguardando · ' : '') + nome;
    }
    if (m.reservado) return 'encaminhando…';
    if (!m.detectado) return 'entrando…';
    return m.motivo + (m.cliques ? ` · manual ${m.cliques}/${m.vida}` : '');
  }

  // ------------------------------------------------------------------ ao vivo (AAP e Orchestrator)

  const agoraServidor = () => Date.now() / 1000 + S.desvio;
  const idadeReal = (o) => Math.max(0, agoraServidor() - (o.inicio || agoraServidor()));
  const rotuloDe = (o) => (o.evento ? o.evento.tipo : [o.origem, o.quem].filter(Boolean).join(' · ') || o.fonte);
  const coberturaDe = (o) => `vivo:${o.fonte}:${o.titulo}`;

  // A arma de uma automação real. Nasce quando a automação aparece; a zona tem limite de armas.
  function autoViva(o, criar) {
    const id = `${o.fonte}:${o.titulo}`;
    let a = S.autosVivas.get(id);
    if (!a && criar) {
      const daZona = [...S.autosVivas.values()].filter((x) => x.plataforma === o.fonte);
      if (daZona.length >= (LIMITE_VIVO[o.fonte] || 3)) {
        // zona cheia: sai a arma parada há mais tempo
        const parada = daZona
          .filter((x) => !S.canhoes.some((c) => c.a === x && c.ativos > 0))
          .sort((x, y) => x.ultimaVez - y.ultimaVez)[0];
        if (parada) S.autosVivas.delete(parada.id);
      }
      a = { id, plataforma: o.fonte, nome: o.titulo, passos: [{ tipo: 'job', nome: o.titulo }], ultimaVez: 0 };
      S.autosVivas.set(id, a);
      posicionar();
    }
    if (a) a.ultimaVez = Math.max(a.ultimaVez, o.fim || o.inicio || 0);
    return a;
  }

  function passosReais(o) {
    const passos = [];
    if (o.fonte === 'eda') passos.push({ tipo: 'regra', nome: 'regra: ' + (o.regra || 'regra do EDA'), feito: true });
    if (o.etapas && o.etapas.length) {
      for (const e of o.etapas.slice(-12)) {
        passos.push({ tipo: e.tipo || 'job', nome: e.nome, feito: e.estado === 'sucesso', atual: e.estado === 'rodando' });
      }
    } else {
      passos.push({ tipo: 'job', nome: o.titulo, atual: o.estado === 'rodando' });
    }
    if (o.aguardando && !passos.some((p) => p.tipo === 'aprovacao' && p.atual)) {
      passos.forEach((p) => { p.atual = false; });
      passos.push({ tipo: 'aprovacao', nome: o.aguardando, atual: true });
    }
    return passos;
  }

  function indiceAtual(passos) {
    let i = passos.findIndex((p) => p.atual);
    if (i < 0) i = passos.findIndex((p) => !p.feito);
    return i < 0 ? passos.length - 1 : i;
  }

  function criarReal(o) {
    const auto = autoViva(o, true);
    const ev = {
      id: String(rotuloDe(o)).slice(0, 44), rotulo: o.titulo,
      classe: NOME_CLASSE[o.classe] ? o.classe : 'demanda',
      auto, cobertura: coberturaDe(o), regra: o.regra,
      raio: o.tipo === 'job' ? 17 : 23, dano: 14, cliques: 99, queda: 30,
    };
    const m = lancar(ev, o.alvo || '—');
    if (!m) return null;
    m.vivo = true;
    m.real = o;
    m.nasceu = S.t;
    m.y0 = m.y;
    m.idadeVis = 0;
    m.caindo = false;
    m.vx = rand(-3, 3);
    // quanto mais o job demora em relação ao costume, mais perto do chão o meteoro chega
    m.tau = Math.max(9, (S.durTipica.get(ev.cobertura) || 16) * 1.1);
    S.reais.set(o.id, m);
    return m;
  }

  function despacharReal(m) {
    const a = m.ev.auto;
    let c = S.canhoes.find((k) => k.a === a);
    if (!c) { // a arma saiu do chão enquanto o meteoro esperava
      S.autosVivas.set(a.id, a);
      posicionar();
      c = S.canhoes.find((k) => k.a === a);
      if (!c) return;
    }
    m.reservado = true;
    c.ocioso = 0;
    S.pulsos.push({
      x0: S.radar.x, x1: c.x, t: 0,
      dur: Math.max(0.15, Math.min(0.5, Math.abs(c.x - S.radar.x) / 1500)),
      cor: COR[a.plataforma],
      fim: () => {
        if (m.morto) return;
        const passos = passosReais(m.real);
        m.exec = {
          a, c, passos, i: indiceAtual(passos), t: 0, dur: 0, prox: 0.3,
          iniciado: true, espera: false, fim: false, rajada: null, finalDisparado: false,
        };
        c.ativos++;
        c.alvo = m;
      },
    });
  }

  // O estado vem do job real: rodando atira, sucesso dá o tiro final, falha derruba o meteoro.
  function avancarReal(m, dt) {
    const o = m.real;
    if (o.estado === 'falha' || o.estado === 'cancelado') {
      if (!m.caindo && S.t - m.nasceu > 0.8) {
        m.caindo = true;
        m.vy = Math.max(160, (chaoY - m.y) / 0.9);
      }
      return;
    }
    const e = m.exec;
    if (!e || e.fim) return;
    e.passos = passosReais(o);
    e.i = indiceAtual(e.passos);
    e.t += dt;
    const plat = e.a.plataforma;
    if (o.estado === 'sucesso') {
      if (S.t - m.nasceu > 1.2) {
        e.i = e.passos.length - 1;
        e.fim = true;
        e.finalDisparado = true;
        atirar(e.c, m, plat, true);
      }
      return;
    }
    if (o.aguardando || o.estado !== 'rodando') return; // esperando aprovação ou ainda na fila
    e.prox -= dt;
    if (e.prox <= 0) {
      e.prox = 1.4;
      atirar(e.c, m, plat, false);
    }
    if (e.passos[e.i] && e.passos[e.i].tipo === 'agente') m.analise = 0.4;
  }

  // Tira do céu sem contar: o job passou a ser etapa de um workflow do Orchestrator.
  function sumir(m) {
    m.morto = true;
    soltar(m);
    S.reais.delete(m.real.id);
    S.n.eventos = Math.max(0, S.n.eventos - 1);
  }

  // Automação que terminou sem passar pelo céu (histórico): entra direto no placar.
  function semear(o, noRegistro) {
    const chave = coberturaDe(o);
    let t = S.porTipo.get(chave);
    if (!t) {
      t = { id: chave, rotulo: o.titulo, plat: o.fonte, auto: 0, perdido: 0 };
      S.porTipo.set(chave, t);
    }
    S.n.eventos++;
    const ok = o.estado === 'sucesso';
    if (ok) {
      t.auto++;
      S.n[o.fonte]++;
      S.n[TEMPO[o.fonte]] += o.dur || 0;
      if (o.dur) S.durTipica.set(chave, o.dur);
    } else {
      t.perdido++;
      S.n.impactos++;
    }
    S.coberturaSuja = true;
    if (!noRegistro) return;
    const detalhe = [rotuloDe(o), o.alvo].filter(Boolean).join(' · ');
    if (ok) registrar(o.fonte, o.titulo, detalhe, o.dur);
    else registrar('impacto', `${o.estado === 'cancelado' ? 'Cancelado' : 'Falhou'} — ${o.titulo}`, detalhe);
  }

  function aplicarOcorrencia(o, historico, noRegistro) {
    S.ocs.set(o.id, o);
    if (S.modo !== 'vivo') return;
    const antes = S.vistas.get(o.id);
    S.vistas.set(o.id, o.estado);
    const m = S.reais.get(o.id);
    if (o.pai) { if (m) sumir(m); return; }
    if (m) { m.real = o; return; }
    if (antes && TERMINAIS.includes(antes)) return; // já contada
    if (TERMINAIS.includes(o.estado) && (historico || agoraServidor() - (o.fim || 0) > 45)) {
      semear(o, noRegistro);
      return;
    }
    criarReal(o);
  }

  // Reconstrói o céu e o placar a partir do que o servidor já conhece.
  function recarregarVivo() {
    const lista = [...S.ocs.values()]
      .filter((o) => !o.pai)
      .sort((a, b) => (a.fim || a.inicio || 0) - (b.fim || b.inicio || 0));
    const noRegistro = new Set(lista.filter((o) => TERMINAIS.includes(o.estado)).slice(-8).map((o) => o.id));
    for (const o of lista.slice().reverse()) { // as automações usadas por último já ganham arma
      const naZona = [...S.autosVivas.values()].filter((x) => x.plataforma === o.fonte).length;
      autoViva(o, naZona < (LIMITE_VIVO[o.fonte] || 3));
    }
    for (const o of lista) aplicarOcorrencia(o, true, noRegistro.has(o.id));
  }

  function aplicarSnapshot(p) {
    S.desvio = (p.agora || Date.now() / 1000) - Date.now() / 1000;
    S.fontes = p.fontes || {};
    S.temFontes = p.modo === 'ao-vivo';
    S.ocs = new Map((p.ocorrencias || []).map((o) => [o.id, o]));
    if (S.temFontes && !S.modoFixo && S.modo !== 'vivo') definirModo('vivo');
    else if (S.modo === 'vivo') recarregarVivo();
    desenharFontes();
  }

  function definirModo(modo) {
    S.modo = modo;
    document.body.classList.toggle('modo-vivo', modo === 'vivo');
    limpar();
    S.vistas.clear();
    if (modo === 'vivo') S.chuva = false;
    posicionar();
    if (modo === 'vivo') recarregarVivo();
    aplicarRotulosDoModo();
  }

  // ------------------------------------------------------------------ efeitos

  function explodir(x, y, cor, r, noChao) {
    if (S.parts.length > 700) return;
    const n = noChao ? 34 : 22;
    for (let i = 0; i < n; i++) {
      const ang = noChao ? rand(-Math.PI, 0) : rand(0, TAU);
      const v = rand(60, 260) * (noChao ? 1.3 : 1);
      const vida = rand(0.35, 0.9);
      S.parts.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, vida, max: vida, cor: i % 3 ? cor : '#ffffff', tam: rand(1.2, 2.6), pedra: false, g: 120 });
    }
    for (let i = 0; i < 8; i++) {
      const ang = noChao ? rand(-Math.PI, 0) : rand(0, TAU);
      const v = rand(40, 160);
      const vida = rand(0.6, 1.2);
      S.parts.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, vida, max: vida, cor, tam: rand(2.5, Math.max(3, r * 0.3)), pedra: true, g: 320, rot: rand(0, TAU) });
    }
    S.aneis.push({ x, y, r: r * 0.6, vr: 230, vida: 0.45, max: 0.45, cor });
  }

  function faiscar(x, y, cor, n) {
    for (let i = 0; i < n; i++) {
      const ang = rand(0, TAU);
      const v = rand(40, 170);
      const vida = rand(0.2, 0.45);
      S.parts.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, vida, max: vida, cor, tam: rand(1, 2), pedra: false, g: 80 });
    }
  }

  function flutuar(x, y, txt, cor) {
    S.textos.push({ x: Math.max(60, Math.min(W - 60, x)), y, txt, cor, vida: 1.5, max: 1.5 });
  }

  function registrar(tipo, titulo, detalhe, tempo) {
    const li = document.createElement('li');
    li.className = tipo;
    const b = document.createElement('b');
    b.textContent = titulo;
    const s = document.createElement('span');
    s.textContent = detalhe;
    li.append(b, s);
    if (tempo != null) {
      const em = document.createElement('em');
      em.textContent = fmtTempo(tempo);
      li.append(em);
    }
    logEl.prepend(li);
    while (logEl.children.length > 40) logEl.lastChild.remove();
  }

  // ------------------------------------------------------------------ simulação

  function atualizar(dt) {
    S.t += dt;

    if (S.chuva && S.modo !== 'vivo') {
      S.proxChuva -= dt;
      if (S.proxChuva <= 0) {
        lancar(sortearEvento());
        S.proxChuva = rand(0.6, 1.4) * (6 / S.intensidade);
      }
    }

    for (const m of S.meteoros) {
      m.idade += dt;
      m.x += m.vx * dt;
      if (m.vivo && !m.caindo) {
        // desce rápido até alcançar a idade real do job; depois acompanha, cada vez mais devagar
        const alvo = idadeReal(m.real);
        m.idadeVis = Math.min(alvo, m.idadeVis + dt * (alvo - m.idadeVis > 2 ? 6 : 1));
        m.y = m.y0 + (chaoY * 0.72 - m.y0) * (1 - Math.exp(-m.idadeVis / m.tau));
        m.vy = 14; // só orienta o rastro
      } else {
        m.y += m.vy * dt;
      }
      m.rot += m.vr * dt;
      if (m.x < 50 || m.x > W - 50) m.vx = -m.vx;
      m.flash = Math.max(0, m.flash - dt * 4);
      m.analise = Math.max(0, m.analise - dt);
      m.trava = Math.max(0, m.trava - dt);
      if (!m.detectado && m.idade > 0.45) {
        m.detectado = true;
        m.trava = 0.5;
        S.aneis.push({ x: S.radar.x, y: chaoY - 36, r: 4, vr: 90, vida: 0.5, max: 0.5, cor: COR[m.ev.classe] });
      }
      if (m.detectado && !m.exec && !m.reservado) tentarDespachar(m);
      if (m.vivo) avancarReal(m, dt);
      else if (m.exec) avancar(m, dt);
      if (!m.morto && m.y + m.r * 0.6 >= chaoY) impacto(m);
    }
    S.meteoros = S.meteoros.filter((m) => !m.morto);

    for (const t of S.tiros) {
      if (t.m.morto) {
        faiscar(t.x, t.y, t.cor, 3);
        t.fim = true;
        continue;
      }
      const dx = t.m.x - t.x;
      const dy = t.m.y - t.y;
      const d = Math.hypot(dx, dy) || 1;
      const passo = t.v * dt;
      if (d <= passo + t.m.r * 0.7) {
        t.fim = true;
        const m = t.m;
        m.flash = 1;
        faiscar(t.x + dx * 0.6, t.y + dy * 0.6, t.cor, 7);
        if (t.plat === 'manual') {
          m.acertos++;
          m.rachas++;
          if (m.acertos >= m.vida) destruir(m, 'manual');
        } else if (t.final) {
          destruir(m, t.plat);
        } else {
          m.rachas++;
        }
      } else {
        t.rastro.push(t.x, t.y);
        if (t.rastro.length > 12) t.rastro.splice(0, 2);
        t.x += (dx / d) * passo;
        t.y += (dy / d) * passo;
      }
    }
    S.tiros = S.tiros.filter((t) => !t.fim);

    for (const p of S.pulsos) {
      p.t += dt;
      if (p.t >= p.dur && !p.feito) {
        p.feito = true;
        p.fim();
      }
    }
    S.pulsos = S.pulsos.filter((p) => !p.feito);

    for (const p of S.parts) {
      p.vida -= dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    S.parts = S.parts.filter((p) => p.vida > 0);

    for (const a of S.aneis) {
      a.vida -= dt;
      a.r += a.vr * dt;
    }
    S.aneis = S.aneis.filter((a) => a.vida > 0);

    for (const f of S.textos) {
      f.vida -= dt;
      f.y -= 26 * dt;
    }
    S.textos = S.textos.filter((f) => f.vida > 0);

    for (const c of S.canhoes) {
      if (c.ativos === 0) c.ocioso += dt;
      const quer = c.a.plataforma === 'eda' || c.ativos > 0 || c.ocioso < 2.2 ? 1 : 0;
      c.sobe += (quer - c.sobe) * Math.min(1, dt * 8);
      c.calor = Math.max(0, c.calor - dt * 2.5);
      if (c.alvo && c.alvo.morto) c.alvo = null;
      const p = pivo(c);
      const ang = c.alvo ? Math.atan2(c.alvo.y - p.y, c.alvo.x - p.x) : -Math.PI / 2;
      c.ang += (ang - c.ang) * Math.min(1, dt * 10);
    }

    for (const r of S.racks) r.alarme = Math.max(0, r.alarme - dt);
    S.tremor = Math.max(0, S.tremor - dt * 2.2);
    S.plantao.flash = Math.max(0, S.plantao.flash - dt * 4);
    S.saude = Math.min(100, S.saude + 1.2 * dt);
  }

  // ------------------------------------------------------------------ desenho

  function caixaArredondada(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function quebrar(texto, larg) {
    // palavra larga demais (AIOPS-REMEDIATE-SERVICE) pode quebrar depois de um hífen
    const pedacos = [];
    for (const palavra of texto.split(' ')) {
      const partes = ctx.measureText(palavra).width > larg ? palavra.split(/(?<=-)/) : [palavra];
      partes.forEach((t, i) => pedacos.push({ t, cola: i > 0 }));
    }
    const linhas = [];
    let atual = '';
    for (const p of pedacos) {
      const tentativa = atual ? atual + (p.cola ? '' : ' ') + p.t : p.t;
      if (atual && ctx.measureText(tentativa).width > larg) {
        linhas.push(atual);
        atual = p.t;
      } else {
        atual = tentativa;
      }
    }
    if (atual) linhas.push(atual);
    if (linhas.length > 3) linhas.splice(2, linhas.length - 2, linhas.slice(2).join(' '));
    return linhas;
  }

  function desenharFundo() {
    const g = ctx.createLinearGradient(0, 0, 0, chaoY);
    g.addColorStop(0, '#070912');
    g.addColorStop(0.7, '#0d1322');
    g.addColorStop(1, '#172036');
    ctx.fillStyle = g;
    ctx.fillRect(-20, -20, W + 40, chaoY + 20);

    for (const e of S.estrelas) {
      ctx.fillStyle = `rgba(200,215,245,${0.25 + 0.3 * Math.sin(S.t * 1.3 + e.f)})`;
      ctx.fillRect(e.x, e.y, e.r, e.r);
    }

    // o que está sendo protegido: silhueta de racks, com LEDs
    for (const r of S.racks) {
      const alarme = r.alarme > 0 && Math.sin(S.t * 14) > 0;
      ctx.fillStyle = alarme ? '#3a1820' : '#111827';
      ctx.fillRect(r.x, chaoY - r.h, r.w, r.h);
      for (let y = chaoY - r.h + 5, k = 0; y < chaoY - 4; y += 7, k++) {
        const aceso = Math.sin(S.t * 2 + r.f + k * 1.7) > 0.2;
        ctx.fillStyle = r.alarme > 0 ? rgba(COR.incidente, 0.9) : rgba(k % 2 ? COR.eda : COR.ao, aceso ? 0.55 : 0.15);
        ctx.fillRect(r.x + 4, y, 3, 2);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(r.x + 10, y, r.w - 14, 1);
      }
    }
  }

  function desenharMeteoro(m) {
    const cor = COR[m.ev.classe];
    const v = Math.hypot(m.vx, m.vy) || 1;
    const ux = m.vx / v;
    const uy = m.vy / v;

    if (m.trava > 0) {
      ctx.strokeStyle = rgba(cor, m.trava * 1.2);
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.moveTo(S.radar.x, chaoY - 36);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // rastro
    const comp = m.r * 5;
    const tx = m.x - ux * comp;
    const ty = m.y - uy * comp;
    const gr = ctx.createLinearGradient(m.x, m.y, tx, ty);
    gr.addColorStop(0, rgba(cor, 0.5));
    gr.addColorStop(1, rgba(cor, 0));
    ctx.fillStyle = gr;
    ctx.beginPath();
    ctx.moveTo(m.x - uy * m.r * 0.9, m.y + ux * m.r * 0.9);
    ctx.lineTo(tx, ty);
    ctx.lineTo(m.x + uy * m.r * 0.9, m.y - ux * m.r * 0.9);
    ctx.closePath();
    ctx.fill();

    // rocha
    const n = m.forma.length;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const a = m.rot + (i / n) * TAU;
      const rr = m.r * m.forma[i];
      const px = m.x + Math.cos(a) * rr;
      const py = m.y + Math.sin(a) * rr;
      if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    }
    ctx.closePath();
    const gb = ctx.createRadialGradient(m.x + ux * m.r * 0.55, m.y + uy * m.r * 0.55, m.r * 0.1, m.x, m.y, m.r * 1.15);
    gb.addColorStop(0, rgba(cor, 0.6));
    gb.addColorStop(0.55, '#2a2f3c');
    gb.addColorStop(1, '#161a24');
    ctx.shadowColor = cor;
    ctx.shadowBlur = 16;
    ctx.fillStyle = gb;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = rgba(cor, 0.9);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    for (const c of m.crateras) {
      const a = m.rot + c.a;
      ctx.beginPath();
      ctx.arc(m.x + Math.cos(a) * m.r * c.d, m.y + Math.sin(a) * m.r * c.d, m.r * c.r, 0, TAU);
      ctx.fill();
    }

    ctx.strokeStyle = rgba(cor, 0.95);
    ctx.lineWidth = 1.5;
    for (let k = 0; k < Math.min(m.rachas, 6); k++) {
      const a = m.rot + k * 1.9;
      ctx.beginPath();
      ctx.moveTo(m.x + Math.cos(a) * m.r * 0.1, m.y + Math.sin(a) * m.r * 0.1);
      ctx.lineTo(m.x + Math.cos(a + 0.35) * m.r * 0.5, m.y + Math.sin(a + 0.35) * m.r * 0.5);
      ctx.lineTo(m.x + Math.cos(a) * m.r * 0.9, m.y + Math.sin(a) * m.r * 0.9);
      ctx.stroke();
    }

    if (m.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${m.flash * 0.55})`;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r, 0, TAU);
      ctx.fill();
    }

    const e = m.exec;
    if (e && m.analise > 0) {
      // agente analisando: feixe fino + anel tracejado girando
      const b = boca(e.c);
      ctx.strokeStyle = rgba(COR.agente, 0.55);
      ctx.lineWidth = 1.2;
      ctx.setLineDash([2, 6]);
      ctx.lineDashOffset = -S.t * 40;
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(m.x, m.y);
      ctx.stroke();
      ctx.strokeStyle = rgba(COR.agente, 0.9);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r + 9, 0, TAU);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    if (e && !e.fim && passosDe(e)[e.i] && passosDe(e)[e.i].tipo === 'aprovacao') {
      const pulso = 0.5 + 0.5 * Math.sin(S.t * 7);
      ctx.strokeStyle = rgba(COR.aprov, 0.5 + 0.5 * pulso);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r + 8 + pulso * 4, 0, TAU);
      ctx.stroke();
    }
  }

  function medirRotulo(m) {
    const e = m.exec;
    const l1 = `${NOME_CLASSE[m.ev.classe]} · ${m.ev.id}`;
    const l2 = m.vivo && m.host === '—' ? statusDe(m) : `${m.host} — ${statusDe(m)}`;
    ctx.font = `600 10px ${MONO}`;
    const w1 = ctx.measureText(l1).width;
    ctx.font = `500 11.5px ${FONTE}`;
    const w2 = ctx.measureText(l2).width;
    const pips = e ? passosDe(e).length : 0;
    const w = Math.max(w1, w2, pips * 11) + 18;
    const h = pips ? 48 : 36;
    const esquerda = m.x + m.r + 12 + w > W - 6;
    const bx = esquerda ? m.x - m.r - 12 - w : m.x + m.r + 12;
    const by = Math.max(30, Math.min(chaoY - h - 6, m.y - h / 2));
    return { m, e, l1, l2, pips, w, h, bx, by, esquerda };
  }

  function desenharRotulos() {
    const postos = [];
    const ordem = S.meteoros.filter((m) => m.y >= -4).sort((a, b) => a.y - b.y);
    for (const m of ordem) {
      const r = medirRotulo(m);
      for (let k = 0; k < 8; k++) {
        const c = postos.find((p) => r.bx < p.bx + p.w + 4 && r.bx + r.w + 4 > p.bx && r.by < p.by + p.h + 4 && r.by + r.h + 4 > p.by);
        if (!c) break;
        r.by = c.by + c.h + 5;
      }
      postos.push(r);
      desenharRotulo(r);
    }
  }

  function desenharRotulo({ m, e, l1, l2, pips, w, h, bx, by, esquerda }) {
    const cor = COR[m.ev.classe];
    if (Math.abs(by + h / 2 - m.y) > h / 2 + 4) {
      // rótulo afastado do meteoro: liga os dois
      ctx.strokeStyle = rgba(cor, 0.45);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(m.x + (esquerda ? -m.r : m.r), m.y);
      ctx.lineTo(esquerda ? bx + w : bx, by + h / 2);
      ctx.stroke();
    }

    caixaArredondada(bx, by, w, h, 6);
    ctx.fillStyle = 'rgba(9,12,20,0.82)';
    ctx.fill();
    ctx.strokeStyle = rgba(cor, 0.55);
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `600 10px ${MONO}`;
    ctx.fillStyle = cor;
    ctx.fillText(l1, bx + 9, by + 14);
    ctx.font = `500 11.5px ${FONTE}`;
    const esperando = e && (e.espera || (m.vivo && m.real.aguardando));
    ctx.fillStyle = e ? (esperando ? COR.aprov : COR[e.a.plataforma]) : (m.reservado ? COR.texto : COR.fraco);
    ctx.fillText(l2, bx + 9, by + 29);

    for (let i = 0; i < pips; i++) {
      const p = passosDe(e)[i];
      const px = bx + 13 + i * 11;
      const py = by + 40;
      const corPasso = p.tipo === 'aprovacao' ? COR.aprov : p.tipo === 'agente' ? COR.agente : COR[e.a.plataforma];
      const feito = i < e.i || e.fim;
      const atual = i === e.i && !e.fim;
      ctx.beginPath();
      ctx.arc(px, py, atual ? 3.5 + Math.sin(S.t * 9) * 0.8 : 3, 0, TAU);
      if (feito || atual) {
        ctx.fillStyle = rgba(corPasso, feito ? 0.95 : 0.6);
        ctx.fill();
        if (atual && e.dur > 0 && !e.espera) {
          ctx.strokeStyle = corPasso;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(px, py, 5.5, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, e.t / e.dur));
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = rgba(corPasso, 0.45);
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  function desenharTiros() {
    ctx.lineCap = 'round';
    for (const t of S.tiros) {
      const r = t.rastro;
      for (let i = 0; i < r.length; i += 2) {
        const nx = i + 2 < r.length ? r[i + 2] : t.x;
        const ny = i + 2 < r.length ? r[i + 3] : t.y;
        ctx.strokeStyle = rgba(t.cor, ((i + 2) / (r.length + 2)) * 0.8);
        ctx.lineWidth = t.plat === 'ao' || t.plat === 'aap' ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(r[i], r[i + 1]);
        ctx.lineTo(nx, ny);
        ctx.stroke();
      }
      ctx.shadowColor = t.cor;
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.plat === 'ao' || t.plat === 'aap' ? (t.final ? 4.5 : 3.5) : 2.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.lineCap = 'butt';
  }

  function desenharRadar() {
    const x = S.radar.x;
    const y = chaoY;
    ctx.strokeStyle = '#3a4560';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 26);
    ctx.moveTo(x - 9, y);
    ctx.lineTo(x, y - 12);
    ctx.lineTo(x + 9, y);
    ctx.stroke();
    ctx.strokeStyle = '#9fb0cc';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x, y - 38, 13, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.fillStyle = COR.alerta;
    ctx.beginPath();
    ctx.arc(x, y - 36, 2.5, 0, TAU);
    ctx.fill();
    const ang = -Math.PI / 2 + Math.sin(S.t * 1.1) * 1.05;
    const g = ctx.createLinearGradient(x, y - 36, x + Math.cos(ang) * 46, y - 36 + Math.sin(ang) * 46);
    g.addColorStop(0, rgba(COR.alerta, 0.5));
    g.addColorStop(1, rgba(COR.alerta, 0));
    ctx.strokeStyle = g;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 36);
    ctx.lineTo(x + Math.cos(ang) * 46, y - 36 + Math.sin(ang) * 46);
    ctx.stroke();
  }

  function desenharPlantao() {
    const x = S.plantao.x;
    const y = chaoY;
    const f = S.plantao.flash;
    ctx.strokeStyle = rgba(COR.manual, 0.45 + f * 0.55);
    ctx.fillStyle = '#1a2130';
    ctx.lineWidth = 1.5;
    caixaArredondada(x - 11, y - 24, 22, 15, 2); // monitor
    ctx.fill();
    ctx.stroke();
    ctx.beginPath(); // pé e mesa
    ctx.moveTo(x, y - 9);
    ctx.lineTo(x, y - 5);
    ctx.moveTo(x - 16, y - 5);
    ctx.lineTo(x + 16, y - 5);
    ctx.moveTo(x - 13, y - 5);
    ctx.lineTo(x - 13, y);
    ctx.moveTo(x + 13, y - 5);
    ctx.lineTo(x + 13, y);
    ctx.stroke();
    ctx.fillStyle = rgba(COR.manual, 0.25 + f * 0.75);
    ctx.fillRect(x - 7, y - 20, 14, 2);
    ctx.fillRect(x - 7, y - 16, 9, 2);
  }

  function desenharEda(c) {
    const cor = S.eda ? COR.eda : COR.apagado;
    const p = pivo(c);
    ctx.fillStyle = '#1c2330';
    ctx.strokeStyle = rgba(cor, 0.8);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x - 20, chaoY);
    ctx.lineTo(c.x - 12, chaoY - 16);
    ctx.lineTo(c.x + 12, chaoY - 16);
    ctx.lineTo(c.x + 20, chaoY);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(c.ang + Math.PI / 2);
    ctx.fillStyle = rgba(cor, 0.9);
    ctx.fillRect(-8, -24, 4, 24);
    ctx.fillRect(4, -24, 4, 24);
    if (c.calor > 0) {
      ctx.shadowColor = cor;
      ctx.shadowBlur = 14;
      ctx.fillStyle = rgba('#ffffff', c.calor);
      ctx.beginPath();
      ctx.arc(0, -22, 3 + c.calor * 4, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.fillStyle = '#232b3a';
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, TAU);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = rgba(cor, 0.4 + c.calor * 0.6);
    ctx.beginPath();
    ctx.arc(0, 0, 3.5, 0, TAU);
    ctx.fill();
    ctx.restore();
  }

  function desenharAo(c) {
    if (c.sobe < 0.02) return;
    const plat = c.a.plataforma;
    const cor = S[plat] ? COR[plat] : COR.apagado;
    const p = pivo(c);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, chaoY);
    ctx.clip();

    ctx.fillStyle = '#1c2330';
    ctx.strokeStyle = rgba(cor, 0.7);
    ctx.lineWidth = 1.5;
    ctx.fillRect(c.x - 8, p.y + 6, 16, 50);
    ctx.strokeRect(c.x - 8, p.y + 6, 16, 50);

    ctx.translate(p.x, p.y);
    ctx.rotate(c.ang + Math.PI / 2);
    ctx.fillStyle = '#2a3446';
    ctx.strokeStyle = cor;
    ctx.fillRect(-4, -30, 8, 30);
    ctx.strokeRect(-4, -30, 8, 30);
    ctx.fillStyle = cor;
    ctx.fillRect(-6, -34, 12, 5);
    ctx.fillStyle = '#232b3a';
    ctx.lineWidth = 2;
    if (plat === 'aap') { // arma do Controller: corpo quadrado
      caixaArredondada(-11, -11, 22, 22, 4);
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, 12, 0, TAU);
    }
    ctx.fill();
    ctx.stroke();
    ctx.shadowColor = cor;
    ctx.shadowBlur = c.calor * 16;
    ctx.fillStyle = rgba(cor, 0.35 + c.calor * 0.65);
    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, TAU);
    ctx.fill();
    ctx.restore();

    if (c.ativos > 1) {
      ctx.font = `600 11px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillStyle = cor;
      ctx.fillText('×' + c.ativos, c.x + 17, p.y + 4);
    }
  }

  function desenharChao() {
    ctx.fillStyle = '#0b0f18';
    ctx.fillRect(-20, chaoY, W + 40, ALT_CHAO + 20);
    ctx.fillStyle = '#2a3550';
    ctx.fillRect(-20, chaoY, W + 40, 1.5);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    // vagas do EDA: regras que ainda não existem
    ctx.strokeStyle = 'rgba(138,147,166,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const x of S.vagas) ctx.strokeRect(x - 13, chaoY - 20, 26, 20);
    ctx.setLineDash([]);
    ctx.font = `400 10.5px ${FONTE}`;
    ctx.fillStyle = 'rgba(138,147,166,0.6)';
    for (const x of S.vagas) ctx.fillText('vaga', x, chaoY + 18);

    const vivo = S.modo === 'vivo';
    const edaParado = vivo && S.fontes.eda && S.fontes.eda.ok && S.fontes.eda.ativas === 0;
    ctx.fillStyle = edaParado ? COR.incidente : COR.fraco;
    ctx.fillText(edaParado ? 'EDA sem' : 'Event', S.radar.x, chaoY + 18);
    ctx.fillText(edaParado ? 'ativação' : 'Stream', S.radar.x, chaoY + 31);
    ctx.fillStyle = COR.fraco;
    if (!vivo) ctx.fillText('Plantão', S.plantao.x, chaoY + 18);

    for (const c of S.canhoes) {
      const plat = c.a.plataforma;
      const ligado = S[plat];
      const ativo = c.ativos > 0 || c.calor > 0;
      // tampa de onde o canhão sai
      ctx.fillStyle = rgba(ligado ? COR[plat] : COR.apagado, ativo ? 0.95 : 0.45);
      ctx.fillRect(c.x - 16, chaoY - 1, 32, 3);
      ctx.font = `${ativo ? 600 : 500} 10.5px ${FONTE}`;
      ctx.fillStyle = !ligado ? COR.apagado : ativo ? COR[plat] : rgba(COR.texto, 0.72);
      quebrar(c.a.nome, c.larg - 8).forEach((linha, i) => ctx.fillText(linha, c.x, chaoY + 18 + i * 13));
    }

    ctx.font = `600 9.5px ${MONO}`;
    const meio = (z) => (z[0] + z[1]) / 2;
    ctx.fillStyle = rgba(S.eda ? COR.eda : COR.apagado, 0.8);
    ctx.fillText(vivo ? 'EDA · REGRAS' : 'EVENT-DRIVEN ANSIBLE · REGRA → JOB', meio(S.zonas.eda), H - 12);
    if (S.zonas.aap) {
      ctx.fillStyle = rgba(COR.aap, 0.8);
      ctx.fillText('CONTROLLER · JOBS E WORKFLOWS', meio(S.zonas.aap), H - 12);
    }
    ctx.fillStyle = rgba(S.ao ? COR.ao : COR.apagado, 0.8);
    ctx.fillText(vivo ? 'ORCHESTRATOR · WORKFLOWS' : 'AUTOMATION ORCHESTRATOR · WORKFLOWS', meio(S.zonas.ao), H - 12);

    // evento sendo encaminhado do Event Stream até a automação
    for (const p of S.pulsos) {
      const k = Math.min(1, p.t / p.dur);
      const x = p.x0 + (p.x1 - p.x0) * k;
      const g = ctx.createLinearGradient(p.x0, 0, x, 0);
      g.addColorStop(0, rgba(p.cor, 0));
      g.addColorStop(1, rgba(p.cor, 0.9));
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(p.x0, x), chaoY - 1, Math.abs(x - p.x0), 3);
      ctx.shadowColor = p.cor;
      ctx.shadowBlur = 12;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, chaoY + 0.5, 3.5, 0, TAU);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  function desenharEfeitos() {
    for (const p of S.parts) {
      const a = Math.max(0, p.vida / p.max);
      if (p.pedra) {
        ctx.fillStyle = `rgba(42,47,60,${a})`;
        ctx.strokeStyle = rgba(p.cor, a);
        ctx.lineWidth = 1;
        ctx.fillRect(p.x - p.tam / 2, p.y - p.tam / 2, p.tam, p.tam);
        ctx.strokeRect(p.x - p.tam / 2, p.y - p.tam / 2, p.tam, p.tam);
      } else {
        ctx.strokeStyle = p.cor === '#ffffff' ? `rgba(255,255,255,${a})` : rgba(p.cor, a);
        ctx.lineWidth = p.tam;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
        ctx.stroke();
      }
    }
    for (const a of S.aneis) {
      ctx.strokeStyle = rgba(a.cor, Math.max(0, a.vida / a.max) * 0.8);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, TAU);
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.font = `600 12px ${MONO}`;
    for (const f of S.textos) {
      ctx.fillStyle = rgba(f.cor, Math.min(1, f.vida / 0.5));
      ctx.fillText(f.txt, f.x, f.y);
    }
  }

  function desenhar() {
    ctx.save();
    if (S.tremor > 0 && !menosMovimento) ctx.translate(rand(-1, 1) * S.tremor * 6, rand(-1, 1) * S.tremor * 6);

    desenharFundo();
    for (const m of S.meteoros) desenharMeteoro(m);
    desenharTiros();
    desenharRadar();
    if (S.modo !== 'vivo') desenharPlantao();
    for (const c of S.canhoes) (c.a.plataforma === 'eda' ? desenharEda : desenharAo)(c);
    desenharChao();
    desenharEfeitos();
    desenharRotulos();

    let aviso = '';
    if (S.modo === 'vivo') {
      if (!S.meteoros.length) {
        aviso = S.temFontes
          ? 'Céu limpo: nenhuma automação rodando agora.'
          : 'Sem credenciais do AAP ou do Orchestrator: nada para mostrar ao vivo.';
      }
    } else if (S.n.eventos === 0) {
      aviso = 'Céu limpo. Provoque um caso nos botões abaixo — ou ligue a Chuva.';
    }
    if (aviso) {
      ctx.textAlign = 'center';
      ctx.font = `500 15px ${FONTE}`;
      ctx.fillStyle = rgba(COR.texto, S.modo === 'vivo' ? 0.45 : 0.7);
      ctx.fillText(aviso, W / 2, chaoY * 0.45);
    }
    if (S.saude < 45) {
      const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.3, W / 2, H / 2, H * 0.85);
      g.addColorStop(0, 'rgba(255,60,50,0)');
      g.addColorStop(1, `rgba(255,60,50,${((45 - S.saude) / 45) * 0.35})`);
      ctx.fillStyle = g;
      ctx.fillRect(-20, -20, W + 40, H + 40);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ placar e controles

  const el = {
    nEventos: $('#nEventos'), nEda: $('#nEda'), tEda: $('#tEda'), nAo: $('#nAo'), tAo: $('#tAo'),
    nAap: $('#nAap'), tAap: $('#tAap'), fontes: $('#fontes'), dtNaoAuto: $('#dtNaoAuto'), dtAuto: $('#dtAuto'),
    nAcoes: $('#nAcoes'), nNaoAuto: $('#nNaoAuto'), nImpactos: $('#nImpactos'), pAuto: $('#pAuto'),
    cobertura: $('#cobertura'),
    saudeBarra: $('#saudeBarra'), saudeValor: $('#saudeValor'),
    aprovar: $('#aprovar'), pausado: $('#pausado'), aoVivo: $('#aoVivo'),
  };

  // Quadro "onde ganhamos, onde perdemos": uma linha por tipo de evento que já apareceu.
  function desenharCobertura() {
    if (!S.coberturaSuja) return;
    S.coberturaSuja = false;
    const ordem = (t) => {
      const i = CAT.eventos.findIndex((e) => e.id === t.id);
      return i < 0 ? 999 : i;
    };
    const vivo = S.modo === 'vivo';
    const itens = vivo
      ? [...S.porTipo.values()].sort((a, b) => (b.auto + b.perdido) - (a.auto + a.perdido)).slice(0, 9)
      : [...S.porTipo.values()].sort((a, b) => ordem(a) - ordem(b));
    if (!itens.length) {
      const vazio = document.createElement('li');
      vazio.className = 'vazio';
      vazio.textContent = vivo ? 'Nenhuma execução recente.' : 'Ainda sem eventos resolvidos.';
      el.cobertura.replaceChildren(vazio);
      return;
    }
    el.cobertura.replaceChildren(...itens.map((t) => {
      const li = document.createElement('li');
      const linha = document.createElement('div');
      linha.className = 'linha';
      const nome = document.createElement('span');
      nome.className = 'nome';
      nome.textContent = t.rotulo;
      nome.title = t.id;
      const conta = document.createElement('span');
      conta.className = 'conta';
      const g = document.createElement('b');
      g.className = t.plat || 'nada';
      g.textContent = t.auto;
      const pd = document.createElement('b');
      pd.className = 'perdido';
      pd.textContent = t.perdido;
      conta.append(g, vivo ? ' ok · ' : ' auto · ', pd, vivo ? ' falha' : ' não');
      linha.append(nome, conta);
      const barra = document.createElement('div');
      barra.className = 'barra';
      const total = t.auto + t.perdido;
      const ganho = document.createElement('i');
      ganho.className = t.plat || 'nada';
      ganho.style.width = (t.auto / total) * 100 + '%';
      const perda = document.createElement('i');
      perda.className = 'perdido';
      perda.style.width = (t.perdido / total) * 100 + '%';
      barra.append(ganho, perda);
      li.append(linha, barra);
      return li;
    }));
  }

  // Indicador de cada fonte ao vivo: respondendo, com erro ou ainda sem resposta.
  function desenharFontes() {
    const nomes = { aap: 'AAP', eda: 'EDA', ao: 'Orchestrator' };
    el.fontes.replaceChildren(...Object.keys(nomes).filter((k) => S.fontes[k]).map((k) => {
      const f = S.fontes[k];
      const chip = document.createElement('span');
      chip.className = 'fonte ' + (f.ok ? 'ok' : f.ok === false ? 'erro' : 'espera');
      chip.textContent = nomes[k] + (k === 'eda' && f.ok ? ` ${f.ativas}/${f.total}` : '');
      chip.title = f.ok === false ? f.erro
        : k === 'eda' && f.ok ? `${f.ativas} de ${f.total} rulebook activations rodando`
          : f.ok ? 'respondendo' : 'aguardando a primeira resposta';
      return chip;
    }));
    el.aoVivo.hidden = !(S.conectado && S.modo === 'vivo');
  }

  function aplicarRotulosDoModo() {
    const vivo = S.modo === 'vivo';
    el.dtNaoAuto.textContent = vivo ? 'Falhas' : 'Não automatizados';
    el.dtAuto.textContent = vivo ? 'Sucesso' : 'Automático';
    $('#btModo').setAttribute('aria-pressed', String(vivo));
    $('#btChuva').setAttribute('aria-pressed', String(S.chuva));
    S.coberturaSuja = true;
    desenharFontes();
  }

  function placar() {
    const n = S.n;
    el.nEventos.textContent = n.eventos;
    el.nEda.textContent = n.eda;
    const media = (soma, qtd) => (qtd ? 'média ' + fmtTempo(soma / qtd) : '–');
    el.tEda.textContent = media(n.tEda, n.eda);
    el.nAap.textContent = n.aap;
    el.tAap.textContent = media(n.tAap, n.aap);
    el.nAo.textContent = n.ao;
    el.tAo.textContent = media(n.tAo, n.ao);
    el.nAcoes.textContent = n.acoes;
    el.nNaoAuto.textContent = n.manual + n.impactos;
    el.nImpactos.textContent = n.impactos === 1 ? '1 impacto' : `${n.impactos} impactos`;
    desenharCobertura();
    const total = n.eda + n.aap + n.ao + n.manual + n.impactos;
    el.pAuto.textContent = total ? Math.round(((n.eda + n.aap + n.ao) / total) * 100) + '%' : '–';
    el.saudeValor.textContent = Math.round(S.saude);
    el.saudeBarra.style.width = S.saude + '%';
    el.saudeBarra.style.backgroundColor = S.saude > 60 ? COR.eda : S.saude > 30 ? COR.alerta : COR.incidente;

    const fila = pendentes();
    el.aprovar.hidden = fila.length === 0;
    if (fila.length) {
      const m = fila[0];
      el.aprovar.textContent = `${passosDe(m.exec)[m.exec.i].nome} · ${m.host} — Enter` + (fila.length > 1 ? ` (+${fila.length - 1})` : '');
    }
    el.pausado.hidden = !S.pausa;
  }

  function chave(botao, prop, aoMudar) {
    const aplicar = () => botao.setAttribute('aria-pressed', String(S[prop]));
    const alternar = () => {
      S[prop] = !S[prop];
      aplicar();
      if (aoMudar) aoMudar();
    };
    botao.addEventListener('click', () => { alternar(); botao.blur(); });
    aplicar();
    return alternar;
  }

  const alternar = {
    e: chave($('#btEda'), 'eda'),
    o: chave($('#btAo'), 'ao'),
    m: chave($('#btAprov'), 'aprovManual', () => { if (!S.aprovManual) pendentes().forEach(aprovar); }),
    a: chave($('#btChuva'), 'chuva', () => { S.proxChuva = 0.3; }),
    ' ': chave($('#btPausa'), 'pausa'),
  };

  function limpar() {
    S.meteoros.forEach((m) => { m.morto = true; });
    S.reais.clear();
    S.meteoros = [];
    S.tiros = [];
    S.parts = [];
    S.aneis = [];
    S.pulsos = [];
    S.textos = [];
    S.canhoes.forEach((c) => { c.ativos = 0; c.alvo = null; c.ocioso = 99; });
    S.saude = 100;
    zerarPlacar();
    S.porTipo.clear();
    S.coberturaSuja = true;
    logEl.replaceChildren();
  }

  // Ao vivo, zerar é ressincronizar: o placar volta a refletir o que o servidor conhece.
  function zerar() {
    limpar();
    if (S.modo === 'vivo') {
      S.vistas.clear();
      recarregarVivo();
    }
  }
  $('#btModo').addEventListener('click', (e) => {
    S.modoFixo = true;
    definirModo(S.modo === 'vivo' ? 'simulacao' : 'vivo');
    e.currentTarget.blur();
  });
  $('#btZerar').addEventListener('click', (e) => { zerar(); e.currentTarget.blur(); });

  $('#intensidade').addEventListener('input', (e) => { S.intensidade = Number(e.target.value); });
  el.aprovar.addEventListener('click', () => aprovar());

  const lancadores = $('#lancadores');
  CAT.eventos.forEach((ev, i) => {
    const a = automacaoDe(ev);
    const b = document.createElement('button');
    b.className = 'lancar';
    b.style.setProperty('--cor', COR[ev.classe]);
    b.title = `${NOME_CLASSE[ev.classe]} ${ev.id} → ${a ? a.nome : 'sem automação'}`;
    const k = document.createElement('kbd');
    k.textContent = i + 1;
    const ponto = document.createElement('i');
    const etiqueta = document.createElement('small');
    etiqueta.textContent = a ? (a.plataforma === 'eda' ? 'EDA' : 'AO') : '—';
    if (a) etiqueta.className = a.plataforma;
    b.append(k, ponto, document.createTextNode(ev.acao || ev.rotulo), etiqueta);
    b.addEventListener('click', () => { lancar(ev); b.blur(); });
    lancadores.append(b);
  });

  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const k = e.key.toLowerCase();
    const vivo = S.modo === 'vivo';
    if (k === 'v') {
      $('#btModo').click();
    } else if (k >= '1' && k <= '9') {
      const ev = CAT.eventos[Number(k) - 1];
      if (ev && !vivo) lancar(ev);
    } else if (alternar[k]) {
      e.preventDefault();
      if (!vivo || k === ' ') alternar[k](); // ao vivo só a pausa faz sentido
    } else if (k === 'enter') {
      e.preventDefault();
      aprovar();
    } else if (k === 'r') {
      zerar();
    }
  });

  // Clique num meteoro: aprova (se estiver esperando) ou age como plantão.
  canvas.addEventListener('pointerdown', (e) => {
    const b = canvas.getBoundingClientRect();
    const x = e.clientX - b.left;
    const y = e.clientY - b.top;
    let alvo = null;
    let melhor = Infinity;
    for (const m of S.meteoros) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d < m.r + 18 && d < melhor) { alvo = m; melhor = d; }
    }
    if (!alvo || alvo.vivo) return; // ao vivo é só leitura: clique não age sobre o job
    if (alvo.exec && alvo.exec.espera) { aprovar(alvo); return; }
    if (alvo.exec || alvo.reservado || alvo.cliques >= alvo.vida) return;
    alvo.cliques++;
    S.n.acoes++;
    S.plantao.flash = 1;
    S.tiros.push({ x: S.plantao.x, y: chaoY - 24, m: alvo, v: 820, cor: COR.manual, plat: 'manual', final: false, rastro: [] });
  });

  // ------------------------------------------------------------------ ponte com o servidor

  // Mensagens com "canal" vêm do coletor; sem "canal" é um meteoro simulado enviado por POST.
  function receber(p) {
    if (!p || typeof p !== 'object') return;
    if (p.canal === 'snapshot') { aplicarSnapshot(p); return; }
    if (p.canal === 'ocorrencia') { if (p.o && p.o.id) aplicarOcorrencia(p.o, false, true); return; }
    if (p.canal === 'fontes') { S.fontes = p.fontes || {}; desenharFontes(); return; }
    if (p.canal || S.modo === 'vivo') return;
    const tipo = p.tipo || p.alertname;
    if (tipo) lancarPorNome(tipo, p.host || p.instance, p.classe);
  }

  if (location.protocol.startsWith('http') && 'EventSource' in window) {
    const fonte = new EventSource('api/stream');
    let abriu = false;
    fonte.onopen = () => { abriu = true; S.conectado = true; desenharFontes(); };
    fonte.onmessage = (ev) => {
      try { receber(JSON.parse(ev.data)); } catch (_) { /* mensagem inválida: ignora */ }
    };
    fonte.onerror = () => {
      S.conectado = false;
      desenharFontes();
      if (!abriu) fonte.close(); // servido sem o server.py: segue só com a simulação
    };
  }

  // ------------------------------------------------------------------ laço

  window.egd = {
    lancar: (tipo, host) => lancarPorNome(tipo, host),
    aprovar: () => aprovar(),
    modo: (m) => { S.modoFixo = true; definirModo(m); },
    receber,
    passo: (dt) => { atualizar(dt); desenhar(); placar(); },
    estado: S,
  };

  new ResizeObserver(layout).observe(canvas.parentElement);
  layout();
  aplicarRotulosDoModo();

  let ultimo = performance.now();
  let proxPlacar = 0;
  function quadro(agora) {
    const dt = Math.min(0.05, (agora - ultimo) / 1000);
    ultimo = agora;
    if (!S.pausa) atualizar(dt);
    desenhar();
    if (agora >= proxPlacar) {
      placar();
      proxPlacar = agora + 150;
    }
    requestAnimationFrame(quadro);
  }
  requestAnimationFrame(quadro);
})();
