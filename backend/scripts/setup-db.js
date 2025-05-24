const { Pool } = require('pg');
require('dotenv').config();

const setupDatabase = async () => {
  const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: 'postgres', // Connect to default database first
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || '5432'),
  });

  try {
    // Create database if it doesn't exist
    const dbName = process.env.DB_NAME || 'video_tracker';
    
    const dbExists = await pool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [dbName]
    );

    if (dbExists.rows.length === 0) {
      await pool.query(`CREATE DATABASE ${dbName}`);
      console.log(`✅ Database '${dbName}' created successfully`);
    } else {
      console.log(`ℹ️  Database '${dbName}' already exists`);
    }

    await pool.end();

    // Connect to the new database and create tables
    const appPool = new Pool({
      user: process.env.DB_USER || 'postgres',
      host: process.env.DB_HOST || 'localhost',
      database: dbName,
      password: process.env.DB_PASSWORD,
      port: parseInt(process.env.DB_PORT || '5432'),
    });

    // Create tables
    await appPool.query(`
      CREATE TABLE IF NOT EXISTS video_progress (
        video_id TEXT NOT NULL,
        user_id TEXT NOT NULL DEFAULT 'default_user',
        checkpoints BOOLEAN[] NOT NULL DEFAULT '{}',
        quizzes JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (video_id, user_id)
      );
    `);

    // Create indexes for better performance
    await appPool.query(`
      CREATE INDEX IF NOT EXISTS idx_video_progress_video_id 
      ON video_progress(video_id);
    `);

    await appPool.query(`
      CREATE INDEX IF NOT EXISTS idx_video_progress_user_id 
      ON video_progress(user_id);
    `);

    await appPool.query(`
      CREATE INDEX IF NOT EXISTS idx_video_progress_updated_at 
      ON video_progress(updated_at);
    `);

    console.log('✅ Database tables and indexes created successfully');
    
    await appPool.end();
    console.log('🎉 Database setup complete!');
    
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    process.exit(1);
  }
};

if (require.main === module) {
  setupDatabase();
}

module.exports = { setupDatabase };
