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
import paymentConnectRoutes from './routes/payment-connect.js';
import pagamentosRoutes from './routes/pagamentos.js';
import billingRoutes from './routes/billing.js';
import webhooksRoutes from './routes/webhooks.js';
import jobsRoutes from './routes/jobs.js';

const app = express();

// A Vercel termina TLS num proxy; sem isto o rate limit veria um único IP para todos.
app.set('trust proxy', 1);

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://saaschurch-new.vercel.app',
      'https://saaschurch-new-git-dev-rezucherattos-projects.vercel.app',
      'https://app.igrejaformosadecristo.com',
    ],
    credentials: true,
  }),
);
app.use(express.json());

// Webhook e jobs se autenticam sozinhos (HMAC e CRON_SECRET) e ficam fora do CORS
// de browser — registrados antes das rotas de usuário para deixar isso explícito.
app.use('/webhooks', webhooksRoutes);
app.use('/jobs', jobsRoutes);

app.use('/auth', authRoutes);
app.use('/instituicoes', instituicoesRoutes);
app.use('/users', usersRoutes);
app.use('/eventos', eventosRoutes);
app.use('/projetos', projetosRoutes);
app.use('/areas', areasRoutes);
app.use('/dashboard', dashboardRoutes);
app.use('/planos', planosRoutes);
app.use('/payment-connect', paymentConnectRoutes);
app.use('/pagamentos', pagamentosRoutes);
app.use('/billing', billingRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  const porta = Number(process.env.PORT) || 3000;

  app.listen(porta, () => {
    console.log(`Server is running on port ${porta}`);
  });
}

// Export para Vercel
export default app;
