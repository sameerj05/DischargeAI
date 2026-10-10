import express from 'express';
import { pool } from './db.js';

const app = express();
app.use(express.json());

const api = express.Router();
app.use('/api', api);

api.get('/patients', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM patientinfo');
    res.json(rows);
  } catch (err) {
    console.error('Failed to fetch patients:', err);
    res.status(500).json({ statusCode: 500, message: 'Failed to fetch patients' });
  }
});

api.post('/ingest', (req, res) => {
  const { data, type } = req.body ?? {};

  if (typeof data !== 'string' || typeof type !== 'string') {
    return res
      .status(400)
      .json({ statusCode: 400, message: '`data` and `type` must be strings' });
  }

  // TODO: process the ingested payload
  res.status(200).json({ statusCode: 200, message: 'Ingested successfully' });
});

app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ statusCode: 400, message: 'Invalid JSON' });
  }
  console.error(err);
  res.status(500).json({ statusCode: 500, message: 'Internal server error' });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`Listening on :${port}`));
