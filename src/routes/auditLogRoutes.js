const express = require('express');
const { listAuditLog } = require('../controllers/auditLogController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listAuditLog);

module.exports = router;
