import { supabaseAdmin } from './auth.js';

const BUCKET = 'projetos-anexos';
const LOGO_BUCKET = 'institution_assets';

let bucketEnsured = false;

// Garante que o bucket exista (idempotente). Cria como público para permitir
// download direto dos anexos via URL pública.
async function ensureBucket(): Promise<void> {
  if (bucketEnsured) return;

  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === BUCKET);

  if (!exists) {
    const { error } = await supabaseAdmin.storage.createBucket(BUCKET, {
      public: true,
    });
    // Ignora erro de "já existe" em caso de corrida
    if (error && !/already exists/i.test(error.message)) {
      throw error;
    }
  }

  bucketEnsured = true;
}

export interface UploadedFile {
  url: string;
  path: string;
}

export async function uploadAnexo(
  instituicaoId: string,
  projetoId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string },
): Promise<UploadedFile> {
  await ensureBucket();

  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${instituicaoId}/${projetoId}/${Date.now()}-${safeName}`;

  const { error } = await supabaseAdmin.storage.from(BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: false,
  });

  if (error) {
    throw error;
  }

  const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);

  return { url: data.publicUrl, path };
}

// Extrai o path do objeto a partir da URL pública para permitir remoção
export function extrairPathDaUrl(url: string): string | null {
  const marker = `/object/public/${BUCKET}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  return decodeURIComponent(url.substring(idx + marker.length));
}

export async function removerAnexo(url: string): Promise<void> {
  const path = extrairPathDaUrl(url);
  if (!path) return;
  await supabaseAdmin.storage.from(BUCKET).remove([path]);
}

// ==================== Logo da instituição ====================
// Bucket `institution_assets` já existe (criado manualmente). Cada instituição
// tem uma pasta cujo nome é o id da instituição. No banco guardamos apenas o
// nome do arquivo; a URL pública é derivada de id + nome do arquivo.

// Faz upload do logo e retorna o nome do arquivo (a ser salvo no banco).
export async function uploadLogo(
  instituicaoId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string },
): Promise<string> {
  const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileName = `${Date.now()}-${safeName}`;
  const path = `${instituicaoId}/${fileName}`;

  const { error } = await supabaseAdmin.storage.from(LOGO_BUCKET).upload(path, file.buffer, {
    contentType: file.mimetype,
    upsert: true,
  });

  if (error) {
    throw error;
  }

  return fileName;
}

// Monta a URL pública a partir do id da instituição e do nome do arquivo.
export function getLogoUrl(instituicaoId: string, fileName: string | null | undefined): string | null {
  if (!fileName) return null;
  const { data } = supabaseAdmin.storage
    .from(LOGO_BUCKET)
    .getPublicUrl(`${instituicaoId}/${fileName}`);
  return data.publicUrl;
}

export async function removerLogo(instituicaoId: string, fileName: string): Promise<void> {
  await supabaseAdmin.storage.from(LOGO_BUCKET).remove([`${instituicaoId}/${fileName}`]);
}
