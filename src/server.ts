import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import eventosRoutes from './routes/eventos.js';
import authRoutes from './routes/auth.js';
import instituicoesRoutes from './routes/instituicoes.js';
import usersRoutes from './routes/users.js';
import projetosRoutes from './routes/projetos.js';
import areasRoutes from './routes/areas.js';
import ocorrenciasCalendarioRoutes from './routes/ocorrenciasCalendario.js';
import dashboardRoutes from './routes/dashboard.js';
import planosRoutes from './routes/planos.js';
import pagbankRoutes from './routes/pagbank.js';
import assinaturasRoutes from './routes/assinaturas.js';
import checkoutRoutes from './routes/checkout.js';
import webhooksRoutes from './routes/webhooks.js';
import jobsRoutes from './routes/jobs.js';
import { validarChaveCifragem } from './lib/pagbank/crypto.js';

// Chave de cifragem dos tokens do PagBank conferida no boot: melhor o erro
// aparecer no start do que no meio do OAuth de um usuário real. Não derruba a
// API — as demais rotas não dependem do PagBank.
try {
  validarChaveCifragem();
} catch (error: any) {
  console.error('PagBank desabilitado:', error?.message ?? error);
}

const app = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: [
      'http://localhost:4001',
      'https://app.igrejaformosadecristo.com',
    ],
    credentials: true,
  }),
);
app.use(
  express.json({
    // O webhook do PagBank valida a assinatura sobre o corpo BRUTO (ao
    // contrário do Mercado Pago, cujo manifest não usava o corpo). Captura o
    // buffer aqui, uma vez, para toda a aplicação — mais barato que um parser
    // dedicado só na rota de webhook.
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }),
);

app.use('/auth', authRoutes);
app.use('/instituicoes', instituicoesRoutes);
app.use('/users', usersRoutes);
app.use('/eventos', eventosRoutes);
app.use('/projetos', projetosRoutes);
app.use('/areas', areasRoutes);
app.use('/ocorrencias-calendario', ocorrenciasCalendarioRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/planos', planosRoutes);
app.use('/pagbank', pagbankRoutes);
app.use('/assinaturas', assinaturasRoutes);
app.use('/checkout', checkoutRoutes);
// Webhook e callback OAuth são server-to-server / redirect de browser: não
// passam por CORS, então não precisam entrar na allowlist acima.
app.use('/webhooks', webhooksRoutes);
app.use('/jobs', jobsRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  // PORT era ignorado aqui (3000 fixo), então o .env podia dizer uma porta e o
  // servidor subir em outra — o frontend apontava para a porta errada sem erro
  // visível, só "conexão recusada" em toda chamada.
  const porta = Number(process.env.PORT) || 3000;

  app.listen(porta, () => {
    console.log(`Server is running on port ${porta}`);
  });
}

// Export para Vercel
export default app;
