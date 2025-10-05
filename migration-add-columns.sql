-- Migração para adicionar colunas faltantes na tabela problems

-- Adicionar colunas se não existirem
ALTER TABLE problems 
ADD COLUMN IF NOT EXISTS problem_description TEXT,
ADD COLUMN IF NOT EXISTS order_date DATE,
ADD COLUMN IF NOT EXISTS supplier_order VARCHAR(255),
ADD COLUMN IF NOT EXISTS product VARCHAR(255),
ADD COLUMN IF NOT EXISTS eurocode VARCHAR(255),
ADD COLUMN IF NOT EXISTS observations TEXT;

-- Copiar dados das colunas antigas para as novas (se existirem dados)
UPDATE problems 
SET problem_description = description 
WHERE problem_description IS NULL AND description IS NOT NULL;

UPDATE problems 
SET problem_description = title 
WHERE problem_description IS NULL AND title IS NOT NULL;

-- Opcional: Remover colunas antigas (comentado por segurança)
-- ALTER TABLE problems DROP COLUMN IF EXISTS title;
-- ALTER TABLE problems DROP COLUMN IF EXISTS description;
