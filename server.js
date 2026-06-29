const express = require('express');
const multer = require('multer');
const xlsx = require('xlsx');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();

const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Crypto & JWT Helpers
const JWT_SECRET = process.env.SESSION_SECRET || 'aegis_secure_session_secret_2026';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword || !storedPassword.includes(':')) return false;
  const [salt, hash] = storedPassword.split(':');
  const verifyHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === verifyHash;
}

function generateToken(username) {
  const expiration = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  const payload = `${username}:${expiration}`;
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return `${payload}:${signature}`;
}

function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  const [username, expirationStr, signature] = parts;
  const expiration = parseInt(expirationStr, 10);
  
  if (expiration < Date.now()) return null; // Expired
  
  const payload = `${username}:${expiration}`;
  const expectedSignature = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  
  if (signature === expectedSignature) {
    return username;
  }
  return null;
}

// Setup middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Configure Multer for Excel file uploads (in-memory storage)
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    const filetypes = /xlsx|xls|csv/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    if (extname) {
      return cb(null, true);
    }
    cb(new Error('Only Excel files (.xlsx, .xls) or CSV files are allowed!'));
  }
});

// Helper to parse and decode cookies
function getCookies(req) {
  if (!req.headers.cookie) return {};
  const list = {};
  req.headers.cookie.split(';').forEach(cookie => {
    const parts = cookie.split('=');
    if (parts.length >= 2) {
      const name = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      try {
        list[name] = decodeURIComponent(val);
      } catch (e) {
        list[name] = val;
      }
    }
  });
  return list;
}

// Admin Authentication Middleware
function checkAdminAuth(req, res, next) {
  const cookies = getCookies(req);
  const token = cookies.admin_token;
  const authHeader = req.headers['x-admin-token'];
  
  const verifiedUser = verifyToken(token || authHeader);
  
  if (verifiedUser) {
    req.adminUser = verifiedUser;
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized: Session expired or invalid admin token' });
  }
}

// Ensure database is initialized before starting server
db.initializeDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}).catch(err => {
  console.error('Failed to initialize database, shutting down:', err);
  process.exit(1);
});

// --- API ENDPOINTS ---

// Admin Setup Status Check
app.get('/api/admin/setup-status', async (req, res) => {
  try {
    const count = await db.countAdmins();
    res.json({ setupRequired: count === 0 });
  } catch (error) {
    console.error('Error counting admins:', error);
    res.status(500).json({ error: 'Failed to check setup status.' });
  }
});

// Admin Registration (first signup is free, subsequent require admin credentials)
app.post('/api/admin/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password || username.trim().length < 3 || password.length < 5) {
      return res.status(400).json({ error: 'Invalid input. Username must be at least 3 chars and password at least 5 chars.' });
    }

    const count = await db.countAdmins();
    if (count > 0) {
      // Require verification to create other admins
      const cookies = getCookies(req);
      const token = cookies.admin_token;
      const verifiedUser = verifyToken(token);
      if (!verifiedUser) {
        return res.status(401).json({ error: 'Only authenticated administrators can register new administrators.' });
      }
    }

    const existing = await db.getAdminByUsername(username);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    const passwordHash = hashPassword(password);
    await db.createAdmin(username, passwordHash);
    res.json({ success: true, message: 'Admin account created successfully.' });
  } catch (error) {
    console.error('Error registering admin:', error);
    res.status(500).json({ error: 'Failed to register admin account.' });
  }
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const admin = await db.getAdminByUsername(username);
    if (!admin || !verifyPassword(password, admin.password)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = generateToken(admin.username);
    res.cookie('admin_token', token, { maxAge: 86400000, httpOnly: true });
    res.clearCookie('admin_pass'); // clean up old auth style
    res.json({ success: true, message: 'Logged in successfully', username: admin.username });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'An error occurred during login.' });
  }
});

// Admin Log Out
app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.json({ success: true, message: 'Logged out successfully' });
});

// Admin Check Auth Status
app.get('/api/admin/check', (req, res) => {
  const cookies = getCookies(req);
  const token = cookies.admin_token;
  const verifiedUser = verifyToken(token);
  
  if (verifiedUser) {
    res.json({ authenticated: true, username: verifiedUser });
  } else {
    res.json({ authenticated: false });
  }
});

