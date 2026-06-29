# BPHC Testing Platform

A secure, multi-sector examination and assessment platform built with Node.js, Express, SQLite, and SheetJS. This platform allows administrators to upload exam papers via Excel files, configure proctoring/time parameters, schedule active windows, and export detailed results back to Excel.

---

## Key Features

### 1. Administrative Capabilities
- **Excel Test Uploads:** Create tests instantly by uploading standard spreadsheet formats (.xlsx, .xls, .csv). The server transactionally parses and validates questions, options, and explanations.
- **Dynamic Active Windows:** Set optional Start and Close windows for exams. The system prevents candidates from loading questions or submitting answers outside this timeframe.
- **Results Management & Exporter:** Click on any test to inspect its specific results, check statistics, or export formatted student lists directly to a real Excel spreadsheet (.xlsx).
- **Score Visibility Control:** Hide or release results visibility to student portals with a single toggle.
- **Multi-Admin Portals:** Hashed password-protected admin registration and JWT session authentication.

### 2. Candidate Interface
- **Portal Selection:** View available testing categories (Sectors) and active assessments.
- **Exam Dashboard:** Easy-to-use question panels with instant-jump grids and response indicators.
- **UX Controls:** Supports keyboard navigation (Arrow keys to navigate, A, B, C, D keys to select options).

### 3. Proctoring Security ("Aegis Security")
- **Focus Monitor:** Track tab-switching, minimization, or workspace changes. Shows an alert overlay and logs focus warning count.
- **Fullscreen Lock:** Forces fullscreen mode. Escaping fullscreen triggers a warning.
- **OS Intercepts:** Disables right-clicks (context menu), text selection, and copy/cut/paste commands.
- **Threshold Disqualification:** Instantly locks and submits candidate assessments as "DISQUALIFIED" if focus violations exceed the maximum warning limit.
- **Local Cache Resiliency:** Restores test state, answers, warnings, and timers from localStorage in case of accidental browser reloads.

---

## Getting Started

### Prerequisites
- Node.js (version 18.0.0 or higher)

### Setup & Installation
1. Clone the repository and navigate into the workspace.
2. Install dependencies:
   `ash
   npm install
   `
3. Configure the .env file in the root directory:
   `env
   PORT=3000
   ADMIN_PASSWORD=admin12345
   DATABASE_FILE=database.sqlite
   `
4. Run the development server:
   `ash
   npm run dev
   `
5. Access the portals:
   - **Student Portal:** http://localhost:3000
   - **Admin Console:** http://localhost:3000/admin.html (Use user dmin and password dmin12345)

---

## Vercel Deployment Warning ⚠️

This application uses **SQLite** (database.sqlite) to store all test data, admin accounts, and student submissions. 

> [!WARNING]
> **Vercel uses an ephemeral, read-only serverless file system.** 
> If you deploy this project directly to Vercel:
> - SQLite will fail to write results to disk, or any data saved (tests, student results, new admin accounts) will be wiped out when serverless functions spin down or reset.
> - Your data will **not** be persisted.

### Recommended Deployment Paths:
1. **Deploy to a Persistent VM / Container:**
   Deploy to hosts like **Render**, **Railway**, **Heroku**, or a **standard VPS** (DigitalOcean, AWS EC2) and attach a persistent storage volume to hold database.sqlite.
2. **Migrate to a Cloud Database (For Vercel):**
   If you want to use Vercel, modify [database.js](database.js) to connect to a cloud relational database (such as **PostgreSQL** from Supabase, Neon, or Vercel Postgres, or **MySQL** from PlanetScale). 
