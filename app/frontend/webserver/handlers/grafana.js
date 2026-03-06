const { mongo } = require('../../../helpers');

// Patterns used to identify and label order events in trailing-trade-logs
const ORDER_PATTERNS = [
  {
    pattern: /buy order has been placed/i,
    title: '▲ Buy placed',
    tags: ['buy', 'placed']
  },
  {
    pattern: /sell order has been placed/i,
    title: '▼ Sell placed',
    tags: ['sell', 'placed']
  },
  {
    pattern: /cancel current buy order|The buy order has been cancelled/i,
    title: '✕ Buy cancelled',
    tags: ['buy', 'cancelled']
  },
  {
    pattern: /cancel current sell order|The sell order has been cancelled/i,
    title: '✕ Sell cancelled',
    tags: ['sell', 'cancelled']
  }
];

// Combined regex for MongoDB $regex filter — derived from ORDER_PATTERNS
const ORDER_LOG_REGEX = new RegExp(
  ORDER_PATTERNS.map(p => p.pattern.source).join('|'),
  'i'
);

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

const queryTradeAnnotations = async (logger, annotation, symbol, from, to) => {
  const archiveMatch = { symbol };
  if (from || to) {
    archiveMatch.archivedAt = {
      ...(from ? { $gte: from.toISOString() } : {}),
      ...(to ? { $lte: to.toISOString() } : {})
    };
  }

  const trades = await mongo.findAll(
    logger,
    'trailing-trade-grid-trade-archive',
    archiveMatch,
    { sort: { archivedAt: 1 } }
  );

  const annotations = trades.map(trade => {
    const buyTimes = (trade.buy || [])
      .filter(b => b.executed && b.executedOrder)
      .map(
        b =>
          b.executedOrder.transactTime ||
          b.executedOrder.updateTime ||
          b.executedOrder.time
      )
      .filter(Boolean);

    const startTime =
      buyTimes.length > 0
        ? Math.min(...buyTimes)
        : new Date(trade.archivedAt).getTime();
    const endTime = new Date(trade.archivedAt).getTime();

    return {
      annotation,
      time: startTime,
      timeEnd: endTime,
      title: 'Trade',
      text: `${trade.symbol} — Profit: ${(trade.profit || 0).toFixed(4)} (${(
        trade.profitPercentage || 0
      ).toFixed(2)}%)`,
      tags: ['trade', symbol]
    };
  });

  // Include any ongoing trade (buy executed but not yet archived)
  const activeGridTrade = await mongo.findOne(
    logger,
    'trailing-trade-grid-trade',
    { key: symbol }
  );

  if (activeGridTrade) {
    const getBuyTime = b =>
      b.executedOrder &&
      (b.executedOrder.transactTime ||
        b.executedOrder.updateTime ||
        b.executedOrder.time);

    const executedBuys = (activeGridTrade.buy || []).filter(
      b => b.executed && b.executedOrder
    );

    const activeBuyTimes = executedBuys.map(getBuyTime).filter(Boolean);

    const tradeStartTime =
      activeBuyTimes.length > 0 ? Math.min(...activeBuyTimes) : null;

    if (tradeStartTime !== null) {
      annotations.push({
        annotation,
        time: tradeStartTime,
        timeEnd: Date.now(),
        title: 'Active trade',
        text: `${symbol} — in progress`,
        tags: ['trade', 'active', symbol]
      });
    } else if (executedBuys.length > 0) {
      // Executed buys exist but no timestamp — fall back to view start
      annotations.push({
        annotation,
        time: from ? from.getTime() : Date.now() - 24 * 60 * 60 * 1000,
        timeEnd: Date.now(),
        title: 'Active trade',
        text: `${symbol} — in progress`,
        tags: ['trade', 'active', symbol]
      });
    } else {
      // No executed buys in grid trade — check lastBuyPrice as last resort
      const lastBuyPriceDoc = await mongo.findOne(
        logger,
        'trailing-trade-symbols',
        { key: `${symbol}-last-buy-price` }
      );
      if (lastBuyPriceDoc && lastBuyPriceDoc.lastBuyPrice > 0) {
        annotations.push({
          annotation,
          time: from ? from.getTime() : Date.now() - 24 * 60 * 60 * 1000,
          timeEnd: Date.now(),
          title: 'Active trade',
          text: `${symbol} — in progress`,
          tags: ['trade', 'active', symbol]
        });
      }
    }
  }

  return annotations;
};

const queryOrderAnnotations = async (logger, annotation, symbol, from, to) => {
  const match = {
    symbol,
    msg: { $regex: ORDER_LOG_REGEX.source, $options: 'i' }
  };
  if (from || to) {
    match.loggedAt = {
      ...(from ? { $gte: from } : {}),
      ...(to ? { $lte: to } : {})
    };
  }

  const logs = await mongo.findAll(logger, 'trailing-trade-logs', match, {
    sort: { loggedAt: 1 }
  });

  return logs
    .map(log => {
      const matched = ORDER_PATTERNS.find(p => p.pattern.test(log.msg));
      if (!matched) return null;
      return {
        annotation,
        time: new Date(log.loggedAt).getTime(),
        title: matched.title,
        text: log.msg,
        tags: matched.tags
      };
    })
    .filter(Boolean);
};

const handleGrafana = async (funcLogger, app) => {
  const logger = funcLogger.child({ endpoint: '/grafana' });

  app.get('/grafana/', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/grafana/variable', async (req, res) =>
    res.json(await getSymbols(logger))
  );

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
    const query = (annotation && annotation.query) || '*';
    const from = range && range.from ? new Date(range.from) : null;
    const to = range && range.to ? new Date(range.to) : null;

    try {
      if (query.startsWith('trades_')) {
        const symbol = query.slice('trades_'.length);
        return res.json(
          await queryTradeAnnotations(logger, annotation, symbol, from, to)
        );
      }

      if (query.startsWith('orders_')) {
        const symbol = query.slice('orders_'.length);
        return res.json(
          await queryOrderAnnotations(logger, annotation, symbol, from, to)
        );
      }

      // Default: all completed trades across all symbols (original behaviour)
      const match = {};
      if (from || to) {
        match.archivedAt = {
          ...(from ? { $gte: from.toISOString() } : {}),
          ...(to ? { $lte: to.toISOString() } : {})
        };
      }

      const trades = await mongo.findAll(
        logger,
        'trailing-trade-grid-trade-archive',
        match,
        { sort: { archivedAt: 1 } }
      );

      return res.json(
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
      return res.status(500).json({ error: err.message });
    }
  });
};

module.exports = { handleGrafana };
