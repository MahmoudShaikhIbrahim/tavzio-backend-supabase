const express = require('express');
const {
  listServices, createService, updateService, deleteService,
  listServiceOptions, createServiceOption, updateServiceOption, deleteServiceOption,
} = require('../controllers/servicesController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listServices);
router.post('/', createService);
router.patch('/:serviceId', updateService);
router.delete('/:serviceId', deleteService);
router.get('/:serviceId/options', listServiceOptions);
router.post('/:serviceId/options', createServiceOption);
router.patch('/:serviceId/options/:optionId', updateServiceOption);
router.delete('/:serviceId/options/:optionId', deleteServiceOption);

module.exports = router;
