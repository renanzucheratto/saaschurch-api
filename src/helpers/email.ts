import { Resend } from 'resend';
import QRCode from 'qrcode';
import { supabaseAdmin } from '../lib/supabase/auth.js';

const RESEND_TEMPLATE_ID = '0b2cad44-566e-4139-980d-931550154370';
const QR_BUCKET = 'qrcodes';

let bucketEnsured = false;

async function ensureQRBucket(): Promise<void> {
  if (bucketEnsured) return;

  const { data: buckets } = await supabaseAdmin.storage.listBuckets();
  const exists = buckets?.some((b) => b.name === QR_BUCKET);

  if (!exists) {
    const { error } = await supabaseAdmin.storage.createBucket(QR_BUCKET, {
      public: true,
    });
    if (error && !/already exists/i.test(error.message)) throw error;
  }

  bucketEnsured = true;
}

export async function enviarEmailQRCode({
  participanteId,
  participanteNome,
  eventoNome,
  token,
  email,
}: {
  participanteId: string;
  participanteNome: string | null;
  eventoNome: string;
  token: string;
  email: string;
}): Promise<void> {
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
  const confirmUrl = `${frontendUrl}/externo/confirmar-presenca?token=${token}`;

  const qrBuffer = await QRCode.toBuffer(confirmUrl, {
    type: 'png',
    width: 300,
    margin: 2,
  });

  await ensureQRBucket();

  const path = `participantes/${participanteId}.png`;
  const { error: uploadError } = await supabaseAdmin.storage
    .from(QR_BUCKET)
    .upload(path, qrBuffer, { contentType: 'image/png', upsert: true });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabaseAdmin.storage
    .from(QR_BUCKET)
    .getPublicUrl(path);

  const resend = new Resend(process.env.RESEND_API_KEY);

  const payload: Parameters<typeof resend.emails.send>[0] = {
    to: [email],
    ...(process.env.RESEND_FROM_EMAIL ? { from: `IFC Maravilhas <${process.env.RESEND_FROM_EMAIL}>` } : {}),
    template: {
      id: RESEND_TEMPLATE_ID,
      variables: {
        participant_name: participanteNome || 'Participante',
        event_name: eventoNome,
        qr_code_image: publicUrlData.publicUrl,
      },
    },
  };

  const { error } = await resend.emails.send(payload);

  if (error) throw error;
}
