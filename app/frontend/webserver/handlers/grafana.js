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

const getOrderFillPrice = order => {
  if (!order) return null;
  const qty = parseFloat(order.executedQty || 0);
  const quoteQty = parseFloat(order.cummulativeQuoteQty || 0);
  if (qty > 0 && quoteQty > 0) return quoteQty / qty;
  return parseFloat(order.price) || null;
};

const getOrderTime = order => {
  if (!order) return null;
  return order.transactTime || order.updateTime || order.time || null;
};

const queryBuyMarkers = async (logger, symbol, from, to) => {
  const match = { symbol };
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

  const datapoints = [];

  trades.forEach(trade => {
    (trade.buy || [])
      .filter(b => b.executed && b.executedOrder)
      .forEach(b => {
        const t = getOrderTime(b.executedOrder);
        const price = getOrderFillPrice(b.executedOrder);
        if (t && price) datapoints.push([price, t]);
      });
  });

  // Include active trade buy
  const activeGridTrade = await mongo.findOne(
    logger,
    'trailing-trade-grid-trade',
    { key: symbol }
  );

  if (activeGridTrade) {
    (activeGridTrade.buy || [])
      .filter(b => b.executed && b.executedOrder)
      .forEach(b => {
        const t = getOrderTime(b.executedOrder);
        const price = getOrderFillPrice(b.executedOrder);
        if (t && price) datapoints.push([price, t]);
      });
  }

  return { target: `buys_${symbol}`, datapoints };
};

const querySellMarkers = async (logger, symbol, from, to) => {
  const match = { symbol };
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

  const datapoints = [];

  trades.forEach(trade => {
    (trade.sell || [])
      .filter(s => s.executed && s.executedOrder)
      .forEach(s => {
        const t = getOrderTime(s.executedOrder);
        const price = getOrderFillPrice(s.executedOrder);
        if (t && price) datapoints.push([price, t]);
      });
  });

  return { target: `sells_${symbol}`, datapoints };
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

const queryLastBuyPrice = async (logger, symbol, from) => {
  const doc = await mongo.findOne(logger, 'trailing-trade-symbols', {
    key: `${symbol}-last-buy-price`
  });
  const price = doc && doc.lastBuyPrice > 0 ? doc.lastBuyPrice : null;
  if (!price) return { target: `last_buy_price_${symbol}`, datapoints: [] };
  const start = from ? from.getTime() : Date.now() - 7 * 24 * 60 * 60 * 1000;
  return {
    target: `last_buy_price_${symbol}`,
    datapoints: [
      [price, start],
      [price, Date.now()]
    ]
  };
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

  let activeTradeAdded = false;

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
      activeTradeAdded = true;
    } else if (executedBuys.length > 0) {
      annotations.push({
        annotation,
        time: from ? from.getTime() : Date.now() - 24 * 60 * 60 * 1000,
        timeEnd: Date.now(),
        title: 'Active trade',
        text: `${symbol} — in progress`,
        tags: ['trade', 'active', symbol]
      });
      activeTradeAdded = true;
    }
  }

  // Last resort: if no annotation added yet, detect active trade via lastBuyPrice
  if (!activeTradeAdded) {
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

  return annotations;
};

const queryBuySellAnnotations = async (
  logger,
  annotation,
  symbol,
  from,
  to
) => {
  const match = { symbol };
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

  const annotations = [];

  trades.forEach(trade => {
    (trade.buy || [])
      .filter(b => b.executed && b.executedOrder)
      .forEach(b => {
        const t = getOrderTime(b.executedOrder);
        const price = getOrderFillPrice(b.executedOrder);
        if (t) {
          annotations.push({
            annotation,
            time: t,
            title: '▲ Buy',
            text: price ? `${symbol} bought at ${price.toFixed(4)}` : symbol,
            tags: ['buy', symbol]
          });
        }
      });

    (trade.sell || [])
      .filter(s => s.executed && s.executedOrder)
      .forEach(s => {
        const t = getOrderTime(s.executedOrder);
        const price = getOrderFillPrice(s.executedOrder);
        if (t) {
          annotations.push({
            annotation,
            time: t,
            title: '▼ Sell',
            text: price ? `${symbol} sold at ${price.toFixed(4)}` : symbol,
            tags: ['sell', symbol]
          });
        }
      });
  });

  // Include buys from the currently active trade
  const activeGridTrade = await mongo.findOne(
    logger,
    'trailing-trade-grid-trade',
    { key: symbol }
  );

  if (activeGridTrade) {
    (activeGridTrade.buy || [])
      .filter(b => b.executed && b.executedOrder)
      .forEach(b => {
        const t = getOrderTime(b.executedOrder);
        const price = getOrderFillPrice(b.executedOrder);
        if (t) {
          annotations.push({
            annotation,
            time: t,
            title: '▲ Buy (active)',
            text: price ? `${symbol} bought at ${price.toFixed(4)}` : symbol,
            tags: ['buy', 'active', symbol]
          });
        }
      });
  }

  return annotations;
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
          if (target.startsWith('buys_')) {
            const symbol = target.slice('buys_'.length);
            return queryBuyMarkers(logger, symbol, from, to);
          }
          if (target.startsWith('sells_')) {
            const symbol = target.slice('sells_'.length);
            return querySellMarkers(logger, symbol, from, to);
          }
          if (target.startsWith('last_buy_price_')) {
            const symbol = target.slice('last_buy_price_'.length);
            return queryLastBuyPrice(logger, symbol, from);
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
          await queryBuySellAnnotations(logger, annotation, symbol, from, to)
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
