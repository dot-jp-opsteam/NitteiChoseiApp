const { candidateWindow, generateCandidates } = require('./candidate-slots');

module.exports = function registerCandidateRoutes({ app, requireAuth, client, readDB, rowToInterview, availabilityApi }) {
  app.get('/api/availability/candidates', requireAuth, async (req, res) => {
    if (!['staff', 'branch_admin', 'admin'].includes(req.authUser.role)) {
      return res.status(403).json({ error: 'スタッフだけが候補を呼び出せます' });
    }
    let window;
    try {
      window = candidateWindow(req.query);
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    try {
      const staffId = req.authUser.id;
      const db = await readDB();
      const raw = (db?.availability || {})[staffId] || {};
      const availability = await availabilityApi.effectiveAvailability(staffId, raw, window.from, window.to + 86400000);
      const rows = await client.execute({ sql: "SELECT * FROM interviews WHERE staff_id = ? AND status = 'fixed'", args: [staffId] });
      res.json({ slots: generateCandidates({ ...window, blocks: availability.blocks, interviews: rows.rows.map(rowToInterview) }) });
    } catch (error) {
      console.error('候補の空き時間を取得できませんでした', error.message);
      res.status(503).json({ error: '空き時間を確認できませんでした。時間をおいて再度お試しください' });
    }
  });
};
