const express = require('express');
const { PDFDocument } = require('pdf-lib');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Ensure directories exist
const uploadsDir = path.join(__dirname, 'uploads');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Database files
const NOTES_FILE = path.join(dataDir, 'notes.json');
const USERS_FILE = path.join(dataDir, 'users.json');

// Initialize data files if they don't exist
if (!fs.existsSync(NOTES_FILE)) fs.writeFileSync(NOTES_FILE, JSON.stringify([]));
if (!fs.existsSync(USERS_FILE)) {
  const initialUsers = {
    teachers: [
      { id: "teacher1", username: "teacher1", password: "pass123", name: "Prof. Smith", batches: ["batch1", "batch2"] },
      { id: "teacher2", username: "teacher2", password: "pass456", name: "Dr. Johnson", batches: ["batch2", "batch3"] }
    ],
    students: [
      { id: "student1", username: "alice", password: "alice123", name: "Alice Johnson", batch: "batch1", email: "alice@example.com" },
      { id: "student2", username: "bob", password: "bob123", name: "Bob Smith", batch: "batch1", email: "bob@example.com" },
      { id: "student3", username: "carol", password: "carol123", name: "Carol Davis", batch: "batch1", email: "carol@example.com" },
      { id: "student4", username: "dave", password: "dave123", name: "Dave Wilson", batch: "batch2", email: "dave@example.com" },
      { id: "student5", username: "eve", password: "eve123", name: "Eve Brown", batch: "batch2", email: "eve@example.com" }
    ]
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(initialUsers, null, 2));
}

// Helper functions
function readNotes() {
  return JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
}

function writeNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
}

function readUsers() {
  return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
}

// Batch data (for display)
const batches = {
  "batch1": { name: "Morning Batch (CS101)", students: ["alice", "bob", "carol"] },
  "batch2": { name: "Afternoon Batch (CS102)", students: ["dave", "eve"] },
  "batch3": { name: "Evening Batch (CS103)", students: [] }
};

// ---------- API Endpoints ----------

// Teacher login
app.post('/api/teacher/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const teacher = users.teachers.find(t => t.username === username && t.password === password);
  if (teacher) {
    res.json({ success: true, teacher: { id: teacher.id, name: teacher.name, batches: teacher.batches } });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// Student login
app.post('/api/student/login', (req, res) => {
  const { username, password } = req.body;
  const users = readUsers();
  const student = users.students.find(s => s.username === username && s.password === password);
  if (student) {
    res.json({ success: true, student: { id: student.id, name: student.name, batch: student.batch, email: student.email } });
  } else {
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

// Get teacher's batches (with student lists)
app.get('/api/teacher/batches/:teacherId', (req, res) => {
  const { teacherId } = req.params;
  const users = readUsers();
  const teacher = users.teachers.find(t => t.id === teacherId);
  if (!teacher) return res.status(404).json({ error: 'Teacher not found' });

  const teacherBatches = teacher.batches.map(batchId => ({
    id: batchId,
    name: batches[batchId]?.name || batchId,
    students: batches[batchId]?.students || []
  }));
  res.json(teacherBatches);
});

// Save whiteboard and create note (PDF)
app.post('/api/notes/save', async (req, res) => {
  try {
    const { images, pageImages, pdfBase64, teacherId, teacherName, batchId, title } = req.body;
    const usedImages = images || pageImages;
    if (!usedImages && !pdfBase64) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!batchId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let pdfBytes;
    if (pdfBase64) {
      pdfBytes = Buffer.from(pdfBase64, 'base64');
    } else {
      // Generate PDF from image pages
      const pdfDoc = await PDFDocument.create();
      for (const imageBase64 of usedImages) {
        const imageBytes = Buffer.from(imageBase64, 'base64');
        const pngImage = await pdfDoc.embedPng(imageBytes);
        const { width, height } = pngImage.scale(1);
        const page = pdfDoc.addPage([width, height]);
        page.drawImage(pngImage, { x: 0, y: 0, width, height });
      }
      pdfBytes = await pdfDoc.save();
    }

    // Save PDF file
    const noteId = uuidv4();
    const filename = `${noteId}.pdf`;
    const filepath = path.join(uploadsDir, filename);
    fs.writeFileSync(filepath, pdfBytes);

    // Save metadata
    const notes = readNotes();
    const newNote = {
      id: noteId,
      title: title || `Notes - ${new Date().toLocaleString()}`,
      teacherId,
      teacherName,
      batchId,
      batchName: batches[batchId]?.name || batchId,
      filename,
      createdAt: new Date().toISOString(),
      pageCount: (usedImages || []).length
    };
    notes.push(newNote);
    writeNotes(notes);

    res.json({ success: true, note: newNote });
  } catch (error) {
    console.error('Error saving note:', error);
    res.status(500).json({ error: 'Failed to save note' });
  }
});

// Get notes for a student (by batch)
app.get('/api/notes/student/:studentId', (req, res) => {
  const { studentId } = req.params;
  const users = readUsers();
  const student = users.students.find(s => s.id === studentId);
  if (!student) return res.status(404).json({ error: 'Student not found' });

  const notes = readNotes();
  const studentNotes = notes
    .filter(note => note.batchId === student.batch)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(studentNotes);
});

// Get notes for a teacher (by teacher ID)
app.get('/api/notes/teacher/:teacherId', (req, res) => {
  const { teacherId } = req.params;
  const notes = readNotes();
  const teacherNotes = notes
    .filter(note => note.teacherId === teacherId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  res.json(teacherNotes);
});

// Download PDF
app.get('/api/notes/download/:noteId', (req, res) => {
  const { noteId } = req.params;
  const notes = readNotes();
  const note = notes.find(n => n.id === noteId);
  if (!note) return res.status(404).json({ error: 'Note not found' });

  const filepath = path.join(uploadsDir, note.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

  res.download(filepath, `${note.title}.pdf`);
});

// Serve frontend pages
app.get('/teacher', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/teacher.html'));
});

app.get('/student', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/student.html'));
});

app.get('/', (req, res) => {
  res.send(`
        <h2>SDA Education Platform</h2>
        <ul>
            <li><a href="/teacher">Teacher Login → Whiteboard</a></li>
            <li><a href="/student">Student Login → My Notes</a></li>
        </ul>
    `);
});

app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`📝 Teacher: http://localhost:${PORT}/teacher`);
  console.log(`📚 Student: http://localhost:${PORT}/student`);
});