const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@host/db',
  ssl: { rejectUnauthorized: false }
});

async function createAdmin() {
  const email = 'admin';
  const password = 'XGl@55#7458';
  
  try {
    console.log('🔐 A gerar hash da password...');
    const passwordHash = await bcrypt.hash(password, 10);
    
    console.log('📝 A criar utilizador admin...');
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id, email',
      [email, passwordHash, 'admin']
    );
    
    console.log('✅ Admin criado com sucesso!');
    console.log('📧 Email:', result.rows[0].email);
    console.log('🔑 Password:', password);
    
    await pool.end();
  } catch (error) {
    if (error.code === '23505') {
      console.error('❌ Erro: Este email já está registado.');
    } else {
      console.error('❌ Erro ao criar admin:', error.message);
    }
    await pool.end();
    process.exit(1);
  }
}

createAdmin();
