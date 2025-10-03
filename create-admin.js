// create-admin.js
// Script para criar o primeiro utilizador admin
// Execute: node create-admin.js

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function createAdmin() {
  const email = 'admin@portal.com';
  const password = 'admin123'; // ALTERE ESTA PASSWORD!
  
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
    console.log('\n⚠️  IMPORTANTE: Altere esta password após o primeiro login!\n');
    
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