// Admin Dynamic Excel Template Generation
app.get('/api/admin/template', (req, res) => {
  try {
    const templateData = [
      {
        "Question": "What is the primary language used for web styling?",
        "Option A": "HTML",
        "Option B": "SQL",
        "Option C": "CSS",
        "Option D": "Python",
        "Correct Option": "C",
        "Explanation": "CSS (Cascading Style Sheets) is used to format the layout and style of web pages."
      },
      {
        "Question": "Which programming language is known for run-time execution in the browser?",
        "Option A": "Java",
        "Option B": "JavaScript",
        "Option C": "C++",
        "Option D": "Swift",
        "Correct Option": "B",
        "Explanation": "JavaScript is the native programming language supported by all modern web browsers."
      }
    ];

    const worksheet = xlsx.utils.json_to_sheet(templateData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Questions Template");
    
    // Write buffer and send response
    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=questions_template.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error generating template:', error);
    res.status(500).json({ error: 'Failed to generate Excel template.' });
  }
});

// Admin Upload Test (Excel Upload)
app.post('/api/admin/upload-test', checkAdminAuth, upload.single('file'), async (req, res) => {
  try {
    const { sectorName, testName, durationMins, proctoringEnabled, maxWarnings, windowStart, windowEnd } = req.body;
    const file = req.file;

    if (!sectorName || !testName || !file) {
      return res.status(400).json({ error: 'Missing required fields: sectorName, testName, and file are required.' });
    }

    const duration = parseInt(durationMins, 10) || 0;
    const proctorEnabled = proctoringEnabled === 'true' || proctoringEnabled === '1' || proctoringEnabled === true ? 1 : 0;
    const warningsLimit = parseInt(maxWarnings, 10) >= 0 ? parseInt(maxWarnings, 10) : 3;
    const startVal = windowStart && windowStart.trim() !== '' ? windowStart : null;
    const endVal = windowEnd && windowEnd.trim() !== '' ? windowEnd : null;

    // Parse Excel file from buffer
    const workbook = xlsx.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet);

    if (rows.length === 0) {
      return res.status(400).json({ error: 'The uploaded sheet is empty.' });
    }

    // Validate headers
    const firstRow = rows[0];
    const keys = Object.keys(firstRow).map(k => k.toLowerCase().replace(/\s+/g, ''));
    
    const requiredKeys = ['question', 'optiona', 'optionb', 'optionc', 'optiond', 'correctoption'];
    const missing = requiredKeys.filter(k => !keys.includes(k));

    if (missing.length > 0) {
      return res.status(400).json({ 
        error: `Invalid template format. The sheet is missing columns corresponding to: ${missing.join(', ')}.` 
      });
    }

    // Process using PostgreSQL Transaction to ensure atomicity
    const result = await db.transaction(async (client) => {
      const sector = await db.getOrCreateSector(sectorName, client);
      const testId = await db.createTest(sector.id, testName, duration, proctorEnabled, warningsLimit, startVal, endVal, client);

      let questionCount = 0;
      for (const row of rows) {
        // Map raw row headers to fields dynamically
        let qText = '';
        let optA = '';
        let optB = '';
        let optC = '';
        let optD = '';
        let correct = '';
        let explanation = '';

        for (const [key, val] of Object.entries(row)) {
          const normalizedKey = key.toLowerCase().replace(/\s+/g, '');
          const strVal = val !== undefined && val !== null ? String(val).trim() : '';

          if (normalizedKey === 'question') qText = strVal;
          else if (normalizedKey === 'optiona') optA = strVal;
          else if (normalizedKey === 'optionb') optB = strVal;
          else if (normalizedKey === 'optionc') optC = strVal;
          else if (normalizedKey === 'optiond') optD = strVal;
          else if (normalizedKey === 'correctoption') correct = strVal;
          else if (normalizedKey === 'explanation') explanation = strVal;
        }

        if (qText && optA && optB && optC && optD && correct) {
          // Validate correct option input
          const cleanCorrect = correct.toUpperCase();
          if (!['A', 'B', 'C', 'D'].includes(cleanCorrect)) {
            throw new Error(`Invalid correct option value "${correct}" for question: "${qText}". Must be A, B, C, or D.`);
          }
          await db.addQuestion(testId, qText, optA, optB, optC, optD, cleanCorrect, explanation, client);
          questionCount++;
        }
      }

      if (questionCount === 0) {
        throw new Error('No valid questions could be imported. Please verify your spreadsheet row entries.');
      }

      return { testId, questionCount, sectorName: sector.name };
    });

    res.json({
      success: true,
      message: `Successfully created test "${testName}" in sector "${result.sectorName}" with ${result.questionCount} questions.`,
      testId: result.testId
    });

  } catch (error) {
    console.error('Error importing test:', error);
    res.status(500).json({ error: error.message || 'An error occurred while importing the test data.' });
  }
});

