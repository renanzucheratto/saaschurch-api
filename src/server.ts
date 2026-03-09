import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import eventosRoutes from './routes/eventos.js';
import authRoutes from './routes/auth.js';
import instituicoesRoutes from './routes/instituicoes.js';
import usersRoutes from './routes/users.js';

const app = express();

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://saaschurch-new.vercel.app',
      'https://saaschurch-new-git-dev-rezucherattos-projects.vercel.app',
    ],
    credentials: true,
  }),
);
app.use(express.json());

app.use('/auth', authRoutes);
app.use('/instituicoes', instituicoesRoutes);
app.use('/users', usersRoutes);
app.use('/eventos', eventosRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

// Export para Vercel
export default app;
