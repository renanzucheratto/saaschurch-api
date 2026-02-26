import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import eventosRoutes from './routes/eventos.js';

const app = express();

app.use(
  cors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'https://saaschurch-new.vercel.app',
    ],
    credentials: true,
  }),
);
app.use(express.json());

app.use('/eventos', eventosRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

// Export para Vercel
export default app;
