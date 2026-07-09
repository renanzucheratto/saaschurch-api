import 'dotenv/config';
import crypto from 'node:crypto';

const ALGORITMO = 'aes-256-gcm';
const TAMANHO_IV = 12;
const TAMANHO_CHAVE = 32;

/**
 * Cifra de tokens OAuth em repouso (SPEC-BE-002).
 *
 * Formato armazenado: `iv:authTag:ciphertext`, cada segmento em base64.
 * Nunca logue o texto claro, nem truncado.
 */
export function obterChave(): Buffer {
  const hex = process.env.MP_TOKEN_ENCRYPTION_KEY;

  if (!hex) {
    throw new Error('MP_TOKEN_ENCRYPTION_KEY não configurada. Gere com: openssl rand -hex 32');
  }

  const chave = Buffer.from(hex, 'hex');

  if (chave.length !== TAMANHO_CHAVE) {
    throw new Error(
      `MP_TOKEN_ENCRYPTION_KEY deve ter ${TAMANHO_CHAVE} bytes (${TAMANHO_CHAVE * 2} chars hex)`,
    );
  }

  return chave;
}

export function cifrar(textoClaro: string, chave: Buffer = obterChave()): string {
  const iv = crypto.randomBytes(TAMANHO_IV);
  const cipher = crypto.createCipheriv(ALGORITMO, chave, iv);

  const cifrado = Buffer.concat([cipher.update(textoClaro, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv.toString('base64'), authTag.toString('base64'), cifrado.toString('base64')].join(':');
}

export function decifrar(armazenado: string, chave: Buffer = obterChave()): string {
  const segmentos = armazenado.split(':');

  if (segmentos.length !== 3) {
    throw new Error('Formato inválido: esperado iv:authTag:ciphertext');
  }

  const [ivB64, authTagB64, cifradoB64] = segmentos;

  const decipher = crypto.createDecipheriv(ALGORITMO, chave, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(cifradoB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
