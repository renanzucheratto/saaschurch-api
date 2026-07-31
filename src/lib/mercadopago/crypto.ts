import crypto from 'crypto';

/**
 * Cifragem dos tokens OAuth das instituições em repouso.
 *
 * AES-256-GCM: além de cifrar, autentica — um ciphertext adulterado falha na
 * verificação da authTag em vez de decifrar em lixo silencioso.
 *
 * Formato serializado: base64(iv):base64(authTag):base64(ciphertext)
 */

const ALGORITMO = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM
const CHAVE_BYTES = 32; // AES-256

let chaveCache: Buffer | null = null;

function getChave(): Buffer {
  if (chaveCache) return chaveCache;

  const bruta = process.env.MP_TOKEN_ENCRYPTION_KEY;

  if (!bruta) {
    throw new Error(
      'MP_TOKEN_ENCRYPTION_KEY não configurada. Gere com: openssl rand -base64 32',
    );
  }

  const chave = Buffer.from(bruta, 'base64');

  if (chave.length !== CHAVE_BYTES) {
    throw new Error(
      `MP_TOKEN_ENCRYPTION_KEY inválida: esperados ${CHAVE_BYTES} bytes em base64, recebidos ${chave.length}. Gere com: openssl rand -base64 32`,
    );
  }

  chaveCache = chave;
  return chave;
}

export function encryptToken(textoPlano: string): string {
  if (!textoPlano) {
    throw new Error('encryptToken: valor vazio');
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITMO, getChave(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(textoPlano, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptToken(valorCifrado: string): string {
  if (!valorCifrado) {
    throw new Error('decryptToken: valor vazio');
  }

  const partes = valorCifrado.split(':');

  if (partes.length !== 3) {
    throw new Error('decryptToken: formato inválido');
  }

  const [ivB64, authTagB64, ciphertextB64] = partes as [string, string, string];

  const decipher = crypto.createDecipheriv(
    ALGORITMO,
    getChave(),
    Buffer.from(ivB64, 'base64'),
  );

  decipher.setAuthTag(Buffer.from(authTagB64, 'base64'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Valida a configuração de cifragem no boot, para o erro aparecer no start
 * e não no meio de um fluxo OAuth de um usuário real.
 */
export function validarChaveCifragem(): void {
  getChave();
}
