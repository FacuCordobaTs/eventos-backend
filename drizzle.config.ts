import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  // 1. Dónde está tu esquema (el código fuente de la verdad)
  schema: './src/db/schema.ts', 
  
  // 2. Dónde guardar los archivos .sql si algún día usás 'generate' en vez de 'push'
  out: './drizzle', 
  
  // 3. El motor de base de datos que configuramos en la VPS
  dialect: 'mysql', 
  
  // 4. Las credenciales de conexión
  dbCredentials: {
    // Bun inyecta process.env automáticamente leyendo tu archivo .env
    url: process.env.DATABASE_URL!, 
  },

  // Opcionales muy recomendados para desarrollo
  verbose: true, // Te muestra por consola las queries SQL exactas que va a ejecutar
  strict: true,  // Te pide confirmación antes de borrar columnas o tablas para evitar desastres
});