const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const config = require('../config');

class SupabaseService {
  constructor() {
    this.pool = null;
    this.isEnabled = false;
    this.init();
  }

  init() {
    if (config.DATABASE_URL) {
      try {
        this.pool = new Pool({
          connectionString: config.DATABASE_URL,
          ssl: {
            rejectUnauthorized: false, // Requerido para conexiones cloud de Supabase / Neon / Render
          },
          max: 10,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 10000,
        });
        this.isEnabled = true;
        console.log('✅ [SUPABASE/POSTGRESQL] Cliente de base de datos cloud inicializado.');
      } catch (err) {
        console.error('❌ [SUPABASE INIT ERROR]', err.message);
        this.isEnabled = false;
      }
    } else {
      console.log('ℹ️ [STORAGE LOCAL] DATABASE_URL no configurada. Operando con persistencia local en disco/JSON.');
    }
  }

  /**
   * Crea las tablas necesarias en Supabase si aún no existen
   */
  async ensureTables() {
    if (!this.isEnabled || !this.pool) return;
    try {
      const client = await this.pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS whatsapp_auth_sessions (
            id VARCHAR(255) PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );

          CREATE TABLE IF NOT EXISTS clinic_state (
            key VARCHAR(100) PRIMARY KEY,
            data JSONB NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          );
        `);
        console.log('✅ [SUPABASE TABLES] Tablas whatsapp_auth_sessions y clinic_state verificadas en Supabase.');
      } finally {
        client.release();
      }
    } catch (err) {
      console.error('❌ [SUPABASE ENSURE TABLES ERROR]', err.message);
    }
  }

  /**
   * Restaura todos los archivos de sesión de WhatsApp desde Supabase al disco local
   */
  async syncAuthFromDatabase(authDir) {
    if (!this.isEnabled || !this.pool) return false;
    try {
      if (!fs.existsSync(authDir)) {
        fs.mkdirSync(authDir, { recursive: true });
      }

      const res = await this.pool.query('SELECT id, data FROM whatsapp_auth_sessions');
      if (res.rows.length > 0) {
        for (const row of res.rows) {
          const filePath = path.join(authDir, row.id);
          fs.writeFileSync(filePath, row.data, 'utf-8');
        }
        console.log(`✅ [SUPABASE AUTH SYNC] ${res.rows.length} archivos de sesión de WhatsApp restaurados desde Supabase.`);
        return true;
      } else {
        console.log('ℹ️ [SUPABASE AUTH] No hay sesión previa guardada en Supabase.');
        return false;
      }
    } catch (err) {
      console.error('❌ [SUPABASE AUTH DOWNLOAD ERROR]', err.message);
      return false;
    }
  }

  /**
   * Sube los archivos de sesión de WhatsApp del disco local a Supabase
   */
  async syncAuthToDatabase(authDir) {
    if (!this.isEnabled || !this.pool) return;
    try {
      if (!fs.existsSync(authDir)) return;

      const files = fs.readdirSync(authDir);
      for (const file of files) {
        const filePath = path.join(authDir, file);
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const content = fs.readFileSync(filePath, 'utf-8');
          await this.pool.query(
            `INSERT INTO whatsapp_auth_sessions (id, data, updated_at) 
             VALUES ($1, $2, NOW()) 
             ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
            [file, content]
          );
        }
      }
      console.log(`💾 [SUPABASE AUTH BACKUP] Sesión de WhatsApp sincronizada en Supabase (${files.length} archivos).`);
    } catch (err) {
      console.error('❌ [SUPABASE AUTH UPLOAD ERROR]', err.message);
    }
  }

  /**
   * Elimina la sesión de WhatsApp de Supabase (al desvincular o resetear QR)
   */
  async clearAuthDatabase() {
    if (!this.isEnabled || !this.pool) return;
    try {
      await this.pool.query('DELETE FROM whatsapp_auth_sessions');
      console.log('🧹 [SUPABASE AUTH CLEAN] Sesión de WhatsApp eliminada de Supabase.');
    } catch (err) {
      console.error('❌ [SUPABASE AUTH CLEAR ERROR]', err.message);
    }
  }

  /**
   * Carga el estado global de citas/chats desde Supabase
   */
  async loadClinicState() {
    if (!this.isEnabled || !this.pool) return null;
    try {
      const res = await this.pool.query("SELECT data FROM clinic_state WHERE key = 'main_store'");
      if (res.rows.length > 0) {
        return res.rows[0].data;
      }
      return null;
    } catch (err) {
      console.error('❌ [SUPABASE LOAD STATE ERROR]', err.message);
      return null;
    }
  }

  /**
   * Guarda el estado global de citas/chats en Supabase
   */
  async saveClinicState(data) {
    if (!this.isEnabled || !this.pool) return;
    try {
      await this.pool.query(
        `INSERT INTO clinic_state (key, data, updated_at)
         VALUES ('main_store', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET data = $1, updated_at = NOW()`,
        [JSON.stringify(data)]
      );
    } catch (err) {
      console.error('❌ [SUPABASE SAVE STATE ERROR]', err.message);
    }
  }
}

module.exports = new SupabaseService();
