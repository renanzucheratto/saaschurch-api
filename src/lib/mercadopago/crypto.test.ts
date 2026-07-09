import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cifrar, decifrar } from './crypto.js';

const CHAVE = crypto.randomBytes(32);

describe('cifra de tokens em repouso', () => {
  it('faz round-trip do texto claro', () => {
    const token = 'APP_USR-1234567890-abcdef';

    expect(decifrar(cifrar(token, CHAVE), CHAVE)).toBe(token);
  });

  it('nunca armazena o texto claro', () => {
    const token = 'APP_USR-segredo';
    const armazenado = cifrar(token, CHAVE);

    expect(armazenado).not.toContain(token);
  });

  it('usa o formato iv:authTag:ciphertext', () => {
    expect(cifrar('x', CHAVE).split(':')).toHaveLength(3);
  });

  it('gera ciphertext diferente a cada chamada (IV aleatório)', () => {
    expect(cifrar('mesmo-token', CHAVE)).not.toBe(cifrar('mesmo-token', CHAVE));
  });

  it('rejeita ciphertext adulterado', () => {
    const [iv, authTag, cifrado] = cifrar('token', CHAVE).split(':');
    const adulterado = Buffer.from(cifrado, 'base64');
    adulterado[0] ^= 0xff;

    expect(() =>
      decifrar([iv, authTag, adulterado.toString('base64')].join(':'), CHAVE),
    ).toThrow();
  });

  it('rejeita decifra com chave errada', () => {
    const armazenado = cifrar('token', CHAVE);

    expect(() => decifrar(armazenado, crypto.randomBytes(32))).toThrow();
  });

  it('rejeita formato inválido', () => {
    expect(() => decifrar('sem-separadores', CHAVE)).toThrow(/Formato inválido/);
  });
});
