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

const app = express();

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

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

// Export para Vercel
export default app;
