/*
 * Catálogo do jogo: o que cai do céu (eventos) e o que responde no chão (automações).
 * Edite aqui para trocar nomes, tempos e cobertura — o jogo não tem nada disso fixo no código.
 *
 * Este catálogo espelha o lab do CRC (levantado em 2026-11-13):
 *  - alertnames: regras do Prometheus em lab-apoio (ConfigMap prometheus-rules)
 *  - regras do EDA: rulebook jornada_selfheal.yml (activation EDA-AIOPS-SELFHEAL) e a
 *    activation "MW - Restart por alerta"
 *  - job templates: os que existem no AAP do CRC
 *  - workflows do Orchestrator: os descritos em crc-install/lab-apoio/06-casos-de-uso.md.
 *    As etapas foram resumidas; os nomes dos agentes do workflow de chamado são aproximados.
 *
 * Tipos de passo: regra | job | agente | aprovacao | loop
 *   - o ÚLTIMO passo precisa atirar (job ou loop): é o tiro dele que destrói o meteoro.
 */
window.CATALOGO = {
  /*
   * Quanto dura cada tipo de etapa, em segundos. É o que define o tempo de resolução:
   * regra do EDA ≈ 10 s (regra + jobEda), workflow do Orchestrator ≈ 15 a 20 s (soma das etapas).
   * Uma etapa pode ter duração própria com o campo "dur". A "queda" de cada evento (mais abaixo)
   * precisa ser bem maior que isso, senão o meteoro chega ao chão antes do fim.
   */
  tempos: { regra: 1, jobEda: 8, job: 3, agente: 4.5, aprovacao: 3, loop: 4 },

  automacoes: [
    // ---------- Event-Driven Ansible: evento -> regra -> job template ----------
    {
      id: 'eda-selfheal',
      plataforma: 'eda',
      nome: 'AIOPS-REMEDIATE-SERVICE',
      regra: 'Portal da Parasol fora do ar', // cada evento pode trocar a regra (campo "regra")
    },
    {
      id: 'eda-mw-restart',
      plataforma: 'eda',
      nome: 'MW - Reiniciar WildFly',
      regra: 'MW - Restart por alerta',
    },

    // ---------- Automation Orchestrator: workflows ----------
    {
      id: 'ao-disk-ia',
      plataforma: 'ao',
      nome: 'Disk remediation com IA (alerta)',
      passos: [
        { tipo: 'job', nome: 'Disk - Diagnóstico' },
        { tipo: 'agente', nome: 'Agente - Analisar o disco' },
        { tipo: 'aprovacao', nome: 'Aprovar expansão' },
        { tipo: 'job', nome: 'Disk - Remediar' },
      ],
    },
    {
      id: 'ao-incidente-lean',
      plataforma: 'ao',
      nome: 'Incidente - solução com IA (lean)',
      passos: [
        { tipo: 'job', nome: 'Incidente - Intake', dur: 2 },
        { tipo: 'job', nome: 'Incidente - Evidências e conhecimento' },
        { tipo: 'agente', nome: 'Agente - Diagnóstico' },
        { tipo: 'job', nome: 'Incidente - Juiz', dur: 2 },
        { tipo: 'aprovacao', nome: 'Aprovar a remediação' },
        { tipo: 'job', nome: 'Apache - Remediar' },
      ],
    },
    {
      id: 'ao-ticket-triagem',
      plataforma: 'ao',
      nome: 'Ticket - triagem e enriquecimento',
      desfecho: 'triado', // este workflow não corrige: classifica, reúne evidências e encaminha
      passos: [
        { tipo: 'agente', nome: 'Agente - Classificar o relato' },
        { tipo: 'job', nome: 'Ticket - Atualizar chamado', dur: 1.5 },
        { tipo: 'job', nome: 'Ticket - Coletar aplicação' },
        { tipo: 'job', nome: 'Ticket - Reunir evidências' },
        { tipo: 'agente', nome: 'Agente - Relator' },
        { tipo: 'job', nome: 'Ticket - Atualizar chamado', dur: 1.5 },
      ],
    },
  ],

  /*
   * classe: alerta | incidente | demanda (muda a cor do meteoro)
   * acao:   texto do botão — o que você "faz" para provocar o evento
   * queda:  segundos do topo até o chão      raio: tamanho
   * peso:   frequência na chuva automática   cliques: ações manuais para derrubar sem automação
   * dano:   quanto o impacto tira da saúde do ambiente
   */
  eventos: [
    {
      id: 'ParasolPortalForaDoAr',
      rotulo: 'Parasol fora do ar',
      acao: 'Derrubar Parasol', // no lab: job template AIOPS-SIMULATE-INCIDENT
      classe: 'alerta',
      automacao: 'eda-selfheal',
      hosts: ['server01'],
      queda: 22, raio: 17, peso: 4, cliques: 4, dano: 14,
    },
    {
      id: 'FirewallParado',
      rotulo: 'Firewall parado',
      acao: 'Parar firewall',
      classe: 'alerta',
      automacao: 'eda-selfheal',
      regra: 'Firewall parado',
      hosts: ['server01'],
      queda: 22, raio: 14, peso: 3, cliques: 4, dano: 10,
    },
    {
      id: 'MwServicoForaDoAr',
      rotulo: 'WildFly fora do ar',
      acao: 'Derrubar WildFly', // no lab: MW - Simular queda do serviço
      classe: 'alerta',
      automacao: 'eda-mw-restart',
      hosts: ['server07'],
      queda: 23, raio: 16, peso: 3, cliques: 4, dano: 12,
    },
    {
      id: 'DiscoLabAcimaDoLimite',
      rotulo: 'Disco cheio',
      acao: 'Encher disco', // no lab: Disk - Encher disco
      classe: 'alerta',
      automacao: 'ao-disk-ia',
      hosts: ['server07'],
      queda: 30, raio: 23, peso: 2, cliques: 6, dano: 16,
    },
    {
      id: 'ApacheDown',
      rotulo: 'Apache fora do ar',
      acao: 'Parar Apache', // no lab: Apache - Simular incidente
      classe: 'incidente', // o rulebook transforma o alerta em incidente e entrega ao AO
      automacao: 'ao-incidente-lean',
      hosts: ['server07'],
      queda: 36, raio: 25, peso: 2, cliques: 7, dano: 20,
    },
    {
      id: 'ticket-novo', // webhook do workflow de triagem
      rotulo: 'Chamado de usuário',
      acao: 'Abrir chamado', // no lab: Ticket - Abrir chamado
      classe: 'demanda',
      automacao: 'ao-ticket-triagem',
      hosts: ['server07'],
      queda: 36, raio: 22, peso: 2, cliques: 6, dano: 12,
    },
    {
      id: 'SELinuxDisabled', // o alerta existe no Prometheus; nenhuma regra ou workflow corrige
      rotulo: 'SELinux desligado',
      acao: 'Desligar SELinux',
      classe: 'alerta',
      automacao: null,
      hosts: ['server01', 'server02', 'server03'],
      queda: 22, raio: 17, peso: 1, cliques: 5, dano: 12,
    },
    {
      id: 'HighCPUUsage', // idem: alerta real, sem regra nem workflow que corrija
      rotulo: 'CPU alta',
      acao: 'Estressar CPU', // no lab: Ticket - Simular sintoma (cpu)
      classe: 'alerta',
      automacao: null,
      hosts: ['server07'],
      queda: 24, raio: 19, peso: 1, cliques: 5, dano: 12,
    },
  ],
};
