import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '@prisma/client';
import pg from 'pg';

const { Pool } = pg;

const connectionString = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is not set');
}

const prisma = new PrismaClient({ adapter: new PrismaPg(new Pool({ connectionString }) as any) });

/**
 * Catálogo de planos.
 *
 * Gratuidade de assinatura (`cobrancaSaaS`) e fee de transação (`feeEventoPercentual`)
 * são eixos ortogonais: o parceiro piloto não paga mensalidade, mas paga a taxa base
 * de 3,50% sobre eventos. O PRO desce para 2,50% justamente porque paga mensalidade.
 */
const PLANOS: Prisma.PlanoCreateInput[] = [
  {
    codigo: 'PILOTO_FREE',
    nome: 'Parceiro Piloto',
    descricao:
      'Acesso completo, sem cobrança de assinatura. Concedido a parceiros do programa piloto.',
    cobrancaSaaS: false,
    valorMensal: new Prisma.Decimal(0),
    valorAnual: new Prisma.Decimal(0),
    mpPreapprovalPlanId: null,
    feeEventoPercentual: new Prisma.Decimal('3.50'),
    feeEventoMinimo: new Prisma.Decimal(0),
    feeEventoMaximo: null,
    limiteEventosAtivos: null,
    limiteUsuarios: null,
    features: {
      pagamentosOnline: true,
      relatorios: true,
      projetos: true,
      areas: true,
      camposCustomizados: true,
      exportacao: true,
    },
    ativo: true,
    ordem: 0,
  },
  {
    codigo: 'ESSENCIAL',
    nome: 'Essencial',
    descricao: 'Para igrejas começando a organizar eventos e inscrições online.',
    cobrancaSaaS: true,
    valorMensal: new Prisma.Decimal('99.00'),
    valorAnual: new Prisma.Decimal('990.00'),
    mpPreapprovalPlanId: null,
    feeEventoPercentual: new Prisma.Decimal('3.50'),
    feeEventoMinimo: new Prisma.Decimal(0),
    feeEventoMaximo: null,
    limiteEventosAtivos: 5,
    limiteUsuarios: 10,
    features: {
      pagamentosOnline: true,
      relatorios: true,
      projetos: false,
      areas: true,
      camposCustomizados: false,
      exportacao: false,
    },
    ativo: true,
    ordem: 1,
  },
  {
    codigo: 'PRO',
    nome: 'Pro',
    descricao: 'Sem limites de eventos ou usuários, com todos os módulos liberados.',
    cobrancaSaaS: true,
    valorMensal: new Prisma.Decimal('249.00'),
    valorAnual: new Prisma.Decimal('2490.00'),
    mpPreapprovalPlanId: null,
    feeEventoPercentual: new Prisma.Decimal('2.50'),
    feeEventoMinimo: new Prisma.Decimal(0),
    feeEventoMaximo: null,
    limiteEventosAtivos: null,
    limiteUsuarios: null,
    features: {
      pagamentosOnline: true,
      relatorios: true,
      projetos: true,
      areas: true,
      camposCustomizados: true,
      exportacao: true,
    },
    ativo: true,
    ordem: 2,
  },
];

async function main() {
  console.log('🌱 Seed de planos...');

  for (const plano of PLANOS) {
    // `upsert` por `codigo`: o seed roda em toda migration deploy e nunca duplica.
    await prisma.plano.upsert({
      where: { codigo: plano.codigo },
      update: plano,
      create: plano,
    });

    console.log(`  ✅ ${plano.codigo}`);
  }

  console.log('\n✅ Seed de planos concluído.');
}

main()
  .catch((e) => {
    console.error('❌ Erro ao executar seed de planos:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