// Admin Get All Test Results
app.get('/api/admin/results', checkAdminAuth, async (req, res) => {
  try {
    const results = await db.getAllResults();
    res.json(results);
  } catch (error) {
    console.error('Error fetching results:', error);
    res.status(500).json({ error: 'Failed to fetch results.' });
  }
});

// Admin Export Results to Excel
app.get('/api/admin/results/export', checkAdminAuth, async (req, res) => {
  try {
    const testId = req.query.testId;
    const allResults = await db.getAllResults();
    
    const dataToExport = (!testId || testId === 'all')
      ? allResults
      : allResults.filter(res => res.test_id === parseInt(testId, 10));

    // Map database results to matching table headers for Excel
    const excelData = dataToExport.map(row => {
      const percentage = ((row.score / row.total_questions) * 100).toFixed(1);
      const isDisqualified = row.terminated_by_proctor === 1;
      
      return {
        "Student Name": row.student_name,
        "Student ID": row.student_id,
        "Student Email": row.student_email,
        "Sector": row.sector_name,
        "Test Name": row.test_name,
        "Score": isDisqualified ? "DISQUALIFIED" : row.score,
        "Total Questions": row.total_questions,
        "Percentage": isDisqualified ? "Violation" : `${percentage}%`,
        "Tab Switches / Warnings": row.tab_switches,
        "Submitted At": new Date(row.submitted_at).toLocaleString()
      };
    });

    const worksheet = xlsx.utils.json_to_sheet(excelData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, "Student Results");

    // Adjust column widths automatically to prevent cut-off values in Excel
    const maxColWidths = [];
    excelData.forEach(row => {
      Object.keys(row).forEach((key, colIndex) => {
        const val = row[key] !== undefined && row[key] !== null ? String(row[key]) : '';
        const len = Math.max(val.length, key.length);
        maxColWidths[colIndex] = Math.max(maxColWidths[colIndex] || 10, len + 2);
      });
    });
    worksheet['!cols'] = maxColWidths.map(w => ({ wch: w }));

    const buffer = xlsx.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    
    res.setHeader('Content-Disposition', `attachment; filename=aegis_assessment_results_${new Date().toISOString().slice(0,10)}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (error) {
    console.error('Error exporting results:', error);
    res.status(500).json({ error: 'Failed to export results to Excel.' });
  }
});

// Admin Get Specific Test Results
app.get('/api/admin/tests/:testId/results', checkAdminAuth, async (req, res) => {
  try {
    const results = await db.getResultsByTest(parseInt(req.params.testId, 10));
    res.json(results);
  } catch (error) {
    console.error('Error fetching test results:', error);
    res.status(500).json({ error: 'Failed to fetch test results.' });
  }
});

// Admin Delete Test
app.delete('/api/admin/tests/:testId', checkAdminAuth, async (req, res) => {
  try {
    await db.deleteTest(parseInt(req.params.testId, 10));
    res.json({ success: true, message: 'Test and associated questions/results deleted successfully.' });
  } catch (error) {
    console.error('Error deleting test:', error);
    res.status(500).json({ error: 'Failed to delete test.' });
  }
});

// Admin Set Test Results Release Status
app.patch('/api/admin/tests/:testId/release', checkAdminAuth, async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const { resultsReleased } = req.body;
    
    if (resultsReleased === undefined) {
      return res.status(400).json({ error: 'Missing resultsReleased boolean in request body.' });
    }
    
    await db.setTestResultsReleaseStatus(testId, !!resultsReleased);
    res.json({ success: true, message: `Results release status updated successfully.` });
  } catch (error) {
    console.error('Error changing results release status:', error);
    res.status(500).json({ error: 'Failed to update results release status.' });
  }
});

// --- STUDENT PORTAL ENDPOINTS ---

// Get all sectors
app.get('/api/sectors', async (req, res) => {
  try {
    const sectors = await db.getAllSectors();
    res.json(sectors);
  } catch (error) {
    console.error('Error fetching sectors:', error);
    res.status(500).json({ error: 'Failed to fetch sectors.' });
  }
});

// Get tests by sector
app.get('/api/sectors/:sectorId/tests', async (req, res) => {
  try {
    const sectorId = parseInt(req.params.sectorId, 10);
    const tests = await db.getTestsBySector(sectorId);
    res.json(tests);
  } catch (error) {
    console.error('Error fetching tests:', error);
    res.status(500).json({ error: 'Failed to fetch tests.' });
  }
});

// Get test metadata
app.get('/api/tests/:testId', async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const test = await db.getTestById(testId);
    if (!test) {
      return res.status(404).json({ error: 'Test not found.' });
    }
    res.json(test);
  } catch (error) {
    console.error('Error fetching test metadata:', error);
    res.status(500).json({ error: 'Failed to fetch test metadata.' });
  }
});

// Get test questions (EXCLUDING correct answers and explanations for safety!)
app.get('/api/tests/:testId/questions', async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const test = await db.getTestById(testId);
    if (!test) {
      return res.status(404).json({ error: 'Test not found.' });
    }

    const now = new Date();
    if (test.window_start && new Date(test.window_start) > now) {
      return res.status(403).json({ error: `Assessment has not started yet. It will open at ${new Date(test.window_start).toLocaleString()}.` });
    }
    if (test.window_end && new Date(test.window_end) < now) {
      return res.status(403).json({ error: 'Assessment is closed. The submission window ended.' });
    }

    const questions = await db.getQuestionsByTest(testId);
    
    // Map to remove correct_option and explanation fields
    const safeQuestions = questions.map(q => ({
      id: q.id,
      question_text: q.question_text,
      option_a: q.option_a,
      option_b: q.option_b,
      option_c: q.option_c,
      option_d: q.option_d
    }));
    
    res.json(safeQuestions);
  } catch (error) {
    console.error('Error fetching questions:', error);
    res.status(500).json({ error: 'Failed to fetch questions.' });
  }
});

// Submit test and grade it
app.post('/api/tests/:testId/submit', async (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const { studentName, studentEmail, studentId, answers, tabSwitches, terminatedByProctor } = req.body;

    if (!studentName || !studentEmail || !studentId || !answers) {
      return res.status(400).json({ error: 'Missing required student details or answers.' });
    }

    const test = await db.getTestById(testId);
    if (!test) {
      return res.status(404).json({ error: 'Test not found.' });
    }

    // Check if test window has ended (with a 2-minute clock drift buffer)
    const now = new Date();
    const graceBuffer = 2 * 60 * 1000;
    if (test.window_end && new Date(test.window_end).getTime() + graceBuffer < now.getTime()) {
      return res.status(403).json({ error: 'This assessment submission window has closed.' });
    }

    // Fetch correct options from DB
    const questions = await db.getQuestionsByTest(testId);
    let score = 0;
    const feedbackQuestions = [];

    for (const q of questions) {
      const studentAns = (answers[q.id] || '').toUpperCase().trim();
      const isCorrect = studentAns === q.correct_option;
      if (isCorrect) {
        score++;
      }
      
      feedbackQuestions.push({
        id: q.id,
        question_text: q.question_text,
        option_a: q.option_a,
        option_b: q.option_b,
        option_c: q.option_c,
        option_d: q.option_d,
        selected_option: studentAns,
        correct_option: q.correct_option,
        explanation: q.explanation,
        is_correct: isCorrect
      });
    }

    const switches = parseInt(tabSwitches, 10) || 0;
    const terminated = terminatedByProctor === 'true' || terminatedByProctor === '1' || terminatedByProctor === true;

    // Save result to database
    await db.saveResult(
      testId,
      studentName,
      studentEmail,
      studentId,
      score,
      questions.length,
      switches,
      terminated ? 1 : 0
    );

    const resultsReleased = test.results_released === 1;

    if (terminated) {
      res.json({
        success: true,
        terminated: true,
        message: 'Your assessment was automatically locked and submitted due to a proctoring warning threshold violation.'
      });
    } else if (!resultsReleased) {
      res.json({
        success: true,
        results_released: false,
        message: 'Your answers have been submitted successfully. The administrator will release the results later.'
      });
    } else {
      res.json({
        success: true,
        results_released: true,
        score: score,
        total: questions.length,
        percentage: ((score / questions.length) * 100).toFixed(1),
        questions: feedbackQuestions
      });
    }

  } catch (error) {
    console.error('Error submitting test answers:', error);
    res.status(500).json({ error: 'An error occurred while grading your test submission.' });
  }
});
