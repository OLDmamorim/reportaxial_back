const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Conexão Neon PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'seu-secret-super-seguro-aqui';

// Middleware de Autenticação
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Token não fornecido' });
    
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    req.userType = decoded.userType;
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token inválido' });
  }
};

// ============ AUTENTICAÇÃO ============

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ message: 'Credenciais inválidas' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ message: 'Credenciais inválidas' });
    }

    const token = jwt.sign(
      { userId: user.id, userType: user.user_type },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        user_type: user.user_type
      }
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Registo de Loja
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, storeName, contactPerson, phone, address } = req.body;

    // Verificar se email já existe
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Email já registado' });
    }

    // Hash da password
    const passwordHash = await bcrypt.hash(password, 10);

    // Criar utilizador
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, 'store']
    );

    const userId = userResult.rows[0].id;

    // Criar loja
    await pool.query(
      'INSERT INTO stores (user_id, store_name, contact_person, phone, address) VALUES ($1, $2, $3, $4, $5)',
      [userId, storeName, contactPerson, phone, address]
    );

    res.status(201).json({ message: 'Registo efetuado com sucesso' });
  } catch (error) {
    console.error('Erro no registo:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// ============ ADMIN ============

// Listar todos os utilizadores
app.get('/api/admin/users', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'admin') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const result = await pool.query(`
      SELECT u.id, u.email, u.user_type, u.created_at,
             COALESCE(s.is_active, sup.is_active, true) as is_active
      FROM users u
      LEFT JOIN stores s ON u.id = s.user_id
      LEFT JOIN suppliers sup ON u.id = sup.user_id
      ORDER BY u.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar utilizadores:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Criar Fornecedor
app.post('/api/admin/create-supplier', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'admin') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const { email, password, supplierName, contactPerson } = req.body;

    // Verificar se email já existe
    const existingUser = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ message: 'Email já registado' });
    }

    // Hash da password
    const passwordHash = await bcrypt.hash(password, 10);

    // Criar utilizador
    const userResult = await pool.query(
      'INSERT INTO users (email, password_hash, user_type) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, 'supplier']
    );

    const userId = userResult.rows[0].id;

    // Criar fornecedor
    await pool.query(
      'INSERT INTO suppliers (user_id, supplier_name, contact_person) VALUES ($1, $2, $3)',
      [userId, supplierName, contactPerson]
    );

    res.status(201).json({ message: 'Fornecedor criado com sucesso' });
  } catch (error) {
    console.error('Erro ao criar fornecedor:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// ============ PROBLEMAS/REPORTS ============

// Criar problema (Loja)
app.post('/api/problems', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'store') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const { problem_description, order_date, supplier_order, product, eurocode, observations, priority } = req.body;

    // Buscar store_id do utilizador
    const storeResult = await pool.query('SELECT id FROM stores WHERE user_id = $1', [req.userId]);
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loja não encontrada' });
    }

    const storeId = storeResult.rows[0].id;

    // Construir descrição completa com todos os detalhes
    let fullDescription = problem_description || '';
    if (order_date) fullDescription += `\nData: ${order_date}`;
    if (supplier_order) fullDescription += `\nEnc Fornecedor: ${supplier_order}`;
    if (eurocode) fullDescription += `\nEurocódigo: ${eurocode}`;
    if (observations) fullDescription += `\nObservações: ${observations}`;

    const result = await pool.query(
      `INSERT INTO problems (store_id, title, description, priority, status)
       VALUES ($1, $2, $3, $4, 'pending') RETURNING *`,
      [storeId, problem_description, fullDescription.trim(), priority || 'normal']
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao criar problema:', error);
    res.status(500).json({ message: 'Erro no servidor', error: error.message });
  }
});

// Listar problemas da loja
app.get('/api/problems/store', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'store') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const storeResult = await pool.query('SELECT id FROM stores WHERE user_id = $1', [req.userId]);
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loja não encontrada' });
    }

    const storeId = storeResult.rows[0].id;

    const result = await pool.query(
      `SELECT p.id, 
              p.title as problem_description,
              p.description,
              p.priority,
              p.status,
              p.created_at,
              p.updated_at
       FROM problems p
       WHERE p.store_id = $1
       ORDER BY p.created_at DESC`,
      [storeId]
    );

    // Buscar respostas separadamente
    const problemsWithResponses = await Promise.all(result.rows.map(async (problem) => {
      const responseResult = await pool.query(
        'SELECT response_text, created_at as response_date FROM responses WHERE problem_id = $1 ORDER BY created_at DESC LIMIT 1',
        [problem.id]
      );
      
      return {
        ...problem,
        response_text: responseResult.rows[0]?.response_text || null,
        response_date: responseResult.rows[0]?.response_date || null
      };
    }));

    res.json(problemsWithResponses);
  } catch (error) {
    console.error('Erro ao listar problemas:', error);
    res.status(500).json({ message: 'Erro no servidor', error: error.message });
  }
});

// Listar todos os problemas (Fornecedor)
app.get('/api/problems/supplier', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'supplier') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const result = await pool.query(
      `SELECT p.id,
              p.title as problem_description,
              p.description,
              p.priority,
              p.status,
              p.created_at,
              p.updated_at,
              s.store_name, 
              s.contact_person as store_contact,
              s.phone as store_phone,
              r.response_text, 
              r.created_at as response_date
       FROM problems p
       JOIN stores s ON p.store_id = s.id
       LEFT JOIN responses r ON p.id = r.problem_id
       ORDER BY p.created_at DESC`
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao listar problemas:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Responder a problema (Fornecedor)
app.post('/api/problems/:problemId/respond', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'supplier') {
      return res.status(403).json({ message: 'Acesso negado' });
    }

    const { problemId } = req.params;
    const { response_text } = req.body;

    // Buscar supplier_id
    const supplierResult = await pool.query('SELECT id FROM suppliers WHERE user_id = $1', [req.userId]);
    if (supplierResult.rows.length === 0) {
      return res.status(404).json({ message: 'Fornecedor não encontrado' });
    }

    const supplierId = supplierResult.rows[0].id;

    // Verificar se já existe resposta
    const existingResponse = await pool.query(
      'SELECT * FROM responses WHERE problem_id = $1',
      [problemId]
    );

    let result;
    if (existingResponse.rows.length > 0) {
      // Atualizar resposta existente
      result = await pool.query(
        `UPDATE responses 
         SET response_text = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE problem_id = $2 
         RETURNING *`,
        [response_text, problemId]
      );
    } else {
      // Criar nova resposta
      result = await pool.query(
        `INSERT INTO responses (problem_id, supplier_id, response_text)
         VALUES ($1, $2, $3) RETURNING *`,
        [problemId, supplierId, response_text]
      );
    }

    // Atualizar status do problema para "in_progress"
    await pool.query(
      'UPDATE problems SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      ['in_progress', problemId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao responder problema:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// 🆕 MARCAR PROBLEMA COMO RESOLVIDO (Apenas Fornecedor)
app.patch('/api/problems/:problemId/resolve', authMiddleware, async (req, res) => {
  try {
    if (req.userType !== 'supplier') {
      return res.status(403).json({ message: 'Apenas fornecedores podem marcar como resolvido' });
    }

    const { problemId } = req.params;

    // Verificar se o problema existe
    const problemCheck = await pool.query('SELECT * FROM problems WHERE id = $1', [problemId]);
    if (problemCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Problema não encontrado' });
    }

    // Atualizar status para "resolved"
    const result = await pool.query(
      `UPDATE problems 
       SET status = 'resolved', updated_at = CURRENT_TIMESTAMP 
       WHERE id = $1 
       RETURNING *`,
      [problemId]
    );

    res.json({
      message: 'Problema marcado como resolvido',
      problem: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao marcar como resolvido:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Buscar detalhes de um problema específico
app.get('/api/problems/:problemId', authMiddleware, async (req, res) => {
  try {
    const { problemId } = req.params;

    const result = await pool.query(
      `SELECT p.id,
              p.title as problem_description,
              p.description,
              p.priority,
              p.status,
              p.created_at,
              p.updated_at,
              s.store_name, 
              s.contact_person as store_contact,
              s.phone as store_phone,
              r.response_text, 
              r.created_at as response_date
       FROM problems p
       JOIN stores s ON p.store_id = s.id
       LEFT JOIN responses r ON p.id = r.problem_id
       WHERE p.id = $1`,
      [problemId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Problema não encontrado' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Erro ao buscar problema:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// ============ SERVIDOR ============

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});

// Teste de conexão com a base de dados
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('❌ Erro na conexão com a base de dados:', err);
  } else {
    console.log('✅ Conexão com Neon PostgreSQL estabelecida:', res.rows[0].now);
  }
});