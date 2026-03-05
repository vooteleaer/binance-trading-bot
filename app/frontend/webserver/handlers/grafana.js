const { mongo } = require('../../../helpers');

const METRICS = [
  'profit',
  'profit_pct',
  'cumulative_profit',
  'buy_qty',
  'sell_qty'
];

const getSymbols = async logger => {
  const result = await mongo.aggregate(logger, 'trailing-trade-candles', [
    // eslint-disable-next-line no-underscore-dangle
    { $group: { _id: '$key' } },
    // eslint-disable-next-line no-underscore-dangle
    { $sort: { _id: 1 } }
  ]);
  // eslint-disable-next-line no-underscore-dangle
  return result.map(r => r._id).filter(Boolean);
};

const queryCandles = async (logger, symbol, from, to) => {
  const match = { key: symbol };
  if (from || to) {
    match.time = {
      ...(from ? { $gte: from.getTime() } : {}),
      ...(to ? { $lte: to.getTime() } : {})
    };
  }
  const rows = await mongo.findAll(logger, 'trailing-trade-candles', match, {
    sort: { time: 1 }
  });
  return {
    type: 'table',
    columns: [
      { text: 'Time', type: 'time' },
      { text: 'Open', type: 'number' },
      { text: 'High', type: 'number' },
      { text: 'Low', type: 'number' },
      { text: 'Close', type: 'number' },
      { text: 'Volume', type: 'number' }
    ],
    rows: rows.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume])
  };
};

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
    { sort: { archivedAt: 1 } }
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

  app.post('/grafana/search', async (req, res) => {
    const { target } = req.body;
    if (target === 'symbols') {
      return res.json(await getSymbols(logger));
    }
    const symbols = await getSymbols(logger);
    return res.json([...METRICS, ...symbols.map(s => `candles_${s}`)]);
  });

  app.post('/grafana/query', async (req, res) => {
    const { range, targets } = req.body;
    const from = range && range.from ? new Date(range.from) : null;
    const to = range && range.to ? new Date(range.to) : null;

    try {
      const results = await Promise.all(
        targets.map(async ({ target }) => {
          if (target.startsWith('candles_')) {
            const symbol = target.slice('candles_'.length);
            return queryCandles(logger, symbol, from, to);
          }
          return {
            target,
            datapoints: await queryMetric(logger, target, from, to)
          };
        })
      );
      res.json(results);
    } catch (err) {
      logger.error({ err }, 'Grafana query failed');
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/grafana/annotations', async (req, res) => {
    const { range, annotation } = req.body;
    const from = range && range.from ? new Date(range.from) : null;
    const to = range && range.to ? new Date(range.to) : null;

    const match = {};
    if (from || to) {
      match.archivedAt = {
        ...(from ? { $gte: from.toISOString() } : {}),
        ...(to ? { $lte: to.toISOString() } : {})
      };
    }

    try {
      const trades = await mongo.findAll(
        logger,
        'trailing-trade-grid-trade-archive',
        match,
        { sort: { archivedAt: 1 } }
      );

      res.json(
        trades.map(trade => ({
          annotation,
          time: new Date(trade.archivedAt).getTime(),
          title: `${(trade.profit || 0) >= 0 ? '▲' : '▼'} ${trade.symbol}`,
          text: `Profit: ${(trade.profit || 0).toFixed(4)} USDC (${(
            trade.profitPercentage || 0
          ).toFixed(2)}%)`,
          tags: [(trade.profit || 0) >= 0 ? 'profit' : 'loss', trade.symbol]
        }))
      );
    } catch (err) {
      logger.error({ err }, 'Grafana annotations failed');
      res.status(500).json({ error: err.message });
    }
  });
};

module.exports = { handleGrafana };
