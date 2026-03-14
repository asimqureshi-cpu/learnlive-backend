require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');

const sessionRoutes = require('./routes/sessions');
const materialsRoutes = require('./routes/materials');
const scoringRoutes = require('./routes/scoring');
const reportsRoutes = require('./routes/reports');
const livekitRoutes = require('./routes/livekit');
const { initWebSocket } = require('./services/websocket');

const app = express();
const server = http.createServer(app);

// Open CORS for MVP
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));
app.options('*', cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.use('/api/sessions', sessionRoutes);
const usersRouter = require('./routes/users');
app.use('/api/users', usersRouter);
app.use('/api/materials', materialsRoutes);
app.use('/api/scoring', scoringRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/livekit', livekitRoutes);

initWebSocket(server);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Learning Platform Backend running on port ${PORT}`);
});
