const { v4: uuidv4 } = require('uuid');
const config = require('config');
const { CronJob } = require('cron');
const { maskConfig } = require('./cronjob/trailingTradeHelper/util');

const {
  executeAlive,
  executeTrailingTradeIndicator,
  executeTradingView
} = require('./cronjob');

const fulfillWithTimeLimit = async (logger, timeLimit, task, failureValue) => {
  let timeout;
  const timeoutPromise = new Promise(resolve => {
    timeout = setTimeout(() => {
      logger.error(
        { tag: 'job-timeout' },
        `Failed to run the job within ${timeLimit}ms.`
      );

      resolve(failureValue);
    }, timeLimit);
  });

  const response = await Promise.race([task, timeoutPromise]);

  /* istanbul ignore next */
  if (timeout) {
    // the code works without this but let's be safe and clean up the timeout.
    clearTimeout(timeout);
  }
  return response;
};

const runCronjob = async serverLogger => {
  const logger = serverLogger.child({ server: 'cronjob' });
  logger.info(
    { config: maskConfig(config) },
    `API ${config.get('mode')} trading started on`
  );

  const jobInstances = {};

  // Execute jobs
  [
    { jobName: 'alive', executeJob: executeAlive },
    {
      jobName: 'trailingTradeIndicator',
      executeJob: executeTrailingTradeIndicator
    },
    {
      jobName: 'tradingView',
      executeJob: executeTradingView
    }
  ].forEach(job => {
    const { jobName, executeJob } = job;
    if (config.get(`jobs.${jobName}.enabled`)) {
      jobInstances[jobName] = new CronJob(
        config.get(`jobs.${jobName}.cronTime`),
        async () => {
          if (jobInstances[jobName].taskRunning) {
            logger.info({ jobName }, 'Task is running, skip this tick');
            return;
          }
          jobInstances[jobName].taskRunning = true;

          const moduleLogger = logger.child({ job: jobName, uuid: uuidv4() });

          // Attach .finally() to the real task so taskRunning is only reset
          // when the job actually completes, not when the timeout races past it.
          // Without this, Promise.race() returns early on timeout but the
          // original executeJob() promise keeps running in the background,
          // causing concurrent job accumulation over time.
          const task = executeJob(moduleLogger).finally(() => {
            jobInstances[jobName].taskRunning = false;
          });

          // Make sure the job running within 20 seconds.
          // If longer than 20 seconds, something went wrong.
          await fulfillWithTimeLimit(moduleLogger, 20000, task, null);
          // NOTE: taskRunning is reset by the .finally() above, not here.
        },
        null,
        false,
        config.get('tz')
      );
      jobInstances[jobName].start();
      logger.info(
        { cronTime: config.get(`jobs.${jobName}.cronTime`) },
        `Job ${jobName} has been started.`
      );
    }
  });
};

module.exports = { runCronjob };
