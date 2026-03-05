const { mongo } = require('../../../helpers');

const METRICS = [
  'profit',
  'profit_pct',
  'cumulative_profit',
  'buy_qty',
  'sell_qty'
];

const queryMetric = async (logger, target, from, to) => {
  const match = {};
  if (from || to) {
    match.archivedAt = {
      ...(from ? { $gte: from.toISOString() } : {}),
      ...(to ? { $lte: to.toISOString() } : {})
    };
  }

  const rows = await mongo.findAll(
    logger,
    'trailing-trade-grid-trade-archive',
    match,
    {
      sort: { archivedAt: 1 }
    }
  );

  if (target === 'cumulative_profit') {
    let running = 0;
    return rows.map(row => {
      running += row.profit || 0;
      return [running, new Date(row.archivedAt).getTime()];
    });
  }

  const fieldMap = {
    profit: 'profit',
    profit_pct: 'profitPercentage',
    buy_qty: 'totalBuyQuoteQty',
    sell_qty: 'totalSellQuoteQty'
  };

  const field = fieldMap[target];
  return rows.map(row => [row[field] || 0, new Date(row.archivedAt).getTime()]);
};

const handleGrafana = async (funcLogger, app) => {
  const logger = funcLogger.child({ endpoint: '/grafana' });

  app.get('/grafana/', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/grafana/search', (req, res) => {
    res.json(METRICS);
  });

  app.post('/grafana/query', async (req, res) => {
    const { range, targets } = req.body;
    const from = range && range.from ? new Date(range.from) : null;
    const to = range && range.to ? new Date(range.to) : null;

    try {
      const results = await Promise.all(
        targets.map(async ({ target }) => ({
          target,
          datapoints: await queryMetric(logger, target, from, to)
        }))
      );
      res.json(results);
    } catch (err) {
      logger.error({ err }, 'Grafana query failed');
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports = { handleGrafana };
