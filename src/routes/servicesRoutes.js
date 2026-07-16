const express = require('express');
const { listServices, createService, updateService, deleteService } = require('../controllers/servicesController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listServices);
router.post('/', createService);
router.patch('/:serviceId', updateService);
router.delete('/:serviceId', deleteService);

module.exports = router;
