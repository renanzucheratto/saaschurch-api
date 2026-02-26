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
      'saaschurch-new.vercel.app',
      'saaschurch-d08mh64ci-rezucherattos-projects.vercel.app',
    ],
    credentials: true,
  }),
);
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'SaaS Church API is running!' });
});

app.use('/eventos', eventosRoutes);

app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running on port ' + (process.env.PORT ?? 3000));
});
