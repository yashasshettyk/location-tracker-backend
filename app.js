require('dotenv').config();
const express = require('express');
const cors = require('cors');
const tracksRouter = require('./routes/tracks');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.use('/api/tracks', tracksRouter);

module.exports = app;
