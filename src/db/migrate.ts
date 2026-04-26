import { migrate } from "drizzle-orm/mysql2/migrator";
import { drizzle } from "drizzle-orm/mysql2";
import { pool } from "../db"; // Asegurate de que la ruta a tu pool sea correcta

async function runMigrations() {
  console.log("⏳ Ejecutando migraciones...");
  
  try {
    // Envolvemos el pool con Drizzle
    const db = drizzle(pool);
    
    // Ejecutamos las migraciones esperando a que terminen (await)
    await migrate(db, { migrationsFolder: "drizzle" });
    
    console.log("✅ Migraciones completadas con éxito");
    
  } catch (error) {
    console.error("❌ Error fatal ejecutando migraciones:", error);
    process.exit(1); // El 1 le avisa al sistema operativo que hubo un error
    
  } finally {
    // Esto se ejecuta SIEMPRE, haya error o no.
    // Cerramos el pool de conexiones para que el script no se quede colgado
    await pool.end(); 
    process.exit(0); // El 0 significa que todo terminó correctamente
  }
}

// Ejecutamos la función
runMigrations();