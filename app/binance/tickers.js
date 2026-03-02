const { v4: uuidv4 } = require('uuid');
const _ = require('lodash');
const { binance, cache, PubSub } = require('../helpers');
const queue = require('../cronjob/trailingTradeHelper/queue');
const { executeTrailingTrade } = require('../cronjob/index');

const {
  getAccountInfo,
  getCachedExchangeSymbols
} = require('../cronjob/trailingTradeHelper/common');
const { errorHandlerWrapper } = require('../error-handler');

let websocketTickersClean = {};

// Watchdog: detect when Binance websocket silently stops delivering tickers.
// Binance can drop connections without a close frame; binance-api-node
// reconnects TCP but may receive no data. Without this, the bot quietly
// stops trading with no errors logged.
let lastTickerReceivedAt = 0;
let tickerWatchdogInterval = null;
const TICKER_WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const setupTickersWebsocket = async (logger, symbols) => {
  // Reset the timestamp so a freshly-setup websocket doesn't immediately
  // look stale to the watchdog.
  lastTickerReceivedAt = Date.now();

  if (tickerWatchdogInterval) {
    clearInterval(tickerWatchdogInterval);
    tickerWatchdogInterval = null;
  }

  if (symbols.length > 0) {
    tickerWatchdogInterval = setInterval(() => {
      const elapsed = Date.now() - lastTickerReceivedAt;
      if (elapsed > TICKER_WATCHDOG_TIMEOUT_MS) {
        logger.warn(
          { elapsed, tag: 'ticker-watchdog' },
          'No ticker received from Binance in 5 minutes — triggering websocket reset'
        );
        // Reset timestamp first to prevent a storm of resets if syncAll is slow.
        lastTickerReceivedAt = Date.now();
        PubSub.publish('reset-all-websockets', 'ticker-watchdog');
      }
    }, 60 * 1000); // check every minute
  }
  const accountInfo = await getAccountInfo(logger);

  const cachedExchangeSymbols = await getCachedExchangeSymbols(logger);

  const monitoringSymbols = _.cloneDeep(symbols);

  // we are adding ${symbol}BTC to our monitoring symbols to support
  // dust transfer feature, and we will not use them for anything else
  accountInfo.balances.reduce((acc, b) => {
    const symbol = `${b.asset}BTC`;
    // Make sure the symbol existing in Binance. Otherwise, just ignore.
    if (
      cachedExchangeSymbols[symbol] !== undefined &&
      acc.includes(symbol) === false
    ) {
      acc.push(symbol);
    }
    return acc;
  }, monitoringSymbols);

  // eslint-disable-next-line no-restricted-syntax
  for (const monitoringSymbol of monitoringSymbols) {
    if (monitoringSymbol in websocketTickersClean) {
      logger.info(
        `Existing opened stream for ${monitoringSymbol} ticker found, clean first`
      );
      websocketTickersClean[monitoringSymbol]();
    }

    websocketTickersClean[monitoringSymbol] = binance.client.ws.miniTicker(
      monitoringSymbol,
      ticker => {
        errorHandlerWrapper(logger, 'Tickers', async () => {
          // Update watchdog heartbeat on every received ticker.
          lastTickerReceivedAt = Date.now();

          const correlationId = uuidv4();

          const { eventType, eventTime, curDayClose: close, symbol } = ticker;

          const symbolLogger = logger.child({
            correlationId,
            symbol
          });

          const saveCandle = async () => {
            // Save latest candle for the symbol
            await cache.hset(
              'trailing-trade-symbols',
              `${symbol}-latest-candle`,
              JSON.stringify({
                eventType,
                eventTime,
                symbol,
                close
              })
            );
          };

          const canExecuteTrailingTrade = symbols.includes(monitoringSymbol);

          symbolLogger.info(
            { ticker, canExecuteTrailingTrade },
            'Received new ticker'
          );

          if (canExecuteTrailingTrade) {
            queue.execute(symbolLogger, monitoringSymbol, {
              correlationId,
              preprocessFn: saveCandle,
              processFn: executeTrailingTrade
            });
          } else {
            await saveCandle();
          }
        });
      }
    );
  }
};

const getWebsocketTickersClean = () => websocketTickersClean;

const refreshTickersClean = logger => {
  if (tickerWatchdogInterval) {
    clearInterval(tickerWatchdogInterval);
    tickerWatchdogInterval = null;
  }

  if (_.isEmpty(websocketTickersClean) === false) {
    logger.info('Existing opened socket for tickers found, clean first');
    _.forEach(websocketTickersClean, (clean, _key) => {
      clean();
    });
    websocketTickersClean = {};
  }
};

module.exports = {
  setupTickersWebsocket,
  getWebsocketTickersClean,
  refreshTickersClean
};
