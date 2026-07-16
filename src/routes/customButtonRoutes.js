const express = require('express');
const {
  listCustomButtons, createCustomButton, updateCustomButton, deleteCustomButton,
} = require('../controllers/customButtonController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listCustomButtons);
router.post('/', createCustomButton);
router.patch('/:buttonId', updateCustomButton);
router.delete('/:buttonId', deleteCustomButton);

module.exports = router;
