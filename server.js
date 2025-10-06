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

// Rota raiz
app.get('/', (req, res) => {
  res.json({ 
    message: 'ReportAxial API está funcionando!',
    version: '1.0.0',
    endpoints: [
      'GET /api/migrate',
      'POST /api/auth/login',
      'POST /api/auth/register',
      'GET /api/problems/store',
      'GET /api/problems/supplier',
      'POST /api/problems/:problemId/messages',
      'GET /api/problems/:problemId/messages'
    ]
  });
});

// Ver estrutura da tabela problems
app.get('/api/table-structure', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'problems'
      ORDER BY ordinal_position;
    `);
    res.json({ columns: result.rows });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Rota de migração da base de dados (executar uma vez)
app.get('/api/migrate', async (req, res) => {
  try {
    console.log('Iniciando migração da base de dados...');
    
    // Adicionar colunas que faltam
    await pool.query(`
      ALTER TABLE problems 
      ADD COLUMN IF NOT EXISTS title VARCHAR(255),
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS priority VARCHAR(50) DEFAULT 'normal',
      ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS viewed_by_supplier BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS viewed_by_store BOOLEAN DEFAULT FALSE;
    `);
    
    // Criar tabela problem_messages para histórico de conversação
    await pool.query(`
      CREATE TABLE IF NOT EXISTS problem_messages (
        id SERIAL PRIMARY KEY,
        problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
        user_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    
    console.log('Migração concluída com sucesso!');
    res.json({ message: 'Migração concluída com sucesso!', success: true });
  } catch (error) {
    console.error('Erro na migração:', error);
    res.status(500).json({ message: 'Erro na migração', error: error.message });
  }
});

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

    // Validar data
    if (order_date) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(order_date)) {
        return res.status(400).json({ message: 'Formato de data inválido. Use YYYY-MM-DD' });
      }
      
      // Validar se a data é válida
      const date = new Date(order_date);
      if (isNaN(date.getTime())) {
        return res.status(400).json({ message: 'Data inválida' });
      }
    }

    // Buscar store_id do utilizador
    const storeResult = await pool.query('SELECT id FROM stores WHERE user_id = $1', [req.userId]);
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ message: 'Loja não encontrada' });
    }

    const storeId = storeResult.rows[0].id;

    const result = await pool.query(
      `INSERT INTO problems (store_id, problem_type, order_date, supplier_order, product, eurocode, observations, status, priority)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        storeId, 
        problem_description || 'Problema', 
        order_date || new Date().toISOString().split('T')[0], 
        supplier_order || '', 
        product || '', 
        eurocode || '', 
        observations || '', 
        'pending',
        priority || 'normal'
      ]
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
              p.problem_type as problem_description,
              p.order_date,
              p.supplier_order,
              p.product,
              p.eurocode,
              p.observations,
              COALESCE(p.priority, 'normal') as priority,
              COALESCE(p.status, 'pending') as status,
              p.created_at,
              p.updated_at,
              p.viewed_by_store
       FROM problems p
       WHERE p.store_id = $1
       ORDER BY p.updated_at DESC`,
      [storeId]
    );

    console.log(`[API] Encontrados ${result.rows.length} problemas para store_id ${storeId}`);

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

    console.log(`[API] Retornando ${problemsWithResponses.length} problemas com respostas`);
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
              p.problem_type as problem_description,
              p.order_date,
              p.supplier_order,
              p.product,
              p.eurocode,
              p.observations,
              COALESCE(p.priority, 'normal') as priority,
              COALESCE(p.status, 'pending') as status,
              p.created_at,
              p.updated_at,
              p.viewed_by_supplier,
              s.store_name, 
              s.contact_person as store_contact,
              s.phone as store_phone,
              r.response_text, 
              r.created_at as response_date
       FROM problems p
       JOIN stores s ON p.store_id = s.id
       LEFT JOIN responses r ON p.id = r.problem_id
       ORDER BY p.updated_at DESC`
    );

    console.log(`[API] Fornecedor: Encontrados ${result.rows.length} problemas`);
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
// Endpoint para editar observações de um problema
app.patch('/api/problems/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { observations } = req.body;

    console.log('[Backend] Editando problema:', { id, observations, userId: req.userId });

    // Verificar se o problema existe
    const problemCheck = await pool.query('SELECT * FROM problems WHERE id = $1', [id]);
    if (problemCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Problema não encontrado' });
    }

    // Atualizar observações
    const result = await pool.query(
      `UPDATE problems 
       SET observations = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING *`,
      [observations, id]
    );

    console.log('[Backend] Problema atualizado:', result.rows[0]);
    res.json({
      message: 'Observações atualizadas com sucesso',
      problem: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao editar problema:', error);
    res.status(500).json({ message: 'Erro no servidor', error: error.message });
  }
});

// Endpoint para marcar problema como visto
app.patch('/api/problems/:id/mark-viewed', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { userType } = req.body; // 'supplier' ou 'store'

    console.log('[Backend] Marcando problema como visto:', { id, userType, userId: req.userId });

    // Buscar problema atual
    const problemCheck = await pool.query('SELECT * FROM problems WHERE id = $1', [id]);
    if (problemCheck.rows.length === 0) {
      return res.status(404).json({ message: 'Problema não encontrado' });
    }

    const problem = problemCheck.rows[0];

    // Determinar qual campo atualizar
    const field = userType === 'supplier' ? 'viewed_by_supplier' : 'viewed_by_store';

    // Se fornecedor está abrindo um problema pendente, mudar para "Em Progresso"
    let newStatus = problem.status;
    if (userType === 'supplier' && problem.status === 'pending') {
      newStatus = 'in_progress';
      console.log('[Backend] Mudando status de pending para in_progress');
    }

    // Atualizar campo de visualização e status
    const result = await pool.query(
      `UPDATE problems 
       SET ${field} = TRUE, status = $1, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $2 
       RETURNING *`,
      [newStatus, id]
    );

    console.log('[Backend] Problema marcado como visto:', result.rows[0]);
    res.json({
      message: 'Problema marcado como visto',
      problem: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao marcar problema como visto:', error);
    res.status(500).json({ message: 'Erro no servidor', error: error.message });
  }
});

app.patch('/api/problems/:problemId/resolve', authMiddleware, async (req, res) => {
  try {
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
              p.problem_type as problem_description,
              p.order_date,
              p.supplier_order,
              p.product,
              p.eurocode,
              p.observations,
              COALESCE(p.priority, 'normal') as priority,
              COALESCE(p.status, 'pending') as status,
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

// ============ MENSAGENS (HISTÓRICO DE CONVERSAÇÃO) ============

// Adicionar mensagem ao histórico
app.post('/api/problems/:problemId/messages', authMiddleware, async (req, res) => {
  try {
    const { problemId } = req.params;
    const { message } = req.body;
    
    if (!message || message.trim() === '') {
      return res.status(400).json({ message: 'Mensagem não pode estar vazia' });
    }

    // Inserir mensagem
    const result = await pool.query(
      `INSERT INTO problem_messages (problem_id, user_type, message) 
       VALUES ($1, $2, $3) 
       RETURNING *`,
      [problemId, req.userType, message]
    );

    // Marcar como não visto pelo outro lado e atualizar updated_at
    if (req.userType === 'store') {
      await pool.query(
        'UPDATE problems SET viewed_by_supplier = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [problemId]
      );
    } else if (req.userType === 'supplier') {
      await pool.query(
        'UPDATE problems SET viewed_by_store = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [problemId]
      );
    }

    res.json({
      message: 'Mensagem adicionada com sucesso',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Erro ao adicionar mensagem:', error);
    res.status(500).json({ message: 'Erro no servidor' });
  }
});

// Listar mensagens de um problema
app.get('/api/problems/:problemId/messages', authMiddleware, async (req, res) => {
  try {
    const { problemId } = req.params;

    const result = await pool.query(
      `SELECT * FROM problem_messages 
       WHERE problem_id = $1 
       ORDER BY created_at ASC`,
      [problemId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar mensagens:', error);
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
});// Redeploy Mon Oct  6 08:11:29 EDT 2025
