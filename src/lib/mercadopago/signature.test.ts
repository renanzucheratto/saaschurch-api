import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { montarManifesto, parseXSignature, validarAssinatura } from './signature.js';

const SEGREDO = 'segredo-de-teste';
const AGORA = 1_704_908_010_000;
const TS = String(AGORA / 1000);

function assinar(manifesto: string): string {
  return crypto.createHmac('sha256', SEGREDO).update(manifesto).digest('hex');
}

function headerValido(dataId: string, requestId: string, ts = TS): string {
  return `ts=${ts},v1=${assinar(montarManifesto(dataId, requestId, ts))}`;
}

describe('parseXSignature', () => {
  it('extrai ts e v1', () => {
    expect(parseXSignature('ts=123,v1=abc')).toEqual({ ts: '123', v1: 'abc' });
  });

  it('devolve null sem v1', () => {
    expect(parseXSignature('ts=123')).toBeNull();
  });

  it('devolve null para header ausente', () => {
    expect(parseXSignature(undefined)).toBeNull();
  });
});

describe('montarManifesto', () => {
  it('segue a ordem e a pontuação do MP', () => {
    expect(montarManifesto('123', 'req-1', '999')).toBe('id:123;request-id:req-1;ts:999;');
  });

  it('omite o campo ausente junto do separador', () => {
    expect(montarManifesto(undefined, 'req-1', '999')).toBe('request-id:req-1;ts:999;');
    expect(montarManifesto('123', undefined, '999')).toBe('id:123;ts:999;');
  });

  it('baixa para minúsculas quando o data.id é alfanumérico', () => {
    expect(montarManifesto('AbC123xyz', 'r', '1')).toBe('id:abc123xyz;request-id:r;ts:1;');
  });

  it('preserva o data.id puramente numérico', () => {
    expect(montarManifesto('1234567890', 'r', '1')).toBe('id:1234567890;request-id:r;ts:1;');
  });
});

describe('validarAssinatura', () => {
  const base = { dataId: '123', xRequestId: 'req-1', segredo: SEGREDO, agora: AGORA };

  it('aceita assinatura correta dentro da janela', () => {
    const resultado = validarAssinatura({ ...base, xSignature: headerValido('123', 'req-1') });

    expect(resultado.valido).toBe(true);
  });

  it('rejeita v1 incorreto', () => {
    const resultado = validarAssinatura({ ...base, xSignature: `ts=${TS},v1=${'0'.repeat(64)}` });

    expect(resultado).toEqual({ valido: false, motivo: 'assinatura não confere' });
  });

  it('rejeita ts de 10 minutos atrás (anti-replay)', () => {
    const tsAntigo = String(AGORA / 1000 - 600);
    const resultado = validarAssinatura({
      ...base,
      xSignature: headerValido('123', 'req-1', tsAntigo),
    });

    expect(resultado).toEqual({ valido: false, motivo: 'ts fora da janela de 5 minutos' });
  });

  it('rejeita header ausente', () => {
    const resultado = validarAssinatura({ ...base, xSignature: undefined });

    expect(resultado).toEqual({ valido: false, motivo: 'x-signature ausente ou malformado' });
  });

  it('rejeita quando o segredo não está configurado', () => {
    const resultado = validarAssinatura({ ...base, segredo: '', xSignature: 'ts=1,v1=a' });

    expect(resultado.valido).toBe(false);
  });

  it('não confere quando o data.id do manifesto diverge', () => {
    // O manifesto assinado usou 999; a validação recebe o query param 123.
    const resultado = validarAssinatura({ ...base, xSignature: headerValido('999', 'req-1') });

    expect(resultado.valido).toBe(false);
  });

  it('não estoura com v1 de tamanho diferente do esperado', () => {
    const resultado = validarAssinatura({ ...base, xSignature: `ts=${TS},v1=abc` });

    expect(resultado.valido).toBe(false);
  });
});
