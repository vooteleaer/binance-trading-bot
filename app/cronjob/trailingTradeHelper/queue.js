const _ = require('lodash');

const startedJobs = {};
const finishedJobs = {};

/**
 * Prepare the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} _jobPayload
 */
const prepareJob = async (funcLogger, symbol, _jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'prepareJob' });

  // Initialize queue for symbol if not yet initialized
  if (startedJobs[symbol] === undefined) {
    startedJobs[symbol] = 0;
    finishedJobs[symbol] = 0;

    logger.info({ symbol }, `Queue ${symbol} initialized`);
  }

  // Start a new job - wait if previous job is still running
  const pos = (startedJobs[symbol] += 1) - 1;

  if (pos > finishedJobs[symbol]) {
    // Wait until previous job is completed
    logger.info({ symbol }, `Queue ${symbol} job #${pos} waiting`);
    while (pos > finishedJobs[symbol]) {
      // eslint-disable-next-line no-await-in-loop, no-promise-executor-return
      await new Promise(r => setTimeout(r, 10));
    }
  }

  logger.info({ symbol }, `Queue ${symbol} job #${pos} started`);

  return false; // continue
};

/**
 * Execute the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} jobPayload
 */
const executeJob = async (funcLogger, symbol, jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'executeJob' });

  // Preprocess before executeTrailingTrade
  if (jobPayload.preprocessFn) {
    // Return value of preprocessFn decides on calling of executeTrailingTrade
    const result = await jobPayload.preprocessFn();

    if (result === false) {
      logger.info({ symbol }, `Queue ${symbol} job done`);
      return false; // continue
    }

    logger.info({ symbol }, `Queue ${symbol} job preprocessed`);
  }

  // Execute the job
  if (jobPayload.processFn) {
    // processFn
    await jobPayload.processFn(
      funcLogger,
      symbol,
      _.get(jobPayload, 'correlationId')
    );
  }

  // Postprocess after executeTrailingTrade
  if (jobPayload.postprocessFn) {
    // postprocessFn
    await jobPayload.postprocessFn();

    logger.info({ symbol }, `Queue ${symbol} job postprocessed`);
  }

  return false; // continue
};

/**
 * Complete the job in queue
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} _jobPayload
 */
const completeJob = async (funcLogger, symbol, _jobPayload) => {
  const logger = funcLogger.child({ helper: 'queue', func: 'completeJob' });

  const pos = (finishedJobs[symbol] += 1) - 1;

  if (startedJobs[symbol] === finishedJobs[symbol]) {
    // Last job in the queue finished
    // Reset the counters
    startedJobs[symbol] = (finishedJobs[symbol] -= startedJobs[symbol]) + 0;
  }

  logger.info({ symbol }, `Queue ${symbol} job #${pos} finished`);

  return true; // completed
};

/**
 * Execute queue or preprocessFn
 *
 * @param {*} funcLogger
 * @param {*} symbol
 * @param {*} jobPayload
 */
const execute = async (funcLogger, symbol, jobPayload = {}) => {
  const logger = funcLogger.child({ helper: 'queue' });

  await prepareJob(logger, symbol, jobPayload);

  // Always call completeJob via finally so the per-symbol counter is never
  // left in a stuck state (startedJobs > finishedJobs) if executeJob throws.
  // The old for-loop over [prepareJob, executeJob, completeJob] would skip
  // completeJob entirely on an exception, deadlocking that symbol's queue.
  try {
    await executeJob(logger, symbol, jobPayload);
  } catch (err) {
    logger.error({ symbol, err }, 'Queue job execution failed');
  } finally {
    await completeJob(logger, symbol, jobPayload);
    logger.info({ symbol }, 'Queue job execution completed.');
  }
};

module.exports = {
  prepareJob,
  completeJob,
  execute
};
