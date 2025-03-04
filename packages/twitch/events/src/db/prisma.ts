import { PrismaClient as PrismaPsql } from '@dotabod/prisma/dist/psql/index.js'

// allow global `var` declarations
declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaPsql | undefined
}

export const prisma = global.prisma ?? new PrismaPsql()

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma
}
