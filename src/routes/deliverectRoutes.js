const express = require('express');
const { registerPos, receiveOrder, syncProducts } = require('../controllers/deliverectController');

const router = express.Router();

router.post('/register', registerPos);
router.post('/orders', receiveOrder);
router.post('/products', syncProducts);
router.post('/tables', (req, res) => res.json([]));
router.post('/floors', (req, res) => res.json([]));

module.exports = router;
