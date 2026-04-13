export type StatusEvento = 'aberto' | 'finalizado' | 'pausado' | 'cancelado';

export interface StatusEventoRegistro {
  id: string;
  nome: string;
  justificativa: string | null;
}

interface EventoStatusInput {
  status?: StatusEventoRegistro | null;
  data_maxima_inscricao?: Date | string | null;
  limite_inscricoes?: number | null;
  quantidadeParticipantes?: number | null;
  data_fim?: Date | string | null;
}

const DEFAULT_PAUSA_JUSTIFICATIVA = 'Este evento está pausado temporariamente.';
const DEFAULT_CANCELAMENTO_JUSTIFICATIVA = 'Este evento foi cancelado.';
const DEFAULT_FINALIZADO_JUSTIFICATIVA = 'As inscrições para este evento foram encerradas.';

const parseDate = (value?: Date | string | null) => {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizarNomeStatus = (nome?: string | null): StatusEvento | null => {
  const statusNormalizado = nome?.trim().toLowerCase();

  if (statusNormalizado === 'aberto' || statusNormalizado === 'finalizado' || statusNormalizado === 'pausado' || statusNormalizado === 'cancelado') {
    return statusNormalizado;
  }

  return null;
};

const formatarJustificativasFinalizacao = (evento: EventoStatusInput) => {
  const motivos: string[] = [];
  const agora = new Date();
  const dataMaximaInscricao = parseDate(evento.data_maxima_inscricao);
  const dataFim = parseDate(evento.data_fim);

  if (dataMaximaInscricao && agora >= dataMaximaInscricao) {
    motivos.push('a data máxima de inscrição foi atingida');
  }

  if (typeof evento.limite_inscricoes === 'number' && evento.limite_inscricoes > 0 && (evento.quantidadeParticipantes ?? 0) >= evento.limite_inscricoes) {
    motivos.push('o limite de inscrições foi atingido');
  }

  if (dataFim && agora >= dataFim) {
    motivos.push('o evento já aconteceu');
  }

  if (motivos.length === 0) {
    return DEFAULT_FINALIZADO_JUSTIFICATIVA;
  }

  if (motivos.length === 1) {
    return `As inscrições foram encerradas porque ${motivos[0]}.`;
  }

  const ultimoMotivo = motivos.pop();
  return `As inscrições foram encerradas porque ${motivos.join(', ')} e ${ultimoMotivo}.`;
};

export const calcularStatusEvento = (evento: EventoStatusInput): StatusEvento => {
  const statusAtual = normalizarNomeStatus(evento.status?.nome);

  if (statusAtual === 'pausado' || statusAtual === 'cancelado' || statusAtual === 'finalizado') {
    return statusAtual;
  }

  const agora = new Date();
  const dataMaximaInscricao = parseDate(evento.data_maxima_inscricao);
  const dataFim = parseDate(evento.data_fim);
  const limiteInscricoes = evento.limite_inscricoes;
  const quantidadeParticipantes = evento.quantidadeParticipantes ?? 0;

  if (dataMaximaInscricao && agora >= dataMaximaInscricao) {
    return 'finalizado';
  }

  if (typeof limiteInscricoes === 'number' && limiteInscricoes > 0 && quantidadeParticipantes >= limiteInscricoes) {
    return 'finalizado';
  }

  if (dataFim && agora >= dataFim) {
    return 'finalizado';
  }

  return 'aberto';
};

export const serializarStatusEvento = (evento: EventoStatusInput): StatusEventoRegistro => {
  const statusCalculado = calcularStatusEvento(evento);

  if (statusCalculado === 'pausado') {
    return {
      id: evento.status?.id ?? '',
      nome: 'pausado',
      justificativa: evento.status?.justificativa?.trim() || DEFAULT_PAUSA_JUSTIFICATIVA,
    };
  }

  if (statusCalculado === 'cancelado') {
    return {
      id: evento.status?.id ?? '',
      nome: 'cancelado',
      justificativa: evento.status?.justificativa?.trim() || DEFAULT_CANCELAMENTO_JUSTIFICATIVA,
    };
  }

  if (statusCalculado === 'finalizado') {
    return {
      id: evento.status?.id ?? '',
      nome: 'finalizado',
      justificativa: formatarJustificativasFinalizacao(evento),
    };
  }

  return {
    id: evento.status?.id ?? '',
    nome: 'aberto',
    justificativa: evento.status?.justificativa?.trim() || null,
  };
};

export const obterJustificativaStatus = (evento: EventoStatusInput) => serializarStatusEvento(evento).justificativa;
