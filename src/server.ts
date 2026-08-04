import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import eventosRoutes from './routes/eventos.js';
import authRoutes from './routes/auth.js';
import instituicoesRoutes from './routes/instituicoes.js';
import usersRoutes from './routes/users.js';
import projetosRoutes from './routes/projetos.js';
import areasRoutes from './routes/areas.js';
import dashboardRoutes from './routes/dashboard.js';
import planosRoutes from './routes/planos.js';
import mercadopagoRoutes from './routes/mercadopago.js';
import checkoutRoutes from './routes/checkout.js';
import webhooksRoutes from './routes/webhooks.js';
import jobsRoutes from './routes/jobs.js';
import { validarChaveCifragem } from './lib/mercadopago/crypto.js';

// Chave de cifragem dos tokens do Mercado Pago conferida no boot: melhor o erro
// aparecer no start do que no meio do OAuth de um usuário real. Não derruba a
// API — as demais rotas não dependem do Mercado Pago.
try {
  validarChaveCifragem();
} catch (error: any) {
  console.error('Mercado Pago desabilitado:', error?.message ?? error);
}

const app = express();

app.set('trust proxy', 1);

app.use(
  cors({
    origin: [
      'http://localhost:3001',
      'https://app.igrejaformosadecristo.com',
    ],
    credentials: true,
  }),
);
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/instituicoes', instituicoesRoutes);
app.use('/users', usersRoutes);
app.use('/eventos', eventosRoutes);
app.use('/projetos', projetosRoutes);
app.use('/areas', areasRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/planos', planosRoutes);
app.use('/mercadopago', mercadopagoRoutes);
app.use('/checkout', checkoutRoutes);
// Webhook e callback OAuth são server-to-server / redirect de browser: não
// passam por CORS, então não precisam entrar na allowlist acima.
app.use('/webhooks', webhooksRoutes);
app.use('/jobs', jobsRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

// Export para Vercel
export default app;
