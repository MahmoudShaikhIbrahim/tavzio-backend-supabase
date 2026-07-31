const express = require('express');
const multer = require('multer');
const { extractMenu, publishMenu } = require('../controllers/menuAiController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// Memory storage - files are read once for the Claude call (and, for
// images, for cropping) and never need to touch disk. 15MB per file
// comfortably covers a phone photo or a scanned PDF page; 25 files caps
// a reasonable multi-page/multi-photo menu upload without letting a
// single request balloon indefinitely.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
});

router.post('/extract', upload.array('files', 25), extractMenu);
router.post('/publish', publishMenu);

module.exports = router;
