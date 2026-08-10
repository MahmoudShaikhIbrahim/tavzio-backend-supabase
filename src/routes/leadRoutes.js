const express = require('express');
const { listLeads, markLeadConverted } = require('../controllers/leadController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect, authorize('super_admin'));

router.get('/', listLeads);
router.patch('/:leadId', markLeadConverted);

module.exports = router;
