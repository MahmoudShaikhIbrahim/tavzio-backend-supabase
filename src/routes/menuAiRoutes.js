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
const ALLOWED_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 25 },
  // Restrict to the file types the extractor actually handles - without
  // this, multer accepts any content type, meaning someone could upload
  // an .exe, .html, or .js file renamed with an image extension and have
  // it sit in memory and get processed. This checks the browser-supplied
  // mimetype, which isn't a hard guarantee (it can be spoofed), but combined
  // with the extractor only ever treating the buffer as image/PDF bytes
  // it closes the obvious "wrong file type entirely" case.
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMETYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Only JPEG, PNG, WEBP, HEIC, and PDF are accepted.`));
    }
    cb(null, true);
  },
});

router.post('/extract', upload.array('files', 25), extractMenu);
router.post('/publish', publishMenu);

module.exports = router;
