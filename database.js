const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('DATABASE_URL is not configured in your .env file!');
}

// Establish PostgreSQL connection pool
// For Supabase, rejectUnauthorized: false is required to support SSL mode
const pool = new Pool({
  connectionString: connectionString,
  ssl: connectionString && connectionString.includes('supabase') ? { rejectUnauthorized: false } : false
});

// Generic promise query helpers
async function query(sql, params = []) {
  return pool.query(sql, params);
}

// Transaction helper - passes client to callback so transactional queries execute on the same client connection
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Initialize tables
async function initializeDatabase() {
  try {
    // Create Admins table
    await query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        is_approved BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add is_approved column if it doesn't exist
    try {
      await query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT FALSE');
    } catch (alterError) {
      console.error('Error adding is_approved column:', alterError);
    }

    // Create Sectors table
    await query(`
      CREATE TABLE IF NOT EXISTS sectors (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL
      )
    `);

    // Create Tests table
    await query(`
      CREATE TABLE IF NOT EXISTS tests (
        id SERIAL PRIMARY KEY,
        sector_id INTEGER NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        duration_mins INTEGER NOT NULL DEFAULT 30,
        results_released INTEGER NOT NULL DEFAULT 0,
        proctoring_enabled INTEGER NOT NULL DEFAULT 0,
        max_warnings INTEGER NOT NULL DEFAULT 3,
        window_start TIMESTAMP,
        window_end TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Questions table
    await query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option VARCHAR(10) NOT NULL,
        explanation TEXT
      )
    `);

    // Create Results table
    await query(`
      CREATE TABLE IF NOT EXISTS results (
        id SERIAL PRIMARY KEY,
        test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
        student_name VARCHAR(255) NOT NULL,
        student_email VARCHAR(255) NOT NULL,
        student_id VARCHAR(255) NOT NULL,
        score INTEGER NOT NULL,
        total_questions INTEGER NOT NULL,
        tab_switches INTEGER DEFAULT 0,
        terminated_by_proctor INTEGER DEFAULT 0,
        submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database schema initialized successfully in Supabase (PostgreSQL).');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Database helper functions
module.exports = {
  pool,
  query,
  transaction,
  initializeDatabase,

  // Sectors
  async getOrCreateSector(name, client = pool) {
    const trimmedName = name.trim();
    let res = await client.query('SELECT * FROM sectors WHERE LOWER(name) = LOWER($1)', [trimmedName]);
    let sector = res.rows[0];
    if (!sector) {
      const insertResult = await client.query('INSERT INTO sectors (name) VALUES ($1) RETURNING id', [trimmedName]);
      sector = { id: insertResult.rows[0].id, name: trimmedName };
    }
    return sector;
  },

  async getAllSectors() {
    const res = await query('SELECT * FROM sectors ORDER BY name ASC');
    return res.rows;
  },

  // Tests
  async createTest(sectorId, name, durationMins, proctoringEnabled = 0, maxWarnings = 3, windowStart = null, windowEnd = null, client = pool) {
    const result = await client.query(
      'INSERT INTO tests (sector_id, name, duration_mins, proctoring_enabled, max_warnings, window_start, window_end) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [sectorId, name, durationMins, proctoringEnabled ? 1 : 0, maxWarnings, windowStart, windowEnd]
    );
    return result.rows[0].id;
  },

  async getTestsBySector(sectorId) {
    const res = await query('SELECT * FROM tests WHERE sector_id = $1 ORDER BY created_at DESC', [sectorId]);
    return res.rows;
  },

  async getTestById(testId) {
    const res = await query(
      `SELECT t.*, s.name as sector_name 
       FROM tests t 
       JOIN sectors s ON t.sector_id = s.id 
       WHERE t.id = $1`,
      [testId]
    );
    return res.rows[0];
  },

  async deleteTest(testId) {
    return query('DELETE FROM tests WHERE id = $1', [testId]);
  },

  // Questions
  async addQuestion(testId, questionText, a, b, c, d, correct, explanation, client = pool) {
    return client.query(
      `INSERT INTO questions (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [testId, questionText, a, b, c, d, correct.toUpperCase().trim(), explanation]
    );
  },

  async getQuestionsByTest(testId) {
    const res = await query('SELECT * FROM questions WHERE test_id = $1 ORDER BY id ASC', [testId]);
    return res.rows;
  },

  // Results
  async saveResult(testId, studentName, studentEmail, studentId, score, totalQuestions, tabSwitches, terminatedByProctor = 0) {
    return query(
      `INSERT INTO results (test_id, student_name, student_email, student_id, score, total_questions, tab_switches, terminated_by_proctor) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [testId, studentName.trim(), studentEmail.trim(), studentId.trim(), score, totalQuestions, tabSwitches, terminatedByProctor ? 1 : 0]
    );
  },

  async getResultsByTest(testId) {
    const res = await query(
      `SELECT * FROM results WHERE test_id = $1 ORDER BY score DESC, submitted_at ASC`,
      [testId]
    );
    return res.rows;
  },

  async getAllResults() {
    const res = await query(
      `SELECT r.*, t.name as test_name, s.name as sector_name
       FROM results r
       JOIN tests t ON r.test_id = t.id
       JOIN sectors s ON t.sector_id = s.id
       ORDER BY r.submitted_at DESC`
    );
    return res.rows;
  },

  // Multi-Admin Helpers
  async createAdmin(username, passwordHash) {
    const trimmedUsername = username.trim().toLowerCase();
    const countRes = await query('SELECT COUNT(*) as count FROM admins');
    const count = parseInt(countRes.rows[0].count, 10);
    const isApproved = count === 0; // First admin is auto-approved

    return query(
      'INSERT INTO admins (username, password, is_approved) VALUES ($1, $2, $3)',
      [trimmedUsername, passwordHash, isApproved]
    );
  },

  async getAdminByUsername(username) {
    const trimmedUsername = username.trim().toLowerCase();
    const res = await query('SELECT * FROM admins WHERE username = $1', [trimmedUsername]);
    return res.rows[0];
  },

  async countAdmins() {
    const res = await query('SELECT COUNT(*) as count FROM admins');
    const row = res.rows[0];
    return row ? parseInt(row.count, 10) : 0;
  },

  async getAllAdmins() {
    const res = await query('SELECT id, username, is_approved, created_at FROM admins ORDER BY id ASC');
    return res.rows;
  },

  async setAdminApproval(adminId, isApproved) {
    return query('UPDATE admins SET is_approved = $1 WHERE id = $2', [isApproved, adminId]);
  },

  async deleteAdmin(adminId) {
    return query('DELETE FROM admins WHERE id = $1', [adminId]);
  },

  // Test Results Release Status Control
  async setTestResultsReleaseStatus(testId, isReleased) {
    const status = isReleased ? 1 : 0;
    return query('UPDATE tests SET results_released = $1 WHERE id = $2', [status, testId]);
  }
};
