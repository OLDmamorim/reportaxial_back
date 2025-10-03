// server.js - Backend API com Express
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Configurar CORS para aceitar pedidos APENAS do Netlify
app.use(cors({
  origin: ['https://reportaxial.netlify.app'],
  credentials: true
}));

app.use(express.json());

// Rota de teste
app.get('/', (req, res) => {
  res.json({ message: 'API ReportAxial funcionando!' });
});

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token não fornecido' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
};

const checkUserType = (...allowedTypes) => {
  return (req, res, next) => {
    if (!allowedTypes.includes(req.user.userType)) {
      return res.status(403).json({ error: 'Acesso negado' });
    }
    next();
  };
};

app.post('/api/auth/register/store', async (req, res) => {
  const { email, password, storeName, contactPerson, phone, address } = req.body;
  try {
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email já registado' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, 'store']
    );
    await pool.query(
      'INSERT INTO stores (user_id, store_name, contact_person, phone, address) VALUES ($1, $2, $3, $4, $5)',
      [userResult.rows[0].id, storeName, contactPerson, phone, address]
    );
    res.status(201).json({ message: 'Loja registada com sucesso' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao registar loja' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    const token = jwt.sign({ userId: user.id, userType: user.user_type }, process.env.JWT_SECRET, { expiresIn: '24h' });
    let profileData = null;
    if (user.user_type === 'store') {
      const store = await pool.query('SELECT * FROM stores WHERE user_id = $1', [user.id]);
      profileData = store.rows[0];
    } else if (user.user_type === 'supplier') {
      const supplier = await pool.query('SELECT * FROM suppliers WHERE user_id = $1', [user.id]);
      profileData = supplier.rows[0];
    }
    res.json({ token, user: { id: user.id, email: user.email, userType: user.user_type, profile: profileData } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao fazer login' });
  }
});

app.post('/api/admin/suppliers', authenticateToken, checkUserType('admin'), async (req, res) => {
  const { email, password, supplierName, contactPerson, phone } = req.body;
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const userResult = await pool.query('INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id', [email, passwordHash, 'supplier']);
    const supplierResult = await pool.query('INSERT INTO suppliers (user_id, supplier_name, contact_person, phone, email) VALUES ($1, $2, $3, $4, $5) RETURNING *', [userResult.rows[0].id, supplierName, contactPerson, phone, email]);
    res.status(201).json(supplierResult.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar fornecedor' });
  }
});

app.get('/api/admin/users', authenticateToken, checkUserType('admin'), async (req, res) => {
  try {
    const result = await pool.query('SELECT u.id, u.email, u.user_type, u.created_at, s.store_name, sp.supplier_name FROM users u LEFT JOIN stores s ON u.id = s.user_id LEFT JOIN suppliers sp ON u.id = sp.user_id ORDER BY u.created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar utilizadores' });
  }
});

app.post('/api/store/problems', authenticateToken, checkUserType('store'), async (req, res) => {
  const { title, description, priority } = req.body;
  try {
    const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [req.user.userId]);
    const result = await pool.query('INSERT INTO problems (store_id, title, description, priority) VALUES ($1, $2, $3, $4) RETURNING *', [store.rows[0].id, title, description, priority || 'normal']);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao criar problema' });
  }
});

app.get('/api/store/problems', authenticateToken, checkUserType('store'), async (req, res) => {
  try {
    const store = await pool.query('SELECT id FROM stores WHERE user_id = $1', [req.user.userId]);
    const result = await pool.query('SELECT p.*, json_agg(json_build_object(\'id\', r.id, \'response_text\', r.response_text, \'created_at\', r.created_at, \'supplier_name\', sp.supplier_name) ORDER BY r.created_at DESC) FILTER (WHERE r.id IS NOT NULL) as responses FROM problems p LEFT JOIN responses r ON p.id = r.problem_id LEFT JOIN suppliers sp ON r.supplier_id = sp.id WHERE p.store_id = $1 GROUP BY p.id ORDER BY p.created_at DESC', [store.rows[0].id]);
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar problemas' });
  }
});

app.get('/api/supplier/problems', authenticateToken, checkUserType('supplier'), async (req, res) => {
  try {
    const result = await pool.query('SELECT p.*, s.store_name, (SELECT COUNT(*) FROM responses WHERE problem_id = p.id) as response_count FROM problems p JOIN stores s ON p.store_id = s.id ORDER BY CASE p.status WHEN \'pending\' THEN 1 WHEN \'in_progress\' THEN 2 WHEN \'resolved\' THEN 3 WHEN \'closed\' THEN 4 END, p.created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao listar problemas' });
  }
});

app.post('/api/supplier/problems/:problemId/responses', authenticateToken, checkUserType('supplier'), async (req, res) => {
  const { problemId } = req.params;
  const { responseText } = req.body;
  try {
    const supplier = await pool.query('SELECT id FROM suppliers WHERE user_id = $1', [req.user.userId]);
    const result = await pool.query('INSERT INTO responses (problem_id, supplier_id, response_text) VALUES ($1, $2, $3) RETURNING *', [problemId, supplier.rows[0].id, responseText]);
    await pool.query('UPDATE problems SET status = \'in_progress\' WHERE id = $1 AND status = \'pending\'', [problemId]);
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao adicionar resposta' });
  }
});

app.get('/api/supplier/problems/:problemId', authenticateToken, checkUserType('supplier'), async (req, res) => {
  const { problemId } = req.params;
  try {
    const result = await pool.query('SELECT p.*, s.store_name, s.contact_person, s.phone, json_agg(json_build_object(\'id\', r.id, \'response_text\', r.response_text, \'created_at\', r.created_at, \'supplier_name\', sp.supplier_name) ORDER BY r.created_at ASC) FILTER (WHERE r.id IS NOT NULL) as responses FROM problems p JOIN stores s ON p.store_id = s.id LEFT JOIN responses r ON p.id = r.problem_id LEFT JOIN suppliers sp ON r.supplier_id = sp.id WHERE p.id = $1 GROUP BY p.id, s.id', [problemId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Problema não encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Erro ao obter problema' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor a correr na porta ${PORT}`);
});
