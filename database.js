const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = path.join(__dirname, process.env.DATABASE_FILE || 'database.sqlite');

// Connect to SQLite Database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    db.run('PRAGMA foreign_keys = ON'); // Enable foreign key constraints
  }
});

// Helper functions wrapping sqlite3 operations in Promises
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve({ id: this.lastID, changes: this.changes });
      }
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

// Transaction wrapper helper
function transaction(fn) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run('BEGIN TRANSACTION', (err) => {
        if (err) return reject(err);
        fn()
          .then((res) => {
            db.run('COMMIT', (commitErr) => {
              if (commitErr) reject(commitErr);
              else resolve(res);
            });
          })
          .catch((fnErr) => {
            db.run('ROLLBACK', () => {
              reject(fnErr);
            });
          });
      });
    });
  });
}

// Initialize tables
async function initializeDatabase() {
  try {
    // Create Admins table
    await run(`
      CREATE TABLE IF NOT EXISTS admins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Sectors table
    await run(`
      CREATE TABLE IF NOT EXISTS sectors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      )
    `);

    // Create Tests table
    await run(`
      CREATE TABLE IF NOT EXISTS tests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sector_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        duration_mins INTEGER NOT NULL DEFAULT 30,
        results_released INTEGER NOT NULL DEFAULT 0,
        proctoring_enabled INTEGER NOT NULL DEFAULT 0,
        max_warnings INTEGER NOT NULL DEFAULT 3,
        window_start DATETIME,
        window_end DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sector_id) REFERENCES sectors(id) ON DELETE CASCADE
      )
    `);

    // Dynamic schema update: try to add results_released, proctoring_enabled, max_warnings to tests table if they weren't there
    try {
      await run('ALTER TABLE tests ADD COLUMN results_released INTEGER DEFAULT 0');
    } catch (alterError) {}
    try {
      await run('ALTER TABLE tests ADD COLUMN proctoring_enabled INTEGER DEFAULT 0');
    } catch (alterError) {}
    try {
      await run('ALTER TABLE tests ADD COLUMN max_warnings INTEGER DEFAULT 3');
    } catch (alterError) {}
    try {
      await run('ALTER TABLE tests ADD COLUMN window_start DATETIME');
    } catch (alterError) {}
    try {
      await run('ALTER TABLE tests ADD COLUMN window_end DATETIME');
    } catch (alterError) {}

    // Create Questions table
    await run(`
      CREATE TABLE IF NOT EXISTS questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option TEXT NOT NULL,
        explanation TEXT,
        FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
      )
    `);

    // Create Results table
    await run(`
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        test_id INTEGER NOT NULL,
        student_name TEXT NOT NULL,
        student_email TEXT NOT NULL,
        student_id TEXT NOT NULL,
        score INTEGER NOT NULL,
        total_questions INTEGER NOT NULL,
        tab_switches INTEGER DEFAULT 0,
        terminated_by_proctor INTEGER DEFAULT 0,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
      )
    `);

    // Dynamic schema update: try to add terminated_by_proctor to results table
    try {
      await run('ALTER TABLE results ADD COLUMN terminated_by_proctor INTEGER DEFAULT 0');
    } catch (alterError) {}

    console.log('Database schema initialized successfully.');
  } catch (err) {
    console.error('Error initializing database:', err);
  }
}

// Database helper functions
module.exports = {
  db,
  run,
  get,
  all,
  transaction,
  initializeDatabase,

  // Sectors
  async getOrCreateSector(name) {
    const trimmedName = name.trim();
    let sector = await get('SELECT * FROM sectors WHERE LOWER(name) = LOWER(?)', [trimmedName]);
    if (!sector) {
      const result = await run('INSERT INTO sectors (name) VALUES (?)', [trimmedName]);
      sector = { id: result.id, name: trimmedName };
    }
    return sector;
  },

  async getAllSectors() {
    return all('SELECT * FROM sectors ORDER BY name ASC');
  },

  // Tests
  async createTest(sectorId, name, durationMins, proctoringEnabled = 0, maxWarnings = 3, windowStart = null, windowEnd = null) {
    const result = await run(
      'INSERT INTO tests (sector_id, name, duration_mins, proctoring_enabled, max_warnings, window_start, window_end) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sectorId, name, durationMins, proctoringEnabled ? 1 : 0, maxWarnings, windowStart, windowEnd]
    );
    return result.id;
  },

  async getTestsBySector(sectorId) {
    return all('SELECT * FROM tests WHERE sector_id = ? ORDER BY created_at DESC', [sectorId]);
  },

  async getTestById(testId) {
    return get(
      `SELECT t.*, s.name as sector_name 
       FROM tests t 
       JOIN sectors s ON t.sector_id = s.id 
       WHERE t.id = ?`,
      [testId]
    );
  },

  async deleteTest(testId) {
    return run('DELETE FROM tests WHERE id = ?', [testId]);
  },

  // Questions
  async addQuestion(testId, questionText, a, b, c, d, correct, explanation) {
    return run(
      `INSERT INTO questions (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, explanation) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [testId, questionText, a, b, c, d, correct.toUpperCase().trim(), explanation]
    );
  },

  async getQuestionsByTest(testId) {
    return all('SELECT * FROM questions WHERE test_id = ? ORDER BY id ASC', [testId]);
  },

  // Results
  async saveResult(testId, studentName, studentEmail, studentId, score, totalQuestions, tabSwitches, terminatedByProctor = 0) {
    return run(
      `INSERT INTO results (test_id, student_name, student_email, student_id, score, total_questions, tab_switches, terminated_by_proctor) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [testId, studentName.trim(), studentEmail.trim(), studentId.trim(), score, totalQuestions, tabSwitches, terminatedByProctor ? 1 : 0]
    );
  },

  async getResultsByTest(testId) {
    return all(
      `SELECT * FROM results WHERE test_id = ? ORDER BY score DESC, submitted_at ASC`,
      [testId]
    );
  },

  async getAllResults() {
    return all(
      `SELECT r.*, t.name as test_name, s.name as sector_name
       FROM results r
       JOIN tests t ON r.test_id = t.id
       JOIN sectors s ON t.sector_id = s.id
       ORDER BY r.submitted_at DESC`
    );
  },

  // Multi-Admin Helpers
  async createAdmin(username, passwordHash) {
    const trimmedUsername = username.trim().toLowerCase();
    return run(
      'INSERT INTO admins (username, password) VALUES (?, ?)',
      [trimmedUsername, passwordHash]
    );
  },

  async getAdminByUsername(username) {
    const trimmedUsername = username.trim().toLowerCase();
    return get('SELECT * FROM admins WHERE username = ?', [trimmedUsername]);
  },

  async countAdmins() {
    const row = await get('SELECT COUNT(*) as count FROM admins');
    return row ? row.count : 0;
  },

  // Test Results Release Status Control
  async setTestResultsReleaseStatus(testId, isReleased) {
    const status = isReleased ? 1 : 0;
    return run('UPDATE tests SET results_released = ? WHERE id = ?', [status, testId]);
  }
};
