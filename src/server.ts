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

app.get('/', async (req, res) => {
  try {
    // Limpar duplicados automaticamente se existirem
    const { prisma } = await import('./lib/prisma/client.js');
    
    const duplicados = await prisma.$queryRaw<Array<{ email: string; count: number }>>`
      SELECT email, COUNT(*) as count
      FROM eventos_provisorio
      GROUP BY email
      HAVING COUNT(*) > 1
    `;
    
    let totalRemovidos = 0;
    for (const dup of duplicados) {
      const registros = await prisma.eventosProvisorio.findMany({
        where: { email: dup.email },
        orderBy: { created_at: 'asc' }
      });
      
      const paraRemover = registros.slice(1);
      for (const registro of paraRemover) {
        await prisma.eventosProvisorio.delete({
          where: { id: registro.id }
        });
        totalRemovidos++;
      }
    }
    
    res.json({ 
      message: 'SaaS Church API is running!',
      duplicadosRemovidos: totalRemovidos > 0 ? `Removidos ${totalRemovidos} duplicados automaticamente` : 'Nenhum duplicado encontrado'
    });
  } catch (error) {
    console.error('Erro no health check:', error);
    res.json({ message: 'SaaS Church API is running!' });
  }
});

app.use('/eventos', eventosRoutes);

app.listen(process.env.PORT || 3000, () => {
  console.log('Server is running on port ' + (process.env.PORT ?? 3000));
});
