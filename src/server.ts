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
import fornecedoresRoutes from './routes/fornecedores.js';
import categoriasFinanceirasRoutes from './routes/categorias-financeiras.js';
import contasBancariasRoutes from './routes/contas-bancarias.js';
import regrasConciliacaoRoutes from './routes/regras-conciliacao.js';
import transacoesBancariasRoutes from './routes/transacoes-bancarias.js';
import mockBradescoRoutes from './routes/mock-bradesco.js';

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
app.use('/financeiro/fornecedores', fornecedoresRoutes);
app.use('/financeiro/categorias', categoriasFinanceirasRoutes);
app.use('/financeiro/contas', contasBancariasRoutes);
app.use('/financeiro/regras', regrasConciliacaoRoutes);
app.use('/financeiro/transacoes', transacoesBancariasRoutes);
app.use('/mock/bradesco', mockBradescoRoutes);

// Para desenvolvimento local
if (process.env.NODE_ENV !== 'production') {
  app.listen(3000, () => {
    console.log('Server is running on port 3000');
  });
}

// Export para Vercel
export default app;
