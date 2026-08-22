const express = require('express');
const {
  listTemplates, createTemplate, deleteTemplate,
  listCampaigns, createCampaign, sendCampaign, cancelCampaign, getCampaignStats,
  listSuppressions, addSuppression, removeSuppression,
} = require('../controllers/marketingController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/templates', listTemplates);
router.post('/templates', createTemplate);
router.delete('/templates/:templateId', deleteTemplate);

router.get('/campaigns', listCampaigns);
router.post('/campaigns', createCampaign);
router.post('/campaigns/:campaignId/send', sendCampaign);
router.patch('/campaigns/:campaignId/cancel', cancelCampaign);
router.get('/campaigns/:campaignId/stats', getCampaignStats);

router.get('/suppressions', listSuppressions);
router.post('/suppressions', addSuppression);
router.delete('/suppressions/:suppressionId', removeSuppression);

module.exports = router;
